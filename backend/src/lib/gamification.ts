import {
  GOAL_INTENSITIES,
  GOAL_TIMELINES,
  GOAL_TYPES,
  type GamificationJourney,
  type UpdateGamificationGoalsRequest,
} from '@advance-academy/contracts/gamification';

/**
 * Pure helpers for Gamification v2 — no I/O, so node:test covers them. The
 * reads and RPC calls live in services/gamification.service.ts; the rules that
 * decide rewards live in the database (migration 047).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` of `now` in an IANA timezone — the same day 047's gam_local_today computes. */
export function localDay(timezone: string, now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDaysIso(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Monday of the week `day` falls in (047's weekly challenge uses Monday-start weeks). */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return addDaysIso(day, -((d.getUTCDay() + 6) % 7));
}

export function isValidIsoDay(day: unknown): day is string {
  if (typeof day !== 'string' || !ISO_DAY.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface StreakDayRow {
  day: string;
  kind: 'active' | 'rest';
}

/**
 * The current streak: consecutive days with an active or rest entry, ending
 * today — or yesterday while today has nothing yet, so a streak never reads as
 * broken before the day is over. Rest days bridge but don't count, exactly as
 * 047's gam_streak_length does.
 */
export function currentStreak(rows: StreakDayRow[], today: string): { current: number; activeToday: boolean } {
  const byDay = new Map(rows.map((r) => [r.day, r.kind]));
  const activeToday = byDay.get(today) === 'active';
  let day = byDay.has(today) ? today : addDaysIso(today, -1);
  let current = 0;
  while (byDay.has(day)) {
    if (byDay.get(day) === 'active') current += 1;
    day = addDaysIso(day, -1);
  }
  return { current, activeToday };
}

/** When the timezone may change again (047's G3: once per 24 hours), or null if now. */
export function timezoneChangeableAt(changedAt: string | null, now: Date): string | null {
  if (!changedAt) return null;
  const next = Date.parse(changedAt) + DAY_MS;
  return next > now.getTime() ? new Date(next).toISOString() : null;
}

export function toJourney(statuses: string[]): GamificationJourney {
  const journey: GamificationJourney = { saved: 0, preparing: 0, applied: 0, interview: 0, offer: 0 };
  for (const s of statuses) {
    // A follow-up is still an application in flight.
    const stage = s === 'follow_up' ? 'applied' : s;
    if (stage in journey) journey[stage as keyof GamificationJourney] += 1;
  }
  return journey;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export function validateGoalsPatch(body: unknown): Parsed<UpdateGamificationGoalsRequest> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'Request body must be an object.' };
  const b = body as Record<string, unknown>;
  const value: UpdateGamificationGoalsRequest = {};
  if (b.timezone !== undefined) {
    if (!isValidTimezone(b.timezone)) return { ok: false, message: 'Pick a timezone from the list.' };
    value.timezone = b.timezone;
  }
  if (b.intensity !== undefined) {
    if (!GOAL_INTENSITIES.includes(b.intensity as never)) return { ok: false, message: 'Intensity must be light, active or intensive.' };
    value.intensity = b.intensity as UpdateGamificationGoalsRequest['intensity'];
  }
  if (b.goalType !== undefined) {
    if (b.goalType !== null && !GOAL_TYPES.includes(b.goalType as never)) return { ok: false, message: 'Unknown goal.' };
    value.goalType = b.goalType as UpdateGamificationGoalsRequest['goalType'];
  }
  if (b.timeline !== undefined) {
    if (b.timeline !== null && !GOAL_TIMELINES.includes(b.timeline as never)) return { ok: false, message: 'Unknown timeline.' };
    value.timeline = b.timeline as UpdateGamificationGoalsRequest['timeline'];
  }
  if (Object.keys(value).length === 0) return { ok: false, message: 'Nothing to update.' };
  return { ok: true, value };
}

export function validateSeenKeys(body: unknown): Parsed<string[]> {
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 20) return { ok: false, message: 'keys must be a list of 1–20 achievements.' };
  if (!keys.every((k) => typeof k === 'string' && /^[a-z_]{1,40}$/.test(k))) return { ok: false, message: 'Unknown achievement key.' };
  return { ok: true, value: [...new Set(keys as string[])] };
}

/** 047's skip_reward_intent wants at least 10 characters; say so before the round trip. */
export function validateSkipReason(body: unknown): Parsed<string> {
  const reason = (body as { reason?: unknown } | null)?.reason;
  if (typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 500) {
    return { ok: false, message: 'Give a reason of 10–500 characters.' };
  }
  return { ok: true, value: reason.trim() };
}
