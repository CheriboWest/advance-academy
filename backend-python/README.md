# backend-python — Career Hub API

FastAPI service behind Career Hub (`/search`, `/companies`, `/coach`): company
and job search data, the coach crawler, contacts, the UK sponsor register,
AI outreach and email. It came from career-hub's `apps/api` and stays Python.
Deploy target: **Railway**.

The browser never calls it directly — it goes through the Next.js rewrite
`/api/careerhub/*` → `BACKEND_PYTHON_URL`; server code calls it directly. The
Anthropic API key lives here, server-side only.

## Stack

- **Framework:** FastAPI on Uvicorn
- **AI:** Anthropic Claude Haiku (`claude-haiku-4-5`) via the official
  `anthropic` Python SDK
- **Language:** Python 3.11+

## Structure

```
backend-python/
├── app/
│   ├── main.py            # FastAPI app + CORS + /health, includes the routers
│   ├── config.py          # env-based settings (dotenv)
│   ├── auth.py            # Supabase JWT verification, is_admin gate for coach routes
│   ├── schemas.py         # Pydantic request/response models
│   ├── routers/           # ai, companies, contacts, discover (crawler), email, sponsors
│   ├── companies/         # sector classification, AI company summaries
│   ├── crawler/           # Adzuna + Reed sources, normalize, scoring, pipeline
│   └── sponsors/          # GOV.UK register import, candidate search, resolver, worker
├── scripts/               # classify_sectors, import_sponsor_register, resolve_sponsorship
├── test_*.py              # plain-Python self-checks (see below)
├── fake_supabase.py, crawl_test_support.py, repo_paths.py   # shared test helpers
├── tests/fixtures/        # sample sponsor-register CSV
├── requirements.txt
├── .env.example
├── Procfile / railway.json / runtime.txt   # Railway deploy
```

## Endpoint

### `POST /ai/outreach` (authenticated)

Requires a Supabase access token: `Authorization: Bearer <token>`. The token's
signature, expiry, and issuer (must contain `SUPABASE_URL`) are verified with
`python-jose`; the coach's user id (`sub`) is read via the reusable
`get_current_user` dependency. A missing or invalid token returns **401**.

Request:

```json
{
  "company_name": "TechNova Solutions",
  "location": "London",
  "sector": "Technology",
  "open_jobs": 2,
  "lead_score": 85
}
```

Response:

```json
{
  "subject": "…",
  "body": "…"
}
```

The system prompt instructs Claude to write professional British English,
concise, personalised to the company, mentioning hiring activity naturally,
avoiding spammy language, 120–180 words, suitable for a recruitment/coaching
business reaching out to a hiring company. Errors, timeouts, and refusals are
mapped to appropriate HTTP status codes.

### `POST /email/send` (authenticated)

Requires a Supabase access token (same `get_current_user` dependency). Sends a
saved outreach draft through **Resend's HTTPS API**. Railway blocks outbound
SMTP on every plan below Pro, so mail leaves over port 443 and Resend does the
SMTP delivery.

Request:

```json
{ "draft_id": "…", "to": "recruiter@company.com" }
```

Flow: verify coach JWT → load the draft from Supabase with the **service role
key** → confirm `coach_user_id` matches the caller → POST to Resend → update the
row (`status = 'sent'`, `sent_at = now()`). Returns
`{ "status": "sent", "sent_at": "…", "recipient_email": "…" }`. A missing draft
is 404; a draft owned by another coach is 403; a send failure is 502.

### `POST /companies/delete` (authenticated)

Permanently deletes companies **for every user** — the coach who asked, other
coaches, students, the public search, and the company detail pages. Requires a
Supabase access token (same `get_current_user` dependency).

Request:

```json
{ "company_ids": ["uuid", "uuid"] }
```

Ids are validated as UUIDs and capped at 200 per request. The endpoint calls the
Postgres function `delete_companies_permanently(uuid[])` with the **service role
key**, which performs the whole deletion in a single transaction:

