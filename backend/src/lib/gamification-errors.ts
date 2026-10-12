/**
 * Maps the SQLSTATEs migration 047's functions raise (supabase/CLAUDE.md)
 * to the HTTP errors routes already understand (`statusCode` + `code`).
 *
 *   GC001  credits exhausted            → 429 CREDIT_EXHAUSTED
 *   GN001  card not found for this user → 404 NOT_FOUND
 *   GN002  intent is not stuck          → 409 INTENT_NOT_STUCK
 *   GX00n  invariant broken             → 500 (a missing policy/grant — never the user's fault)
 *   42501  privilege / RLS failure      → 500 (same: a deployment problem)
 *
 * Anything else is returned as a plain 500 carrying the database message for
 * the log; routes never show a 500's message to the user.
 */

export interface PgErrorLike {
  code?: string;
  message?: string;
  details?: string | null;
}

export type GamificationHttpError = Error & { statusCode: number; code: string; cause?: unknown };

function httpError(statusCode: number, code: string, message: string, cause: unknown): GamificationHttpError {
  return Object.assign(new Error(message), { statusCode, code, cause });
}

export function mapGamificationDbError(error: PgErrorLike, action: string): GamificationHttpError {
  const sqlstate = error.code ?? '';
  if (sqlstate === 'GC001') {
    return httpError(429, 'CREDIT_EXHAUSTED', 'You have no credits left for this. Invite a friend to earn more, or upgrade to Mentorship.', error);
  }
  if (sqlstate === 'GN001') return httpError(404, 'NOT_FOUND', 'That job is not in your tracker.', error);
  if (sqlstate === 'GN002') return httpError(409, 'INTENT_NOT_STUCK', 'That reward is not stuck, so it cannot be skipped.', error);
  if (/^GX\d{3}$/.test(sqlstate) || sqlstate === '42501') {
    return httpError(500, 'GAMIFICATION_INVARIANT', `Failed to ${action}: ${sqlstate} ${error.message ?? ''}`.trim(), error);
  }
  return httpError(500, 'DATABASE_ERROR', `Failed to ${action}: ${error.message ?? 'unknown error'}`, error);
}
