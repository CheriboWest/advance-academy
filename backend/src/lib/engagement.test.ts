import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, unsubscribeToken, verifyUnsubscribeToken } from './engagement.js';

test('unsubscribe token: verifies for its own user only', () => {
  const t = unsubscribeToken('user-a', 'secret');
  assert.equal(verifyUnsubscribeToken('user-a', t, 'secret'), true);
  assert.equal(verifyUnsubscribeToken('user-b', t, 'secret'), false);
  assert.equal(verifyUnsubscribeToken('user-a', t, 'other-secret'), false);
  assert.equal(verifyUnsubscribeToken('user-a', 'short', 'secret'), false);
});

test('escapeHtml: neutralises markup from job titles and names', () => {
  assert.equal(escapeHtml('<b>"A&B"</b>'), '&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
});
