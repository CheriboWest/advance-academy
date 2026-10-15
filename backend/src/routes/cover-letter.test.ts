import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk';
import { JdError } from '../lib/cover-letter/jd.js';
import { coverLetterErrorResponse } from './cover-letter.js';

test('a JD problem goes out with its own code and recovery message, even as a 504', () => {
  const timeout = new JdError('JD_URL_TIMEOUT', 'The job page took too long to load. Paste the job description…');
  assert.deepEqual(coverLetterErrorResponse(timeout), {
    status: 504,
    body: { code: 'JD_URL_TIMEOUT', message: 'The job page took too long to load. Paste the job description…' },
    log: false,
  });
  const inaccessible = new JdError('JD_URL_INACCESSIBLE', "We couldn't open that job link: …");
  assert.equal(coverLetterErrorResponse(inaccessible).status, 422);
  assert.equal(coverLetterErrorResponse(inaccessible).body.code, 'JD_URL_INACCESSIBLE');
});

test('a too-short description is a 400 with JD_TOO_SHORT', () => {
  const r = coverLetterErrorResponse(new JdError('JD_TOO_SHORT', 'The job description is too short…'));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'JD_TOO_SHORT');
});

test('a cut-off letter says so instead of the generic 5xx text', () => {
  const err = Object.assign(new Error('The letter came back cut off. Please try again — no credit was used.'), {
    statusCode: 502,
    code: 'LLM_FAILED',
    expose: true,
  });
  assert.deepEqual(coverLetterErrorResponse(err).body, { code: 'LLM_FAILED', message: err.message });
});

test('an AI timeout is LLM_TIMEOUT (504), saying no credit was used', () => {
  const r = coverLetterErrorResponse(new APIConnectionTimeoutError());
  assert.equal(r.status, 504);
  assert.equal(r.body.code, 'LLM_TIMEOUT');
  assert.match(r.body.message, /no credit was used/);
});

test('an unexpected 5xx stays generic and is logged (no internal text leaks)', () => {
  const r = coverLetterErrorResponse(Object.assign(new Error('relation "x" does not exist'), { statusCode: 500 }));
  assert.deepEqual(r, { status: 500, body: { code: 'COVER_LETTER_FAILED', message: 'Could not write the cover letter. Please try again.' }, log: true });
});

test('credits and 4xx service errors keep their existing shape', () => {
  const credits = coverLetterErrorResponse(Object.assign(new Error('Out of credits'), { statusCode: 429, code: 'CREDIT_EXHAUSTED', scope: 'monthly' }));
  assert.deepEqual(credits, { status: 429, body: { code: 'CREDIT_EXHAUSTED', message: 'Out of credits', scope: 'monthly' }, log: false });
  const notFound = coverLetterErrorResponse(Object.assign(new Error('That job is not in your tracker.'), { statusCode: 404 }));
  assert.deepEqual(notFound.body, { code: 'NOT_FOUND', message: 'That job is not in your tracker.' });
});

// The reported bug: a full JD pasted by hand still got "Could not write the cover
// letter. Please try again." Reproduced against the real backend: Anthropic's
// errors carry `status`, not `statusCode`, so every API error the route didn't
// name fell through to that generic 500. Built the way the SDK builds them.
const GENERIC = 'Could not write the cover letter. Please try again.';
function anthropicError(status: number, type: string, message: string) {
  return APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers({ 'request-id': 'req_test' }));
}

test('Anthropic 400 "credit balance too low" is LLM_REJECTED with a useful message, not the generic text', () => {
  const r = coverLetterErrorResponse(
    anthropicError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'),
  );
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'LLM_REJECTED');
  assert.notEqual(r.body.message, GENERIC);
  assert.match(r.body.message, /problem on our side, not with your CV or job description — no credit was used/);
  assert.equal(r.log, true, 'the real cause must reach the server log');
});

test('Anthropic 404 (model not found) is LLM_REJECTED too', () => {
  const r = coverLetterErrorResponse(anthropicError(404, 'not_found_error', 'model: claude-haiku-4-5'));
  assert.equal(r.body.code, 'LLM_REJECTED');
  assert.notEqual(r.body.message, GENERIC);
});

test('Anthropic 403 (key without access) is LLM_UNAVAILABLE', () => {
  const r = coverLetterErrorResponse(anthropicError(403, 'permission_error', 'Your API key does not have permission.'));
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'LLM_UNAVAILABLE');
});

test('Anthropic overload keeps its own message (unchanged)', () => {
  const r = coverLetterErrorResponse(anthropicError(529, 'overloaded_error', 'Overloaded'));
  assert.deepEqual(r.body, { code: 'LLM_BUSY', message: 'The writing service is busy. Try again in a minute.' });
});

test('a failed save after the letter was written says so, and is logged', () => {
  const err = Object.assign(new Error("Your letter was written but couldn't be saved, so no credit was used."), {
    statusCode: 500,
    code: 'COVER_LETTER_SAVE_FAILED',
    expose: true,
  });
  const r = coverLetterErrorResponse(err);
  assert.deepEqual(r, { status: 500, body: { code: 'COVER_LETTER_SAVE_FAILED', message: err.message }, log: true });
});
