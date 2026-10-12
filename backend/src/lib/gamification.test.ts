import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysIso,
  currentStreak,
  isValidIsoDay,
  isValidTimezone,
  localDay,
  mondayOf,
  timezoneChangeableAt,
  toJourney,
  validateGoalsPatch,
  validateSeenKeys,
  validateSkipReason,
} from './gamification.js';
import { mapGamificationDbError } from './gamification-errors.js';
import { isGamificationV2Enabled } from '../config/features.js';

test('localDay: the local date, not the UTC one', () => {
  const lateUtc = new Date('2026-10-11T23:30:00Z');
  assert.equal(localDay('Europe/London', lateUtc), '2026-10-12'); // BST, UTC+1
  assert.equal(localDay('America/New_York', lateUtc), '2026-10-11');
  assert.equal(localDay('Asia/Ho_Chi_Minh', new Date('2026-10-11T17:30:00Z')), '2026-10-12');
});

test('mondayOf / addDaysIso: Monday-start weeks across a month end', () => {
  assert.equal(mondayOf('2026-10-11'), '2026-10-05'); // Sunday
  assert.equal(mondayOf('2026-10-12'), '2026-10-12'); // Monday
  assert.equal(mondayOf('2026-11-01'), '2026-10-26');
  assert.equal(addDaysIso('2026-10-31', 1), '2026-11-01');
  assert.equal(addDaysIso('2026-03-01', -1), '2026-02-28');
});

test('currentStreak: counts active days, rest days bridge but do not count', () => {
  const rows = [
    { day: '2026-10-11', kind: 'active' as const },
    { day: '2026-10-10', kind: 'rest' as const },
    { day: '2026-10-09', kind: 'active' as const },
    { day: '2026-10-08', kind: 'active' as const },
    // gap on the 7th
    { day: '2026-10-06', kind: 'active' as const },
  ];
  assert.deepEqual(currentStreak(rows, '2026-10-11'), { current: 3, activeToday: true });
});

test('currentStreak: today not done yet keeps yesterday\'s streak alive', () => {
  const rows = [
    { day: '2026-10-10', kind: 'active' as const },
    { day: '2026-10-09', kind: 'active' as const },
  ];
  assert.deepEqual(currentStreak(rows, '2026-10-11'), { current: 2, activeToday: false });
  assert.deepEqual(currentStreak(rows, '2026-10-12'), { current: 0, activeToday: false });
  assert.deepEqual(currentStreak([], '2026-10-12'), { current: 0, activeToday: false });
});

test('currentStreak: a rest day booked for today holds the streak', () => {
  const rows = [
    { day: '2026-10-11', kind: 'rest' as const },
    { day: '2026-10-10', kind: 'active' as const },
  ];
  assert.deepEqual(currentStreak(rows, '2026-10-11'), { current: 1, activeToday: false });
});

test('timezoneChangeableAt: null when never changed or more than a day ago', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  assert.equal(timezoneChangeableAt(null, now), null);
  assert.equal(timezoneChangeableAt('2026-10-10T11:00:00Z', now), null);
  assert.equal(timezoneChangeableAt('2026-10-11T09:00:00Z', now), '2026-10-12T09:00:00.000Z');
});

test('toJourney: follow-ups count as applied, rejected cards drop out', () => {
  assert.deepEqual(toJourney(['saved', 'saved', 'preparing', 'applied', 'follow_up', 'interview', 'offer', 'rejected']), {
    saved: 2, preparing: 1, applied: 2, interview: 1, offer: 1,
  });
});

test('isValidIsoDay / isValidTimezone', () => {
  assert.equal(isValidIsoDay('2026-10-11'), true);
  assert.equal(isValidIsoDay('2026-02-30'), false);
  assert.equal(isValidIsoDay('11/10/2026'), false);
  assert.equal(isValidIsoDay(20261011), false);
  assert.equal(isValidTimezone('Europe/London'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
  assert.equal(isValidTimezone(''), false);
});

test('validateGoalsPatch: accepts known values, rejects unknown and empty patches', () => {
  assert.deepEqual(validateGoalsPatch({ intensity: 'light', goalType: null }), { ok: true, value: { intensity: 'light', goalType: null } });
  assert.deepEqual(validateGoalsPatch({ timezone: 'Asia/Ho_Chi_Minh', timeline: 'asap', goalType: 'visa_sponsored' }), {
    ok: true,
    value: { timezone: 'Asia/Ho_Chi_Minh', timeline: 'asap', goalType: 'visa_sponsored' },
  });
  assert.equal(validateGoalsPatch({ intensity: 'heroic' }).ok, false);
  assert.equal(validateGoalsPatch({ timezone: 'Mars/Olympus' }).ok, false);
  assert.equal(validateGoalsPatch({ goalType: 'astronaut' }).ok, false);
  assert.equal(validateGoalsPatch({}).ok, false);
  assert.equal(validateGoalsPatch([]).ok, false);
  assert.equal(validateGoalsPatch(null).ok, false);
});

test('validateSeenKeys: 1–20 snake_case keys, de-duplicated', () => {
  assert.deepEqual(validateSeenKeys({ keys: ['first_shot', 'first_shot', 'on_a_roll'] }), { ok: true, value: ['first_shot', 'on_a_roll'] });
  assert.equal(validateSeenKeys({ keys: [] }).ok, false);
  assert.equal(validateSeenKeys({ keys: ["x'; drop"] }).ok, false);
  assert.equal(validateSeenKeys({}).ok, false);
});

test('validateSkipReason: at least 10 characters after trimming', () => {
  assert.deepEqual(validateSkipReason({ reason: '  corrupt snapshot  ' }), { ok: true, value: 'corrupt snapshot' });
  assert.equal(validateSkipReason({ reason: '   short   ' }).ok, false);
  assert.equal(validateSkipReason({}).ok, false);
});

test('mapGamificationDbError: 047 SQLSTATEs become the HTTP errors routes understand', () => {
  const c = mapGamificationDbError({ code: 'GC001', message: 'CREDIT_EXHAUSTED' }, 'x');
  assert.equal(c.statusCode, 429);
  assert.equal(c.code, 'CREDIT_EXHAUSTED');
  assert.equal(mapGamificationDbError({ code: 'GN001' }, 'x').statusCode, 404);
  assert.equal(mapGamificationDbError({ code: 'GN002' }, 'x').statusCode, 409);
  for (const code of ['GX001', 'GX002', 'GX006', '42501']) {
    const e = mapGamificationDbError({ code, message: 'boom' }, 'save');
    assert.equal(e.statusCode, 500, code);
    assert.equal(e.code, 'GAMIFICATION_INVARIANT', code);
  }
  // A missing policy must never look like an empty wallet.
  assert.notEqual(mapGamificationDbError({ code: 'GX001' }, 'x').code, 'CREDIT_EXHAUSTED');
  assert.equal(mapGamificationDbError({ code: '23505' }, 'x').statusCode, 500);
});

test('isGamificationV2Enabled: off unless exactly "true"', () => {
  const saved = process.env.GAMIFICATION_V2_ENABLED;
  try {
    for (const [value, want] of [[undefined, false], ['', false], ['1', false], ['yes', false], ['true', true], [' TRUE ', true]] as const) {
      if (value === undefined) delete process.env.GAMIFICATION_V2_ENABLED;
      else process.env.GAMIFICATION_V2_ENABLED = value;
      assert.equal(isGamificationV2Enabled(), want, String(value));
    }
  } finally {
    if (saved === undefined) delete process.env.GAMIFICATION_V2_ENABLED;
    else process.env.GAMIFICATION_V2_ENABLED = saved;
  }
});
