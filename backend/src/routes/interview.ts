import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import {
  startInterviewSession,
  sendInterviewMessage,
  evaluateInterview,
} from '../services/interview.service.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { dbListSessions, dbGetSession } from '../lib/interview-prep/db.js';
import type {
  StartSessionBody,
  SendMessageBody,
  EvaluateSessionBody,
} from '../types/interview-prep.js';
import { perUserDaily } from '../lib/rate-limit.js';
import { assertCredits, spendCredits, requireMembership } from '../lib/credits.js';
import { recordToolResult } from '../services/tool-results.service.js';
import { ensureCvVersion } from '../lib/cv-version-link.js';

const ALLOWED_AUDIO_EXTENSIONS = ['.webm', '.mp3', '.wav', '.m4a', '.ogg', '.mp4', '.mpeg', '.mpga'];

function statusOf(error: unknown): number {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    return Number((error as { statusCode?: number }).statusCode) || 500;
  }
  return 500;
}

export async function registerInterviewRoutes(app: FastifyInstance) {
  // Combined start/message endpoint to mirror the existing client contract.
  // Per-student daily cap applies only to action === 'start' (DAILY_LIMIT_INTERVIEW, default
  // 2/day/user). The per-turn 'message' action is exempt via allowList — a single 5-question
  // session would otherwise blow the budget on its own messages.
  app.post<{ Body: StartSessionBody | SendMessageBody }>(
    '/api/interview',
    perUserDaily(
      'DAILY_LIMIT_INTERVIEW',
      2,
      'Interview Prep',
      (req) => (req.body as { action?: string } | undefined)?.action !== 'start',
    ),
    async (request, reply) => {
    const body = request.body as (StartSessionBody | SendMessageBody) & { action?: string };
    try {
      if (body?.action === 'start') {
        // Interview Lab is the mentorship perk: trial accounts get 403 here no
        // matter their balance. Checked before credits so the user sees the
        // upgrade prompt rather than a confusing "out of credits".
        await requireMembership(request.userId, 'Interview Lab');
        // Credit wallet (no-op for admins). Only the session start is charged;
        // per-turn 'message' calls belong to the session already paid for.
        await assertCredits(request.userId, 'interview');
        const session = await startInterviewSession(body as StartSessionBody, request.userId);
        await spendCredits(request.userId, 'interview');
        return session;
      }
      if (body?.action === 'message') {
        return await sendInterviewMessage(body as SendMessageBody, request.userId);
      }
      return reply.code(400).send({ error: 'Unknown action' });
    } catch (error) {
      const code = statusOf(error);
      const message = error instanceof Error ? error.message : 'Internal error';
      request.log.error(error);
      // 429 = out of credits, 403 = trial account hitting a mentorship feature.
      // The interview FE reads `message` off both, so send it alongside the
      // existing `error` field.
      if (code === 429 || code === 403) {
        const e = error as { code?: string; scope?: string };
        const fallback = code === 403 ? 'MEMBERSHIP_REQUIRED' : 'CREDIT_EXHAUSTED';
        return reply.code(code).send({ code: e.code ?? fallback, message, error: message, scope: e.scope });
      }
      return reply.code(code).send({ error: message });
    }
  });

  app.post<{ Body: EvaluateSessionBody }>('/api/evaluate', async (request, reply) => {
    try {
      const evaluation = await evaluateInterview(request.body, request.userId);
      // The feedback report is the session's finished output — store it so the
      // user can reread it from History without re-running the evaluation.
      // Best-effort: a failed write never fails the evaluation.
      const session = request.body?.session;
      const context = session?.context;
      const label = [context?.jobTitle, context?.companyName].filter(Boolean).join(' · ');
      // The mock's setup travels with the report (migration 018): a score means
      // little to a coach without the JD and persona it was scored against.
      // `cvText` is excluded on purpose — it goes to `cv_versions` instead, so
      // the CV is stored once and pointed at rather than copied per run.
      const cvVersionId = await ensureCvVersion({
        userId: request.userId,
        rawText: context?.cvText ?? '',
        name: `Interview Lab · ${label || 'mock'}`,
        origin: 'interview_lab',
      });
      await recordToolResult(request.userId, 'interview', label || 'Interview Lab', evaluation, {
        input: context
          ? {
              personaId: session?.personaId ?? null,
              jobTitle: context.jobTitle,
              jobDescription: context.jobDescription,
              companyName: context.companyName,
              companyUrl: context.companyUrl,
              extraLinks: context.extraLinks,
              questionBank: context.questionBank ?? null,
              // The link back to the coaching session that launched this mock
              // (ticket T7). Stored here rather than in a column of its own:
              // the mock IS a tool run, it already lives in tool_results, and a
              // parallel copy on coaching_sessions would be a second truth.
              coachingSessionId: context.coachingSessionId ?? null,
            }
          : undefined,
        cvVersionId,
      });
      return evaluation;
    } catch (error) {
      const code = statusOf(error);
      const message = error instanceof Error ? error.message : 'Internal error';
      request.log.error(error);
      return reply.code(code).send({ error: message });
    }
  });

  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/api/interview/sessions', async (request) => {
    const requestedLimit = Number(request.query.limit);
    return dbListSessions(
      request.userId,
      request.query.cursor,
      Number.isFinite(requestedLimit) ? requestedLimit : 20,
    );
  });

  app.get<{ Params: { id: string } }>('/api/interview/sessions/:id', async (request, reply) => {
    const session = await dbGetSession(request.params.id, request.userId);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    return { session };
  });

  // Voice mode transcription (scoped so @fastify/multipart only applies here)
  await app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 25 * 1024 * 1024 },
    });

    scoped.post('/api/interview/transcribe', async (request, reply) => {
      let data;
      try {
        data = await request.file();
      } catch {
        return reply.code(400).send({ error: 'Invalid multipart upload' });
      }

      if (!data) {
        return reply.code(400).send({ error: 'No audio file provided' });
      }

      const filename = (data.filename ?? '').toLowerCase();
      const hasAllowedExtension = ALLOWED_AUDIO_EXTENSIONS.some((ext) => filename.endsWith(ext));
      const mimeType = data.mimetype ?? '';
      const hasAudioMime = mimeType.startsWith('audio/') || mimeType.startsWith('video/webm');

      if (!hasAllowedExtension && !hasAudioMime) {
        return reply.code(400).send({
          error: 'Unsupported audio format. Use webm, mp3, wav, m4a, or ogg.',
        });
      }

      let buffer: Buffer;
      try {
        buffer = await data.toBuffer();
      } catch {
        return reply.code(413).send({ error: 'Audio file too large (25 MB max)' });
      }

      try {
        const result = await transcribeAudio(buffer, data.filename || 'answer.webm', mimeType);
        return result;
      } catch (error) {
        const statusCode =
          error && typeof error === 'object' && 'statusCode' in error
            ? Number((error as { statusCode?: number }).statusCode) || 500
            : 500;
        const message = error instanceof Error ? error.message : 'Transcription failed';
        request.log.error(error);
        return reply.code(statusCode).send({ error: message });
      }
    });
  });
}
