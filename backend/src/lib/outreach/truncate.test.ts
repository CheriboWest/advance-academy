/**
 * Tests for the LinkedIn word-boundary truncation (AAT-19).
 *
 * Uses Node's built-in test runner — no external framework, and the `*.spec.ts`
 * name keeps the file out of the Railway build (tsconfig.build.json excludes it).
 *
 * Run (once deps are installed):  npx tsx --test "src/**\/*.spec.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateLinkedInMessage, LINKEDIN_MAX_CHARS } from './truncate.js';

test('short message: returned unchanged (trimmed)', () => {
  assert.equal(truncateLinkedInMessage('  Hi there, nice to connect!  '), 'Hi there, nice to connect!');
});

test('message exactly at the limit: not truncated', () => {
  const exact = 'a'.repeat(LINKEDIN_MAX_CHARS);
  assert.equal(truncateLinkedInMessage(exact), exact);
});

test('over-limit message: stays within the character limit', () => {
  const long = 'alpha '.repeat(100); // 600 chars
  const result = truncateLinkedInMessage(long);
  assert.ok(result.length <= LINKEDIN_MAX_CHARS, `length ${result.length} > ${LINKEDIN_MAX_CHARS}`);
});

test('over-limit message: never splits a word', () => {
  const long = 'alpha '.repeat(100);
  const result = truncateLinkedInMessage(long);
  // Strip the trailing ellipsis; every remaining token must be a whole "alpha".
  const words = result.replace(/…$/, '').trim().split(' ');
  assert.ok(words.every((w) => w === 'alpha'), `found a split word: ${JSON.stringify(words)}`);
  assert.ok(result.endsWith('…'));
});

test('real-world sentence: cuts on a word boundary, no partial trailing word', () => {
  const msg =
    'I noticed your team just shipped the new analytics dashboard and I would love to bring my data engineering experience to help scale it across more enterprise customers over the coming quarters as you continue expanding the platform internationally and beyond.'.repeat(2);
  const result = truncateLinkedInMessage(msg);
  assert.ok(result.length <= LINKEDIN_MAX_CHARS);
  // The character right before the ellipsis must not be mid-word boundary garbage:
  // the body (sans ellipsis) must equal a clean prefix of the original on a space boundary.
  const body = result.replace(/…$/, '');
  assert.ok(msg.startsWith(body), 'truncated body is not a prefix of the original');
  assert.ok(!body.endsWith(' '), 'body should be trimmed of trailing space');
  // The original char immediately after the body is a space → cut on a clean word boundary.
  assert.equal(msg[body.length], ' ');
});

test('spaceless over-long token: falls back to a hard cut, still within limit', () => {
  const blob = 'x'.repeat(400);
  const result = truncateLinkedInMessage(blob);
  assert.ok(result.length <= LINKEDIN_MAX_CHARS);
  assert.ok(result.endsWith('…'));
});
