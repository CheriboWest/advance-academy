import { getSupabase } from './supabase.js';

/**
 * Who counts as an admin (sprint F4, migration 015).
 *
 * Two sources, checked in this order:
 *
 *   1. `ADMIN_USER_IDS` env allowlist — the bootstrap path and the backdoor. It
 *      works before anyone has the DB flag set, and it survives a mistyped
 *      `is_admin` update that would otherwise lock every admin out of /admin.
 *   2. `users.is_admin` — the normal path, togglable from the admin screen.
 *
 * `is_admin` is deliberately independent of `tier`, so a coach can sit on a real
 * trial/membership tier to test the student experience without losing access.
 *
 * Fails closed: unset env + no flag => nobody is admin.
 */
export async function isAdminUser(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  if (isAllowlistedAdmin(userId)) return true;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('users')
    .select('is_admin')
    .eq('id', userId)
    .maybeSingle();
  if (error) return false; // lookup failure must not grant access
  return Boolean(data?.is_admin);
}

/** Source 1 alone, for callers that already read `users.is_admin` themselves. */
export function isAllowlistedAdmin(userId: string): boolean {
  return (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(userId);
}
