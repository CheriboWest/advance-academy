# supabase — schema and migrations

**The live database is production** (project `tiumnkknbgnqhrvohnxy`). Never run SQL
against it without the user's explicit go-ahead. Use the `add-migration` skill.

## Migrations (`migrations/`)

- Applied **by hand** in the Supabase SQL editor (or `psql`); there is no migration
  CLI and no record table — which files ran on prod is tracked in commits/PRs.
- Order is filename order under `LC_ALL=C` (`018_` before `018a_`, `023_` before
  `023a_`). The next migration takes the next free number; never renumber old ones.
- `024_ch0001_*` … `038_ch0015_*` are career-hub's original `0001`–`0015`; the old
  number stays in the name so "requires migration 0009" notes still resolve (grep `ch0009`).
- Write new migrations idempotent (`if not exists`, `create or replace`, guarded
  `do $$` blocks). Older ones are not all idempotent — don't bulk re-run them.
- Never apply a batch with `--single-transaction`: `033` uses
  `create index concurrently` and `040`/`041` run their own `begin/commit`.
- **After applying anything, verify RLS on the live DB** and expect zero rows:
  `select tablename from pg_tables where schemaname='public' and rowsecurity=false;`
  A table without RLS is publicly read/writable via the anon key and triggers
  Supabase's `rls_disabled_in_public` alert (it happened to `cv_analysis_jobs` and
  `company_additional_url`). `011_rls_hardening_sweep.sql` is the idempotent re-enable.
- Service-role-only tables (e.g. `contacts`, sponsorship tables) get RLS with no
  policies plus revoked `anon`/`authenticated` grants.
- Some migrations' comments say "see CLAUDE.md" — that now means this file.

## Gamification schema (migration 047)

Full design, privilege matrix and rollout: `git show 062d0e5:docs/GAMIFICATION_V2.md`.

- Rewards are judged **in SQL**: AFTER triggers on source tables write
  `reward_intents` (with a snapshot) in the same transaction; `process_reward_intents`
  judges them in `seq` order under a per-user advisory lock, in READ COMMITTED.
- `reward_decisions` are immutable — one first decision per (user, kind, subject);
  a card's first decision locks the card. Capped decisions earn no XP but still lock.
- `gamification_config` is versioned: to change numbers **insert a new version**,
  never update an old one (intents keep the version they were captured under).
- Privilege model: four `NOLOGIN` owner roles (`gamification_capture`, `_processor`,
  `_cover_letter_writer`, `_admin`) own the `SECURITY DEFINER` functions, each
  pinning `search_path = pg_catalog, pg_temp` and schema-qualifying everything.
  `service_role` may only read the tables, write goal settings / `seen_at`, and
  EXECUTE eight RPCs (`create_saved_job`, `change_job_status`, `record_cover_letter`,
  `charge_credits`, `process_reward_intents`, `ensure_daily_quests`, `book_rest_day`,
  `skip_reward_intent`). A new grant must keep that true.
- Guards: a CV run may only link its own user's card and never re-link; only
  `record_cover_letter` may set the cover-letter marker (checked with `current_user`);
  timezone changes at most once per 24h.
- After applying 047-style role changes, also check that no API role is a member of
  an owner role (expect zero rows):
  `select r.rolname, g.rolname from pg_roles r, pg_roles g where g.rolname like 'gamification\_%' and r.rolname in ('anon','authenticated','service_role','authenticator') and pg_has_role(r.oid, g.oid, 'MEMBER');`

## SQL tests (`tests/`)

- `PGHOST=127.0.0.1 PGPORT=<port> supabase/tests/run_local.sh` on a **scratch** local
  Postgres 16 + pgvector cluster: loads Supabase role stand-ins from `tests/support/`,
  applies every migration as non-superuser `postgres`, runs `046_*.test.sql`,
  `047_*.test.sql` (each rolled back) and the two-session concurrency test.
  `MIGRATION_ROLE=supabase_admin` checks the superuser path (use a fresh cluster).
- The test files refuse to run against a database whose `jobs` has rows. Never point
  them at production.

## Reference only — never run

- `reference/schema_May_5_2026.sql` (+ `.dbml`) is the last full dump and **predates
  migrations 012–045**; read the numbered files for anything newer.
  `reference/schema.dbml` mirrors only 001–004.
- `careerhub/schema.sql` mirrors career-hub's pre-merge schema; `careerhub/tests/`
  are SQL self-checks for a throwaway local database (see `careerhub/README.md`).

## Model notes

- `cv_bullets` belong to a user; `cv_version_bullets` links them to CV versions (M:N).
- `saved_jobs` duplicate detection is the partial unique index on `(user_id, url_key)`;
  `job_events` is append-only with `user_id` denormalised for counting.
- `match_bullets` (migration 007, HNSW over `cv_bullets.bullet_embedding`) backs coach
  retrieval and merge suggestions; without it both silently degrade.
