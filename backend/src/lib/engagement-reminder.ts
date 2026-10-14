import { TERMINAL_SAVED_JOB_STATUSES } from '@advance-academy/contracts/job-tracking';
import { getSupabase } from './supabase.js';
import { isEmailSendingEnabled, sendEmail } from './email.js';
import { escapeHtml, unsubscribeSecret, unsubscribeToken, utcDay } from './engagement.js';

/**
 * Reminder emails (App 1 "Reminders"). Runs in the Fastify process on the same
 * pattern as cv-analysis-reaper: once at boot, then hourly.
 *
 *   follow_ups    — from 08:00 UTC, one email on the day a tracked job's
 *                   follow-up falls due.
 *
 * (The `weekly_tasks` email went with the v1 weekly goals; gamification's
 * quests replaced them.) A row in `reminder_sends` is
 * claimed BEFORE sending; its unique key is what stops a second backend
 * instance (or the next hourly pass) sending the same reminder again. A failed
 * send releases the claim so the next pass retries.
 */

const INTERVAL_MS = 60 * 60 * 1000;
const MAX_USERS = 5000;
let running = false;

interface Recipient {
  id: string;
  email: string;
  full_name: string | null;
}

interface DueJob {
  user_id: string;
  title: string;
  company_name: string | null;
}

async function claim(userId: string, kind: string, periodKey: string): Promise<boolean> {
  const { error } = await getSupabase().from('reminder_sends').insert({ user_id: userId, kind, period_key: periodKey });
  if (!error) return true;
  if (error.code === '23505') return false; // already sent
  throw new Error(`reminder claim failed: ${error.message}`);
}

async function release(userId: string, kind: string, periodKey: string): Promise<void> {
  await getSupabase()
    .from('reminder_sends')
    .delete()
    .eq('user_id', userId)
    .eq('kind', kind)
    .eq('period_key', periodKey);
}

function appUrl(path: string): string {
  const base = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}${path}`;
}

function unsubscribeUrl(userId: string, apiPath: boolean): string {
  const q = `u=${encodeURIComponent(userId)}&t=${encodeURIComponent(unsubscribeToken(userId, unsubscribeSecret()))}`;
  return appUrl(apiPath ? `/api/engagement/unsubscribe?${q}` : `/unsubscribe?${q}`);
}

function buildHtml(name: string | null, sections: string[], userId: string): string {
  const hello = name?.trim() ? `Hi ${escapeHtml(name.trim().split(/\s+/)[0])},` : 'Hi,';
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f5f2;font-family:Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;">
    <tr><td>
      <p style="margin:0 0 16px;font-size:16px;">${hello}</p>
      ${sections.join('\n')}
      <p style="margin:24px 0 0;">
        <a href="${appUrl('/')}" style="display:inline-block;background:#c9a84c;color:#1a1a1a;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:8px;">Open Advance Academy</a>
      </p>
      <p style="margin:28px 0 0;font-size:12px;color:#888;">
        You get these because reminders are on for your account.
        <a href="${unsubscribeUrl(userId, false)}" style="color:#888;">Stop reminder emails</a>.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function followUpSection(jobs: DueJob[]): string {
  const items = jobs
    .map((j) => `<li>${escapeHtml(j.title)}${j.company_name ? ` — ${escapeHtml(j.company_name)}` : ''}</li>`)
    .join('');
  return `<p style="margin:0 0 8px;font-weight:bold;">Follow up today</p>
      <ul style="margin:0 0 16px;padding-left:20px;">${items}</ul>
      <p style="margin:0 0 16px;">A short, polite check-in keeps you on the recruiter's radar. Update the card in <a href="${appUrl('/jobs')}">your tracker</a> once it's sent.</p>`;
}

export async function runReminderPass(now = new Date()): Promise<void> {
  if (!isEmailSendingEnabled() || running) return;
  running = true;
  try {
    const sb = getSupabase();
    const today = utcDay(now);
    const hour = now.getUTCHours();
    if (hour < 8) return;

    const { data: users, error } = await sb
      .from('users')
      .select('id, email, full_name')
      .eq('status', 'approved')
      .eq('email_reminders', true)
      .limit(MAX_USERS);
    if (error) throw new Error(`reminder users: ${error.message}`);
    const recipients = ((users ?? []) as Recipient[]).filter((u) => u.email);
    if (recipients.length === 0) return;

    const dueByUser = new Map<string, DueJob[]>();
    const { data: due, error: dueErr } = await sb
      .from('saved_jobs')
      .select('user_id, title, company_name')
      .eq('next_follow_up_at', today)
      .not('status', 'in', `(${TERMINAL_SAVED_JOB_STATUSES.join(',')})`);
    if (dueErr) throw new Error(`reminder follow-ups: ${dueErr.message}`);
    for (const job of (due ?? []) as DueJob[]) {
      dueByUser.set(job.user_id, [...(dueByUser.get(job.user_id) ?? []), job]);
    }

    for (const user of recipients) {
      const jobs = dueByUser.get(user.id);
      if (!jobs?.length) continue;
      let claimed = false;
      // One student's bad row must not stop everyone else's reminders.
      try {
        if (!(await claim(user.id, 'follow_ups', today))) continue;
        claimed = true;
        const result = await sendEmail({
          to: user.email,
          subject: 'Follow-ups due today',
          html: buildHtml(user.full_name, [followUpSection(jobs)], user.id),
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl(user.id, true)}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        if (!result.ok) throw new Error(result.error ?? 'send failed');
      } catch (err) {
        console.warn(`[reminders] ${user.id}: ${err instanceof Error ? err.message : err}`);
        if (claimed) await release(user.id, 'follow_ups', today);
      }
    }
  } catch (err) {
    console.error('[reminders] pass failed', err);
  } finally {
    running = false;
  }
}

/**
 * Ships dark: nothing is sent until ENGAGEMENT_REMINDERS_ENABLED=true, so a dev
 * or sandbox backend pointed at real users can't email the whole cohort by
 * accident. Same stance as LEADS_CAPTURE_ENABLED.
 */
export function startEngagementReminders(): void {
  if (process.env.ENGAGEMENT_REMINDERS_ENABLED !== 'true') return;
  void runReminderPass();
  setInterval(() => void runReminderPass(), INTERVAL_MS).unref();
}
