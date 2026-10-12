import { getSupabase, isMissingColumnError } from '../lib/supabase.js';
import { coachingGrant, membershipGrant, type Tier } from '../lib/credits.js';
import { invalidateUserStatus, type UserStatus } from '../lib/user-access.js';
import {
  attachEngagement,
  indexEngagement,
  NO_ENGAGEMENT,
  type Engagement,
  type EngagementRow,
} from '../lib/admin/engagement.js';

/**
 * Admin user management (sprint F4).
 *
 * Backs /admin/users: review the signup queue (migration 018), list accounts, move
 * them between tiers, top up credits and coaching sessions, and toggle the admin
 * flag. Every mutation writes an `admin_actions` row (migration 016) so "who
 * approved this account / granted these credits, and when" is answerable later.
 *
 * All access control lives in the route (lib/admin.ts) — this module assumes the
 * caller is already proven to be an admin.
 */

import type { AdminUserRow } from '@advance-academy/contracts/admin';
export type { AdminUserRow };

export interface ListUsersFilters {
  /** Case-insensitive substring match on email. */
  search?: string;
  tier?: string;
  status?: string;
  limit?: number;
}

const SELECT_COLS =
  'id, email, full_name, status, tier, is_admin, credit_balance, coaching_credits, referral_count, first_tool_used_at, reviewed_at, created_at';

/** The same list without migration 019's column, for a deploy that outran it. */
const SELECT_COLS_PRE_019 =
  'id, email, full_name, status, tier, is_admin, credit_balance, referral_count, first_tool_used_at, reviewed_at, created_at';

export async function listUsers(filters: ListUsersFilters = {}): Promise<AdminUserRow[]> {
  const supabase = getSupabase();
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);

  const build = (columns: string) => {
    let query = supabase.from('users').select(columns).order('created_at', { ascending: false }).limit(limit);
    if (filters.tier) query = query.eq('tier', filters.tier);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.search?.trim()) query = query.ilike('email', `%${filters.search.trim()}%`);
    return query;
  };

  let { data, error } = await build(SELECT_COLS);
  // /admin/users is how a coach fixes a broken account — and now also the only
  // place a pending signup gets approved. It must not be the thing that breaks
  // when migration 019 has not been applied yet.
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await build(SELECT_COLS_PRE_019));
  }
  if (error) {
    throw Object.assign(new Error('Could not load users'), { statusCode: 500, cause: error });
  }

  const rows = (data ?? []) as unknown as AdminUserRow[];
  return attachEngagement(rows, await loadEngagement(rows.map((r) => r.id)));
}

/**
 * Activity totals for the accounts on screen, in one round trip.
 *
 * Fails soft for the same reason the SELECT above falls back: /admin/users is
 * how a pending signup gets approved, and it must not be the thing that breaks
 * when migration 021 has not been applied yet. Losing the RPC costs two columns,
 * which render as "—"/0; losing the page costs the approval queue.
 */
async function loadEngagement(userIds: string[]): Promise<Map<string, Engagement>> {
  if (userIds.length === 0) return new Map();

  const { data, error } = await getSupabase().rpc('user_engagement', { user_ids: userIds });
  if (error) {
    console.error('[admin] user_engagement RPC failed — run migration 021:', error);
    return new Map();
  }
  return indexEngagement(data as EngagementRow[] | null);
}

export interface UpdateUserPatch {
  /** Approval decision (migration 018). Only an admin can move an account off 'pending'. */
  status?: Exclude<UserStatus, 'pending'>;
  tier?: Tier;
  /** Signed change to the wallet, e.g. +5 or -2. */
  creditDelta?: number;
  /** Signed change to the coaching quota (migration 019), e.g. +1. */
  coachingDelta?: number;
  isAdmin?: boolean;
}

/** What a membership upgrade hands out. Passed in so the plan is testable without env. */
export interface Grants {
  credits: number;
  sessions: number;
}

export interface UpdatePlan {
  updates: Record<string, unknown>;
  audits: { action: string; detail: Record<string, unknown> }[];
}

/**
 * Decide what an admin patch changes, without touching the database.
 *
 * Pure on purpose: this is where the money rules live (top-up-not-add, no
 * negative balances, deltas stacking on a same-request grant), and they are far
 * easier to pin down in a unit test than through Supabase.
 *
 * Audit actions must stay inside the `admin_actions_action_check` constraint —
 * migration 018 narrowed it, and 020 re-widened it for 'adjust_coaching'. A value
 * outside the list is rejected by the DB and, because the audit write is
 * best-effort, disappears silently.
 */
