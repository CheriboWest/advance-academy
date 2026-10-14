-- ============================================================================
--  048 — List every company, hide expired jobs at read time, close them hourly.
--  Run in Supabase SQL Editor. Idempotent: safe to re-run.
--
--  1. public_company_summary was an INNER JOIN on active jobs (024 → 037), so a
--     company with no open job had no row: /search couldn't reach most of the
--     ~7,000 companies, and /companies/<slug>, the coach company profile and
--     Contact Directory links 404ed once a company's last job closed. It is now
--     a LEFT JOIN with open_jobs = 0 for those companies. Same columns, same
--     order (backend-python/test_public_company_summary_view.py checks), so no
--     new data is exposed — only more rows of the same columns. The frontend
--     filters `open_jobs > 0` wherever it means "companies hiring".
--
--  2. Jobs past their stated `expires_at` stayed visible until the next crawl
--     ran close_expired_jobs() (046). The view and the "Public can read active
--     jobs" policy now also require the job not to have expired, with the same
--     manual_import_xlsx exemption close_expired_jobs() has.
--
--  3. close_expired_jobs() is scheduled hourly with pg_cron (the line 046 left
--     commented out), so `is_active` catches up without a crawl. Skipped with a
--     notice where pg_cron isn't available (local test clusters).
--
--  4. coach_company_page(): one page of the coach Sponsored Companies list,
--     filtered in SQL (confirmed sponsors only by default, name search, the
--     coach's hidden companies left out) with contact counts and the total.
--     It replaces downloading every company and sending every id back in a
--     ~20 KB `?company_ids=` URL for the counts. Service role only; the coach
--     check is backend-python's (/sponsors/companies).
-- ============================================================================

-- ── 1 + 2. The view ─────────────────────────────────────────────────────────
create or replace view public.public_company_summary as
select
  c.id,
  c.slug,
  c.name,
  c.website,
  c.careers_url,
  c.sector,
  c.region,
  c.hq_location,
  c.lead_score,
  count(j.id) as open_jobs,
  c.ai_summary,
  c.ai_summary_generated_at
from public.companies c
left join public.jobs j
  on j.company_id = c.id
 and j.is_active = true
 and (j.expires_at is null or j.expires_at > now() or j.source = 'manual_import_xlsx')
group by c.id;

-- 031: the view must run with the caller's rights, not its owner's.
alter view public.public_company_summary set (security_invoker = true);

comment on view public.public_company_summary is
  'Every company with its count of open (active, unexpired) jobs; 0 when none (048).';

-- ── 2. The jobs read policy (041) ───────────────────────────────────────────
drop policy if exists "Public can read active jobs" on public.jobs;

create policy "Public can read active jobs" on public.jobs
  as permissive for select to anon, authenticated
  using (is_active = true and (expires_at is null or expires_at > now() or source = 'manual_import_xlsx'));

-- ── 3. Hourly expiry ────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron not available: close_expired_jobs() not scheduled';
    return;
  end if;
  create extension if not exists pg_cron;
  -- cron.schedule with an existing job name updates that job, so re-running is safe.
  perform cron.schedule('close-expired-jobs', '7 * * * *', 'select public.close_expired_jobs()');
end
$$;

-- ── 4. Coach Sponsored Companies, one page ──────────────────────────────────
create or replace function public.coach_company_page(
  p_coach    uuid,
  p_licensed boolean,
  p_q        text    default null,
  p_offset   integer default 0,
  p_limit    integer default 30
)
returns table (
  id          uuid,
  slug        text,
  name        text,
  sector      text,
  region      text,
  hq_location text,
  lead_score  integer,
  open_jobs   bigint,
  contacts    bigint,
  total       bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.slug, s.name, s.sector, s.region, s.hq_location, s.lead_score, s.open_jobs,
         (select count(*) from public.contacts k where k.company_id = s.id),
         count(*) over ()
    from public.public_company_summary s
   where (not p_licensed
          or exists (select 1 from public.company_sponsorship_current c where c.company_id = s.id))
     and (p_q is null or s.name ilike '%' || p_q || '%')
     and not exists (select 1 from public.coach_company_meta m
                      where m.company_id = s.id and m.coach_user_id = p_coach and m.hidden)
   order by s.name, s.id
  offset greatest(p_offset, 0)
   limit least(greatest(p_limit, 1), 100)
$$;

revoke all on function public.coach_company_page(uuid, boolean, text, integer, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.coach_company_page(uuid, boolean, text, integer, integer) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.coach_company_page(uuid, boolean, text, integer, integer) to service_role;
  end if;
end
$$;
