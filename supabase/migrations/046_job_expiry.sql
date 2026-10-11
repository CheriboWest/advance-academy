-- ============================================================================
--  046 — Job expiry: close jobs the source says have closed, and (dry-run by
--  default) jobs that successful crawls have stopped returning.
--  Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
--  Idempotent: safe to re-run. Purely additive — no existing column, view or
--  policy changes, so every reader that filters on `jobs.is_active` (the
--  public_company_summary view, the "Public can read active jobs" policy, the
--  student queries in features/career-hub/lib) picks up closures unchanged.
--
--  Depends on: 023a / 024 (public.jobs with the unique content_hash, public.
--  discovery_queries). Nothing here references companies, so the
--  unhandled-FK guard in delete_companies_permanently() (039) is unaffected;
--  job_sightings cascades from jobs, which that function already deletes.
--
--  Why: before this migration nothing ever set jobs.is_active = false — the
--  crawler upserted `true` on every sighting — so every job ever crawled stayed
--  visible to students until its company was deleted.
--
--  Two kinds of closure, deliberately kept apart:
--
--    expired  The source stated a closing date and it has passed (Reed's
--             `expirationDate`). Needs no crawl at all, so close_expired_jobs()
--             is safe to run on a schedule and after every crawl.
--
--    stale    Not returned by repeated, fully successful fetches of the same
--             search. Absence is weak evidence — each fetch is page 1 only, at
--             most 50 results, ranked by relevance — so close_stale_jobs() is a
--             DRY RUN unless called with p_dry_run => false, and even then it
--             refuses to close anything until every crawled search has enough
--             successful fetches for every source asked about.
--
--  Evidence tables (service_role only, written by backend-python's crawler):
--    crawl_fetches  one row per source fetch whose results were completely
--                   ingested. A source that errored, was not configured, had
--                   its results truncated, or was part of a (query, location)
--                   pair that failed anywhere is never written. Empty fetches
--                   are written (result_count = 0) so coverage gaps are
--                   visible, but never count as evidence.
--    job_sightings  the last time each (job, source, query, location) was seen.
--
--  `manual_import_xlsx` jobs (contacts importer) are never crawled and are
--  excluded from both kinds of closure.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. jobs: expiry and observation columns
-- ---------------------------------------------------------------------------
alter table if exists public.jobs
  -- Closing time the source stated. Never cleared by a source that omits it.
  add column if not exists expires_at    timestamptz,
  -- Last time any fetch returned this job. NULL = not observed since this
  -- migration (every row that predates it), which is NOT evidence of anything.
  add column if not exists last_seen_at  timestamptz,
  add column if not exists closed_at     timestamptz,
  add column if not exists closed_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'jobs_closed_reason_check'
       and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs
      add constraint jobs_closed_reason_check
      check (closed_reason in ('expired', 'stale'));
  end if;
end
$$;

create index if not exists jobs_active_expires_at_idx
  on public.jobs (expires_at)
  where is_active and expires_at is not null;

create index if not exists jobs_active_last_seen_at_idx
  on public.jobs (last_seen_at)
  where is_active;

-- ---------------------------------------------------------------------------
-- 2. crawl_fetches: completed source fetches (the only evidence of absence)
-- ---------------------------------------------------------------------------
create table if not exists public.crawl_fetches (
  id           bigint generated always as identity primary key,
  -- crawl_runs.id. No foreign key on purpose: crawl_runs has a history of
  -- schema drift, and the evidence must outlive any clean-up of old runs.
  run_id       uuid,
  source       text        not null,
  -- Normalised exactly as discovery_queries stores them (normalize_query).
  query        text        not null,
  location     text        not null,
  result_count integer     not null check (result_count >= 0),
  -- The same instant the crawler stamps on this pair's job_sightings, so a
  -- fetch never counts as evidence against a job it returned itself.
  fetched_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

create index if not exists crawl_fetches_scope_idx
  on public.crawl_fetches (source, query, location, fetched_at desc);

-- ---------------------------------------------------------------------------
-- 3. job_sightings: where and when each job was last returned
-- ---------------------------------------------------------------------------
create table if not exists public.job_sightings (
  content_hash  text        not null
                references public.jobs (content_hash) on delete cascade,
  source        text        not null,
  query         text        not null,
  location      text        not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null,
  primary key (content_hash, source, query, location)
);

-- ---------------------------------------------------------------------------
-- 4. RLS: deny by default, service_role only — same posture as 034 contacts.
-- ---------------------------------------------------------------------------
alter table public.crawl_fetches enable row level security;
alter table public.job_sightings enable row level security;

do $$
declare
  tbl text;
  role_name text;
begin
  foreach tbl in array array['public.crawl_fetches', 'public.job_sightings'] loop
    execute format('revoke all on %s from public', tbl);
    foreach role_name in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on %s from %I', tbl, role_name);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all on %s to service_role', tbl);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. close_expired_jobs(): close every active job whose stated closing time
--    has passed. Returns how many it closed.
-- ---------------------------------------------------------------------------
create or replace function public.close_expired_jobs()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_closed integer;
begin
  update public.jobs
     set is_active     = false,
         closed_at     = now(),
         closed_reason = 'expired'
   where is_active
     and expires_at is not null
     and expires_at <= now()
     and source is distinct from 'manual_import_xlsx';
  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Shared guard for the staleness thresholds. Floors stop a typo (or an
--    over-eager caller) turning one unlucky fetch into mass closure.
-- ---------------------------------------------------------------------------
create or replace function public.assert_job_staleness_args(
  p_unseen       interval,
  p_min_age      interval,
  p_min_fetches  integer,
  p_min_span     interval,
  p_sources      text[]
)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_min_fetches is null or p_min_fetches < 2 then
    raise exception 'p_min_fetches must be at least 2 (got %)', p_min_fetches
      using errcode = 'invalid_parameter_value';
  end if;
  if p_unseen is null or p_unseen < interval '7 days' then
    raise exception 'p_unseen must be at least 7 days (got %)', p_unseen
      using errcode = 'invalid_parameter_value';
  end if;
  if p_min_age is null or p_min_age < interval '7 days' then
    raise exception 'p_min_age must be at least 7 days (got %)', p_min_age
      using errcode = 'invalid_parameter_value';
  end if;
  if p_min_span is null or p_min_span < interval '1 day' then
    raise exception 'p_min_span must be at least 1 day (got %)', p_min_span
      using errcode = 'invalid_parameter_value';
  end if;
  if p_sources is null or cardinality(p_sources) = 0 then
    raise exception 'p_sources must name at least one crawled source'
      using errcode = 'invalid_parameter_value';
  end if;
  if 'manual_import_xlsx' = any (p_sources) then
    raise exception 'manual_import_xlsx jobs are never crawled and cannot go stale'
      using errcode = 'invalid_parameter_value';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. job_crawl_coverage(): for every search ever crawled (discovery_queries)
--    and every source asked about, how much non-empty fetch evidence exists.
--    A (search, source) is covered once it has >= p_min_fetches non-empty
--    completed fetches spanning >= p_min_span.
-- ---------------------------------------------------------------------------
create or replace function public.job_crawl_coverage(
  p_min_fetches integer  default 2,
  p_min_span    interval default interval '7 days',
  p_sources     text[]   default array['adzuna', 'reed']
)
returns table (
  source           text,
  query            text,
  location         text,
  nonempty_fetches integer,
  first_fetch_at   timestamptz,
  last_fetch_at    timestamptz,
  covered          boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.source,
         dq.query,
         dq.location,
         coalesce(f.n, 0)::integer,
         f.first_at,
         f.last_at,
         coalesce(f.n, 0) >= p_min_fetches
           and f.last_at - f.first_at >= p_min_span
    from public.discovery_queries dq
   cross join unnest(p_sources) as s(source)
    left join lateral (
      select count(*) as n,
             min(cf.fetched_at) as first_at,
             max(cf.fetched_at) as last_at
        from public.crawl_fetches cf
       where cf.source = s.source
         and cf.query = dq.query
         and cf.location = dq.location
         and cf.result_count > 0
    ) f on true;
$$;

-- ---------------------------------------------------------------------------
-- 8. stale_job_candidates(): the jobs close_stale_jobs() would close, and why.
--    Read-only. `kind` is:
--      'stale'  seen since tracking began, and EVERY (source, search) it was
--               seen in has since had >= p_min_fetches non-empty completed
--               fetches without it, the latest >= p_min_span after the sighting.
--      'legacy' (only with p_include_legacy) predates tracking — no sighting at
--               all — and its source's coverage is complete.
--    Both also require: active, a crawled source in p_sources, NO stated
--    closing date at all (a job with one is open until that date and is closed
--    by close_expired_jobs, never guessed at), unseen for p_unseen and older
--    than p_min_age.
-- ---------------------------------------------------------------------------
create or replace function public.stale_job_candidates(
  p_unseen         interval default interval '14 days',
  p_min_age        interval default interval '21 days',
  p_min_fetches    integer  default 2,
  p_min_span       interval default interval '7 days',
  p_sources        text[]   default array['adzuna', 'reed'],
  p_include_legacy boolean  default false
)
returns table (
  job_id       uuid,
  content_hash text,
  source       text,
  kind         text,
  posted_at    timestamptz,
  last_seen_at timestamptz,
  sightings    integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tracking_started timestamptz;
  v_covered_sources  text[];
begin
  perform public.assert_job_staleness_args(
    p_unseen, p_min_age, p_min_fetches, p_min_span, p_sources);

  select min(cf.fetched_at) into v_tracking_started from public.crawl_fetches cf;

  -- Sources whose every crawled search is covered. Empty when nothing has been
  -- crawled yet (no discovery_queries) — "nothing to check" is not coverage.
  select coalesce(array_agg(c.source), '{}')
    into v_covered_sources
    from (
      select cov.source
        from public.job_crawl_coverage(p_min_fetches, p_min_span, p_sources) cov
       group by cov.source
      having bool_and(cov.covered)
    ) c;

  return query
  with base as (
    select j.*
      from public.jobs j
     where j.is_active
       and j.source = any (p_sources)
       and j.source is distinct from 'manual_import_xlsx'
       and j.expires_at is null
       and coalesce(j.posted_at, j.created_at) < now() - p_min_age
  ),
  stale as (
    select b.id, b.content_hash, b.source, 'stale'::text as kind,
           b.posted_at, b.last_seen_at,
           (select count(*)::integer from public.job_sightings s
             where s.content_hash = b.content_hash) as sightings
      from base b
     where b.last_seen_at is not null
       and b.last_seen_at < now() - p_unseen
       and exists (
         select 1 from public.job_sightings s
          where s.content_hash = b.content_hash
       )
       -- Every place it was seen must have moved on without it.
       and not exists (
         select 1
           from public.job_sightings s
           left join lateral (
             select count(*) as n, max(cf.fetched_at) as latest
               from public.crawl_fetches cf
              where cf.source = s.source
                and cf.query = s.query
                and cf.location = s.location
                and cf.result_count > 0
                and cf.fetched_at > s.last_seen_at
           ) ev on true
          where s.content_hash = b.content_hash
            and not (
              ev.n >= p_min_fetches
              and ev.latest >= s.last_seen_at + p_min_span
            )
       )
  ),
  legacy as (
    select b.id, b.content_hash, b.source, 'legacy'::text as kind,
           b.posted_at, b.last_seen_at, 0 as sightings
      from base b
     where p_include_legacy
       and v_tracking_started is not null
       and v_tracking_started < now() - p_unseen
       and b.source = any (v_covered_sources)
       and b.last_seen_at is null
       and b.created_at < v_tracking_started
       and not exists (
         select 1 from public.job_sightings s
          where s.content_hash = b.content_hash
       )
  )
  select * from stale
  union all
  select * from legacy;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. close_stale_jobs(): report (default) or close stale jobs.
--    Dry run unless p_dry_run => false. A real run additionally refuses —
--    raises, closes nothing — unless coverage is complete for every source in
--    p_sources. Returns a jsonb summary either way.
-- ---------------------------------------------------------------------------
create or replace function public.close_stale_jobs(
  p_dry_run        boolean  default true,
  p_include_legacy boolean  default false,
  p_unseen         interval default interval '14 days',
  p_min_age        interval default interval '21 days',
  p_min_fetches    integer  default 2,
  p_min_span       interval default interval '7 days',
  p_sources        text[]   default array['adzuna', 'reed']
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dry_run   boolean := coalesce(p_dry_run, true);
  v_uncovered jsonb;
  v_stale     integer;
  v_legacy    integer;
  v_closed    integer := 0;
  v_sample    jsonb;
begin
  perform public.assert_job_staleness_args(
    p_unseen, p_min_age, p_min_fetches, p_min_span, p_sources);

  select coalesce(jsonb_agg(jsonb_build_object(
           'source', cov.source, 'query', cov.query, 'location', cov.location,
           'nonempty_fetches', cov.nonempty_fetches)
           order by cov.source, cov.query, cov.location), '[]'::jsonb)
    into v_uncovered
    from public.job_crawl_coverage(p_min_fetches, p_min_span, p_sources) cov
   where not cov.covered;

  if not v_dry_run then
    if not exists (select 1 from public.discovery_queries) then
      raise exception 'Refusing to close stale jobs: no crawled searches yet, so coverage cannot be verified'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if jsonb_array_length(v_uncovered) > 0 then
      raise exception 'Refusing to close stale jobs: % (source, search) pairs lack % non-empty fetches over %. Run close_stale_jobs() as a dry run to list them.',
        jsonb_array_length(v_uncovered), p_min_fetches, p_min_span
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  -- Candidates are materialised once so the summary, the sample and the UPDATE
  -- all act on the same set. Dropped at commit; reused if called twice in one
  -- transaction.
  if to_regclass('pg_temp.stale_job_ids') is null then
    create temporary table stale_job_ids (
      id uuid primary key, kind text not null
    ) on commit drop;
  else
    truncate pg_temp.stale_job_ids;
  end if;

  insert into pg_temp.stale_job_ids (id, kind)
  select c.job_id, c.kind
    from public.stale_job_candidates(
      p_unseen, p_min_age, p_min_fetches, p_min_span, p_sources, p_include_legacy) c;

  select count(*) filter (where kind = 'stale'),
         count(*) filter (where kind = 'legacy')
    into v_stale, v_legacy
    from pg_temp.stale_job_ids;

  select coalesce(jsonb_agg(t.id), '[]'::jsonb)
    into v_sample
    from (select id from pg_temp.stale_job_ids order by id limit 20) t;

  if not v_dry_run then
    update public.jobs j
       set is_active     = false,
           closed_at     = now(),
           closed_reason = 'stale'
      from pg_temp.stale_job_ids t
     where j.id = t.id
       and j.is_active;
    get diagnostics v_closed = row_count;
  end if;

  return jsonb_build_object(
    'dry_run',            v_dry_run,
    'include_legacy',     coalesce(p_include_legacy, false),
    'sources',            to_jsonb(p_sources),
    'coverage_complete',  jsonb_array_length(v_uncovered) = 0
                            and exists (select 1 from public.discovery_queries),
    'uncovered_count',    jsonb_array_length(v_uncovered),
    'uncovered',          v_uncovered,
    'stale_candidates',   v_stale,
    'legacy_candidates',  v_legacy,
    'closed',             v_closed,
    'sample_job_ids',     v_sample
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Execution rights — service_role only, same posture as 033.
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  role_name text;
begin
  foreach fn in array array[
    'public.close_expired_jobs()',
    'public.assert_job_staleness_args(interval, interval, integer, interval, text[])',
    'public.job_crawl_coverage(integer, interval, text[])',
    'public.stale_job_candidates(interval, interval, integer, interval, text[], boolean)',
    'public.close_stale_jobs(boolean, boolean, interval, interval, integer, interval, text[])'
  ] loop
    execute format('revoke all on function %s from public', fn);
    foreach role_name in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on function %s from %I', fn, role_name);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;
end
$$;

-- Optional, NOT run by this migration — schedule only after reading
-- docs/JOB_EXPIRY.md. Needs the pg_cron extension (Database → Extensions).
--
--   select cron.schedule('close-expired-jobs', '7 * * * *',
--                        $$select public.close_expired_jobs()$$);
--
-- close_stale_jobs() is deliberately not scheduled here; see the runbook.
