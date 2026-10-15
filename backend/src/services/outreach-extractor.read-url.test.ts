// readUrl: Jina Reader failures come back with a reason the Cover Letter can
// explain, inside the caller's time budget. extractTextFromUrl keeps its old
// contract for Outreach, Interview Prep and company research.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTextFromUrl, readUrl } from './outreach-extractor.service.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (init?: RequestInit) => Promise<Response>) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    return handler(init);
  }) as typeof fetch;
  return calls;
}

const jinaJson = (data: Record<string, unknown>) =>
  new Response(JSON.stringify({ code: 200, data }), { status: 200, headers: { 'content-type': 'application/json' } });

async function rejectsWithReason(p: Promise<unknown>, expected: Record<string, unknown>) {
  await assert.rejects(p, (err: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(expected)) assert.equal(err[k], v, `${k}`);
    return true;
  });
}

test('a readable page returns its text and no target status', async () => {
  stubFetch(async () => jinaJson({ title: 'Job', content: '  Data Analyst — SQL, Python  ' }));
  assert.deepEqual(await readUrl('https://jobs.example.com/1'), { content: 'Data Analyst — SQL, Python', targetStatus: null });
});

test("the site's own error status comes through from Jina's warning", async () => {
  stubFetch(async () => jinaJson({ content: 'Page not found', warning: 'Target URL returned error 404: Not Found' }));
  assert.deepEqual(await readUrl('https://jobs.example.com/1'), { content: 'Page not found', targetStatus: 404 });
});

test("Jina's own 4xx is an 'http' failure with the site's status, and is not retried", async () => {
  const calls = stubFetch(async () => new Response('{"message":"Target URL returned error 403: Forbidden"}', { status: 422 }));
  await rejectsWithReason(readUrl('https://jobs.example.com/1', { maxRetries: 3 }), { reason: 'http', status: 422, targetStatus: 403, statusCode: 500 });
  assert.equal(calls.length, 1);
});

test("a struggling reader (503) is retried, then an 'http' failure", async () => {
  const calls = stubFetch(async () => new Response('busy', { status: 503 }));
  await rejectsWithReason(readUrl('https://jobs.example.com/1', { maxRetries: 2, timeoutMs: 1000 }), { reason: 'http', status: 503 });
  assert.equal(calls.length, 2);
});

test("a slow page times out per attempt and ends as a 'timeout' failure, within the retry budget", async () => {
  const calls = stubFetch(
    (init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  );
  const started = Date.now();
  await rejectsWithReason(readUrl('https://jobs.example.com/1', { timeoutMs: 30, maxRetries: 2 }), { reason: 'timeout' });
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - started < 3000, 'two 30ms attempts and one 1s backoff');
});

test("a network error is a 'network' failure", async () => {
  stubFetch(async () => {
    throw new TypeError('fetch failed');
  });
  await rejectsWithReason(readUrl('https://jobs.example.com/1', { maxRetries: 1 }), { reason: 'network' });
});

test("an empty page is an 'empty' failure", async () => {
  stubFetch(async () => jinaJson({ title: 'x', content: '' }));
  await rejectsWithReason(readUrl('https://jobs.example.com/1'), { reason: 'empty' });
});

test('extractTextFromUrl keeps its contract: text, or a statusCode-500 error', async () => {
  stubFetch(async () => jinaJson({ content: 'Hello' }));
  assert.equal(await extractTextFromUrl('https://jobs.example.com/1'), 'Hello');
  stubFetch(async () => new Response('nope', { status: 404 }));
  await assert.rejects(extractTextFromUrl('https://jobs.example.com/1'), (err: Error & { statusCode?: number }) => {
    assert.equal(err.statusCode, 500);
    assert.match(err.message, /^Failed to extract URL: Jina API failed with status 404/);
    return true;
  });
});
