import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { coverLetterSaveError } from './cover-letter.service.js';
import { mapGamificationDbError } from '../lib/gamification-errors.js';

test('a database failure on save becomes COVER_LETTER_SAVE_FAILED, exposed, with the cause kept', () => {
  // Exactly what PostgREST says when migration 047's charge_credits is missing.
  const db = mapGamificationDbError(
    { code: 'PGRST202', message: 'Could not find the function public.charge_credits(p_cost, p_user) in the schema cache' },
    'save the cover letter',
  );
  const logged = mock.method(console, 'error', () => {});
  try {
    const err = coverLetterSaveError(db) as Error & { statusCode: number; code: string; expose: boolean; cause: unknown };
    assert.equal(err.statusCode, 500);
    assert.equal(err.code, 'COVER_LETTER_SAVE_FAILED');
    assert.equal(err.expose, true);
    assert.match(err.message, /written but couldn't be saved, so no credit was used/);
    assert.equal(err.cause, db);
    // The log names the database error — and nothing from the letter or the JD.
    assert.equal(logged.mock.callCount(), 1);
    assert.match(String(logged.mock.calls[0].arguments.join(' ')), /DATABASE_ERROR.*charge_credits/);
  } finally {
    logged.mock.restore();
  }
});

test('out of credits and "not your card" keep their own status and message', () => {
  const exhausted = mapGamificationDbError({ code: 'GC001', message: 'CREDIT_EXHAUSTED' }, 'save the cover letter');
  assert.equal(coverLetterSaveError(exhausted), exhausted);
  const missing = mapGamificationDbError({ code: 'GN001', message: 'card not found for this user' }, 'save the cover letter');
  assert.equal(coverLetterSaveError(missing), missing);
});
