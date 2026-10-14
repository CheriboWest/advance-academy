import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAdminUser } from '../lib/admin.js';
import { isValidIsoDay, validateGoalsPatch, validateSeenKeys, validateSkipReason } from '../lib/gamification.js';
import {
  bookRestDay,
  getCoinHistory,
  getGamificationSummary,
  listStuckIntents,
  markAchievementsSeen,
  skipRewardIntent,
  updateGamificationGoals,
} from '../services/gamification.service.js';

/**
 * Gamification (migration 047, supabase/CLAUDE.md). No LLM, no credits.
 * Rewards are judged by the database from what the student did; nothing here
 * can grant XP or coins directly.
 */

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
}

function sendError(error: unknown, request: FastifyRequest, reply: FastifyReply, fallback: string) {
  const e = error as { statusCode?: number; code?: string; message?: string };
  const status = Number(e?.statusCode) || 500;
  if (status >= 500) {
    request.log.error(error);
    return reply.code(500).send({ code: 'GAMIFICATION_FAILED', message: fallback });
  }
  return reply.code(status).send({ code: e.code ?? 'INVALID_REQUEST', message: e.message ?? fallback });
}

/** Loose per-user cap: the summary runs the reward processor, so it isn't free. */
const PER_USER = {
  config: {
    rateLimit: {
      max: 60,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => req.userId ?? req.ip,
      errorResponseBuilder: (_req: FastifyRequest, ctx: { after: string }) => ({
        code: 'RATE_LIMIT_EXCEEDED',
        scope: 'gamification',
        message: `Too many requests — please wait ${ctx.after}.`,
      }),
    },
  },
};

export async function registerGamificationRoutes(app: FastifyInstance) {
  app.get('/api/gamification', PER_USER, async (request, reply) => {
    if (!request.userId) return unauthorized(reply);
    try {
      return await getGamificationSummary(request.userId);
    } catch (error) {
      return sendError(error, request, reply, 'Could not load your progress.');
    }
  });

  app.patch('/api/gamification/goals', PER_USER, async (request, reply) => {
    if (!request.userId) return unauthorized(reply);
    const parsed = validateGoalsPatch(request.body);
    if (!parsed.ok) return reply.code(400).send({ code: 'INVALID_REQUEST', message: parsed.message });
    try {
      return { goals: await updateGamificationGoals(request.userId, parsed.value) };
    } catch (error) {
      return sendError(error, request, reply, 'Could not save your goals.');
    }
  });

  app.post('/api/gamification/rest-days', PER_USER, async (request, reply) => {
    if (!request.userId) return unauthorized(reply);
    const day = (request.body as { day?: unknown } | null)?.day;
    if (!isValidIsoDay(day)) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'day must be YYYY-MM-DD.' });
    try {
      return { restDaysLeftThisMonth: await bookRestDay(request.userId, day) };
    } catch (error) {
      return sendError(error, request, reply, 'Could not book that rest day.');
    }
  });

  app.post('/api/gamification/achievements/seen', PER_USER, async (request, reply) => {
    if (!request.userId) return unauthorized(reply);
    const parsed = validateSeenKeys(request.body);
    if (!parsed.ok) return reply.code(400).send({ code: 'INVALID_REQUEST', message: parsed.message });
    try {
      await markAchievementsSeen(request.userId, parsed.value);
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, request, reply, 'Could not update your achievements.');
    }
  });

  app.get('/api/gamification/coins', PER_USER, async (request, reply) => {
    if (!request.userId) return unauthorized(reply);
    const limit = Number((request.query as { limit?: string } | undefined)?.limit);
    try {
      return await getCoinHistory(request.userId, Number.isFinite(limit) ? limit : 50);
    } catch (error) {
      return sendError(error, request, reply, 'Could not load your coins.');
    }
  });

  // ── Admin: rewards that failed 10 times stop their user's queue until skipped.
  app.get('/api/admin/gamification/stuck', async (request, reply) => {
    if (!(await isAdminUser(request.userId))) return reply.code(403).send({ code: 'FORBIDDEN', message: 'Admin access required.' });
    try {
      return { intents: await listStuckIntents() };
    } catch (error) {
      return sendError(error, request, reply, 'Could not load stuck rewards.');
    }
  });

  app.post<{ Params: { seq: string } }>('/api/admin/gamification/intents/:seq/skip', async (request, reply) => {
    if (!(await isAdminUser(request.userId))) return reply.code(403).send({ code: 'FORBIDDEN', message: 'Admin access required.' });
    const seq = Number(request.params.seq);
    if (!Number.isSafeInteger(seq) || seq <= 0) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Unknown reward.' });
    const parsed = validateSkipReason(request.body);
    if (!parsed.ok) return reply.code(400).send({ code: 'INVALID_REQUEST', message: parsed.message });
    try {
      await skipRewardIntent(request.userId!, seq, parsed.value);
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, request, reply, 'Could not skip that reward.');
    }
  });
}
