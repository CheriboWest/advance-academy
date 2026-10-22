import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createTrialAndSendMagicLink } from '../services/passwordless.service.js';
import { isValidEmail } from '../services/leads.service.js';

/**
 * Passwordless auth (CA-001, ticket P2/2a).
 *
 * POST /api/auth/passwordless — public (no bearer token). Given an email, mints
 * (or reuses) a trial account and emails a magic login link via Resend. Added to
 * the auth skip-list in main.ts.
 *
 * We always return 200 with { ok: true } for a valid email, whether or not the
 * account is new — never reveal whether an email is already registered.
 */

const RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => req.ip,
      errorResponseBuilder: (_req: FastifyRequest, ctx: { after: string }) => ({
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Too many requests. Please try again in ${ctx.after}.`,
      }),
    },
  },
};

interface Body {
  email?: unknown;
  name?: unknown;
  ref?: unknown; // inviter's referral code (P3c)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/api/auth/passwordless', RATE_LIMIT, async (request, reply) => {
    const body = (request.body ?? {}) as Body;

    if (!isValidEmail(body.email)) {
      return reply.code(422).send({ code: 'INVALID_EMAIL', message: 'A valid email is required.' });
    }

    try {
      const { emailSent } = await createTrialAndSendMagicLink(body.email as string, str(body.name), str(body.ref));
      if (!emailSent) {
        // Usually Supabase's mailer rate limit. Saying "check your inbox" here
        // left students waiting for an email that was never sent.
        return reply.code(503).send({
          code: 'EMAIL_NOT_SENT',
          message: 'We could not send your login link right now. Please wait a few minutes and try again.',
        });
      }
      return reply.code(200).send({ ok: true });
    } catch (error) {
      request.log.error(error);
      return reply
        .code(500)
        .send({ code: 'PASSWORDLESS_FAILED', message: 'Could not send your login link. Please try again.' });
    }
  });
}