| Table | Treatment | Why |
| ----- | --------- | --- |
| `jobs` | deleted | Shared crawler data, meaningless without the company |
| `coach_company_meta` | deleted (all coaches) | Per-coach stars/notes/hidden for that company; its foreign key also forbids leaving it behind |
| `outreach_emails` | **kept**, `company_id` set to `null` | Coach-authored drafts and the record of mail actually sent — not the company's data to delete |
| `companies` | deleted | The company itself |

The function refuses (and rolls back) if any other table references
`companies.id`, so an unhandled relationship fails loudly instead of destroying
un-audited rows.

Response:

```json
{
  "requested": 2,
  "deleted_companies": 1,
  "deleted_company_ids": ["…"],
  "missing_company_ids": ["…"],
  "deleted_jobs": 7,
  "deleted_coach_meta": 3,
  "unlinked_outreach_emails": 1
}
```

`deleted_companies + len(missing_company_ids) == requested`, so a partial result
is explicit rather than implied. A missing token is 401, a malformed id is 422,
an uninstalled function is 500 (naming the migration to apply), and any other
database failure is 502 — in which case nothing was deleted, because the
transaction rolled back.

Requires migration `supabase/migrations/027_ch0004_company_permanent_delete.sql`.

### Crawler (authenticated)

- **`POST /discover/start`** — `{ query, city, sources, force }`. Verifies the
  coach JWT, checks the 24h cache (`discovery_queries`); returns
  `{ cached: true, hours_ago, jobs_available }` on a fresh hit, otherwise creates
  a `crawl_runs` row and launches a **BackgroundTask**, returning
  `{ cached: false, run_id, status: "running" }`.
- **`GET /discover/status/{run_id}`** — the run's status + statistics (poll until
  `status` is `completed`/`failed`).
- **`GET /discover/history`** — the last 10 crawl runs.

**Crawl statistics.** The pipeline counts raw / normalized / inserted / updated
/ duplicate jobs and created / updated companies into a single `CrawlStats`
object, and persists it to that run's `crawl_runs` row in the **same UPDATE**
that sets the terminal `status`. One statement matters: the coach's UI stops
polling as soon as it sees a terminal status, so writing the status first and
the counts second would leave a window where a finished crawl renders zeros.
`GET /discover/status/{run_id}` reads those columns straight back — nothing is
recomputed or aggregated from `jobs`/`companies`.

Requires migration `supabase/migrations/028_ch0005_crawl_run_stats_columns.sql`.
Without it the database has nowhere to store the counts; the pipeline falls back
to a status-only write (so the run still finishes) and logs a message naming the
migration.

Crawl pipeline: fetch from Adzuna/Reed (per-source timeouts, partial failure
tolerated) → normalize company/title/city/salary → merge company name variants
into one slug → upsert companies (best-effort homepage enrichment: description,
sector, careers_url) → recompute `lead_score` → dedup jobs by `content_hash` and
upsert into `jobs` → record stats on `crawl_runs`. Newly ingested companies with
active jobs appear automatically in the student portal via
`public_company_summary`.

### Sponsor register (authenticated)

The **[UK Register of Licensed Sponsors: workers](https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers)**
is the only authority for whether an organisation currently holds a sponsor
licence. Claude is an *entity-resolution* layer on top of it — it decides
whether a crawled company and a register row describe the same organisation,
and never whether a licence exists.

- **`POST /sponsors/import`** — locate the current CSV on GOV.UK, download,
  parse, and upsert it. Also the refresh path: the publication page is read on
  every run, so a newly published edition is picked up without a code change.
  Safe to run repeatedly.
- **`GET /sponsors/imports`** — recent ingestion runs with their statistics.
- **`POST /sponsors/resolve/{company_id}`** — resolve one company on demand.
- **`POST /sponsors/resolve?limit=&force=`** — bulk-resolve companies whose
  conclusion is missing or stale (the backfill, and the sweep after a refresh).
