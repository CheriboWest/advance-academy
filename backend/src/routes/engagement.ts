import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getSupabase } from '../lib/supabase.js';
import { unsubscribeSecret, verifyUnsubscribeToken } from '../lib/engagement.js';
import { getEngagement, setEmailReminders } from '../services/engagement.service.js';

/**
 * Reminder emails. GET/PATCH read and set the switch: ordinary authed routes; no LLM, no
 * credits. The unsubscribe route is public (listed in main.ts skipPaths): it is
 * hit from an email link or by a mail provider's one-click unsubscribe, with the
 * HMAC token standing in for the login.
 */

function readUnsubscribe(request: FastifyRequest): { u: string; t: string } | null {
  const q = (request.query ?? {}) as Record<string, unknown>;
  const b = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const u = typeof q.u === 'string' ? q.u : typeof b.u === 'string' ? b.u : '';
  const t = typeof q.t === 'string' ? q.t : typeof b.t === 'string' ? b.t : '';
  return u && t ? { u, t } : null;
}

export async function registerEngagementRoutes(app: FastifyInstance) {
  app.get('/api/engagement', async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
    try {
      return await getEngagement(request.userId);
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ code: 'ENGAGEMENT_FAILED', message: 'Could not load your reminder setting.' });
    }
  });

  app.patch<{ Body: { emailReminders?: unknown } }>('/api/engagement', async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
    if (typeof request.body?.emailReminders !== 'boolean') {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'emailReminders must be true or false.' });
    }
    try {
      await setEmailReminders(request.userId, request.body.emailReminders);
      return { emailReminders: request.body.emailReminders };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ code: 'ENGAGEMENT_FAILED', message: 'Could not save that setting.' });
    }
  });

  // One-click unsubscribe (RFC 8058 POSTs with the token in the URL) and the
  // /unsubscribe page (token in the body) both land here.
  app.post('/api/engagement/unsubscribe', async (request, reply) => {
    const params = readUnsubscribe(request);
    const secret = unsubscribeSecret();
    if (!params || !secret || !verifyUnsubscribeToken(params.u, params.t, secret)) {
      return reply.code(400).send({ code: 'INVALID_LINK', message: 'This unsubscribe link is not valid.' });
    }
    const { error } = await getSupabase().from('users').update({ email_reminders: false }).eq('id', params.u);
    if (error) {
      request.log.error(error);
      return reply.code(500).send({ code: 'UNSUBSCRIBE_FAILED', message: 'Could not unsubscribe you. Try again.' });
    }
    return { ok: true };
  });
}
