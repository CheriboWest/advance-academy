# career-hub's Supabase reference (`supabase/careerhub`)

What career-hub kept in its own `infra/supabase/` before the merge. Its
migrations now live in `supabase/migrations/` as `024_ch0001_*` … `038_ch0015_*`
(the original number stays in the name, so `0004` below is `027_ch0004_*`).

The **source of truth is the Supabase project itself** — it was created before
these files existed, so `schema.sql` is a human-readable *mirror* of the
expected shape, not a script that produced it. Treat any difference between the
two as the live database being right and the mirror being stale.

## Layout

```
supabase/careerhub/
├── schema.sql                  # mirror of the expected schema (reference only — never run it on live)
├── verify_sponsor_import.sql   # read-only checks after a sponsor-register import
└── tests/                      # SQL self-checks, run against a throwaway database
```

## Migrations

| File | Purpose |
| ---- | ------- |
| `0001_crawler_ingestion.sql` | Crawler/dedup columns, `discovery_queries`, `crawl_runs`, `public_company_summary` |
| `0002_crawl_run_stats.sql` | Additional `crawl_runs` statistics columns |
| `0003_job_title_search.sql` | `pg_trgm` + GIN index backing Job Role Search |
| `0004_company_permanent_delete.sql` | `delete_companies_permanently(uuid[])` — transactional, `service_role`-only permanent company deletion |
| `0005_crawl_run_stats_columns.sql` | `crawl_runs` columns the crawler writes: `source`, `started_at`/`completed_at`, `error`, and the seven per-run job/company counts |
| `0006_sponsor_register.sql` | `sponsor_licences`, `sponsor_register_imports`, `company_sponsorship` + the `company_sponsorship_current` view |
| `0007_company_sponsorship_checks.sql` | `company_sponsorship_checks` — per-company resolution state (what the last attempt concluded, against which register edition) |
| `0008_sponsorship_rls.sql` | Deny-by-default RLS + revoked grants on the four sponsorship tables; `company_sponsorship_current` becomes `security_invoker` |
| `0009_sponsor_import_staging.sql` | Stage-then-promote sponsor imports: `staged_import_id` / `last_import_id` on `sponsor_licences`, `is_current` defaults to false, and `finalize_sponsor_register_import()` (service_role only) does withdrawal in the database |
| `0010_sponsor_chunked_finalization.sql` | Publishes a staged edition in bounded chunks instead of one statement: `begin_sponsor_register_finalization()`, `promote_sponsor_register_import_chunk()`, `withdraw_sponsor_register_chunk()`, `complete_sponsor_register_import()` (all service_role only), plus `withdrawn_by_import_id` and a self-shrinking partial index backing chunk selection |

All migrations are additive and idempotent: re-running one is a no-op.

Apply them in the Supabase SQL editor (or `psql`) in filename order.

## Permanent company deletion (0004)

`companies` is referenced by `jobs` and `coach_company_meta` with
`ON DELETE NO ACTION`, so a bare `delete from companies` fails on a foreign key.
Migration 0004 adds a `SECURITY DEFINER` function that removes the dependants
and the company in **one transaction**:

- `jobs` — deleted (shared crawler data).
- `coach_company_meta` — deleted, for every coach (per-coach stars/notes/hidden
  for that company; the foreign key also forbids leaving it behind).
- `outreach_emails` — **kept**, with `company_id` set to `null`. Drafts and
  sent-mail records are coach-authored content, not the company's data.
- `companies` — deleted.

If any *other* table references `companies.id`, the function raises and rolls
back, naming the table. Extend it explicitly rather than letting deletion depend
on cascade behaviour nobody audited.

Execute is granted to `service_role` only, so the destructive path is reachable
only through `POST /companies/delete` on `backend-python`, which verifies the coach's
JWT first. `anon` and `authenticated` (a coach's browser session) cannot call
it.

## Running the SQL self-checks

Against a throwaway local PostgreSQL database (never the live project):

```bash
createdb ch_test
psql -v ON_ERROR_STOP=1 -d ch_test -f supabase/careerhub/schema.sql
psql -v ON_ERROR_STOP=1 -d ch_test -f supabase/migrations/027_ch0004_company_permanent_delete.sql
psql -v ON_ERROR_STOP=1 -d ch_test -f supabase/careerhub/tests/0004_company_permanent_delete_test.sql
```

Assertions use `raise exception`, so `ON_ERROR_STOP=1` is required — the run
aborts on the first failure and prints `PASS`/`FAIL` per check. The role-grant
checks are skipped unless `anon`, `authenticated`, and `service_role` exist
locally; create them as bare `nologin` roles to exercise those too.