- **`GET /sponsors/companies/{company_id}`** — confirmed sponsorships plus the
  last check.

#### Automatic resolution

Every crawl checks the companies it touched, **after** the crawl reaches a
terminal state:

```
run_crawl
  ├─ asyncio.wait_for(_execute, 90s)   crawl proper — untouched
  │      └─ _ingest → companies upserted → stats.affected_company_ids
  ├─ _finalize(...)                    crawl status + statistics persisted
  └─ _resolve_sponsorship(ids)         sponsorship — isolated, non-fatal
        ├─ skip companies with a current conclusion
        ├─ candidate search in Postgres  → 0 candidates ⇒ no_match, no model call
        ├─ Claude resolution             → bounded concurrency + retries
        └─ persist company_sponsorship (match only) + company_sponsorship_checks
```

Running it after `_finalize` rather than inside `_ingest` is deliberate: inside
the crawl it would spend the 90-second timeout budget, and a slow register
lookup could turn a good crawl into a timeout. Here the crawl's outcome is
already written, and the hook swallows every exception — a crawl that ingested
jobs correctly is a successful crawl whether or not the register could be
consulted.

**No register, no resolution.** If no register edition has been imported
successfully, the whole batch is skipped — no model calls, no rows, no check
state. An empty register means these companies are *unchecked*, not *not
sponsors*, and writing `no_match` would record that misreading permanently.

A company is resolved only when it has never been checked, it was checked
against an older register edition, or its last attempt errored **and** it has
not exhausted its retry budget. `company_sponsorship_checks.attempts` counts
**cumulative failed model HTTP attempts against the current register edition**
since the last successful conclusion: three transient failures in one run
advance it by 3, any conclusion resets it to 0, and a failure that never reached
the model (a database error) costs nothing. At 9 the company stops being
enqueued automatically and waits for `--force` or a new register edition. That state lives
in `company_sponsorship_checks` (migration 0007), which also gives `no_match` and
`ambiguous` somewhere to live — `company_sponsorship.sponsor_licence_id` is NOT
NULL, so that table holds confirmed links and nothing else.

| Setting | Default | |
| --- | --- | --- |
| `SPONSOR_RESOLVE_CONCURRENCY` | `3` | In-flight model requests |
| `SPONSOR_RESOLVE_MAX_PER_CRAWL` | `50` | Companies per crawl |

Transient failures (timeout, connection, 429, 5xx) are retried up to 3 attempts
with jittered exponential backoff; a 4xx is not retried. Either way the company
is recorded as `error` so the next run picks it up again.

#### Resolving manually

```bash
cd backend-python
python scripts/resolve_sponsorship.py --company <uuid>           # one company
python scripts/resolve_sponsorship.py --company <uuid> --force   # force a recheck
python scripts/resolve_sponsorship.py --all --limit 200          # backfill
```

Requires migrations `0006_sponsor_register.sql`,
`0007_company_sponsorship_checks.sql` and `0008_sponsorship_rls.sql`.

**These tables are private.** Migration 0008 enables RLS with no policies and
revokes table privileges from `anon` and `authenticated`, so neither the browser
nor a signed-in session can read them through PostgREST. Only `service_role`
reaches them. Being authenticated is not the same as being a coach — students
authenticate too, and sponsorship is a paid entitlement — so access will be
granted later through this API with explicit entitlement checks, not by a
blanket RLS policy.

#### Stored fields

| GOV.UK column | Stored as | Notes |
| --- | --- | --- |
| Organisation Name | `organisation_name` | Verbatim; never rewritten |
| Town/City | `town_city` | Verbatim |
| County | `county` | Verbatim |
| Type & Rating | `type_rating` | Verbatim, plus parsed `licence_type` + `rating` |
| Route | `route` | Verbatim |

