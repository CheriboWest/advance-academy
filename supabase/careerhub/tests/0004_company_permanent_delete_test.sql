-- Self-check for migration 0004 (permanent company deletion).
--
-- Runs against a throwaway database built from `supabase/careerhub/schema.sql` +
-- the migrations. It asserts with `raise exception`, so psql must be run with
-- ON_ERROR_STOP=1: any failed assertion aborts the run.
--
--   createdb ch_test
--   psql -v ON_ERROR_STOP=1 -d ch_test -f supabase/careerhub/schema.sql
--   psql -v ON_ERROR_STOP=1 -d ch_test -f supabase/migrations/027_ch0004_company_permanent_delete.sql
--   psql -v ON_ERROR_STOP=1 -d ch_test -f supabase/careerhub/tests/0004_company_permanent_delete_test.sql

\set ON_ERROR_STOP on
\pset pager off

create or replace function pg_temp.assert(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition then
    raise notice 'PASS  %', label;
  else
    raise exception 'FAIL  %', label;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: three companies, two coaches.
--   acme  — 2 active jobs, meta for both coaches (one hidden), 2 outreach rows
--   beta  — 1 active job, no meta, no outreach
--   gamma — 1 active job, untouched control
-- ---------------------------------------------------------------------------
truncate table public.jobs, public.coach_company_meta, public.outreach_emails,
               public.companies restart identity;

insert into public.companies (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111', 'acme',  'Acme Ltd'),
  ('22222222-2222-2222-2222-222222222222', 'beta',  'Beta Ltd'),
  ('33333333-3333-3333-3333-333333333333', 'gamma', 'Gamma Ltd');

insert into public.jobs (company_id, title, is_active, content_hash) values
  ('11111111-1111-1111-1111-111111111111', 'Engineer', true,  'acme-1'),
  ('11111111-1111-1111-1111-111111111111', 'Designer', false, 'acme-2'),
  ('22222222-2222-2222-2222-222222222222', 'Analyst',  true,  'beta-1'),
  ('33333333-3333-3333-3333-333333333333', 'Manager',  true,  'gamma-1');

insert into public.coach_company_meta (coach_user_id, company_id, starred, hidden, notes) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', true,  true,  'coach A note'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', false, false, 'coach B note'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', true,  false, 'keep me');

insert into public.outreach_emails (id, coach_user_id, company_id, subject, status) values
  ('dddddddd-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a',
   '11111111-1111-1111-1111-111111111111', 'Hello Acme', 'sent'),
  ('dddddddd-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b',
   '11111111-1111-1111-1111-111111111111', 'Draft for Acme', 'draft'),
  ('dddddddd-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000a',
   '33333333-3333-3333-3333-333333333333', 'Hello Gamma', 'draft');

-- ---------------------------------------------------------------------------
-- 0. Baseline: today's naive delete is impossible (FK NO ACTION on jobs).
-- ---------------------------------------------------------------------------
do $$
declare failed boolean := false;
begin
  begin
    delete from public.companies where id = '11111111-1111-1111-1111-111111111111';
  exception when foreign_key_violation then
    failed := true;
  end;
  perform pg_temp.assert(failed, 'bare DELETE on companies is blocked by a foreign key');
  perform pg_temp.assert(
    exists (select 1 from public.companies where slug = 'acme'),
    'blocked DELETE left the company in place');
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Single deletion: company with multiple jobs, meta for two coaches,
--    outreach for two coaches.
-- ---------------------------------------------------------------------------
do $$
declare r jsonb;
begin
  r := public.delete_companies_permanently(array['11111111-1111-1111-1111-111111111111']::uuid[]);

  perform pg_temp.assert((r->>'requested')::int = 1,                 'single: requested = 1');
  perform pg_temp.assert((r->>'deleted_companies')::int = 1,         'single: deleted_companies = 1');
  perform pg_temp.assert((r->>'deleted_jobs')::int = 2,              'single: both jobs deleted (active + inactive)');
  perform pg_temp.assert((r->>'deleted_coach_meta')::int = 2,        'single: meta deleted for both coaches');
  perform pg_temp.assert((r->>'unlinked_outreach_emails')::int = 2,  'single: outreach unlinked for both coaches');
  perform pg_temp.assert(jsonb_array_length(r->'missing_company_ids') = 0, 'single: nothing missing');

  perform pg_temp.assert(not exists (select 1 from public.companies where slug = 'acme'),
    'single: company row is gone');
  perform pg_temp.assert(not exists (
      select 1 from public.jobs where company_id = '11111111-1111-1111-1111-111111111111'),
    'single: no jobs remain');
  perform pg_temp.assert(not exists (
      select 1 from public.coach_company_meta where company_id = '11111111-1111-1111-1111-111111111111'),
    'single: no coach_company_meta remains for any coach');
  perform pg_temp.assert(not exists (
      select 1 from public.public_company_summary where slug = 'acme'),
    'single: gone from public_company_summary (student search + detail page)');

  -- Outreach content survives; only the company link is cleared.
  perform pg_temp.assert(
    (select count(*) from public.outreach_emails
      where id in ('dddddddd-0000-0000-0000-00000000000a','dddddddd-0000-0000-0000-00000000000b')
        and company_id is null) = 2,
    'single: outreach rows kept with company_id cleared');
  perform pg_temp.assert(
    (select subject from public.outreach_emails where id = 'dddddddd-0000-0000-0000-00000000000a') = 'Hello Acme',
    'single: outreach subject/body preserved');

  -- Control company untouched.
  perform pg_temp.assert(exists (select 1 from public.companies where slug = 'gamma'),
    'single: other companies unaffected');
  perform pg_temp.assert(
    (select count(*) from public.jobs where company_id = '33333333-3333-3333-3333-333333333333') = 1,
    'single: other companies keep their jobs');
  perform pg_temp.assert(
    (select count(*) from public.coach_company_meta
      where company_id = '33333333-3333-3333-3333-333333333333') = 1,
    'single: unrelated coach metadata untouched');
  perform pg_temp.assert(
    (select company_id from public.outreach_emails where id = 'dddddddd-0000-0000-0000-00000000000c')
      = '33333333-3333-3333-3333-333333333333',
    'single: unrelated outreach still linked');
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. A hidden company (coach_company_meta.hidden = true) was deletable above,
--    and hiding still works independently for the survivors.
-- ---------------------------------------------------------------------------
do $$
begin
  update public.coach_company_meta
     set hidden = true
   where coach_user_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and company_id = '33333333-3333-3333-3333-333333333333';

  perform pg_temp.assert(
    (select hidden from public.coach_company_meta
      where coach_user_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
        and company_id = '33333333-3333-3333-3333-333333333333'),
    'hidden flag still settable after deletions');
  perform pg_temp.assert(
    exists (select 1 from public.public_company_summary where slug = 'gamma'),
    'hidden company still exists globally (hiding is per-coach, not deletion)');

  update public.coach_company_meta set hidden = false
   where company_id = '33333333-3333-3333-3333-333333333333';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Bulk deletion: duplicates deduped, unknown ids reported, valid ids gone.
-- ---------------------------------------------------------------------------
do $$
declare r jsonb;
begin
  r := public.delete_companies_permanently(array[
    '22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222222',   -- duplicate
    '33333333-3333-3333-3333-333333333333',
    '99999999-9999-9999-9999-999999999999',   -- never existed
    null                                       -- ignored
  ]::uuid[]);

  perform pg_temp.assert((r->>'requested')::int = 3,          'bulk: duplicates and nulls collapsed to 3 requested');
  perform pg_temp.assert((r->>'deleted_companies')::int = 2,  'bulk: 2 companies deleted');
  perform pg_temp.assert((r->>'deleted_jobs')::int = 2,       'bulk: jobs from both companies deleted');
  perform pg_temp.assert((r->>'deleted_coach_meta')::int = 1, 'bulk: meta deleted');
  perform pg_temp.assert(
    r->'missing_company_ids' = '["99999999-9999-9999-9999-999999999999"]'::jsonb,
    'bulk: unknown id reported as missing, not silently counted as deleted');

  perform pg_temp.assert((select count(*) from public.companies) = 0,          'bulk: all companies gone');
  perform pg_temp.assert((select count(*) from public.jobs) = 0,               'bulk: all jobs gone');
  perform pg_temp.assert((select count(*) from public.coach_company_meta) = 0, 'bulk: all meta gone');
  perform pg_temp.assert((select count(*) from public.outreach_emails) = 3,    'bulk: no outreach row was deleted');
  perform pg_temp.assert(
    (select count(*) from public.outreach_emails where company_id is not null) = 0,
    'bulk: surviving outreach rows are all unlinked');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Empty / null input is a no-op, not a "delete everything".
-- ---------------------------------------------------------------------------
insert into public.companies (id, slug, name)
  values ('44444444-4444-4444-4444-444444444444', 'delta', 'Delta Ltd');

do $$
declare r jsonb;
begin
  r := public.delete_companies_permanently('{}'::uuid[]);
  perform pg_temp.assert((r->>'deleted_companies')::int = 0, 'empty array deletes nothing');

  r := public.delete_companies_permanently(null);
  perform pg_temp.assert((r->>'deleted_companies')::int = 0, 'null input deletes nothing');

  r := public.delete_companies_permanently(array[null]::uuid[]);
  perform pg_temp.assert((r->>'requested')::int = 0, 'array of nulls deletes nothing');

  perform pg_temp.assert((select count(*) from public.companies) = 1,
    'no-op calls left the company table intact');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. An unhandled table referencing companies.id aborts the whole call and
--    rolls back — no partial deletion.
-- ---------------------------------------------------------------------------
create table if not exists public.zz_unhandled_ref (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id)
);

do $$
declare raised boolean := false;
begin
  begin
    perform public.delete_companies_permanently(
      array['44444444-4444-4444-4444-444444444444']::uuid[]);
  exception when foreign_key_violation then
    raised := true;
  end;

  perform pg_temp.assert(raised, 'unhandled referencing table raises instead of guessing');
  perform pg_temp.assert(
    exists (select 1 from public.companies where slug = 'delta'),
    'guarded failure rolled back — company still present');
end;
$$;

drop table public.zz_unhandled_ref;

-- ---------------------------------------------------------------------------
-- 6. Privileges: the function is service_role-only where those roles exist.
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.assert(
    not has_function_privilege('public', 'public.delete_companies_permanently(uuid[])', 'execute'),
    'PUBLIC cannot execute the deletion function');

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    perform pg_temp.assert(
      not has_function_privilege('authenticated',
        'public.delete_companies_permanently(uuid[])', 'execute'),
      'authenticated (coach browser session) cannot execute the deletion function');
  else
    raise notice 'SKIP  role "authenticated" does not exist on this database';
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    perform pg_temp.assert(
      has_function_privilege('service_role',
        'public.delete_companies_permanently(uuid[])', 'execute'),
      'service_role can execute the deletion function');
  else
    raise notice 'SKIP  role "service_role" does not exist on this database';
  end if;
end;
$$;

-- Clean up the last fixture.
select public.delete_companies_permanently(
  array['44444444-4444-4444-4444-444444444444']::uuid[]) as cleanup;

\echo ''
\echo 'All assertions passed.'
