# backend-python — Career Hub API (FastAPI, port 8000)

career-hub's service, kept in Python on purpose — don't port it to Fastify.
Endpoint-by-endpoint reference (sponsor register, crawler, deletion) is `README.md`.

- **Reached only through** the Next.js rewrite `/api/careerhub/*` (browser) or
  directly from server code — see `features/career-hub/CLAUDE.md`.
- **Auth** (`app/auth.py`): Supabase JWTs verified against the project JWKS — the
  project must sign with asymmetric keys (ES256); HS256 tokens fail with 401. A 401
  "Unknown token signing key" / "Invalid token issuer" means this service points at a
  different Supabase project than the frontend. Coach routes also require
  `users.is_admin`.
- **Job crawler** (`/discover/*`, `app/crawler/`) is not a scraper: it calls the
  Adzuna and Reed APIs over `httpx` (`ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `REED_API_KEY`)
  as an in-process FastAPI background task, writing `crawl_runs`,
  `discovery_queries`, `companies`, `jobs`. A restart mid-run kills it
  ("The crawl was interrupted").
- **Contacts**: one table, `contacts` (migration 034, service-role only). Coaches use
  `/contacts` and `/contacts/directory` here (UI `/coach/contacts`); students on
  Membership get a reduced shape (no phone/notes) from Fastify
  `routes/company-contacts.ts`. The category (HR, recruiter…) is derived from
  `job_title` by `contactCategory` in `packages/contracts/src/contacts.ts`, never stored.
- **Sectors**: `companies.sector` is written only by `app/companies/sector.py`
  (backfill `scripts/classify_sectors.py`). Its list must match `SECTOR_OPTIONS` in
  `features/career-hub/lib/filters.ts` — `test_sector.py` checks.
- **Scripts write production** (`scripts/import_sponsor_register.py`,
  `resolve_sponsorship.py`, `classify_sectors.py` use `.env` = prod Supabase and paid
  LLM calls). Run them only when the user asks.

## Job expiry (migration 046, `scripts/job_expiry.py`)

Full rollout and undo steps: `git show 062d0e5:docs/JOB_EXPIRY.md`.

- Closing a job = `is_active = false` plus `closed_reason`. The
  `public_company_summary` view and the jobs RLS policy also hide a job whose
  `expires_at` has passed (migration 048), so it vanishes before it is closed.
  A company whose last job closes stays listed with `open_jobs = 0`.
- `expired`: Reed's stated `expires_at` has passed — closed on ingest, after every
  crawl, and hourly by pg_cron (`close-expired-jobs`, migration 048). Adzuna states
  no date.
  `stale`: repeated, fully successful fetches stopped returning it —
  `close_stale_jobs()` is a **dry run by default** and refuses to apply until every
  search has coverage (≥2 non-empty completed fetches over ≥7 days). Rows from
  `manual_import_xlsx` are never closed.
- Evidence tables: `job_sightings` (every stored job; can only delay a closure) and
  `crawl_fetches` — written **only** when the whole (query, location) pair succeeded
  with nothing truncated or failed. Never relax that rule.
- The crawler upserts jobs **one request per column set** (PostgREST rejects mixed
  keys), and a source without a date must never null Reed's `expires_at`.
- `scripts/job_expiry.py`: `coverage` and `stale` (dry run) only report; `expired`
  and `stale --apply` close jobs **on production**. Reopen stale closures with
  `update jobs set is_active = true, closed_at = null, closed_reason = null where closed_reason = 'stale';`

## Tests

- Plain-Python self-checks, no pytest: `npm run test:python` from the root, or
  `.venv/bin/python test_<name>.py`. Each prints PASS/FAIL lines and exits non-zero on failure.
- Several checks assert agreement with the frontend and migrations (a route has a
  client, a column exists). Paths come from `repo_paths.py` — update it, not the tests,
  when the tree moves. Database fakes: `fake_supabase.py`, `crawl_test_support.py`.