export function planUserUpdate(
  current: AdminUserRow,
  patch: UpdateUserPatch,
  actorId: string,
  grants: Grants,
  now: string,
): UpdatePlan {
  const updates: Record<string, unknown> = {};
  const audits: UpdatePlan['audits'] = [];

  if (patch.status && patch.status !== current.status) {
    updates.status = patch.status;
    updates.reviewed_at = now;
    updates.reviewed_by = actorId;
    audits.push({ action: 'set_status', detail: { from: current.status, to: patch.status } });
  }

  if (patch.tier && patch.tier !== current.tier) {
    updates.tier = patch.tier;
    const detail: Record<string, unknown> = { from: current.tier, to: patch.tier };
    if (patch.tier === 'membership') {
      if (current.credit_balance < grants.credits) {
        updates.credit_balance = grants.credits;
        detail.granted = grants.credits - current.credit_balance;
      }
      // The coaching session that comes with membership (migration 019). Topped
      // up to the grant rather than added to, for the same reason as the wallet:
      // toggling the tier back and forth must not farm sessions.
      const held = current.coaching_credits ?? 0;
      if (held < grants.sessions) {
        updates.coaching_credits = grants.sessions;
        detail.coachingGranted = grants.sessions - held;
      }
    }
    audits.push({ action: 'set_tier', detail });
  }

  if (patch.creditDelta) {
    const base = (updates.credit_balance as number | undefined) ?? current.credit_balance;
    const next = Math.max(0, base + patch.creditDelta);
    updates.credit_balance = next;
    audits.push({ action: 'adjust_credits', detail: { from: base, to: next, delta: patch.creditDelta } });
  }

  if (patch.coachingDelta) {
    const base = (updates.coaching_credits as number | undefined) ?? current.coaching_credits ?? 0;
    const next = Math.max(0, base + patch.coachingDelta);
    updates.coaching_credits = next;
    audits.push({
      action: 'adjust_coaching',
      detail: { from: base, to: next, delta: patch.coachingDelta },
    });
  }

  if (typeof patch.isAdmin === 'boolean' && patch.isAdmin !== current.is_admin) {
    updates.is_admin = patch.isAdmin;
    audits.push({ action: 'set_admin', detail: { from: current.is_admin, to: patch.isAdmin } });
  }

  return { updates, audits };
}

/**
 * Apply an admin patch to one account and record what changed.
 *
 * Tier upgrades top the wallet up to the membership grant rather than adding to
 * it, so repeatedly toggling a tier can't farm credits. `max(current, grant)`
 * means an inviter who already earned past 20 through referrals keeps their
 * larger balance. The coaching quota follows the same rule.
 */
export async function updateUser(
  actorId: string,
  targetId: string,
  patch: UpdateUserPatch,
): Promise<AdminUserRow> {
  const supabase = getSupabase();

  const read = (columns: string) =>
    supabase.from('users').select(columns).eq('id', targetId).maybeSingle();

  let { data: before, error: readErr } = await read(SELECT_COLS);
  if (readErr && isMissingColumnError(readErr)) {
    ({ data: before, error: readErr } = await read(SELECT_COLS_PRE_019));
  }
  if (readErr) {
    throw Object.assign(new Error('Could not load the account'), { statusCode: 500, cause: readErr });
  }
  if (!before) {
    throw Object.assign(new Error('No such user'), { statusCode: 404 });
  }
  const current = before as unknown as AdminUserRow;

  // Lockout guard: an admin removing their own flag could leave nobody able to
  // reach /admin (the env allowlist may well be empty in production).
  if (patch.isAdmin === false && actorId === targetId) {
    throw Object.assign(new Error('You cannot remove your own admin access.'), { statusCode: 400 });
  }
  // Same reasoning for the approval gate: rejecting yourself locks you out of the
  // queue you'd need to un-reject yourself from.
  if (patch.status === 'rejected' && actorId === targetId) {
    throw Object.assign(new Error('You cannot review your own account.'), { statusCode: 400 });
  }

  const { updates, audits } = planUserUpdate(
    current,
    patch,
    actorId,
    { credits: membershipGrant(), sessions: coachingGrant() },
    new Date().toISOString(),
  );

  if (Object.keys(updates).length === 0) {
    // Nothing to do — but the caller still expects a complete row.
    const held = (await loadEngagement([targetId])).get(targetId) ?? NO_ENGAGEMENT;
    return { ...current, ...held };
  }

  const write = (body: Record<string, unknown>, columns: string) =>
    supabase.from('users').update(body).eq('id', targetId).select(columns).maybeSingle();

  let { data: after, error: writeErr } = await write(updates, SELECT_COLS);

  // Upgrading someone to membership now also grants a coaching session. If
  // migration 019 has not been applied, that column does not exist and the whole
  // update fails — which would mean an admin cannot approve or promote anybody.
  // Drop the coaching part and do the rest rather than blocking the review.
  if (writeErr && isMissingColumnError(writeErr) && 'coaching_credits' in updates) {
    console.error('[admin] users.coaching_credits is missing — run migration 019.');
    const { coaching_credits: _dropped, ...rest } = updates;
    if (Object.keys(rest).length > 0) {
      ({ data: after, error: writeErr } = await write(rest, SELECT_COLS_PRE_019));
    }
  }

  if (writeErr || !after) {
    throw Object.assign(new Error('Could not update the account'), { statusCode: 500, cause: writeErr });
  }

  // Without this the approval sits behind the 60s status cache in lib/user-access.
  if (updates.status) invalidateUserStatus(targetId);

  // Audit is best-effort: the change already landed, and losing the log entry
  // must not turn a successful update into an error for the admin.
  const { error: auditErr } = await supabase.from('admin_actions').insert(
    audits.map((a) => ({
      actor_id: actorId,
      target_user_id: targetId,
      action: a.action,
      detail: a.detail,
    })),
  );
  if (auditErr) console.error(`[admin] audit write failed for ${targetId}:`, auditErr);

  // The UPDATE ... RETURNING has no engagement columns — they are not stored on
  // the row. Filling them in keeps the returned shape a real AdminUserRow rather
  // than one with two fields quietly undefined.
  const updated = after as unknown as AdminUserRow;
  const engagement = (await loadEngagement([targetId])).get(targetId) ?? NO_ENGAGEMENT;
  return { ...updated, ...engagement };
}
