import type {
  CoinHistoryResponse,
  GamificationGoals,
  GamificationQuest,
  GamificationSummary,
  StuckRewardIntent,
  UpdateGamificationGoalsRequest,
} from '@advance-academy/contracts/gamification';
import { getSupabase } from '../lib/supabase.js';
import { mapGamificationDbError, type PgErrorLike } from '../lib/gamification-errors.js';
import {
  addDaysIso,
  currentStreak,
  localDay,
  mondayOf,
  timezoneChangeableAt,
  toJourney,
  type StreakDayRow,
} from '../lib/gamification.js';

/**
 * Gamification v2 (migration 047). Reads are plain service-role selects scoped
 * by user_id; every write goes through one of 047's functions, which is the
 * only way service_role can write a ledger at all (it holds SELECT only).
 * The routes call none of this unless GAMIFICATION_V2_ENABLED is on.
 */

const DEFAULT_TIMEZONE = 'Europe/London';
const PAGE = 1000; // PostgREST's row cap per request

function httpError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function readError(action: string, error: PgErrorLike): Error {
  return mapGamificationDbError(error, action);
}

/** First letter up: the database's messages are written lower-case. */
function sentence(message: string | undefined, fallback: string): string {
  const m = (message ?? '').trim() || fallback;
  return m.charAt(0).toUpperCase() + m.slice(1) + (m.endsWith('.') ? '' : '.');
}

interface GoalRow {
  timezone: string;
  timezone_changed_at: string | null;
  intensity: GamificationGoals['intensity'];
  goal_type: GamificationGoals['goalType'];
  timeline: GamificationGoals['timeline'];
}

async function loadGoalRow(userId: string): Promise<GoalRow | null> {
  const { data, error } = await getSupabase()
    .from('user_goal_settings')
    .select('timezone, timezone_changed_at, intensity, goal_type, timeline')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw readError('load goals', error);
  return data as GoalRow | null;
}

function toGoals(row: GoalRow | null, now: Date): GamificationGoals {
  return {
    timezone: row?.timezone ?? DEFAULT_TIMEZONE,
    intensity: row?.intensity ?? 'active',
    goalType: row?.goal_type ?? null,
    timeline: row?.timeline ?? null,
    timezoneChangeableAt: timezoneChangeableAt(row?.timezone_changed_at ?? null, now),
  };
}

async function sumXp(userId: string, fromDay?: string): Promise<number> {
  let total = 0;
  for (let offset = 0; ; offset += PAGE) {
    let q = getSupabase().from('xp_grants').select('xp').eq('user_id', userId);
    if (fromDay) q = q.gte('local_day', fromDay);
    const { data, error } = await q.order('decision_id').range(offset, offset + PAGE - 1);
    if (error) throw readError('load XP', error);
    const rows = (data ?? []) as Array<{ xp: number }>;
    total += rows.reduce((sum, r) => sum + r.xp, 0);
    if (rows.length < PAGE) return total;
  }
}

/**
 * Judge whatever this user has done since the last call. A failure here is
 * logged, never shown: the summary still renders, and the intent retries with
 * backoff on the next call (or goes stuck for an admin to look at).
 */
async function processRewards(userId: string): Promise<void> {
  const { error } = await getSupabase().rpc('process_reward_intents', { p_user: userId });
  if (error) console.error(`[gamification] processing rewards for ${userId} failed:`, error.code, error.message);
}

