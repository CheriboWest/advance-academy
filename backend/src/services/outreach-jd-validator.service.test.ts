/**
 * Tests for the JD validator's response interpreter (AAT-16).
 *
 * Uses Node's built-in test runner — no external test framework, and the file is
 * named `*.spec.ts` so `tsconfig.build.json` excludes it from the Railway build.
 *
 * Run (once deps are installed):  npx tsx --test "src/**\/*.spec.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretJdValidation, JD_PARSE_FAILURE_REASON } from './outreach-jd-validator.service.js';

const EXCERPT = 'Senior Frontend Engineer — build delightful UIs with React and TypeScript. '.repeat(40);

test('parse failure: no JSON object → invalid JD with a clear reason (not raw junk)', () => {
  const result = interpretJdValidation('Sorry, I cannot help with that.', EXCERPT);
  assert.equal(result.valid, false);
  assert.equal(result.reason, JD_PARSE_FAILURE_REASON);
  assert.equal(result.jdText, undefined); // must NOT leak the heuristic slice
});

test('parse failure: malformed JSON → invalid JD with a clear reason', () => {
  const result = interpretJdValidation('{ "isJobDescription": true, "extractedJd": ', EXCERPT);
  assert.equal(result.valid, false);
  assert.equal(result.reason, JD_PARSE_FAILURE_REASON);
  assert.equal(result.jdText, undefined);
});

test('valid JD: uses the LLM-extracted text', () => {
  const raw = JSON.stringify({
    isJobDescription: true,
    reason: 'Looks like a job posting.',
    extractedJd: 'Frontend Engineer at Acme. Build React apps.',
  });
  const result = interpretJdValidation(raw, EXCERPT);
  assert.equal(result.valid, true);
  assert.equal(result.jdText, 'Frontend Engineer at Acme. Build React apps.');
});

test('valid JD with empty extraction: falls back to the heuristic slice', () => {
  const raw = JSON.stringify({ isJobDescription: true, reason: 'ok', extractedJd: '   ' });
  const result = interpretJdValidation(raw, EXCERPT);
  assert.equal(result.valid, true);
  assert.equal(result.jdText, EXCERPT.slice(0, 1500));
});

test('explicit non-JD verdict: invalid with the LLM reason preserved', () => {
  const raw = JSON.stringify({ isJobDescription: false, reason: 'This is a news article.', extractedJd: null });
  const result = interpretJdValidation(raw, EXCERPT);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'This is a news article.');
});

test('JSON embedded in prose is still extracted', () => {
  const raw = 'Here is the result:\n{ "isJobDescription": true, "extractedJd": "QA Engineer role." }\nHope it helps!';
  const result = interpretJdValidation(raw, EXCERPT);
  assert.equal(result.valid, true);
  assert.equal(result.jdText, 'QA Engineer role.');
});
