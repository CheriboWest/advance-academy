-- ============================================================================
--  049 — Bulk company/contact importer (CareerHub CRM, /coach/contacts/import)
--  Run in Supabase SQL Editor. Idempotent: safe to re-run. Additive only.
--  Design and rollout: backend-python/app/contacts_import/CLAUDE.md.
--
--  Reuses public.companies and public.contacts (034). Adds:
--    * company_aliases            — verified alternative names for a company,
--                                   created only when an admin confirms a match
--    * contact_import_batches     — one uploaded file: mapping, status, summary
--    * contact_import_rows        — every source row, raw cells preserved, its
--                                   classification, the admin's resolution and
--                                   the commit result / error
--    * ci_norm_* normalizers      — the ONE definition of "same email / phone /
--                                   LinkedIn profile / domain / name"; preview
--                                   and commit both match through them
--    * contact_import_classify()  — preview: matched / new / needs_review /
--                                   invalid / skipped, per row. A company
--                                   matches by exact name or verified alias
--                                   only; a website domain alone never does
--    * contact_import_commit()    — the import, in ONE transaction under an
--                                   advisory lock: any row error rolls every
--                                   write back and records row-level errors
--
--  The staging tables deliberately carry no foreign keys to companies or
--  contacts (ids are kept as provenance): delete_companies_permanently()'s
--  unhandled-FK guard must keep working, and history must outlive a deleted
--  company. company_aliases does reference companies, so it is added to that
--  guard's allowlist below — the only change to that function.
--
--  Everything here is service_role only (RLS on, no policies, revoked from
--  anon/authenticated); backend-python is the only caller, behind its admin
--  gate (app/auth.py get_current_user).
--
--  Depends on: 001 (companies), 024 (companies.slug unique), 023a (jobs),
--  034 (contacts), 039 (delete_companies_permanently, replaced below).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Normalizers. IMMUTABLE so they can back expression indexes.
-- ---------------------------------------------------------------------------

-- "Exact name" after unicode/case/punctuation/whitespace noise: "ACME  Ltd." and
-- "Acme Ltd" match; "Acme Ltd" and "Acme" do NOT (legal suffixes are kept — the
-- slug is the looser key, and a slug-only match is sent to review, never merged).
create or replace function public.ci_norm_name(p text) returns text
language sql immutable parallel safe set search_path = pg_catalog as $$
  select nullif(btrim(regexp_replace(
           regexp_replace(replace(lower(normalize(p, NFKC)), '&', ' and '), '[^[:alnum:][:space:]]', ' ', 'g'),
           '\s+', ' ', 'g')), '')
$$;

create or replace function public.ci_norm_email(p text) returns text
language sql immutable parallel safe set search_path = pg_catalog as $$
  select case when lower(btrim(normalize(p, NFKC))) ~ '^[^@\s]+@[^@\s]+\.[^@\s.]+$'
              then lower(btrim(normalize(p, NFKC))) end
$$;

-- UK-centric: "+44 (0)20 7946 0000", "0044 20 7946 0000" and "020 7946 0000"
-- all become "02079460000". Under 7 digits is not a phone number.
create or replace function public.ci_norm_phone(p text) returns text
language sql immutable parallel safe set search_path = pg_catalog as $$
  select case
    when d is null or length(d) < 7 then null
    when d like '0044%' then '0' || ltrim(substr(d, 5), '0')
    when d like '440%' and length(d) = 13 then '0' || substr(d, 4)
    when d like '44%' and length(d) = 12 then '0' || substr(d, 3)
    else d end
  from (select nullif(regexp_replace(normalize(p, NFKC), '\D', '', 'g'), '') as d) x
$$;

