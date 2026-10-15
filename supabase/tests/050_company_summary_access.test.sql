-- Self-checking test for migration 050 (public_company_summary readable again).
-- SCRATCH DATABASES ONLY.
--
--   psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/050_company_summary_access.test.sql
--
-- Needs a database with every migration applied. Runs in one transaction that
-- is rolled back and refuses to start if public.companies already has rows.
-- A clean run ends with "ALL COMPANY SUMMARY ACCESS CHECKS PASSED".
--
-- The regression: after 048, anon and authenticated got "permission denied for
-- table companies" from this view, which took down /search and the coach
-- Dashboard (where coach sign-in lands).

\set ON_ERROR_STOP on
begin;

do $$
begin
  if exists (select 1 from public.companies) then
    raise exception 'public.companies is not empty — run this only against a scratch database';
  end if;
end
$$;

create function pg_temp.check(label text, cond boolean) returns void
language plpgsql as $$
begin
  if cond is distinct from true then
    raise exception 'FAIL: %', label;
  end if;
  raise notice 'ok   %', label;
end;
$$;

create function pg_temp.hiring_as(r text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute format('set local role %I', r);
  select count(*) into n from public.public_company_summary where open_jobs > 0;
  reset role;
  return n;
end;
$$;

create function pg_temp.reads_companies_as(r text) returns boolean
language plpgsql as $$
begin
  execute format('set local role %I', r);
  perform 1 from public.companies limit 1;
  reset role;
  return true;
exception when insufficient_privilege then
  reset role;
  return false;
end;
$$;

insert into public.companies (id, name, slug) values
  ('00000000-0000-0000-0000-0000000005c1', 'Hiring Co', 'hiring-co'),
  ('00000000-0000-0000-0000-0000000005c2', 'Quiet Co', 'quiet-co');
insert into public.jobs (company_id, title, is_active, source, content_hash, expires_at) values
  ('00000000-0000-0000-0000-0000000005c1', 'Open role', true, 'adzuna', 'h050-1', now() + interval '10 days'),
  ('00000000-0000-0000-0000-0000000005c1', 'Closed role', false, 'adzuna', 'h050-2', null),
  ('00000000-0000-0000-0000-0000000005c2', 'Expired role', true, 'reed', 'h050-3', now() - interval '1 day');

select pg_temp.check('the view runs with its owner''s rights (050)',
  coalesce((select not ('security_invoker=true' = any(reloptions)) from pg_class
             where oid = 'public.public_company_summary'::regclass), true));
select pg_temp.check('authenticated (coaches) can read the view', pg_temp.hiring_as('authenticated') = 1);
select pg_temp.check('anon (/search) can read the view', pg_temp.hiring_as('anon') = 1);
select pg_temp.check('the view still counts only active, unexpired jobs',
  (select open_jobs from public.public_company_summary where slug = 'hiring-co') = 1
  and (select open_jobs from public.public_company_summary where slug = 'quiet-co') = 0);
select pg_temp.check('companies itself stays closed to anon (040)', not pg_temp.reads_companies_as('anon'));
select pg_temp.check('companies itself stays closed to authenticated (040)', not pg_temp.reads_companies_as('authenticated'));

do $$ begin raise notice 'ALL COMPANY SUMMARY ACCESS CHECKS PASSED'; end $$;
rollback;
