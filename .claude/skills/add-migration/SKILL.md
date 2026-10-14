---
name: add-migration
description: Write a new Supabase SQL migration for this repo and hand it to the user to apply. Use for any schema change — new table, column, index, RLS policy, RPC function or view.
---

# Add a migration

The database is **production** and migrations are applied by hand. You write the
file; the user runs it. Never execute SQL against the live project yourself.

1. **Number** — next free number after the highest in `supabase/migrations/`
   (`LC_ALL=C ls supabase/migrations | tail -3`). Name: `NNN_short_snake_name.sql`.
   Never renumber or edit a migration that has already shipped; add a new one.
2. **Header comment** — what changes, why, and "Run in Supabase SQL Editor.
   Idempotent: safe to re-run."
3. **Idempotent SQL** — `create table if not exists`, `add column if not exists`,
   `create index if not exists`, `create or replace function/view`,
   `drop policy if exists` before `create policy`. No `begin/commit` unless the file
   needs it (and then never wrap a batch in `--single-transaction`).
4. **RLS on every new table** — `alter table … enable row level security;`. Tables only
   the backend touches: no policies, plus
   `revoke all on <table> from anon, authenticated;`.
5. **Code** — update the backend service and the `packages/contracts` types in the same
   change; mention the migration number in a comment where the code depends on it.
6. **Hand-off** — tell the user the file to run, then the RLS check to run after it,
   which must return zero rows:
   `select tablename from pg_tables where schemaname='public' and rowsecurity=false;`
7. `supabase/reference/` dumps are not updated per migration — leave them.