-- A LinkedIn PERSON profile, reduced to "linkedin.com/in/<handle>". Anything
-- else (company pages, posts, display text that isn't a URL) is null: display
-- text is never treated as a URL unless it is one.
create or replace function public.ci_norm_linkedin(p text) returns text
language sql immutable parallel safe set search_path = pg_catalog as $$
  select 'linkedin.com/in/' || lower(m[1])
  from (select regexp_match(btrim(p), '^https?://(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com/in/([^/?#\s]+)/?(?:[?#].*)?$', 'i') as m) x
  where m is not null
$$;

-- Host of a URL or bare domain, lower-cased, without "www." or a port.
create or replace function public.ci_norm_domain(p text) returns text
language sql immutable parallel safe set search_path = pg_catalog as $$
  select case when h ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then h end
  from (select regexp_replace(
                 split_part(split_part(split_part(split_part(
                   regexp_replace(lower(btrim(p)), '^[a-z][a-z0-9+.-]*://', ''), '/', 1), '?', 1), '#', 1), ':', 1),
                 '^www\.', '') as h) x
$$;

-- Hosts shared by many organisations never identify an employer: a "website"
-- on one of these (or any subdomain of one) is not a company domain. Job
-- boards and applicant-tracking systems, social sites, maps and review sites,
-- link shorteners, webmail, and site builders/hosting where every customer
-- lives under the same domain. Even so, a domain alone never matches a
-- company (contact_import_classify); this list only keeps such hosts out of
-- canonical_domain and out of the candidates an admin is shown.
create or replace function public.ci_generic_domain(p text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog as $$
  select p is not null and exists (
    select 1 from unnest(array[
      -- job boards and applicant tracking
      'linkedin.com', 'lnkd.in', 'indeed.com', 'indeed.co.uk', 'reed.co.uk', 'totaljobs.com', 'cv-library.co.uk',
      'glassdoor.com', 'glassdoor.co.uk', 'adzuna.co.uk', 'adzuna.com', 'monster.co.uk', 'monster.com', 'jobsite.co.uk',
      'cwjobs.co.uk', 'ziprecruiter.co.uk', 'ziprecruiter.com', 'simplyhired.co.uk', 'jooble.org', 'efinancialcareers.com',
      'guardianjobs.co.uk', 'jobs.ac.uk', 'lever.co', 'greenhouse.io', 'workable.com', 'smartrecruiters.com',
      'myworkdayjobs.com', 'teamtailor.com', 'bamboohr.com', 'recruitee.com', 'jobvite.com', 'icims.com', 'ashbyhq.com',
      'breezy.hr', 'pinpointhq.com', 'applytojob.com', 'personio.de', 'personio.com', 'hibob.com',
      -- government, search, maps, reviews and company directories
      'gov.uk', 'google.com', 'google.co.uk', 'goo.gl', 'g.page', 'maps.apple.com', 'bing.com', 'trustpilot.com',
      'yell.com', 'crunchbase.com', 'zoominfo.com', 'endole.co.uk', 'companycheck.co.uk',
      -- social and content
      'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'youtu.be', 'tiktok.com',
      'pinterest.com', 'threads.net', 'medium.com', 'substack.com', 'linktr.ee', 'about.me', 'wa.me', 'whatsapp.com',
      'calendly.com', 'eventbrite.co.uk', 'eventbrite.com',
      -- link shorteners
      'bit.ly', 'tinyurl.com', 'ow.ly', 't.co', 'rebrand.ly', 'forms.gle',
      -- webmail
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk', 'msn.com',
      'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'proton.me', 'gmx.com',
      'btinternet.com', 'sky.com', 'virginmedia.com',
      -- site builders, hosting and file sharing
      'wixsite.com', 'wix.com', 'squarespace.com', 'weebly.com', 'wordpress.com', 'blogspot.com', 'godaddysites.com',
      'webflow.io', 'carrd.co', 'notion.site', 'github.io', 'github.com', 'gitlab.io', 'netlify.app', 'vercel.app',
      'herokuapp.com', 'pages.dev', 'firebaseapp.com', 'web.app', 'azurewebsites.net', 'cloudfront.net',
      'amazonaws.com', 'myshopify.com', 'square.site', 'sharepoint.com', 'dropbox.com', 'typeform.com',
      'jotform.com', 'hubspotpagebuilder.com', 'hs-sites.com', 'list-manage.com']) g
    where p = g or p like '%.' || g)
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.company_aliases (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  alias            text not null check (btrim(alias) <> ''),
  normalized_alias text generated always as (public.ci_norm_name(alias)) stored not null,
  source           text not null default 'import_review' check (source in ('import_review', 'manual')),
  verified_by      uuid not null,
  verified_at      timestamptz not null default now(),
  import_batch_id  uuid,
  created_at       timestamptz not null default now(),
  -- One company per alias, or the alias would be ambiguous by construction.
  constraint company_aliases_normalized_alias_key unique (normalized_alias)
);
create index if not exists company_aliases_company_idx on public.company_aliases (company_id);
comment on table public.company_aliases is
  'Alternative names an admin has confirmed for a company (e.g. while resolving an import row). '
  'Matching by alias is exact on ci_norm_name — never fuzzy.';

create table if not exists public.contact_import_batches (
  id           uuid primary key default gen_random_uuid(),
  created_by   uuid not null,
  file_name    text not null,
  file_kind    text not null check (file_kind in ('xlsx', 'csv')),
  file_sha256  text not null,
  file_size    integer not null check (file_size >= 0),
  -- 'uploading' until every row is stored: a batch the upload never finished
  -- stays marked as such (and can't be mapped or committed) rather than
  -- passing for a complete file.
  status       text not null default 'uploaded'
               constraint contact_import_batches_status_check
               check (status in ('uploading', 'uploaded', 'previewed', 'committed', 'failed')),
  sheets       jsonb not null default '[]',   -- [{name, index, headers, suggested_mapping, row_count}]
  mapping      jsonb,                         -- {sheet: {include, group_fill, columns: {col: role}}}
  summary      jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  previewed_at timestamptz,
  committed_at timestamptz,
  committed_by uuid
);
-- Re-runs over an earlier draft of this migration pick up 'uploading'.
alter table public.contact_import_batches drop constraint if exists contact_import_batches_status_check;
alter table public.contact_import_batches add constraint contact_import_batches_status_check
  check (status in ('uploading', 'uploaded', 'previewed', 'committed', 'failed'));
create index if not exists contact_import_batches_created_idx on public.contact_import_batches (created_at desc);
create index if not exists contact_import_batches_sha_idx on public.contact_import_batches (file_sha256);

create table if not exists public.contact_import_rows (
  id                 bigint generated always as identity primary key,
  batch_id           uuid not null references public.contact_import_batches (id) on delete cascade,
  sheet              text not null,
  sheet_index        integer not null default 0,
  row_number         integer not null,
  raw                jsonb not null,           -- every cell as read: value, text, hyperlink, header
  extracted          jsonb,                    -- set when the mapping is applied
  parse_errors       text[] not null default '{}',
  classification     text check (classification in ('matched', 'new', 'needs_review', 'invalid', 'skipped')),
  company_status     text,
  contact_status     text,
  company_match      jsonb,                    -- {id, method} or {pending_row}
  contact_match      jsonb,
  company_candidates jsonb not null default '[]',
  contact_candidates jsonb not null default '[]',
  reasons            text[] not null default '{}',
  source_job_id      uuid,                     -- an existing jobs row whose source_url is this row's link
  resolution         jsonb,                    -- the admin's decision for a needs_review row
  result_status      text check (result_status in ('created', 'updated', 'matched', 'skipped', 'failed', 'rolled_back')),
  result             jsonb,
  error              text,
  constraint contact_import_rows_unique unique (batch_id, sheet, row_number)
);
create index if not exists contact_import_rows_batch_idx on public.contact_import_rows (batch_id, sheet_index, row_number);

-- ---------------------------------------------------------------------------
-- 3. Lookup indexes for the normalized keys (all additive).
-- ---------------------------------------------------------------------------
create index if not exists companies_ci_name_idx on public.companies (public.ci_norm_name(name));
create index if not exists companies_ci_canonical_domain_idx on public.companies (public.ci_norm_domain(canonical_domain));
create index if not exists companies_ci_website_idx on public.companies (public.ci_norm_domain(website));
create index if not exists companies_ci_website_url_idx on public.companies (public.ci_norm_domain(website_url));
create index if not exists contacts_ci_email_idx on public.contacts (public.ci_norm_email(email));
create index if not exists contacts_ci_linkedin_idx on public.contacts (public.ci_norm_linkedin(linkedin_url));
create index if not exists contacts_ci_company_name_idx on public.contacts (company_id, public.ci_norm_name(full_name));

-- ---------------------------------------------------------------------------
-- 4. RLS on; service_role only.
-- ---------------------------------------------------------------------------
do $$
declare t text; r text;
begin
  foreach t in array array['company_aliases', 'contact_import_batches', 'contact_import_rows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on public.%I from %I', t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
    end if;
  end loop;
  -- contact_import_rows.id's identity sequence: Supabase's default privileges
  -- hand it to anon and authenticated too. Only service_role inserts rows.
  execute 'revoke all on sequence public.contact_import_rows_id_seq from public';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on sequence public.contact_import_rows_id_seq from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage, select on sequence public.contact_import_rows_id_seq to service_role';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. delete_companies_permanently: 039's function, unchanged except for
--    company_aliases on the allowlist.
-- ---------------------------------------------------------------------------
create or replace function public.delete_companies_permanently(
  p_company_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids            uuid[];
  v_unhandled      text;
  v_deleted_ids    uuid[] := '{}';
  v_jobs           integer := 0;
  v_meta           integer := 0;
  v_outreach       integer := 0;
  v_contacts       integer := 0;
begin
  select coalesce(array_agg(distinct id), '{}')
    into v_ids
    from unnest(coalesce(p_company_ids, '{}'::uuid[])) as id
   where id is not null;

  if array_length(v_ids, 1) is null then
    return jsonb_build_object(
      'requested', 0,
      'deleted_companies', 0,
      'deleted_company_ids', '[]'::jsonb,
      'missing_company_ids', '[]'::jsonb,
      'deleted_jobs', 0,
      'deleted_coach_meta', 0,
      'unlinked_outreach_emails', 0,
      'deleted_contacts', 0
    );
  end if;

  select string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by c.relname)
    into v_unhandled
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where con.contype = 'f'
     and con.confrelid = 'public.companies'::regclass
     and format('%I.%I', n.nspname, c.relname) not in (
       'public.jobs', 'public.coach_company_meta', 'public.outreach_emails',
       'public.contacts',
       -- AdvanceAcademyTools tables (migrations 001 and 008). Each already
       -- declares the on-delete action this function would otherwise have to
       -- repeat by hand, so listing them here is the whole fix:
       --   company_research_reports  on delete cascade   (research about the
       --     company; has no meaning once the company is gone)
       --   company_additional_url    on delete cascade   (likewise)
       --   job_targets               on delete set null  (a student's target
       --     survives; it just loses the company link)
       --   question_bank_entries     on delete set null  (likewise - a coach
       --     deleting a company must not delete interview history)
       'public.company_research_reports', 'public.company_additional_url',
       'public.job_targets', 'public.question_bank_entries',
       -- career-hub's own sponsorship tables, added by 029 and 030 — i.e. after
       -- 027 wrote the guard, which is why its author never listed them. Same
       -- reasoning as the four above: both declare ON DELETE CASCADE, so the
       -- company row going away already removes them.
       --   company_sponsorship         on delete cascade  (a resolved link to a
       --     sponsor licence; meaningless once the company is gone)
       --   company_sponsorship_checks  on delete cascade  (one row of
       --     resolution state per company)
       'public.company_sponsorship', 'public.company_sponsorship_checks',
       -- 049: verified company aliases (bulk contact importer). ON DELETE
       -- CASCADE: an alias names one company and means nothing without it.
       'public.company_aliases'
     );

  if v_unhandled is not null then
    raise exception
      'Refusing to delete companies: unhandled foreign key reference(s) from %. '
      'Extend delete_companies_permanently() to handle them explicitly.',
      v_unhandled
      using errcode = 'foreign_key_violation';
  end if;

  update public.outreach_emails
     set company_id = null
   where company_id = any (v_ids);
  get diagnostics v_outreach = row_count;

  delete from public.jobs where company_id = any (v_ids);
  get diagnostics v_jobs = row_count;

  delete from public.coach_company_meta where company_id = any (v_ids);
  get diagnostics v_meta = row_count;

  delete from public.contacts where company_id = any (v_ids);
  get diagnostics v_contacts = row_count;

  with removed as (
    delete from public.companies where id = any (v_ids) returning id
  )
  select coalesce(array_agg(id), '{}') into v_deleted_ids from removed;

  return jsonb_build_object(
    'requested', array_length(v_ids, 1),
    'deleted_companies', coalesce(array_length(v_deleted_ids, 1), 0),
    'deleted_company_ids', to_jsonb(v_deleted_ids),
    'missing_company_ids', to_jsonb(
      array(select id from unnest(v_ids) as id where not (id = any (v_deleted_ids)))
    ),
    'deleted_jobs', v_jobs,
    'deleted_coach_meta', v_meta,
    'unlinked_outreach_emails', v_outreach,
    'deleted_contacts', v_contacts
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Classification (preview). Re-run inside the commit, so a company or
--    contact created between preview and commit is matched, not duplicated.
-- ---------------------------------------------------------------------------
create or replace function public.contact_import_classify(p_batch uuid) returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
  r record;
  c jsonb; ct jsonb; res_c jsonb; res_k jsonb;
  v_name text; v_nkey text; v_slug text; v_dom text;
  v_em text; v_li text; v_nm text; v_ph text; v_ckey text; v_key text; v_url text;
  v_dom_ids uuid[]; v_name_ids uuid[]; v_alias_ids uuid[]; v_named uuid[]; v_all uuid[]; v_slug_ids uuid[];
  v_ids uuid[]; v_ph_ids uuid[]; v_job_ids uuid[];
  v_cs text; v_ks text; v_cls text; v_cid uuid; v_cref bigint; v_kref bigint;
  v_cm jsonb; v_km jsonb; v_cc jsonb; v_kc jsonb; v_reasons text[];
  v_pc jsonb := '{}';   -- pending company keys (n:/d:/s:) -> row id
  v_pt jsonb := '{}';   -- pending contact keys (e:/l:/p:) -> row id
begin
  if not exists (select 1 from public.contact_import_batches b where b.id = p_batch) then
    raise exception 'import batch % not found', p_batch using errcode = 'CI404';
  end if;
  if exists (select 1 from public.contact_import_batches b where b.id = p_batch and b.status = 'uploading') then
    raise exception 'import batch % did not finish uploading', p_batch using errcode = 'CI400';
  end if;

  for r in select * from public.contact_import_rows x where x.batch_id = p_batch order by x.sheet_index, x.row_number loop
    v_cs := null; v_ks := null; v_cls := null; v_cid := null; v_cref := null; v_kref := null;
    v_cm := null; v_km := null; v_cc := '[]'; v_kc := '[]'; v_reasons := '{}';

    if r.extracted is null then
      v_cls := 'invalid'; v_reasons := array['The column mapping has not been applied to this row.'];
    elsif coalesce((r.extracted ->> 'excluded')::boolean, false) then
      v_cls := 'skipped'; v_reasons := array['This sheet is not included in the import.'];
    elsif cardinality(r.parse_errors) > 0 then
      v_cls := 'invalid'; v_reasons := r.parse_errors;
    else
      c := r.extracted -> 'company';
      v_name := nullif(btrim(c ->> 'name'), '');
      v_nkey := public.ci_norm_name(v_name);
      v_slug := nullif(c ->> 'slug', '');
      v_dom := public.ci_norm_domain(c ->> 'website');
      if public.ci_generic_domain(v_dom) then v_dom := null; end if;
      res_c := r.resolution -> 'company';

      -- ── Company ──────────────────────────────────────────────────────────
      if res_c ->> 'action' = 'skip' then
        v_cs := 'skipped'; v_reasons := array_append(v_reasons, 'Company skipped by an admin.');
      elsif res_c ->> 'action' = 'match' then
        select co.id into v_cid from public.companies co where co.id = (res_c ->> 'company_id')::uuid;
        if v_cid is null then
          v_cs := 'invalid'; v_reasons := array_append(v_reasons, 'The company chosen for this row no longer exists.');
        else
          v_cs := 'matched'; v_cm := jsonb_build_object('id', v_cid, 'method', 'manual');
        end if;
      else
        select coalesce(array_agg(distinct co.id), '{}') into v_dom_ids from public.companies co
         where v_dom is not null
           and (public.ci_norm_domain(co.canonical_domain) = v_dom or public.ci_norm_domain(co.website) = v_dom
                or public.ci_norm_domain(co.website_url) = v_dom);
        select coalesce(array_agg(distinct co.id), '{}') into v_name_ids from public.companies co
         where v_nkey is not null and public.ci_norm_name(co.name) = v_nkey;
        select coalesce(array_agg(distinct a.company_id), '{}') into v_alias_ids from public.company_aliases a
         where v_nkey is not null and a.normalized_alias = v_nkey;
        select coalesce(array_agg(distinct u), '{}') into v_named from unnest(v_name_ids || v_alias_ids) u;
        select coalesce(array_agg(distinct u), '{}') into v_all from unnest(v_dom_ids || v_named) u;
        select coalesce(array_agg(co.id), '{}') into v_slug_ids from public.companies co
         where v_slug is not null and co.slug = v_slug and not (co.id = any (v_all));

        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', co.id, 'name', co.name, 'slug', co.slug, 'website', coalesce(co.website, co.website_url),
                 'reasons', to_jsonb(array_remove(array[
                   case when co.id = any (v_dom_ids) then 'domain' end,
                   case when co.id = any (v_name_ids) then 'name' end,
                   case when co.id = any (v_alias_ids) then 'alias' end,
                   case when co.id = any (v_slug_ids) then 'similar_name' end], null)))
               order by co.name), '[]')
          into v_cc from public.companies co where co.id = any (v_all || v_slug_ids);

        if res_c ->> 'action' = 'create' then
          if v_nkey is null or v_slug is null then
            v_cs := 'invalid'; v_reasons := array_append(v_reasons, 'A company cannot be created without a name.');
          elsif exists (select 1 from public.companies co where co.slug = v_slug) then
            v_cs := 'needs_review';
            v_reasons := array_append(v_reasons, format('Cannot create: an existing company already uses the slug "%s". Match it instead, or skip.', v_slug));
          elsif v_pc ? ('s:' || v_slug) and not (v_pc ? ('n:' || v_nkey)) then
            v_cs := 'needs_review';
            v_reasons := array_append(v_reasons, format('Another row in this file creates a company with the slug "%s".', v_slug));
          elsif v_pc ? ('n:' || v_nkey) then
            v_cs := 'new_pending'; v_cref := (v_pc ->> ('n:' || v_nkey))::bigint;
          else
            v_cs := 'new';
          end if;
        elsif cardinality(v_named) = 1 and v_dom_ids <@ v_named then
          -- Matched only when the name (or a verified alias) identifies one
          -- company and the website, if any, points nowhere else.
          v_cid := v_named[1];
          v_cs := 'matched';
          v_cm := jsonb_build_object('id', v_cid, 'method', case when v_cid = any (v_name_ids) then 'name' else 'alias' end);
        elsif cardinality(v_all) > 1 then
          v_cs := 'needs_review';
          v_reasons := array_append(v_reasons, format('Matches %s existing companies by name, alias or website domain. Choose one, or skip.', cardinality(v_all)));
        elsif cardinality(v_dom_ids) = 1 then
          -- A website domain alone is never a match: different companies share
          -- hosts, parents and agencies. The name has to agree, or an admin decides.
          v_cs := 'needs_review';
          v_reasons := array_append(v_reasons, case when v_nkey is null
            then format('No company name in this row. Its website domain belongs to "%s": confirm the match, or skip.',
                        (select co.name from public.companies co where co.id = v_dom_ids[1]))
            else format('Same website domain as "%s", but a different name. Confirm the match (and save "%s" as an alias if it is the same company), create a separate company, or skip.',
                        (select co.name from public.companies co where co.id = v_dom_ids[1]), v_name) end);
        elsif cardinality(v_slug_ids) > 0 then
          v_cs := 'needs_review';
          v_reasons := array_append(v_reasons, 'Similar to an existing company (same normalized name once legal suffixes are removed). Confirm the match, or skip.');
        elsif v_nkey is not null and v_pc ? ('n:' || v_nkey) then
          -- In-file grouping is by exact normalized name only, never by domain.
          v_cs := 'new_pending';
          v_cref := (v_pc ->> ('n:' || v_nkey))::bigint;
        elsif v_dom is not null and v_pc ? ('d:' || v_dom) then
          v_cs := 'needs_review';
          v_reasons := array_append(v_reasons, case when v_nkey is null
            then format('No company name in this row, and another row in this file (row id %s) creates the company with this website. Skip it.', v_pc ->> ('d:' || v_dom))
            else format('Another row in this file (row id %s) creates a company with the same website domain under a different name. Create this one as a separate company, or skip.', v_pc ->> ('d:' || v_dom)) end);
        elsif v_nkey is null then
          v_cs := 'needs_review';
          v_reasons := array_append(v_reasons, 'No company name in this row and no existing company with its domain. Match one, or skip.');
        elsif v_slug is not null and v_pc ? ('s:' || v_slug) then
          v_cs := 'needs_review';
          v_reasons := array_append(v_reasons, format('Another row in this file (row id %s) would create a company with the same normalized name. Match an existing company, or skip.', v_pc ->> ('s:' || v_slug)));
        else
          v_cs := 'new';
        end if;
        if v_cs = 'new_pending' then v_cm := jsonb_build_object('pending_row', v_cref); end if;
      end if;

      -- ── Contact ──────────────────────────────────────────────────────────
      -- Extraction warnings (e.g. a value that was kept as a note) are shown, not acted on.
      select v_reasons || coalesce(array_agg(w), '{}') into v_reasons
        from jsonb_array_elements_text(coalesce(r.extracted -> 'warnings', '[]')) w;
      ct := r.extracted -> 'contact';
      if nullif(r.extracted ->> 'contact_error', '') is not null then
        -- Contact data the extractor could not use safely. The company part can still
        -- import, but only once an admin has confirmed the contact is to be left out.
        if v_cs in ('skipped', 'invalid') or r.resolution -> 'contact' ->> 'action' = 'skip' then
          v_ks := 'skipped';
        else
          v_ks := 'needs_review';
          v_reasons := array_append(v_reasons, 'Contact not imported: ' || (r.extracted ->> 'contact_error') || ' Skip the contact to import the company alone.');
        end if;
      elsif ct is not null and jsonb_typeof(ct) = 'object' then
        res_k := r.resolution -> 'contact';
        v_em := public.ci_norm_email(ct ->> 'email');
        v_li := public.ci_norm_linkedin(ct ->> 'linkedin_url');
        v_nm := public.ci_norm_name(ct ->> 'full_name');
        v_ph := public.ci_norm_phone(ct ->> 'phone');
        v_ids := '{}';

        if v_cs in ('skipped', 'invalid') then
          v_ks := 'skipped';
        elsif res_k ->> 'action' = 'skip' then
          v_ks := 'skipped'; v_reasons := array_append(v_reasons, 'Contact skipped by an admin.');
        elsif res_k ->> 'action' = 'match' then
          if exists (select 1 from public.contacts k where k.id = (res_k ->> 'contact_id')::uuid and k.company_id = v_cid) then
            v_ks := 'matched'; v_km := jsonb_build_object('id', res_k ->> 'contact_id', 'method', 'manual');
          else
            v_ks := 'invalid'; v_reasons := array_append(v_reasons, 'The contact chosen for this row is not at the matched company (or no longer exists).');
          end if;
        else
          select coalesce(array_agg(k.id), '{}') into v_ids from public.contacts k
           where v_em is not null and public.ci_norm_email(k.email) = v_em;
          if cardinality(v_ids) = 0 then
            select coalesce(array_agg(k.id), '{}') into v_ids from public.contacts k
             where v_li is not null and public.ci_norm_linkedin(k.linkedin_url) = v_li;
          end if;

          if res_k ->> 'action' = 'create' then
            -- "Create" overrides an uncertain name match, never an exact
            -- email/LinkedIn duplicate. Re-checked at commit, under the lock,
            -- so a contact another batch created in the meantime counts too.
            if cardinality(v_ids) > 0 then
              v_ks := 'needs_review';
              v_reasons := array_append(v_reasons, format('Cannot create a new contact: %s existing contact(s) already have this email/LinkedIn profile. Match the one at this company, or leave the contact out.', cardinality(v_ids)));
            end if;
          else
            if cardinality(v_ids) = 1 and v_cid is not null
               and (select k.company_id from public.contacts k where k.id = v_ids[1]) = v_cid then
              v_ks := 'matched';
              v_km := jsonb_build_object('id', v_ids[1], 'method', case when v_em is not null
                        and exists (select 1 from public.contacts k where k.id = v_ids[1] and public.ci_norm_email(k.email) = v_em)
                        then 'email' else 'linkedin' end);
            elsif cardinality(v_ids) = 1 then
              v_ks := 'needs_review';
              v_reasons := array_append(v_reasons, 'This email/LinkedIn profile already belongs to a contact at another company (or this row''s company is not settled yet).');
            elsif cardinality(v_ids) > 1 then
              v_ks := 'needs_review';
              v_reasons := array_append(v_reasons, format('%s existing contacts share this email/LinkedIn profile. Choose one, or skip.', cardinality(v_ids)));
            elsif v_cid is not null and v_nm is not null then
              select coalesce(array_agg(k.id), '{}') into v_ids from public.contacts k
               where k.company_id = v_cid and public.ci_norm_name(k.full_name) = v_nm;
              if cardinality(v_ids) > 0 then
                select coalesce(array_agg(k.id), '{}') into v_ph_ids from public.contacts k
                 where k.id = any (v_ids) and v_ph is not null and public.ci_norm_phone(k.phone) = v_ph;
                if cardinality(v_ph_ids) = 1 then
                  v_ks := 'matched'; v_km := jsonb_build_object('id', v_ph_ids[1], 'method', 'company_name_phone');
                else
                  v_ks := 'needs_review';
                  v_reasons := array_append(v_reasons, 'A contact with this name already exists at this company, but no phone number confirms it is the same person.');
                end if;
              end if;
            end if;
          end if;

          if v_ks is null then
            -- In-file duplicates: same email, profile, or company+name+phone as an earlier row.
            v_ckey := case when v_cid is not null then v_cid::text
                           when v_cs = 'new' then 'row:' || r.id
                           when v_cs = 'new_pending' then 'row:' || v_cref end;
            v_kref := coalesce((v_pt ->> ('e:' || v_em))::bigint, (v_pt ->> ('l:' || v_li))::bigint,
                               case when v_ckey is not null and v_nm is not null and v_ph is not null
                                    then (v_pt ->> ('p:' || v_ckey || '|' || v_nm || '|' || v_ph))::bigint end);
            if v_kref is not null then
              v_ks := 'duplicate_in_file'; v_km := jsonb_build_object('pending_row', v_kref);
            else
              v_ks := 'new';
            end if;
          end if;
        end if;

        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', k.id, 'full_name', k.full_name, 'company_id', k.company_id, 'company_name', co.name,
                 'email', k.email, 'phone', k.phone, 'linkedin_url', k.linkedin_url, 'job_title', k.job_title)), '[]')
          into v_kc from public.contacts k join public.companies co on co.id = k.company_id
         where k.id = any (v_ids);
      end if;

      v_cls := case
        when v_cs = 'invalid' or v_ks = 'invalid' then 'invalid'
        when v_cs = 'skipped' then 'skipped'
        when v_cs = 'needs_review' or v_ks = 'needs_review' then 'needs_review'
        when v_cs = 'new' or v_ks = 'new' then 'new'
        else 'matched' end;

      -- Only rows that will actually import may stand in for later duplicates.
      if v_cls in ('new', 'matched') then
        if v_cs = 'new' then
          v_pc := v_pc || jsonb_build_object('n:' || v_nkey, r.id, 's:' || v_slug, r.id);
          if v_dom is not null then v_pc := v_pc || jsonb_build_object('d:' || v_dom, r.id); end if;
        end if;
        if v_ks = 'new' then
          if v_em is not null then v_pt := v_pt || jsonb_build_object('e:' || v_em, r.id); end if;
          if v_li is not null then v_pt := v_pt || jsonb_build_object('l:' || v_li, r.id); end if;
          if v_ckey is not null and v_nm is not null and v_ph is not null then
            v_pt := v_pt || jsonb_build_object('p:' || v_ckey || '|' || v_nm || '|' || v_ph, r.id);
          end if;
        elsif v_ks = 'matched' then
          -- A matched contact whose empty email/profile this row fills in owns
          -- that value from here on: a later row with it is the same person,
          -- not a new contact sharing their email.
          if v_em is not null and not (v_pt ? ('e:' || v_em)) and exists (
               select 1 from public.contacts k where k.id = (v_km ->> 'id')::uuid and nullif(btrim(k.email), '') is null) then
            v_pt := v_pt || jsonb_build_object('e:' || v_em, r.id);
          end if;
          if v_li is not null and not (v_pt ? ('l:' || v_li)) and exists (
               select 1 from public.contacts k where k.id = (v_km ->> 'id')::uuid and nullif(btrim(k.linkedin_url), '') is null) then
            v_pt := v_pt || jsonb_build_object('l:' || v_li, r.id);
          end if;
        end if;
      end if;
    end if;

    -- Source information: link a real URL to an existing job posting, if one has it.
    v_url := nullif(r.extracted -> 'source' ->> 'url', '');
    v_job_ids := '{}';
    if v_url is not null then
      select coalesce(array_agg(j.id), '{}') into v_job_ids from public.jobs j where j.source_url = v_url;
    end if;

    update public.contact_import_rows x
       set classification = v_cls, company_status = v_cs, contact_status = v_ks,
           company_match = v_cm, contact_match = v_km, company_candidates = v_cc, contact_candidates = v_kc,
           reasons = v_reasons, source_job_id = case when cardinality(v_job_ids) = 1 then v_job_ids[1] end
     where x.id = r.id;
  end loop;

  update public.contact_import_batches b
     set status = case when b.status = 'uploaded' then 'previewed' else b.status end,
         previewed_at = now(), updated_at = now()
   where b.id = p_batch;

  return (select jsonb_build_object(
            'total', count(*),
            'matched', count(*) filter (where classification = 'matched'),
            'new', count(*) filter (where classification = 'new'),
            'needs_review', count(*) filter (where classification = 'needs_review'),
            'invalid', count(*) filter (where classification = 'invalid'),
            'skipped', count(*) filter (where classification = 'skipped'))
          from public.contact_import_rows x where x.batch_id = p_batch);
