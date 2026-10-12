import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * Gamification v2 end to end: the real services, through supabase-js and
 * PostgREST, against a database with migration 047. LOCAL SCRATCH ONLY.
 *
 * Skipped unless both are set (so `npm test` stays offline):
 *   GAMIFICATION_IT_SUPABASE_URL   a local Supabase-style URL serving /rest/v1
 *                                  (`supabase start`, or PostgREST behind a
 *                                  proxy) — anything not on localhost is refused
 *   GAMIFICATION_IT_SERVICE_KEY    a service_role JWT for it
 *
 * Build the database with supabase/tests/run_local.sh. The test creates its own
 * users and deletes them (and, by cascade, everything they own) at the end.
 */

const url = process.env.GAMIFICATION_IT_SUPABASE_URL?.trim();
const key = process.env.GAMIFICATION_IT_SERVICE_KEY?.trim();
const skip = !url || !key ? 'set GAMIFICATION_IT_SUPABASE_URL and GAMIFICATION_IT_SERVICE_KEY to run' : false;

if (url && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) {
  throw new Error(`refusing to run against ${url}: local scratch databases only`);
}

const U = randomUUID();
const OTHER = randomUUID();
const ADMINLESS = randomUUID();

// Loaded after the env points at the scratch database (getSupabase caches its client).
let m: {
  sb: typeof import('../lib/supabase.js');
  jobs: typeof import('./job-tracking.service.js');
  gam: typeof import('./gamification.service.js');
  letter: typeof import('./cover-letter.service.js');
  engagement: typeof import('./engagement.service.js');
  interviewDb: typeof import('../lib/interview-prep/db.js');
};

before(async () => {
  if (skip) return;
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  process.env.GAMIFICATION_V2_ENABLED = 'true';
  m = {
    sb: await import('../lib/supabase.js'),
    jobs: await import('./job-tracking.service.js'),
    gam: await import('./gamification.service.js'),
    letter: await import('./cover-letter.service.js'),
    engagement: await import('./engagement.service.js'),
    interviewDb: await import('../lib/interview-prep/db.js'),
  };
  const { error } = await m.sb.getSupabase().from('users').insert([
    { id: U, email: `it-${U}@test.local`, credit_balance: 1, status: 'approved' },
    { id: OTHER, email: `it-${OTHER}@test.local`, credit_balance: 0, status: 'approved' },
    { id: ADMINLESS, email: `it-${ADMINLESS}@test.local`, credit_balance: 0, status: 'approved' },
  ]);
  assert.equal(error, null, error?.message);
});

after(async () => {
  if (skip || !m) return;
  await m.sb.getSupabase().from('users').delete().in('id', [U, OTHER, ADMINLESS]);
});

const db = () => m.sb.getSupabase();

let cardId = '';

test('create_saved_job: card, its event and the save intent land together', { skip }, async () => {
  const job = await m.jobs.createSavedJob(U, { title: 'Analyst', jobUrl: 'https://it.example/jobs/1', source: 'career_hub' });
  cardId = job.id;
  assert.equal(job.status, 'saved');
  assert.equal(job.title, 'Analyst');
  const events = await db().from('job_events').select('to_status').eq('job_id', job.id);
  assert.deepEqual(events.data, [{ to_status: 'saved' }]);
  const intents = await db().from('reward_intents').select('kind').eq('user_id', U);
  assert.deepEqual(intents.data, [{ kind: 'job_saved' }]);
});

test('create_saved_job: the same link again is a 409 with the existing card', { skip }, async () => {
  await assert.rejects(m.jobs.createSavedJob(U, { title: 'Again', jobUrl: 'https://it.example/jobs/1/' }), (e: unknown) => {
    assert.equal((e as { statusCode?: number }).statusCode, 409);
    assert.equal((e as { jobId?: string }).jobId, cardId);
    return true;
  });
});

test('change_job_status: applied stamps applied_at; the same status is a no-op; another user gets null', { skip }, async () => {
  const applied = await m.jobs.changeJobStatus(U, cardId, { status: 'applied' });
  assert.equal(applied?.status, 'applied');
  assert.ok(applied?.appliedAt);
  const again = await m.jobs.changeJobStatus(U, cardId, { status: 'applied' });
  assert.equal(again?.status, 'applied');
  const events = await db().from('job_events').select('to_status').eq('job_id', cardId).eq('to_status', 'applied');
  assert.equal(events.data?.length, 1);
  assert.equal(await m.jobs.changeJobStatus(OTHER, cardId, { status: 'offer' }), null);
  assert.equal(await m.jobs.changeJobStatus(U, randomUUID(), { status: 'offer' }), null);
});

test('summary: quests assigned, intents judged, XP/coins/achievements/journey read back', { skip }, async () => {
  const s = await m.gam.getGamificationSummary(U);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.quests.map((q) => q.key), ['practice_answer', 'save_jobs', 'tailor_cv']);
  // save +2 and a quick application +5 (no tailored CV).
  assert.equal(s.xp.total, 7);
  assert.equal(s.xp.thisWeek, 7);
  assert.equal(s.xp.weeklyTarget, 80);
  assert.equal(s.coins, 10);
  assert.deepEqual(s.achievements.map((a) => a.key), ['first_shot']);
  assert.equal(s.streak.current, 1);
  assert.equal(s.streak.activeToday, true);
  assert.equal(s.journey.applied, 1);
  assert.equal(s.pendingRewards, 0);
  // Reading again awards nothing new.
  const again = await m.gam.getGamificationSummary(U);
  assert.equal(again.xp.total, 7);
  assert.equal(again.coins, 10);
});

