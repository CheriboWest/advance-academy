import type { FastifyInstance } from 'fastify';
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
  if (!b.savedJobId) {
    if (!optionalString(b.jobTitle, 200) || !optionalString(b.companyName, 200)) return 'Job title and company must be short text.';
    if (!optionalString(b.jobDescription, MAX_JD)) return `The job description must be ${MAX_JD} characters or fewer.`;
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
        const e = error as { statusCode?: number; code?: string; message?: string; scope?: string };
        const status = Number(e?.statusCode) || 500;
        if (status === 429 && e.code === 'CREDIT_EXHAUSTED') {
          return reply.code(429).send({ code: e.code, message: e.message, scope: e.scope });
        }
        if (isOverloadedError(error)) {
          return reply.code(503).send({ code: 'LLM_BUSY', message: 'The writing service is busy. Try again in a minute.' });
        }
        if (status >= 500) request.log.error(error);
        return reply.code(status).send({
          code: status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_REQUEST' : 'COVER_LETTER_FAILED',
          message: status < 500 && e.message ? e.message : 'Could not write the cover letter. Please try again.',
        });
      }
    },
  );
}
