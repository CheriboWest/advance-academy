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

## Tests

- Plain-Python self-checks, no pytest: `npm run test:python` from the root, or
  `.venv/bin/python test_<name>.py`. Each prints PASS/FAIL lines and exits non-zero on failure.
- Several checks assert agreement with the frontend and migrations (a route has a
  client, a column exists). Paths come from `repo_paths.py` — update it, not the tests,
  when the tree moves. Database fakes: `fake_supabase.py`, `crawl_test_support.py`.
