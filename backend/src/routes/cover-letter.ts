import type { FastifyInstance } from 'fastify';
import { APIConnectionTimeoutError, APIConnectionError, APIError, AuthenticationError } from '@anthropic-ai/sdk';
import type { GenerateCoverLetterRequest } from '@advance-academy/contracts/cover-letter';
import { assertCredits } from '../lib/credits.js';
import { perUserDaily } from '../lib/rate-limit.js';
import { isOverloadedError } from '../lib/llm-anthropic.js';
import { generateCoverLetter } from '../services/cover-letter.service.js';
import { recordToolResult } from '../services/tool-results.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JD = 20_000;

function optionalString(v: unknown, max: number): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.length <= max);
}

/** Shape check; the service owns "is there enough to write from". */
function validate(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'Request body must be an object.';
  const b = body as Record<string, unknown>;
  if (typeof b.cvVersionId !== 'string' || !UUID_RE.test(b.cvVersionId)) return 'Pick a CV from your CV Library.';
  if (b.savedJobId !== undefined && (typeof b.savedJobId !== 'string' || !UUID_RE.test(b.savedJobId))) {
    return 'savedJobId must be an id.';
  }
  // Also with a saved job: a pasted description replaces the card's.
  if (!optionalString(b.jobDescription, MAX_JD)) return `The job description must be ${MAX_JD} characters or fewer.`;
  if (!b.savedJobId) {
    if (!optionalString(b.jobTitle, 200) || !optionalString(b.companyName, 200)) return 'Job title and company must be short text.';
    if (!optionalString(b.jobUrl, 2000)) return 'The job link is too long.';
    if (b.jobUrl) {
      try {
        const u = new URL(b.jobUrl as string);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'The job link must be an http(s) link.';
      } catch {
        return 'The job link must be an http(s) link.';
      }
    }
    if (!b.jobDescription && !b.jobUrl) return 'Pick a saved job, or paste a job link or description.';
  }
  return null;
}

export async function registerCoverLetterRoutes(app: FastifyInstance) {
  app.post<{ Body: GenerateCoverLetterRequest }>(
    '/api/cover-letter/generate',
    perUserDaily('DAILY_LIMIT_COVER_LETTER', 10, 'Cover Letter'),
    async (request, reply) => {
      if (!request.userId) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
      const problem = validate(request.body);
      if (problem) return reply.code(400).send({ code: 'INVALID_REQUEST', message: problem });

      try {
        await assertCredits(request.userId, 'coverLetter');
        // Charged inside the transaction that saves the letter (record_cover_letter).
        const result = await generateCoverLetter(request.userId, request.body);
        await recordToolResult(
          request.userId,
          'cover_letter',
          [result.jobTitle, result.companyName].filter(Boolean).join(' · '),
          result,
          {
            input: {
              savedJobId: request.body.savedJobId ?? null,
              jobTitle: result.jobTitle,
              companyName: result.companyName,
              jobUrl: request.body.jobUrl ?? null,
            },
            cvVersionId: request.body.cvVersionId,
          },
        );
        return result;
      } catch (error) {
        const { status, body, log } = coverLetterErrorResponse(error);
        if (log) request.log.error(error);
        return reply.code(status).send(body);
      }
    },
  );
}

/**
 * What a failed generation tells the student. Exported for tests. A JdError (no
 * usable job description) and a bad letter carry `expose`, so their message —
 * which says how to recover — goes out whatever the status; before, any 5xx
 * (a timed-out link is a 504) became "Could not write the cover letter".
 */
export function coverLetterErrorResponse(error: unknown): {
  status: number;
  body: { code: string; message: string; scope?: string };
  log: boolean;
} {
  const e = error as { statusCode?: number; code?: string; message?: string; scope?: string; expose?: boolean };
  const status = Number(e?.statusCode) || 500;
  if (status === 429 && e.code === 'CREDIT_EXHAUSTED') {
    return { status: 429, body: { code: e.code, message: e.message ?? '', scope: e.scope }, log: false };
  }
  if (e?.expose && e.code && e.message) {
    // A JD problem is the student's to fix; a 5xx here (a failed save) is ours, so log it.
    return { status, body: { code: e.code, message: e.message }, log: status >= 500 && !e.code.startsWith('JD_') };
  }
  if (isOverloadedError(error)) {
    return { status: 503, body: { code: 'LLM_BUSY', message: 'The writing service is busy. Try again in a minute.' }, log: false };
  }
  // AI service failures: say which, and that nothing was charged (the credit is spent only on success).
  if (error instanceof APIConnectionTimeoutError) {
    return {
      status: 504,
      body: { code: 'LLM_TIMEOUT', message: 'Writing the letter took too long. Try again in a moment — no credit was used.' },
      log: false,
    };
  }
  if (error instanceof AuthenticationError || error instanceof APIConnectionError) {
    return {
      status: 503,
      body: { code: 'LLM_UNAVAILABLE', message: 'The writing service is unavailable right now. Try again later — no credit was used.' },
      log: true,
    };
  }
  // Any other answer from the AI API. These carry `status`, not `statusCode`,
  // so they used to fall through to the generic 500 below: a 400 "credit
  // balance is too low", a 404 retired model or a 403 key without access all
  // read "Could not write the cover letter. Please try again." The student can't
  // fix these, so say it's on our side; the log has Anthropic's own message.
  if (error instanceof APIError) {
    const s = error.status;
    if (s === 401 || s === 403) {
      return {
        status: 503,
        body: { code: 'LLM_UNAVAILABLE', message: 'The writing service is unavailable right now. Try again later — no credit was used.' },
        log: true,
      };
    }
    return {
      status: 502,
      body: {
        code: 'LLM_REJECTED',
        message:
          'The writing service turned the request down. This is a problem on our side, not with your CV or job description — no credit was used. Please try again later.',
      },
      log: true,
    };
  }
  return {
    status,
    body: {
      code: status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_REQUEST' : 'COVER_LETTER_FAILED',
      message: status < 500 && e?.message ? e.message : 'Could not write the cover letter. Please try again.',
    },
    log: status >= 500,
  };
}
