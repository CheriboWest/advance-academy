import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterLiveJobs } from './job-liveness.js';
import type { ExaJobListing } from '@advance-academy/contracts/dream-company';

const realFetch = globalThis.fetch;

/** Mock fetch: map url → {status, finalUrl?}. Returns a duck-typed response. */
function mockFetch(map: Record<string, { status: number; finalUrl?: string }>): void {
  globalThis.fetch = (async (url: string | URL) => {
    const key = String(url);
    const entry = map[key] ?? { status: 200 };
    return { status: entry.status, url: entry.finalUrl ?? key } as Response;
  }) as typeof fetch;
}

function job(url: string): ExaJobListing {
  return { title: url, url, snippet: '' };
}

test('filterLiveJobs: drops 404/410/5xx, keeps 200/3xx/405 (fail-open)', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  mockFetch({
    'https://reed.co.uk/live': { status: 200 },
    'https://reed.co.uk/gone': { status: 404 },
    'https://reed.co.uk/expired': { status: 410 },
    'https://reed.co.uk/boom': { status: 503 }, // 5xx now dropped
    'https://reed.co.uk/method': { status: 405 }, // HEAD not allowed → keep
  });
  const jobs = ['live', 'gone', 'expired', 'boom', 'method'].map((s) => job(`https://reed.co.uk/${s}`));
  const res = await filterLiveJobs(jobs, { timeoutMs: 1000 });
  assert.deepEqual(res.live.map((j) => j.url), ['https://reed.co.uk/live', 'https://reed.co.uk/method']);
  assert.equal(res.checked, 5);
  assert.equal(res.dropped, 3);
});

test('filterLiveJobs: Adzuna URLs are SKIPPED (kept, not fetched, not counted)', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  let fetched = 0;
  globalThis.fetch = (async (url: string | URL) => {
    fetched++;
    // Even if Adzuna "looked" 404, it must be kept because we skip it entirely.
    return { status: 404, url: String(url) } as Response;
  }) as typeof fetch;
  const jobs = [job('https://www.adzuna.co.uk/jobs/land/ad/123'), job('https://www.adzuna.co.uk/jobs/details/9')];
  const res = await filterLiveJobs(jobs, { timeoutMs: 1000 });
  assert.equal(res.live.length, 2); // both kept
  assert.equal(res.checked, 0); // none actually fetched-counted
  assert.equal(fetched, 0); // never even called fetch for adzuna
});

test('filterLiveJobs: drops when final (redirected) URL signals expired', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  mockFetch({
    'https://reed.co.uk/jobs/x/1': { status: 200, finalUrl: 'https://reed.co.uk/jobs/expired' },
    'https://reed.co.uk/jobs/x/2': { status: 200, finalUrl: 'https://reed.co.uk/jobs/x/2' },
  });
  const jobs = [job('https://reed.co.uk/jobs/x/1'), job('https://reed.co.uk/jobs/x/2')];
  const res = await filterLiveJobs(jobs, { timeoutMs: 1000 });
  assert.deepEqual(res.live.map((j) => j.url), ['https://reed.co.uk/jobs/x/2']);
});

test('filterLiveJobs: network error / timeout is fail-open (job kept)', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = (async () => {
    throw new Error('ETIMEDOUT');
  }) as typeof fetch;
  const res = await filterLiveJobs([job('https://reed.co.uk/unknown')], { timeoutMs: 1000 });
  assert.equal(res.live.length, 1);
  assert.equal(res.dropped, 0);
});

test('filterLiveJobs: empty input short-circuits', async () => {
  const res = await filterLiveJobs([], { timeoutMs: 1000 });
  assert.deepEqual(res, { live: [], checked: 0, dropped: 0 });
});
