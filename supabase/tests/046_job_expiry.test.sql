-- Self-checking test for migration 046 (job expiry). SCRATCH DATABASES ONLY.
--
--   psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/046_job_expiry.test.sql
--
-- Needs a database with the migrations through 046 applied. Everything runs in
-- one transaction that is rolled back, and it refuses to start if public.jobs
-- already has rows — so it cannot touch real data even if pointed at the wrong
-- database. Any failed check raises and stops the script; a clean run ends with
-- "ALL JOB EXPIRY SQL CHECKS PASSED".

\set ON_ERROR_STOP on
begin;

do $$
begin
  if exists (select 1 from public.jobs) then
    raise exception 'public.jobs is not empty — run this only against a scratch database';
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

-- Fixtures ------------------------------------------------------------------
insert into public.companies (id, name, slug) values
  ('00000000-0000-0000-0000-0000000000c1', 'Acme', 'acme'),
  ('00000000-0000-0000-0000-0000000000c2', 'Beta', 'beta');

insert into public.discovery_queries (query, location, last_refreshed_at) values
  ('software engineer', 'london', now()),
  ('nurse', 'leeds', now());

-- j(n) = a fixed uuid per fixture job, so checks can name them.
create function pg_temp.j(n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;

create function pg_temp.add_job(
  n integer, p_source text, p_posted interval, p_last_seen interval,
  p_expires interval default null, p_company uuid default '00000000-0000-0000-0000-0000000000c1',
  p_created interval default interval '60 days'
) returns void language sql as $$
  insert into public.jobs (id, company_id, title, source, content_hash, is_active,
                           posted_at, last_seen_at, expires_at, created_at)
  values (pg_temp.j(n), p_company, 'Job ' || n, p_source, 'hash-' || n, true,
          now() - p_posted,
          case when p_last_seen is null then null else now() - p_last_seen end,
          case when p_expires is null then null else now() + p_expires end,
          now() - p_created)
$$;

create function pg_temp.seen(n integer, p_source text, p_query text, p_location text, p_ago interval)
returns void language sql as $$
  insert into public.job_sightings (content_hash, source, query, location, last_seen_at)
  values ('hash-' || n, p_source, p_query, p_location, now() - p_ago)
$$;

create function pg_temp.fetched(p_source text, p_query text, p_location text, p_ago interval, p_count integer default 10)
returns void language sql as $$
  insert into public.crawl_fetches (source, query, location, result_count, fetched_at)
  values (p_source, p_query, p_location, p_count, now() - p_ago)
$$;

-- ---------------------------------------------------------------------------
-- Explicit expiry
-- ---------------------------------------------------------------------------
select pg_temp.add_job(1, 'reed', '30 days', '1 day', '-1 day');                 -- expired yesterday
select pg_temp.add_job(2, 'reed', '30 days', '1 day', '5 days');                 -- closes in 5 days
select pg_temp.add_job(3, 'manual_import_xlsx', '30 days', null, '-1 day');      -- imported: never closed
select pg_temp.add_job(4, 'adzuna', '30 days', '1 day');                         -- no stated date

select pg_temp.check('close_expired_jobs closes exactly the one past-dated crawled job',
                     public.close_expired_jobs() = 1);
select pg_temp.check('expired job is inactive with reason expired and a closed_at',
  (select not is_active and closed_reason = 'expired' and closed_at is not null
     from public.jobs where id = pg_temp.j(1)));
select pg_temp.check('job with a future closing date stays active',
  (select is_active and closed_reason is null from public.jobs where id = pg_temp.j(2)));
select pg_temp.check('manual_import_xlsx job is never closed, even past its date',
  (select is_active from public.jobs where id = pg_temp.j(3)));
select pg_temp.check('job without a stated date is untouched by close_expired_jobs',
  (select is_active from public.jobs where id = pg_temp.j(4)));
select pg_temp.check('a second sweep closes nothing more and keeps the first closed_at',
  public.close_expired_jobs() = 0
  and (select closed_at = now() from public.jobs where id = pg_temp.j(1)));

-- Clear the explicit-expiry fixtures so the stale counts below are exact.
delete from public.jobs where id in (pg_temp.j(1), pg_temp.j(2), pg_temp.j(3), pg_temp.j(4));

-- ---------------------------------------------------------------------------
-- Staleness fixtures. Searches: se/london and nurse/leeds.
-- ---------------------------------------------------------------------------
-- Adzuna fetch evidence for se/london: a 25d fetch (older than every sighting
-- below, so it only gives the search its coverage span), two non-empty fetches
-- 15 and 10 days ago, plus an empty one that must never count.
select pg_temp.fetched('adzuna', 'software engineer', 'london', '25 days');
select pg_temp.fetched('adzuna', 'software engineer', 'london', '15 days');
select pg_temp.fetched('adzuna', 'software engineer', 'london', '10 days');
select pg_temp.fetched('adzuna', 'software engineer', 'london', '9 days', 0);
-- Adzuna coverage for nurse/leeds (so the adzuna source is fully covered).
select pg_temp.fetched('adzuna', 'nurse', 'leeds', '14 days');
select pg_temp.fetched('adzuna', 'nurse', 'leeds', '5 days');
-- Reed has only one fetch of se/london and nothing for nurse/leeds: uncovered.
select pg_temp.fetched('reed', 'software engineer', 'london', '10 days');

-- 10: seen 20d ago in se/london; two later non-empty fetches (15d, 10d), the
--     latest 10d after the sighting → STALE
select pg_temp.add_job(10, 'adzuna', '30 days', '20 days');
select pg_temp.seen(10, 'adzuna', 'software engineer', 'london', '20 days');
-- 11: its se/london sighting is 12d old: only ONE non-empty fetch is later
--     (10d; the 9d one is empty) → not stale
select pg_temp.add_job(11, 'adzuna', '30 days', '16 days');
select pg_temp.seen(11, 'adzuna', 'software engineer', 'london', '12 days');
-- 12: posted only 10 days ago → too young, not stale
select pg_temp.add_job(12, 'adzuna', '10 days', '20 days');
select pg_temp.seen(12, 'adzuna', 'software engineer', 'london', '20 days');
-- 13: last seen 10 days ago (< 14 unseen) → not stale
select pg_temp.add_job(13, 'adzuna', '30 days', '10 days');
select pg_temp.seen(13, 'adzuna', 'software engineer', 'london', '20 days');
-- 14: future stated closing date → never stale
select pg_temp.add_job(14, 'adzuna', '30 days', '20 days', '10 days');
select pg_temp.seen(14, 'adzuna', 'software engineer', 'london', '20 days');
-- 15: se/london has moved on, but it was also seen in nurse/leeds 13d ago and
--     only one non-empty fetch there is later (5d) → not stale
select pg_temp.add_job(15, 'adzuna', '30 days', '20 days');
select pg_temp.seen(15, 'adzuna', 'software engineer', 'london', '20 days');
select pg_temp.seen(15, 'adzuna', 'nurse', 'leeds', '13 days');
-- 16: Reed job in se/london — Adzuna fetches there are not Reed evidence → not stale
select pg_temp.add_job(16, 'reed', '30 days', '20 days');
select pg_temp.seen(16, 'reed', 'software engineer', 'london', '20 days');
-- 17: manual_import_xlsx with sightings (should never happen, but must still be excluded)
select pg_temp.add_job(17, 'manual_import_xlsx', '30 days', '20 days');
select pg_temp.seen(17, 'adzuna', 'software engineer', 'london', '20 days');
-- 18: designer/bristol, seen 20d ago; two later non-empty fetches (19d, 17d) but
--     the latest is only 3 days after the sighting → not stale. The 30d fetch
--     (before the sighting) gives the search itself enough span to be covered.
insert into public.discovery_queries (query, location, last_refreshed_at)
values ('designer', 'bristol', now());
select pg_temp.fetched('adzuna', 'designer', 'bristol', '30 days');
select pg_temp.fetched('adzuna', 'designer', 'bristol', '19 days');
select pg_temp.fetched('adzuna', 'designer', 'bristol', '17 days');
select pg_temp.add_job(18, 'adzuna', '30 days', '20 days');
select pg_temp.seen(18, 'adzuna', 'designer', 'bristol', '20 days');

-- 20: legacy adzuna job (no sighting, never seen since tracking) created 60d ago
select pg_temp.add_job(20, 'adzuna', '60 days', null);
-- 21: legacy reed job — reed coverage is incomplete, so never a legacy candidate
select pg_temp.add_job(21, 'reed', '60 days', null);
-- 22: adzuna job with no sighting but created AFTER tracking began → not legacy
select pg_temp.add_job(22, 'adzuna', '30 days', null, null, '00000000-0000-0000-0000-0000000000c1', '5 days');
-- 23: only job of company c2, and stale → the company should leave the public view once closed
select pg_temp.add_job(23, 'adzuna', '30 days', '20 days', null, '00000000-0000-0000-0000-0000000000c2');
select pg_temp.seen(23, 'adzuna', 'software engineer', 'london', '20 days');

-- ---------------------------------------------------------------------------
-- Candidates and dry run
-- ---------------------------------------------------------------------------
select pg_temp.check('stale candidates are exactly jobs 10 and 23',
  (select array_agg(job_id order by job_id) from public.stale_job_candidates()
    ) = array[pg_temp.j(10), pg_temp.j(23)]);

select pg_temp.check('legacy candidates need p_include_legacy and a covered source: only job 20',
  (select array_agg(job_id order by job_id) from public.stale_job_candidates(p_include_legacy => true)
    where kind = 'legacy') = array[pg_temp.j(20)]);

select pg_temp.check('coverage: adzuna fully covered, reed not',
  (select bool_and(covered) from public.job_crawl_coverage() where source = 'adzuna')
  and not (select bool_and(covered) from public.job_crawl_coverage() where source = 'reed'));

select pg_temp.check('close_stale_jobs() defaults to a dry run that closes nothing',
  (select (r->>'dry_run')::boolean and (r->>'closed')::int = 0
          and (r->>'stale_candidates')::int = 2 and (r->>'legacy_candidates')::int = 0
          and not (r->>'coverage_complete')::boolean
     from (select public.close_stale_jobs() r) x)
  and (select bool_and(is_active) from public.jobs));

-- ---------------------------------------------------------------------------
-- Refusals (each inside its own subtransaction)
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    perform public.close_stale_jobs(p_dry_run => false);
    raise exception 'FAIL: apply with uncovered reed searches did not refuse';
  exception when object_not_in_prerequisite_state then
    raise notice 'ok   apply refuses while any (source, search) lacks coverage';
  end;
  begin
    delete from public.discovery_queries;
    perform public.close_stale_jobs(p_dry_run => false, p_sources => array['adzuna']);
    raise exception 'FAIL: apply with no crawled searches did not refuse';
  exception when object_not_in_prerequisite_state then
    raise notice 'ok   apply refuses when nothing has been crawled (no coverage to verify)';
  end;
  begin
    perform public.close_stale_jobs(p_min_fetches => 1);
    raise exception 'FAIL: p_min_fetches below the floor was accepted';
  exception when invalid_parameter_value then
    raise notice 'ok   thresholds below the safety floors are rejected';
  end;
  begin
    perform public.stale_job_candidates(p_sources => array['adzuna', 'manual_import_xlsx']);
    raise exception 'FAIL: manual_import_xlsx was accepted as a stale source';
  exception when invalid_parameter_value then
    raise notice 'ok   manual_import_xlsx cannot be named as a stale source';
  end;
end
$$;

select pg_temp.check('refusals left every job active',
  (select bool_and(is_active) from public.jobs));

-- ---------------------------------------------------------------------------
-- Apply, limited to the fully covered source
-- ---------------------------------------------------------------------------
select pg_temp.check('company c2 shows one open job before its only job closes',
  (select open_jobs from public.public_company_summary where id = '00000000-0000-0000-0000-0000000000c2') = 1);

select pg_temp.check('apply for adzuna closes exactly the two stale jobs (no legacy without the flag)',
  (select (r->>'closed')::int = 2 and not (r->>'dry_run')::boolean
     from (select public.close_stale_jobs(p_dry_run => false, p_sources => array['adzuna']) r) x));

select pg_temp.check('closed stale jobs carry reason stale; nothing else closed',
  (select array_agg(id order by id) from public.jobs where not is_active) = array[pg_temp.j(10), pg_temp.j(23)]
  and (select bool_and(closed_reason = 'stale' and closed_at is not null) from public.jobs where not is_active));

-- 048: the company stays listed, with no open jobs.
select pg_temp.check('a company whose only job closed stays in public_company_summary with 0 open jobs',
  (select open_jobs from public.public_company_summary where id = '00000000-0000-0000-0000-0000000000c2') = 0);

-- (Run the apply and inspect the rows in separate statements: one statement
-- cannot see the rows its own function call just updated.)
select pg_temp.check('legacy apply closes one job',
  (select (r->>'closed')::int = 1
     from (select public.close_stale_jobs(p_dry_run => false, p_include_legacy => true,
                                          p_sources => array['adzuna']) r) x));
select pg_temp.check('the legacy job closed is the covered-source one; uncovered and post-tracking ones stay',
  (select not is_active and closed_reason = 'stale' from public.jobs where id = pg_temp.j(20))
  and (select is_active from public.jobs where id = pg_temp.j(21))
  and (select is_active from public.jobs where id = pg_temp.j(22)));

select pg_temp.check('manual_import_xlsx job 17 is still active after every sweep',
  (select is_active from public.jobs where id = pg_temp.j(17)));

-- ---------------------------------------------------------------------------
-- Integrity and privileges
-- ---------------------------------------------------------------------------
delete from public.jobs where id = pg_temp.j(15);
select pg_temp.check('deleting a job cascades to its sightings',
  not exists (select 1 from public.job_sightings where content_hash = 'hash-15'));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    set local role anon;
    begin
      perform 1 from public.job_sightings;
      raise exception 'FAIL: anon could read job_sightings';
    exception when insufficient_privilege then
      raise notice 'ok   anon cannot read job_sightings';
    end;
    begin
      perform public.close_expired_jobs();
      raise exception 'FAIL: anon could execute close_expired_jobs';
    exception when insufficient_privilege then
      raise notice 'ok   anon cannot execute close_expired_jobs';
    end;
    reset role;
  end if;
end
$$;

do $$ begin raise notice 'ALL JOB EXPIRY SQL CHECKS PASSED'; end $$;
rollback;