test('cover letter v2: charge and write in one call; out of credits is a 429; a foreign card a 404', { skip }, async () => {
  const card = await m.jobs.createSavedJob(U, { title: 'Letter job', jobUrl: 'https://it.example/jobs/2' });
  await m.letter.chargeAndSaveCoverLetter(U, card.id, 'Dear hiring manager', null);
  const row = await db().from('saved_jobs').select('status, cover_letter_text').eq('id', card.id).single();
  assert.deepEqual(row.data, { status: 'preparing', cover_letter_text: 'Dear hiring manager' });
  const user = await db().from('users').select('credit_balance, first_tool_used_at').eq('id', U).single();
  assert.equal(user.data?.credit_balance, 0);
  assert.ok(user.data?.first_tool_used_at);

  await assert.rejects(m.letter.chargeAndSaveCoverLetter(U, card.id, 'Second', null), (e: unknown) => {
    const err = e as { statusCode?: number; code?: string; scope?: string };
    assert.equal(err.statusCode, 429);
    assert.equal(err.code, 'CREDIT_EXHAUSTED');
    assert.equal(err.scope, 'Cover Letter');
    return true;
  });
  const unchanged = await db().from('saved_jobs').select('cover_letter_text').eq('id', card.id).single();
  assert.equal(unchanged.data?.cover_letter_text, 'Dear hiring manager');

  await db().from('users').update({ credit_balance: 5 }).eq('id', OTHER);
  await assert.rejects(m.letter.chargeAndSaveCoverLetter(OTHER, card.id, 'Not yours', null), (e: unknown) => {
    assert.equal((e as { statusCode?: number }).statusCode, 404);
    return true;
  });
  const other = await db().from('users').select('credit_balance').eq('id', OTHER).single();
  assert.equal(other.data?.credit_balance, 5, 'a refused letter charges nothing');
});

test('goals: saved; a second timezone change within a day is a 409; an unknown zone a 400', { skip }, async () => {
  const goals = await m.gam.updateGamificationGoals(U, { timezone: 'Asia/Ho_Chi_Minh', intensity: 'light' });
  assert.equal(goals.timezone, 'Asia/Ho_Chi_Minh');
  assert.equal(goals.intensity, 'light');
  assert.ok(goals.timezoneChangeableAt);
  await assert.rejects(m.gam.updateGamificationGoals(U, { timezone: 'Europe/London' }), (e: unknown) => {
    assert.equal((e as { code?: string }).code, 'TIMEZONE_CHANGE_TOO_SOON');
    return true;
  });
  const intensity = await m.gam.updateGamificationGoals(U, { intensity: 'intensive' });
  assert.equal(intensity.intensity, 'intensive');
  await assert.rejects(m.gam.updateGamificationGoals(OTHER, { timezone: 'Mars/Olympus' }), (e: unknown) => {
    assert.equal((e as { statusCode?: number }).statusCode, 400);
    return true;
  });
});

test('rest days: book today, not twice', { skip }, async () => {
  const today = (await m.gam.getGamificationSummary(U)).today;
  assert.equal(await m.gam.bookRestDay(OTHER, (await m.gam.getGamificationSummary(OTHER)).today), 1);
  await assert.rejects(m.gam.bookRestDay(U, today), (e: unknown) => {
    // U was active today, so today is already in the streak.
    assert.equal((e as { statusCode?: number }).statusCode, 409);
    return true;
  });
});

test('achievements seen, coin history', { skip }, async () => {
  await m.gam.markAchievementsSeen(U, ['first_shot']);
  const s = await m.gam.getGamificationSummary(U);
  assert.ok(s.achievements.find((a) => a.key === 'first_shot')?.seenAt);
  const coins = await m.gam.getCoinHistory(U);
  assert.equal(coins.balance, 10);
  assert.deepEqual(coins.transactions.map((t) => `${t.reason}:${t.reference}:${t.delta}`), ['achievement:first_shot:10']);
});

test('admin skip: a non-admin actor is refused by the database', { skip }, async () => {
  assert.deepEqual(await m.gam.listStuckIntents(), []);
  await assert.rejects(m.gam.skipRewardIntent(ADMINLESS, 1, 'not an admin at all'), (e: unknown) => {
    assert.equal((e as { statusCode?: number }).statusCode, 403);
    return true;
  });
});

test('engagement with v2 on reads but never writes the points ledger', { skip }, async () => {
  await m.engagement.getEngagement(U);
  const ledger = await db().from('points_ledger').select('points').eq('user_id', U);
  assert.deepEqual(ledger.data, []);
});

test('interview sessions: only the owner passes the ownership check', { skip }, async () => {
  const session = await db().from('interview_sessions').insert({ user_id: U, persona_id: 'mentor' }).select('id').single();
  assert.equal(await m.interviewDb.dbSessionBelongsToUser(session.data!.id, U), true);
  assert.equal(await m.interviewDb.dbSessionBelongsToUser(session.data!.id, OTHER), false);
  assert.equal(await m.interviewDb.dbSessionBelongsToUser(session.data!.id, undefined), false);
  assert.equal(await m.interviewDb.dbGetSession(session.data!.id, OTHER), null);
  assert.ok(await m.interviewDb.dbGetSession(session.data!.id, U));
});