end
$$;

-- Fill-only merge of one field: what to do with an incoming value.
create or replace function public.contact_import_merge_action(p_existing text, p_incoming text, p_kind text)
returns text language sql immutable set search_path = pg_catalog, public as $$
  select case
    when nullif(btrim(p_incoming), '') is null then 'none'
    when nullif(btrim(p_existing), '') is null then 'fill'
    when case p_kind
           when 'email'    then public.ci_norm_email(p_existing) is not distinct from public.ci_norm_email(p_incoming)
           when 'phone'    then public.ci_norm_phone(p_existing) is not distinct from public.ci_norm_phone(p_incoming)
           when 'linkedin' then public.ci_norm_linkedin(p_existing) is not distinct from public.ci_norm_linkedin(p_incoming)
           else lower(btrim(p_existing)) = lower(btrim(p_incoming)) end
      then 'same'
    else 'conflict' end
$$;

-- ---------------------------------------------------------------------------
-- 7. Commit. One transaction, serialized with every other import commit.
--    All-or-nothing: if any row fails, every write is rolled back, the failing
--    rows are marked 'failed' with their error and the rest 'rolled_back'.
--    Existing data is only ever filled where it was empty; differing values
--    are reported as conflicts, never overwritten.
-- ---------------------------------------------------------------------------
create or replace function public.contact_import_commit(p_batch uuid, p_actor uuid) returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
  b public.contact_import_batches;
  r record;
  c jsonb; ct jsonb; res_c jsonb;
  v_nkey text; v_slug text; v_dom text; v_web text; v_em text; v_li text; v_nm text; v_ph text;
  v_cid uuid; v_kid uuid; v_other uuid; v_alias_owner uuid; v_existing record; v_co record;
  v_company_action text; v_contact_action text; v_conflicts jsonb; v_set jsonb; v_act text; v_notes text;
  v_aliases int := 0;
  v_ck jsonb := '{}';   -- companies created by this import, by exact name (n:) -> id
  v_kk jsonb := '{}';   -- created contacts by key (e:/l:/p:) -> id
  v_errors jsonb := '[]';
  v_summary jsonb;
  f text;
