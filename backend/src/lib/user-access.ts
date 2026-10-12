import { getSupabase } from './supabase.js';

import type { UserStatus } from '@advance-academy/contracts/admin';
export type { UserStatus };

// ponytail: 60s in-memory Map, one PK lookup per user per minute. Approvals take
// effect within a minute, which is fine for a human-reviewed queue. Move to Redis
// only if we run >1 backend instance AND that minute starts mattering.
// Admin rights are deliberately NOT cached here — lib/admin.ts owns that (it also
// honours the ADMIN_USER_IDS allowlist), and two caches of the same fact drift.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: UserStatus; expiresAt: number }>();

export async function getUserStatus(userId: string): Promise<UserStatus> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const { data, error } = await getSupabase()
    .from('users')
    .select('status')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw Object.assign(new Error('Could not verify account status.'), { statusCode: 503 });
  }

  // No row means the auth.users → public.users trigger (migration 006) did not fire.
  // Treat as pending rather than approved: fail closed.
  const value = (data?.status as UserStatus) ?? 'pending';
  cache.set(userId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Called after an admin review so the decision is not hidden behind the TTL. */
export function invalidateUserStatus(userId: string) {
  cache.delete(userId);
}

/**
 * The approval gate decision. Pure, so it can be tested without a DB — this is the
 * security-critical part; the surrounding cache is a plain TTL Map.
 *
 * 403 rather than 401: the token IS valid, the account just isn't cleared. The
 * frontend needs to tell them apart (401 → re-login, 403 → show /pending).
 */
export function approvalError(status: UserStatus): { code: string; message: string } | null {
  if (status === 'approved') return null;
  if (status === 'rejected') {
    return {
      code: 'ACCOUNT_REJECTED',
      message: 'Your account request was not approved. Contact your programme coach.',
    };
  }
  // 'pending' and anything unrecognised — fail closed.
  return {
    code: 'ACCOUNT_PENDING',
    message: 'Your account is awaiting approval. You will get access once a coach reviews it.',
  };
}
