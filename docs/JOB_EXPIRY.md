# Job expiry (migration 046)

Career Hub showed every job it had ever crawled: nothing set `jobs.is_active =
false`, and the crawler upserted `true` on every sighting. Migration 046 and the
crawler changes alongside it close jobs in two separate ways.

| | **Expired** | **Stale** |
|---|---|---|
| Meaning | The source stated a closing date and it has passed | Repeated, fully successful fetches of the same search stopped returning it |
| Sources | Reed (`expirationDate`). Adzuna states no date | Adzuna and Reed |
| Closed by | `close_expired_jobs()`, run after every crawl and on a schedule. Also on ingest, when a Reed row arrives already past its date | `close_stale_jobs()`, **a dry run by default** |
| `closed_reason` | `expired` | `stale` |
| Reopened when | A newer Reed posting states a later date | The job is seen again in any crawl |

`manual_import_xlsx` jobs (the contacts importer) are never closed by either.

Nothing on the read side changed. The `public_company_summary` view, the "Public
can read active jobs" policy and the student queries in
`features/career-hub/lib` already filter on `is_active`. One consequence: when a
company's last job closes, the company leaves `/search`, and `/companies/<slug>`
and the coach company pages return 404, because they read the same view.

## What counts as evidence for "stale"

The crawler writes two service-role-only tables:

- **`job_sightings`**: the last time each (job, source, query, location) was
  returned. Written for every job a crawl stores, so it can only ever delay a
  closure.
- **`crawl_fetches`**: one row per source fetch, written **only** when the whole
  (query, location) pair is complete. That means every source asked for
  succeeded (one failure or missing credentials writes nothing for the pair), no
  results were truncated, every returned job was stored and sighted, and nothing
  later in the pair failed or timed out. Empty fetches are written with
  `result_count = 0` so coverage gaps show up, but the SQL never counts them as
  evidence.

A job is a **stale** candidate only when all of these hold:

- it is active, from a crawled source, and has **no** stated closing date;
- it was posted more than 21 days ago and has not been seen for 14;
- **every** (source, search) it was ever seen in has since had at least 2
  non-empty completed fetches without it, the latest at least 7 days after the
  sighting.

The thresholds are parameters with safety floors. The function refuses fewer
than 2 fetches, or windows under 7 days (1 day for the span).

**Legacy** rows predate 046: they have no sightings and `last_seen_at` is null.
They are only considered with `p_include_legacy => true`, and only for a source
whose every crawled search is covered.

**Coverage** means every search in `discovery_queries` has at least 2 non-empty
completed fetches spanning at least 7 days, for every source asked about. A
non-dry run of `close_stale_jobs()` **refuses** (raises and closes nothing)
until coverage is complete for every source in `p_sources`.

## Rollout

Each step can be stopped at without harm.

1. **Staging first.** Apply `supabase/migrations/046_job_expiry.sql` in the SQL
   editor. It is idempotent and only adds columns, tables, indexes and
   functions. It depends on 023a/024 (`jobs`, `discovery_queries`), so on
   production it goes after the cutover's 023a–045.
2. Check RLS, as for every migration. This should return 0 rows:
   `select tablename from pg_tables where schemaname='public' and rowsecurity=false;`
3. **Deploy backend-python.**
   - Order matters less than usual. A crawler deployed before the migration
     logs `jobs.expires_at is missing` and ingests exactly as before.
   - The post-crawl sweep logs `close_expired_jobs skipped` until 046 exists.
   - Deploying in the other order (migration first, old crawler still running)
     is also safe: the old code simply records no evidence.
4. **Measure** before anything closes in bulk:
   ```sql
   select source, is_active, closed_reason, count(*) from jobs group by 1,2,3 order by 1,2,3;
   select count(*) from jobs where is_active and expires_at <= now();  -- next sweep closes these
   ```
5. **Explicit expiry is live** from the first crawl: Reed dates are stored, and
   past ones close on ingest and in the post-crawl sweep. To also close jobs
   when nobody is crawling, schedule the sweep. Pick one:
   - pg_cron (enable it under Database → Extensions):
     `select cron.schedule('close-expired-jobs', '7 * * * *', $$select public.close_expired_jobs()$$);`
   - a Railway cron service running `python scripts/job_expiry.py expired`.
6. **Stale stays a report.** Run it daily and read the numbers:
   ```
   python scripts/job_expiry.py coverage
   python scripts/job_expiry.py stale            # dry run: candidates, coverage, sample ids
   ```
   Coverage only grows when searches are re-crawled. Nothing re-crawls on a
   schedule yet, so until a recurring re-crawl exists, coverage completes only
   for searches coaches happen to repeat. Spot-check about 20
   `sample_job_ids` by opening their `source_url`.
7. **Enable stale closing** only once coverage is complete and the spot-checks
   hold:
   ```
   python scripts/job_expiry.py stale --apply                 # all sources
   python scripts/job_expiry.py stale --apply --source adzuna # or one covered source
   ```
   Legacy rows come last, the same way, with `--include-legacy`. Then decide
   whether to schedule it.

## Undo

- **Reopen closures:**
  `update jobs set is_active = true, closed_at = null, closed_reason = null where closed_reason = 'stale';`
  Use `'expired'` instead to reopen those, though the next sweep re-closes any
  whose date is still past.
- **Remove the feature:**
  1. Unschedule any cron job.
  2. Redeploy the previous crawler.
  3. `drop function` the five 046 functions.
  4. `drop table job_sightings, crawl_fetches`.
  5. Drop the four `jobs` columns and the `jobs_closed_reason_check` constraint.

  No other data depends on them.

## Tests

- `backend-python/test_reed_expiry.py`, `test_job_expiry_ingest.py`,
  `test_crawl_fetch_evidence.py` and `test_job_expiry_migration.py` run offline
  with the other self-checks:
  `for f in test_*.py; do .venv/bin/python $f; done`
- `supabase/tests/046_job_expiry.test.sql` exercises the SQL against a real
  Postgres. **Scratch databases only.** It refuses to run if `jobs` has rows,
  and rolls back:
  `psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/046_job_expiry.test.sql`
