import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowlistedAdmin } from './admin.js';

test('isAllowlistedAdmin: exact ids from ADMIN_USER_IDS, spaces trimmed, empty means nobody', () => {
  const saved = process.env.ADMIN_USER_IDS;
  try {
    process.env.ADMIN_USER_IDS = ' coach-a , coach-b ';
    assert.equal(isAllowlistedAdmin('coach-a'), true);
    assert.equal(isAllowlistedAdmin('coach-b'), true);
    assert.equal(isAllowlistedAdmin('coach'), false);
    process.env.ADMIN_USER_IDS = '';
    assert.equal(isAllowlistedAdmin(''), false);
  } finally {
    if (saved === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = saved;
  }
});
