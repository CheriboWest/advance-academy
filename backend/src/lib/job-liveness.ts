/**
 * Liveness check for job URLs (Issue 2) — STATUS-ONLY, no body scraping.
 *
 * Layered defence (per PM decision): freshness (≤7d) is the PRIMARY shield against
 * "no longer available"; Reed's expirationDate is a second structural signal; this check
 * is the third, cheap, status-only layer. We deliberately do NOT download/parse page
 * bodies (slow, fragile, per-site markers, Adzuna bot-blocks) — that content-scan is
 * DEFERRED (see AC9) until measured necessary.
 *
 * Rules:
 *   - DROP on an unambiguous "gone" status: 404, 410, or any 5xx.
 *   - DROP if, after following redirects, the final URL path clearly signals an expired
 *     posting (e.g. ".../expired", ".../job-not-found"). Conservative token list only.
 *   - SKIP Adzuna redirect URLs entirely — they return 200 from Adzuna's redirector even
 *     for closed jobs AND block bots (403); checking them yields false signals. Rely on
 *     freshness for Adzuna instead. They are KEPT, never dropped, never fetched.
 *   - FAIL-OPEN on timeout / network error / any other status (keep the job + it counts
 *     as unchecked): a false drop hides a real vacancy.
 */
import type { ExaJobListing } from '@advance-academy/contracts/dream-company';

export interface LivenessOptions {
  timeoutMs: number;
  concurrency?: number;
}

export interface LivenessResult {
  live: ExaJobListing[];
  /** How many URLs were actually HTTP-checked (excludes skipped Adzuna links). */
  checked: number;
  dropped: number;
}

/** Adzuna redirector URLs — skip (bot-blocked + always-200); rely on freshness. */
function isSkippableHost(url: string): boolean {
  try {
    return /(^|\.)adzuna\./i.test(new URL(url).host);
  } catch {
    return false;
  }
}

// Tokens in a FINAL (post-redirect) URL path that signal a dead posting. Conservative.
const EXPIRED_PATH_RE = /(expired|no-longer-available|job-not-found|not-found|jobnotfound|removed)/i;

type CheckOutcome = 'dead' | 'alive' | 'skipped';

/** Status-only liveness for one URL. Never throws. */
async function checkUrl(url: string, timeoutMs: number): Promise<CheckOutcome> {
  if (!url) return 'skipped';
  if (isSkippableHost(url)) return 'skipped';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    const status = (res as { status?: number }).status ?? 0;
    if (status === 404 || status === 410 || (status >= 500 && status <= 599)) return 'dead';
    const finalUrl = (res as { url?: string }).url ?? '';
    if (finalUrl && EXPIRED_PATH_RE.test(finalUrl)) return 'dead';
    return 'alive';
  } catch {
    return 'alive'; // timeout / network error → fail-open (keep)
  } finally {
    clearTimeout(timer);
  }
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Drop only jobs whose URL is definitively dead. Fail-open on any uncertainty. */
export async function filterLiveJobs(jobs: ExaJobListing[], opts: LivenessOptions): Promise<LivenessResult> {
  if (jobs.length === 0) return { live: [], checked: 0, dropped: 0 };
  const concurrency = opts.concurrency ?? 8;
  const outcomes = await mapLimit(jobs, concurrency, (job) => checkUrl(job.url, opts.timeoutMs));
  const live = jobs.filter((_, i) => outcomes[i] !== 'dead');
  return {
    live,
    checked: outcomes.filter((o) => o !== 'skipped').length,
    dropped: jobs.length - live.length,
  };
}
