import type { EngagementResponse, EngagementTask } from '@advance-academy/contracts/engagement';
import { getSupabase } from '../lib/supabase.js';
import { isGamificationV2Enabled } from '../config/features.js';
import { addDays, taskProgress, utcDay, weekStartUtc, type WeekCounts } from '../lib/engagement.js';

/**
 * Progress & Engagement (migration 045). Task progress is derived from what the
 * student did; the only writes are the points ledger and the reminder claims.
 * Every query is scoped by user_id — the tables are service-role only.
 */

function dbError(action: string, error: { message?: string } | null): Error {
  return Object.assign(new Error(`Failed to ${action}: ${error?.message ?? 'unknown error'}`), { statusCode: 500 });
}

/** What the student did in [start, end). */
export async function weekCounts(userId: string, start: Date, end: Date): Promise<WeekCounts> {
  const sb = getSupabase();
  const from = start.toISOString();
  const to = end.toISOString();
  const [applied, tools, saved] = await Promise.all([
    sb
      .from('job_events')
      .select('job_id')
      .eq('user_id', userId)
      .eq('to_status', 'applied')
      .gte('created_at', from)
      .lt('created_at', to),
    sb
      .from('tool_results')
      .select('tool')
      .eq('user_id', userId)
      .in('tool', ['cv', 'cover_letter', 'interview'])
      .gte('created_at', from)
      .lt('created_at', to),
    sb
      .from('saved_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', from)
      .lt('created_at', to),
  ]);
  if (applied.error) throw dbError('count applications', applied.error);
  if (tools.error) throw dbError('count tool runs', tools.error);
  if (saved.error) throw dbError('count saved jobs', saved.error);

  const toolRows = (tools.data ?? []) as Array<{ tool: string }>;
  const runs = (tool: string) => toolRows.filter((r) => r.tool === tool).length;
  return {
    // A card moved to "applied" twice (e.g. undo and redo) is still one application.
    applications: new Set((applied.data ?? []).map((r) => (r as { job_id: string }).job_id)).size,
    jobs_saved: saved.count ?? 0,
    cv_runs: runs('cv'),
    cover_letters: runs('cover_letter'),
    interviews: runs('interview'),
  };
}

/** Record points for finished tasks. The unique key makes this safe to repeat. */
async function award(userId: string, weekStart: Date, tasks: EngagementTask[]): Promise<void> {
  const rows = tasks
    .filter((t) => t.done)
    .map((t) => ({ user_id: userId, task_key: t.key, period_start: utcDay(weekStart), points: t.points }));
  if (rows.length === 0) return;
  const { error } = await getSupabase()
    .from('points_ledger')
    .upsert(rows, { onConflict: 'user_id,task_key,period_start', ignoreDuplicates: true });
  if (error) throw dbError('award points', error);
}

export async function getEngagement(userId: string, now = new Date()): Promise<EngagementResponse> {
  const thisWeek = weekStartUtc(now);
  const lastWeek = addDays(thisWeek, -7);

  // Last week too: a task finished on Sunday night and first seen on Monday
  // still earns its points.
  const [current, previous] = await Promise.all([
    weekCounts(userId, thisWeek, addDays(thisWeek, 7)),
    weekCounts(userId, lastWeek, thisWeek),
  ]);
  const tasks = taskProgress(current);
  // Gamification v2 never awards on read: the points ledger stays as history,
  // and new rewards come only from 047's processor.
  if (!isGamificationV2Enabled()) {
    await Promise.all([award(userId, thisWeek, tasks), award(userId, lastWeek, taskProgress(previous))]);
  }

  const sb = getSupabase();
  const [ledger, user] = await Promise.all([
    // ponytail: sums in JS — ~5 rows a week per student. A SQL sum if this ever gets slow.
    sb.from('points_ledger').select('points, period_start').eq('user_id', userId),
    sb.from('users').select('email_reminders').eq('id', userId).maybeSingle(),
  ]);
  if (ledger.error) throw dbError('load points', ledger.error);
  if (user.error) throw dbError('load settings', user.error);

  const rows = (ledger.data ?? []) as Array<{ points: number; period_start: string }>;
  const weekKey = utcDay(thisWeek);
  return {
    weekStart: weekKey,
    tasks,
    pointsThisWeek: rows.filter((r) => r.period_start === weekKey).reduce((sum, r) => sum + r.points, 0),
    pointsTotal: rows.reduce((sum, r) => sum + r.points, 0),
    emailReminders: (user.data as { email_reminders?: boolean } | null)?.email_reminders ?? true,
  };
}

export async function setEmailReminders(userId: string, enabled: boolean): Promise<void> {
  const { error } = await getSupabase().from('users').update({ email_reminders: enabled }).eq('id', userId);
  if (error) throw dbError('update email reminders', error);
}