export async function getGamificationSummary(userId: string, now = new Date()): Promise<GamificationSummary> {
  const sb = getSupabase();

  // Quests first: progress is only counted for decisions made after today's
  // quests exist, so assigning them after processing would lose today's work.
  const quests = await sb.rpc('ensure_daily_quests', { p_user: userId });
  if (quests.error) throw readError('assign daily quests', quests.error);
  await processRewards(userId);

  const goalRow = await loadGoalRow(userId);
  const goals = toGoals(goalRow, now);
  const today = localDay(goals.timezone, now);

  const [config, questRows, streakRows, wallet, achievements, cards, pending, xpTotal, xpWeek] = await Promise.all([
    sb.from('gamification_config').select('weekly_targets, rest_days_per_month').order('version', { ascending: false }).limit(1).maybeSingle(),
    sb.from('daily_quest_assignments').select('quest_key, kind, target, progress, completed_at').eq('user_id', userId).eq('day', today).order('quest_key'),
    sb.from('streak_days').select('day, kind').eq('user_id', userId).gte('day', addDaysIso(today, -400)).order('day', { ascending: false }).limit(PAGE),
    sb.from('coin_wallets').select('balance').eq('user_id', userId).maybeSingle(),
    sb.from('user_achievements').select('achievement_key, earned_at, seen_at').eq('user_id', userId).order('earned_at'),
    sb.from('saved_jobs').select('status').eq('user_id', userId).limit(500),
    sb.from('reward_intents').select('seq', { count: 'exact', head: true }).eq('user_id', userId).in('state', ['pending', 'stuck']),
    sumXp(userId),
    sumXp(userId, mondayOf(today)),
  ]);
  for (const [name, r] of [
    ['config', config], ['quests', questRows], ['streak', streakRows], ['coins', wallet],
    ['achievements', achievements], ['journey', cards], ['pending rewards', pending],
  ] as const) {
    if (r.error) throw readError(`load ${name}`, r.error);
  }

  const cfg = config.data as { weekly_targets: Record<string, number>; rest_days_per_month: number } | null;
  const streak = (streakRows.data ?? []) as StreakDayRow[];
  const restThisMonth = streak.filter((r) => r.kind === 'rest' && r.day.slice(0, 7) === today.slice(0, 7)).length;

  return {
    enabled: true,
    today,
    xp: { total: xpTotal, thisWeek: xpWeek, weeklyTarget: cfg?.weekly_targets?.[goals.intensity] ?? 0 },
    streak: {
      ...currentStreak(streak, today),
      restDaysLeftThisMonth: Math.max(0, (cfg?.rest_days_per_month ?? 0) - restThisMonth),
      upcomingRestDays: streak.filter((r) => r.kind === 'rest' && r.day > today).map((r) => r.day).sort(),
    },
    coins: (wallet.data as { balance: number } | null)?.balance ?? 0,
    quests: ((questRows.data ?? []) as Array<{ quest_key: string; kind: string; target: number; progress: number; completed_at: string | null }>).map(
      (q): GamificationQuest => ({ key: q.quest_key, kind: q.kind, target: q.target, progress: q.progress, done: q.completed_at !== null }),
    ),
    achievements: ((achievements.data ?? []) as Array<{ achievement_key: string; earned_at: string; seen_at: string | null }>).map((a) => ({
      key: a.achievement_key,
      earnedAt: a.earned_at,
      seenAt: a.seen_at,
    })),
    goals,
    journey: toJourney(((cards.data ?? []) as Array<{ status: string }>).map((c) => c.status)),
    pendingRewards: pending.count ?? 0,
  };
}

/**
 * Goals and timezone. service_role may insert/update exactly these columns
 * (047). 047's G3 trigger owns the timezone rules — a real IANA zone, at most
 * one change per 24 hours — and its errors become 400 / 409 here.
 */
export async function updateGamificationGoals(
  userId: string,
  patch: UpdateGamificationGoalsRequest,
  now = new Date(),
): Promise<GamificationGoals> {
  const fields: Record<string, unknown> = {};
  if (patch.timezone !== undefined) fields.timezone = patch.timezone;
  if (patch.intensity !== undefined) fields.intensity = patch.intensity;
  if (patch.goalType !== undefined) fields.goal_type = patch.goalType;
  if (patch.timeline !== undefined) fields.timeline = patch.timeline;

  const sb = getSupabase();
  const write = async (exists: boolean) =>
    exists
      ? sb.from('user_goal_settings').update({ ...fields, updated_at: now.toISOString() }).eq('user_id', userId)
      : sb.from('user_goal_settings').insert({ user_id: userId, ...fields });

  // Not an upsert: PostgREST's ON CONFLICT would also SET user_id, which
  // service_role is (deliberately) not allowed to update.
  let { error } = await write((await loadGoalRow(userId)) !== null);
  if (error?.code === '23505') ({ error } = await write(true)); // a racing first save
  if (error) {
    if (error.code === '22023') throw httpError(400, 'INVALID_TIMEZONE', 'Pick a timezone from the list.');
    if (error.code === '23514' && /24 hours/.test(error.message ?? '')) {
      throw httpError(409, 'TIMEZONE_CHANGE_TOO_SOON', 'Your timezone can change once a day. Try again tomorrow.');
    }
    throw readError('save goals', error);
  }
  return toGoals(await loadGoalRow(userId), now);
}

