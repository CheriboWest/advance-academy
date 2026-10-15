import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APIConnectionTimeoutError } from '@anthropic-ai/sdk';
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