begin
  -- One commit at a time: two admins importing overlapping files can never
  -- both decide "new" for the same company or contact.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('contact_import_commit'));

  select * into b from public.contact_import_batches x where x.id = p_batch for update;
  if not found then raise exception 'import batch % not found', p_batch using errcode = 'CI404'; end if;
  if b.status = 'committed' then raise exception 'import batch % is already committed', p_batch using errcode = 'CI409'; end if;
  if b.status not in ('previewed', 'failed') then
    raise exception 'import batch % has not been previewed', p_batch using errcode = 'CI400';
  end if;
  if b.created_by <> p_actor then
    raise exception 'only the admin who uploaded this file can import it' using errcode = 'CI403';
  end if;

  perform public.contact_import_classify(p_batch);

  begin   -- everything in here is undone if any row fails
    for r in select * from public.contact_import_rows x where x.batch_id = p_batch order by x.sheet_index, x.row_number loop
      begin
        if r.classification not in ('new', 'matched') then
          update public.contact_import_rows x
             set result_status = 'skipped', error = null,
                 result = jsonb_build_object('reason', case r.classification
                   when 'invalid' then 'invalid' when 'needs_review' then 'needs_review (unresolved)' else 'skipped by an admin' end,
                   -- Why, as of this commit: a row decided in the preview can need review
                   -- again if another import created the same contact in the meantime.
                   'reasons', to_jsonb(r.reasons))
           where x.id = r.id;
          continue;
        end if;

        c := r.extracted -> 'company'; ct := r.extracted -> 'contact'; res_c := r.resolution -> 'company';
        v_nkey := public.ci_norm_name(c ->> 'name'); v_slug := nullif(c ->> 'slug', '');
        v_dom := public.ci_norm_domain(c ->> 'website');
        if public.ci_generic_domain(v_dom) then v_dom := null; end if;
        v_web := case when v_dom is not null then c ->> 'website' end;
        v_conflicts := '[]'; v_company_action := 'matched'; v_contact_action := null; v_kid := null;

        -- ── Company ──
        if r.company_status = 'matched' then
          v_cid := (r.company_match ->> 'id')::uuid;
        else  -- new / new_pending: one company per exact name, however many rows name it
          v_cid := (v_ck ->> ('n:' || v_nkey))::uuid;
          if v_cid is null then
            insert into public.companies (name, slug, website, canonical_domain)
            values (c ->> 'name', v_slug, v_web, v_dom)
            returning id into v_cid;
            v_company_action := 'created';
            v_ck := v_ck || jsonb_build_object('n:' || v_nkey, v_cid);
          else
            v_company_action := 'in_file';   -- created by an earlier row of this import
          end if;
        end if;
        if v_company_action <> 'created' then
          select co.* into v_co from public.companies co where co.id = v_cid for update;
          if v_dom is not null then
            if v_co.website is null and v_co.website_url is null and v_co.canonical_domain is null then
              update public.companies co set website = v_web, canonical_domain = v_dom, updated_at = now() where co.id = v_cid;
              if v_company_action = 'matched' then v_company_action := 'updated'; end if;
            elsif v_dom is distinct from coalesce(public.ci_norm_domain(v_co.canonical_domain), public.ci_norm_domain(v_co.website),
                                                  public.ci_norm_domain(v_co.website_url)) then
              v_conflicts := v_conflicts || jsonb_build_object('record', 'company', 'field', 'website',
                               'existing', coalesce(v_co.website, v_co.website_url, v_co.canonical_domain), 'incoming', c ->> 'website');
            end if;
          end if;
          if res_c ->> 'action' = 'match' and coalesce((res_c ->> 'save_alias')::boolean, false)
             and v_nkey is not null and v_nkey is distinct from public.ci_norm_name(v_co.name) then
            insert into public.company_aliases (company_id, alias, verified_by, import_batch_id)
            values (v_cid, c ->> 'name', p_actor, p_batch)
            on conflict (normalized_alias) do nothing;
            if found then v_aliases := v_aliases + 1; end if;
            select a.company_id into v_alias_owner from public.company_aliases a where a.normalized_alias = v_nkey;
            if v_alias_owner is distinct from v_cid then
              raise exception 'the alias "%" already belongs to another company', c ->> 'name' using errcode = 'CI422';
            end if;
          end if;
        end if;

        -- ── Contact ──
        if ct is not null and jsonb_typeof(ct) = 'object' and r.contact_status in ('matched', 'new', 'duplicate_in_file') then
          v_em := public.ci_norm_email(ct ->> 'email'); v_li := public.ci_norm_linkedin(ct ->> 'linkedin_url');
          v_nm := public.ci_norm_name(ct ->> 'full_name'); v_ph := public.ci_norm_phone(ct ->> 'phone');
          v_notes := concat_ws('; ', nullif(ct ->> 'notes', ''),
                       format('Imported from %s (%s, row %s)', b.file_name, r.sheet, r.row_number));
          if r.contact_status = 'matched' then
            v_kid := (r.contact_match ->> 'id')::uuid;
          else
            v_kid := coalesce((v_kk ->> ('e:' || v_em))::uuid, (v_kk ->> ('l:' || v_li))::uuid,
                              (v_kk ->> ('p:' || v_cid || '|' || v_nm || '|' || v_ph))::uuid);
          end if;

          if v_kid is null then
            -- The preview already sent existing emails/profiles to review; this
            -- catches one written since by anything outside the import lock.
            select k.id into v_other from public.contacts k
             where (v_em is not null and public.ci_norm_email(k.email) = v_em)
                or (v_li is not null and public.ci_norm_linkedin(k.linkedin_url) = v_li)
             limit 1;
            if v_other is not null then
              raise exception 'contact % already has this email address or LinkedIn profile; match or skip this contact', v_other
                using errcode = 'CI422';
            end if;
            insert into public.contacts (company_id, full_name, job_title, email, phone, linkedin_url, notes)
            values (v_cid, btrim(ct ->> 'full_name'), nullif(btrim(ct ->> 'job_title'), ''), nullif(btrim(ct ->> 'email'), ''),
                    nullif(btrim(ct ->> 'phone'), ''), nullif(btrim(ct ->> 'linkedin_url'), ''), v_notes)
            returning id into v_kid;
            v_contact_action := 'created';
            if v_em is not null then v_kk := v_kk || jsonb_build_object('e:' || v_em, v_kid); end if;
            if v_li is not null then v_kk := v_kk || jsonb_build_object('l:' || v_li, v_kid); end if;
            if v_nm is not null and v_ph is not null then
              v_kk := v_kk || jsonb_build_object('p:' || v_cid || '|' || v_nm || '|' || v_ph, v_kid);
            end if;
          else
            select k.* into v_existing from public.contacts k where k.id = v_kid for update;
            v_set := '{}';
            foreach f in array array['job_title', 'email', 'phone', 'linkedin_url'] loop
              v_act := public.contact_import_merge_action(to_jsonb(v_existing) ->> f, ct ->> f,
                         case f when 'email' then 'email' when 'phone' then 'phone' when 'linkedin_url' then 'linkedin' else 'text' end);
              if v_act = 'fill' and f in ('email', 'linkedin_url') then
                -- Filling an empty email/profile must not give a second contact one
                -- that is already someone's: report it instead.
                select k.id into v_other from public.contacts k
                 where k.id <> v_kid
                   and case f when 'email' then public.ci_norm_email(k.email) = v_em
                              else public.ci_norm_linkedin(k.linkedin_url) = v_li end
                 limit 1;
                if v_other is not null then
                  v_act := 'conflict';
                  v_conflicts := v_conflicts || jsonb_build_object('record', 'contact', 'field', f, 'existing', null,
                                   'incoming', ct ->> f, 'reason', 'used_by_other_contact', 'other_contact_id', v_other);
                  continue;
                end if;
              end if;
              if v_act = 'fill' then
                v_set := v_set || jsonb_build_object(f, btrim(ct ->> f));
              elsif v_act = 'conflict' then
                v_conflicts := v_conflicts || jsonb_build_object('record', 'contact', 'field', f,
                                 'existing', to_jsonb(v_existing) ->> f, 'incoming', ct ->> f);
              end if;
            end loop;
            -- Notes are filled only with real source notes; provenance alone stays in the
            -- import history rather than being stamped onto every matched contact.
            if v_existing.notes is null and nullif(btrim(ct ->> 'notes'), '') is not null then
              v_set := v_set || jsonb_build_object('notes', v_notes);
            end if;
            if v_set <> '{}' then
              update public.contacts k
                 set job_title = coalesce(k.job_title, v_set ->> 'job_title'),
                     email = coalesce(k.email, v_set ->> 'email'),
                     phone = coalesce(k.phone, v_set ->> 'phone'),
                     linkedin_url = coalesce(k.linkedin_url, v_set ->> 'linkedin_url'),
                     notes = coalesce(k.notes, v_set ->> 'notes'),
                     updated_at = now()
               where k.id = v_kid;
              v_contact_action := 'updated';
              -- Later rows with the email/profile filled in here are this contact.
              if v_set ? 'email' and v_em is not null then v_kk := v_kk || jsonb_build_object('e:' || v_em, v_kid); end if;
              if v_set ? 'linkedin_url' and v_li is not null then v_kk := v_kk || jsonb_build_object('l:' || v_li, v_kid); end if;
            else
              v_contact_action := 'matched';
            end if;
          end if;
        end if;

        update public.contact_import_rows x
           set result_status = case when 'created' in (v_company_action, v_contact_action) then 'created'
                                    when 'updated' in (v_company_action, v_contact_action) then 'updated'
                                    else 'matched' end,
               error = null,
               result = jsonb_build_object('company_id', v_cid, 'company', v_company_action,
                                           'contact_id', v_kid, 'contact', v_contact_action, 'conflicts', v_conflicts)
         where x.id = r.id;
      exception when others then
        v_errors := v_errors || jsonb_build_object('row_id', r.id, 'sheet', r.sheet, 'row_number', r.row_number,
                                                   'sqlstate', sqlstate, 'error', sqlerrm);
      end;
    end loop;

    if jsonb_array_length(v_errors) > 0 then
      raise exception 'contact import rolled back: % row(s) failed', jsonb_array_length(v_errors) using errcode = 'CI500';
    end if;
  exception when sqlstate 'CI500' then
    -- Every company/contact/alias write above is gone. Record why.
    update public.contact_import_rows x
       set result_status = case when e.row_id is not null then 'failed' else 'rolled_back' end,
           error = e.error, result = null
      from public.contact_import_rows y
      left join (select (j ->> 'row_id')::bigint as row_id, (j ->> 'sqlstate') || ': ' || (j ->> 'error') as error
                   from jsonb_array_elements(v_errors) j) e on e.row_id = y.id
     where x.id = y.id and y.batch_id = p_batch;
    v_summary := jsonb_build_object('status', 'failed', 'failed_rows', jsonb_array_length(v_errors), 'errors', v_errors,
                   'rows', (select jsonb_object_agg(s, n) from (select result_status s, count(*) n from public.contact_import_rows
                                                                 where batch_id = p_batch group by 1) q));
    update public.contact_import_batches x
       set status = 'failed', summary = v_summary, updated_at = now(),
           error = format('%s row(s) failed; nothing was imported.', jsonb_array_length(v_errors))
     where x.id = p_batch;
    return v_summary;
  end;

  select jsonb_build_object(
           'status', 'committed',
           'rows', jsonb_build_object(
             'total', count(*),
             'created', count(*) filter (where result_status = 'created'),
             'updated', count(*) filter (where result_status = 'updated'),
             'matched', count(*) filter (where result_status = 'matched'),
             'skipped', count(*) filter (where result_status = 'skipped'),
             'failed', 0),
           'companies', jsonb_build_object(
             'created', count(*) filter (where result ->> 'company' = 'created'),
             'updated', count(*) filter (where result ->> 'company' = 'updated'),
             'matched', count(distinct result ->> 'company_id') filter (where result ->> 'company' in ('matched', 'updated'))),
           'contacts', jsonb_build_object(
             'created', count(*) filter (where result ->> 'contact' = 'created'),
             'updated', count(*) filter (where result ->> 'contact' = 'updated'),
             'matched', count(*) filter (where result ->> 'contact' = 'matched')),
           'aliases_created', v_aliases,
           'conflicts', coalesce(sum(jsonb_array_length(result -> 'conflicts')), 0))
    into v_summary
    from public.contact_import_rows x where x.batch_id = p_batch;

  update public.contact_import_batches x
     set status = 'committed', summary = v_summary, error = null, committed_at = now(), committed_by = p_actor, updated_at = now()
   where x.id = p_batch;
  return v_summary;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. EXECUTE: only this migration's functions; service_role only for the
--    two entry points. The normalizers stay callable (pure, no data access)
--    so expression indexes and ad-hoc queries can use them.
-- ---------------------------------------------------------------------------
do $$
declare f text; r text;
begin
  foreach f in array array['public.contact_import_classify(uuid)', 'public.contact_import_commit(uuid, uuid)',
                           'public.contact_import_merge_action(text, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.contact_import_classify(uuid) to service_role';
    execute 'grant execute on function public.contact_import_commit(uuid, uuid) to service_role';
  end if;
end
$$;

-- Verify after running (expect zero rows):
--   select tablename from pg_tables where schemaname = 'public' and rowsecurity = false;