export async function bookRestDay(userId: string, day: string): Promise<number> {
  const { data, error } = await getSupabase().rpc('book_rest_day', { p_user: userId, p_day: day });
  if (error) {
    if (error.code === '22023') throw httpError(400, 'INVALID_REST_DAY', sentence(error.message, 'Pick today or a day this month'));
    if (error.code === '23514') throw httpError(409, 'REST_DAY_UNAVAILABLE', sentence(error.message, 'That rest day is not available'));
    throw readError('book a rest day', error);
  }
  return data as number;
}

export async function markAchievementsSeen(userId: string, keys: string[], now = new Date()): Promise<void> {
  const { error } = await getSupabase()
    .from('user_achievements')
    .update({ seen_at: now.toISOString() })
    .eq('user_id', userId)
    .in('achievement_key', keys)
    .is('seen_at', null);
  if (error) throw readError('mark achievements seen', error);
}

export async function getCoinHistory(userId: string, limit = 50): Promise<CoinHistoryResponse> {
  const sb = getSupabase();
  const [wallet, txns] = await Promise.all([
    sb.from('coin_wallets').select('balance').eq('user_id', userId).maybeSingle(),
    sb.from('coin_transactions').select('delta, reason, reference, balance_after, created_at')
      .eq('user_id', userId).order('id', { ascending: false }).limit(Math.min(Math.max(limit, 1), 200)),
  ]);
  if (wallet.error) throw readError('load coins', wallet.error);
  if (txns.error) throw readError('load coin history', txns.error);
  return {
    balance: (wallet.data as { balance: number } | null)?.balance ?? 0,
    transactions: ((txns.data ?? []) as Array<{ delta: number; reason: string; reference: string; balance_after: number; created_at: string }>).map(
      (t) => ({ delta: t.delta, reason: t.reason, reference: t.reference, balanceAfter: t.balance_after, createdAt: t.created_at }),
    ),
  };
}

export async function listStuckIntents(): Promise<StuckRewardIntent[]> {
  const { data, error } = await getSupabase()
    .from('reward_intents')
    .select('seq, user_id, kind, attempts, last_error, captured_at')
    .eq('state', 'stuck')
    .order('seq')
    .limit(100);
  if (error) throw readError('list stuck rewards', error);
  return ((data ?? []) as Array<{ seq: number; user_id: string; kind: string; attempts: number; last_error: string | null; captured_at: string }>).map(
    (r) => ({ seq: r.seq, userId: r.user_id, kind: r.kind, attempts: r.attempts, lastError: r.last_error, capturedAt: r.captured_at }),
  );
}

/** The database re-checks users.is_admin and writes the audit + admin_actions rows. */
export async function skipRewardIntent(actorId: string, seq: number, reason: string): Promise<void> {
  const { error } = await getSupabase().rpc('skip_reward_intent', { p_actor: actorId, p_seq: seq, p_reason: reason });
  if (!error) return;
  if (error.code === '42501' && /not an admin/.test(error.message ?? '')) throw httpError(403, 'FORBIDDEN', 'Admins only.');
  if (error.code === '22023') throw httpError(400, 'INVALID_REQUEST', 'Give a reason of at least 10 characters.');
  throw mapGamificationDbError(error, 'skip the reward');
}