Alongside them: `normalized_name`/`normalized_town` (lookup only), `natural_key`
(the register line's identity), `source_url`, `register_published_at`,
`first_seen_at`, `last_seen_at`, `is_current`, `withdrawn_at`.

#### Deduplication and current status

A register line is identified by (organisation, town, county, type & rating,
route), hashed into `natural_key` with a unique index — so one organisation can
hold several rows (multiple routes or sites) and re-running the importer over an
unchanged file inserts nothing. A row that stops appearing in a newer edition is
marked `is_current = false` with a `withdrawn_at` stamp and **kept**: absence
from today's file means the licence is not listed today, not that it never
existed.

#### Running the importer manually

```bash
cd backend-python

# 1. Validate a manually downloaded edition. Writes nothing.
python scripts/import_sponsor_register.py --file register.csv --validate

# 2. Import it once the report says "safe to import".
python scripts/import_sponsor_register.py --file register.csv

# 3. Or download the current edition from GOV.UK and ingest it.
python scripts/import_sponsor_register.py
```

`--validate` and `--dry-run` are the same flag: both parse the whole file,
normalize, run every uniqueness and safety check, print the report and touch no
database. They share one code path with the real import, so what you validate is
exactly what would be written — a second flag with its own logic could drift
from the importer and validate something the importer does not do.

#### Import safety

The dangerous file is not one that fails to parse — that raises and writes
nothing. It is one that parses successfully into the **wrong shape**: GOV.UK
renames a column, most rows lose their organisation name, the import "succeeds"
with 400 rows instead of 60,000, and the withdrawal step marks the real register
as no longer current.

So a parsed edition is validated before a single register row is written, and
the import is refused unless:

| Check | Threshold |
| --- | --- |
| Rows parsed | > 0 |
| Organisation name present | every accepted row |
| Route present | every accepted row |
| Rejection rate | < 2% |
| Shrink vs the last successful edition | < 20% |

`--force` overrides all of them, for a genuinely smaller edition a human has
inspected. The thresholds live in `app/sponsors/validation.py`.

**Withdrawal ordering.** Parsing and validation complete before any write; the
new edition is upserted in full; only then are rows absent from it marked
`is_current = false`. If any step raises, withdrawal never runs and the stored
register keeps every row it had. Verified by tests that refuse a shrunken, an
empty and an unparseable edition and then assert the stored rows are untouched.

#### Bulk-write reliability

The register is ~142,000 rows. Writes are chunked at **250 rows** (`SPONSOR_UPSERT_CHUNK`)
and carry an import-specific **120-second** timeout (`SPONSOR_IMPORT_TIMEOUT`) —
`SupabaseRest`'s 15-second default is right for interactive requests and far too
short for an upsert into a six-figure table with a unique index. Raising the
default instead would let an interactive endpoint hang for minutes.

Each batch retries up to 5 times (`SPONSOR_BATCH_ATTEMPTS`) with exponential
backoff and jitter, on timeouts, connection failures, 429 and 5xx. A 4xx that is
not 429 is permanent and fails immediately.

**Retrying a timed-out write is safe.** A `ReadTimeout` does not prove the
server discarded the request — PostgREST may have committed it and answered too
late. Because `natural_key` is unique and every write is an upsert, re-sending a
batch that already landed updates the same rows rather than duplicating them.
That is also why a failed import can simply be re-run: rows written by the
previous attempt are recognised as unchanged and the import continues from
there, with no manual cleanup.

Statistics are assigned only after every batch is confirmed, so a failed import
never reports rows it did not write, and the run is reconciled against a
`count=exact` query afterwards.

Progress is logged per batch:

```
[sponsor-import] writing 141904 rows in 568 batches of 250 (insert=141904 update=0 unchanged=0)
[sponsor-import] edition batch 1/568 rows=250 completed | processed=250 remaining=141654 (0.2%)
[sponsor-import] edition batch 27/568 retry=1 reason=ReadTimeout backoff=1.4s
```

Verification queries for after an import: `supabase/careerhub/verify_sponsor_import.sql`.

`GET /health` returns `{"status": "ok"}`.

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable            | Required | Default           | Notes                                   |
| ------------------- | -------- | ----------------- | --------------------------------------- |
| `ANTHROPIC_API_KEY` | ✅       | —                 | Server-side only; never sent to browser |
| `ANTHROPIC_MODEL`   | ❌       | `claude-haiku-4-5` | Claude model id                        |
| `ANTHROPIC_TIMEOUT` | ❌       | `30`              | Request timeout (seconds)               |
| `ALLOWED_ORIGINS`   | ❌       | `http://localhost:3000` | Comma-separated CORS origins (your Vercel URL) |
| `ALLOWED_ORIGIN_REGEX` | ❌    | —                 | Extra CORS origins by regex, for Vercel preview URLs. Full-matched — anchor it to your own scope |
| `SUPABASE_URL`      | ✅       | —                 | Supabase project URL; coach tokens are verified against its public JWKS, and the issuer must contain it |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | —              | Service role key; loads/updates drafts, runs the crawler ingestion, and performs permanent company deletion server-side (never sent to browser) |
| `RESEND_API_KEY`    | ✅       | —                 | Resend API key (`re_…`); sends over HTTPS |
| `EMAIL_FROM`        | ✅       | —                 | From address; its domain must be verified in Resend |
| `ADZUNA_APP_ID`     | ✅ (crawler) | —             | Adzuna API app id                       |
| `ADZUNA_APP_KEY`    | ✅ (crawler) | —             | Adzuna API app key                      |
| `REED_API_KEY`      | ✅ (crawler) | —             | Reed API key                            |
| `SPONSOR_RESOLVER_MODEL` | ❌  | `claude-haiku-4-5` | Model used for sponsor entity resolution |
| `SPONSOR_RESOLVE_CONCURRENCY` | ❌ | `3` | In-flight resolution requests |
| `SPONSOR_RESOLVE_MAX_PER_CRAWL` | ❌ | `50` | Companies resolved per crawl |
| `SPONSOR_UPSERT_CHUNK` | ❌ | `250` | Rows per register upsert batch |
| `SPONSOR_IMPORT_TIMEOUT` | ❌ | `120` | Seconds per bulk register write |
| `SPONSOR_BATCH_ATTEMPTS` | ❌ | `5` | Attempts per batch before failing |

## Run locally

```bash
cd backend-python
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # then add your ANTHROPIC_API_KEY
uvicorn app.main:app --reload --port 8000
```

- API: http://localhost:8000
- Interactive docs: http://localhost:8000/docs

## Deploy to Railway

1. Create a new Railway project from this repo, root directory `backend-python`.
2. Railway uses `railway.json` / `Procfile` to run
   `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
3. Set the environment variables above in the Railway dashboard. `SUPABASE_URL`
   and `SUPABASE_SERVICE_ROLE_KEY` must be the **merged** project's, or every
   coach token fails with "Unknown token signing key" / "Invalid token issuer".
4. Set the frontend's server-only `BACKEND_PYTHON_URL` to the Railway service URL
   and **rebuild** — the `/api/careerhub/*` rewrite is fixed at build time and
   silently disappears when the variable is unset (every call then 404s).

## Self-checks

The API ships plain-Python self-checks (no pytest). Run them all from
`backend-python/` with `for f in test_*.py; do .venv/bin/python $f; done`, or one at a time:

```bash
python test_auth.py        # JWKS token verification
python test_cors.py        # CORS configuration
python test_scoring.py     # lead scoring
python test_companies.py   # permanent company deletion endpoint
python test_sponsor_register.py   # sponsor-register ingestion (fixture CSV)
python test_sponsor_matching.py   # candidate search + entity resolution
python test_sponsor_worker.py     # automatic resolution, retries, batching
python test_sponsor_validation.py # import validation + withdrawal safety
python test_sponsor_import_retry.py # bulk-write retry, resume, withdrawal safety
```

`test_companies.py` stubs the Supabase call, so it needs no network and no
database: it covers auth, id validation, the de-duplicated RPC payload, partial
results, and error mapping.
