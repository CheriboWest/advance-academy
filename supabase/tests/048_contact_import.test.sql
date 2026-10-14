-- Self-checking test for migration 048 (bulk company/contact importer).
-- SCRATCH DATABASES ONLY.
--
--   psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/048_contact_import.test.sql
--   (or supabase/tests/run_local.sh, which builds the database first)
--
-- Run as a superuser (it switches to service_role/anon/authenticated with SET
-- LOCAL ROLE). One transaction, rolled back; refuses to start if the database
-- already has contacts or import batches. A clean run ends with
-- "ALL CONTACT IMPORT SQL CHECKS PASSED".

\set ON_ERROR_STOP on
begin;

do $$
begin
  if exists (select 1 from public.contacts) or exists (select 1 from public.contact_import_batches) then
    raise exception 'this database has contacts or import batches — run this only against a scratch database';
  end if;
  if not (select rolsuper from pg_roles where rolname = current_user) then
    raise exception 'run this test as a superuser';
  end if;
end
$$;

-- Helpers -------------------------------------------------------------------
create function pg_temp.check(label text, cond boolean) returns void
language plpgsql as $$
begin
  if cond is distinct from true then
    raise exception 'FAIL: %', label;
  end if;
  raise notice 'ok   %', label;
end;
$$;

-- Run p_sql as p_role (null = the superuser running the test); it must succeed.
create function pg_temp.ok(label text, p_role text, p_sql text) returns void
language plpgsql as $$
begin
  if p_role is not null then execute format('set local role %I', p_role); end if;
  begin
    execute p_sql;
  exception when others then
    reset role;
    raise exception 'FAIL: % — unexpected error % %', label, sqlstate, sqlerrm;
  end;
  reset role;
  raise notice 'ok   %', label;
end;
$$;

-- Run p_sql as p_role; it must fail with an error whose "SQLSTATE message"
-- matches p_pattern (case-insensitive regex). Everything it did is rolled back.
create function pg_temp.deny(label text, p_role text, p_sql text, p_pattern text) returns void
language plpgsql as $$
declare v_err text;
begin
  begin
    if p_role is not null then execute format('set local role %I', p_role); end if;
    execute p_sql;
    v_err := null;
    raise exception using errcode = 'TT001', message = 'no error';
  exception when others then
    if sqlstate = 'TT001' then v_err := null; else v_err := sqlstate || ' ' || sqlerrm; end if;
  end;
  reset role;
  if v_err is null then
    raise exception 'FAIL: % — succeeded, expected an error matching /%/', label, p_pattern;
  elsif v_err !~* p_pattern then
    raise exception 'FAIL: % — got "%", expected /%/', label, v_err, p_pattern;
  end if;
  raise notice 'ok   %  [%]', label, substring(v_err from 1 for 80);
end;
$$;

-- Run the single-value query p_sql as p_role and compare its text form.
create function pg_temp.expect(label text, p_role text, p_sql text, want text) returns void
language plpgsql as $$
declare v text;
begin
  if p_role is not null then execute format('set local role %I', p_role); end if;
  begin
    execute p_sql into v;
  exception when others then
    reset role;
    raise exception 'FAIL: % — unexpected error % %', label, sqlstate, sqlerrm;
  end;
  reset role;
  if v is distinct from want then
    raise exception 'FAIL: % — got "%", want "%"', label, v, want;
  end if;
  raise notice 'ok   %  (= %)', label, want;
end;
$$;

-- Like expect, but first runs p_setup as the superuser and undoes both.
create function pg_temp.expect_undone(label text, p_setup text, p_role text, p_sql text, want text) returns void
language plpgsql as $$
declare v text;
begin
  begin
    execute p_setup;
    if p_role is not null then execute format('set local role %I', p_role); end if;
    execute p_sql into v;
    raise exception using errcode = 'TT002', message = coalesce(v, '<null>');
  exception when others then
    if sqlstate <> 'TT002' then
      reset role;
      raise exception 'FAIL: % — unexpected error % %', label, sqlstate, sqlerrm;
    end if;
    v := nullif(sqlerrm, '<null>');
  end;
  reset role;
  if v is distinct from want then
    raise exception 'FAIL: % — got "%", want "%"', label, v, want;
  end if;
  raise notice 'ok   %  (= %)', label, want;
end;
$$;


-- Fixtures --------------------------------------------------------------------
create temp table ids (k text primary key, v uuid);
insert into ids values
  ('A', '0a000000-0000-0000-0000-00000000000a'), ('B', '0b000000-0000-0000-0000-00000000000b'),
  ('E1', 'e1000000-0000-0000-0000-000000000001'), ('E2', 'e2000000-0000-0000-0000-000000000002'),
  ('E3', 'e3000000-0000-0000-0000-000000000003'), ('D1', 'd1000000-0000-0000-0000-000000000001'),
  ('D2', 'd2000000-0000-0000-0000-000000000002'),
  ('K1', 'c1000000-0000-0000-0000-000000000001'), ('K2', 'c2000000-0000-0000-0000-000000000002'),
  ('K3', 'c3000000-0000-0000-0000-000000000003'), ('K4', 'c4000000-0000-0000-0000-000000000004');
grant select on ids to public;
create function pg_temp.id(k text) returns uuid language sql stable as $$ select v from ids where ids.k = $1 $$;

insert into public.companies (id, name, slug, website) values
  (pg_temp.id('E1'), 'Acme Recruitment Ltd', 'acme-recruitment', 'https://acme-rec.co.uk'),
  (pg_temp.id('E2'), 'Beta Talent', 'beta-talent', null),
  (pg_temp.id('E3'), 'Gamma Group', 'gamma', null),
  (pg_temp.id('D1'), 'Delta One', 'delta-one', 'https://delta.co.uk'),
  (pg_temp.id('D2'), 'Delta Two', 'delta-two', 'https://www.delta.co.uk/jobs');
insert into public.contacts (id, company_id, full_name, email, phone, linkedin_url, job_title) values
  (pg_temp.id('K1'), pg_temp.id('E1'), 'Jane Doe', 'jane@acme-rec.co.uk', null, null, null),
  (pg_temp.id('K2'), pg_temp.id('E2'), 'Sam Lee', null, '020 7946 0000', null, null),
  (pg_temp.id('K3'), pg_temp.id('E2'), 'Pat Kim', 'pat@beta.com', null, 'https://linkedin.com/in/patkim', null),
  (pg_temp.id('K4'), pg_temp.id('E1'), 'Chris Fox', null, '07700 900111', null, 'Recruiter');
insert into public.jobs (company_id, title, source, source_url, content_hash)
values (pg_temp.id('E1'), 'Recruiter', 'adzuna', 'https://jobs.example/123', 'test-hash-048');

create function pg_temp.batch(p_actor text, p_name text) returns uuid language sql as $$
  insert into public.contact_import_batches (created_by, file_name, file_kind, file_sha256, file_size)
  values (pg_temp.id(p_actor), p_name, 'xlsx', md5(p_name), 1) returning id
$$;

-- One staged row, as backend-python writes it after applying the mapping.
create function pg_temp.add(p_batch uuid, p_row int, p_company jsonb, p_contact jsonb default null,
                            p_errors text[] default '{}', p_source jsonb default null, p_sheet text default 'JOB AGENCIES UK')
returns bigint language sql as $$
  insert into public.contact_import_rows (batch_id, sheet, row_number, raw, extracted, parse_errors)
  values (p_batch, p_sheet, p_row,
          jsonb_build_object('A', jsonb_build_object('header', 'Company', 'value', p_company ->> 'name', 'text', p_company ->> 'name')),
          jsonb_build_object('company', p_company, 'contact', p_contact, 'source', p_source), p_errors)
  returning id
$$;

create function pg_temp.co(p_name text, p_slug text, p_website text default null) returns jsonb language sql as $$
  select jsonb_build_object('name', p_name, 'slug', p_slug, 'website', p_website)
$$;
create function pg_temp.ct(p_name text, p_email text default null, p_phone text default null,
                           p_linkedin text default null, p_title text default null) returns jsonb language sql as $$
  select jsonb_build_object('full_name', p_name, 'email', p_email, 'phone', p_phone, 'linkedin_url', p_linkedin, 'job_title', p_title)
$$;

create function pg_temp.r(p_batch uuid, p_row int) returns public.contact_import_rows language sql as $$
  select * from public.contact_import_rows where batch_id = p_batch and row_number = p_row
$$;

create temp table batches (k text primary key, v uuid);
grant select on batches to public;
create function pg_temp.b(k text) returns uuid language sql stable as $$ select v from batches where batches.k = $1 $$;

-- =============================================================================
-- 1. Preview classification
-- =============================================================================
do $$
declare b uuid := pg_temp.batch('A', 'contacts.xlsx'); v jsonb;
begin
  insert into batches values ('B1', b);
  perform pg_temp.add(b, 1, pg_temp.co('ACME  recruitment ltd.', 'acme-recruitment'),
                      pg_temp.ct('Jane Doe', 'JANE@acme-rec.co.uk', '+44 20 1111 2222', null, 'Senior Recruiter'));
  perform pg_temp.add(b, 2, pg_temp.co('Acme Recruitment Ltd', 'acme-recruitment', 'https://acme-rec.co.uk/about'));
  perform pg_temp.add(b, 3, pg_temp.co('Delta Holdings', 'delta', 'delta.co.uk'));
  perform pg_temp.add(b, 4, pg_temp.co('Gamma UK', 'gamma'));
  perform pg_temp.add(b, 5, pg_temp.co('Beta Talent', 'beta-talent'), pg_temp.ct('Sam Lee', null, '+44 (0)20 7946 0000'));
  perform pg_temp.add(b, 6, pg_temp.co('Beta Talent', 'beta-talent'), pg_temp.ct('Sam Lee', null, '07000 000000'));
  perform pg_temp.add(b, 7, pg_temp.co('Acme Recruitment Ltd', 'acme-recruitment'), pg_temp.ct('Pat Kim', 'pat@beta.com'));
  perform pg_temp.add(b, 8, pg_temp.co('Newco Staffing', 'newco-staffing', 'https://newco.example'),
                      pg_temp.ct('Alex New', 'alex@newco.example'));
  perform pg_temp.add(b, 9, pg_temp.co('NEWCO staffing', 'newco-staffing'), pg_temp.ct('Alex New', 'ALEX@newco.example', null, null, 'Director'));
  perform pg_temp.add(b, 10, '{}'::jsonb, null, array['No company name: the group ended at a blank row.']);
  perform pg_temp.add(b, 11, pg_temp.co('Beta Talent', 'beta-talent'), pg_temp.ct('Pat Kim', null, null, 'https://www.linkedin.com/in/PatKim/'));
  perform pg_temp.add(b, 12, pg_temp.co('Acme Recruitment Ltd', 'acme-recruitment', 'https://uk.indeed.com/jobs?q=x'),
                      null, '{}', jsonb_build_object('text', 'Recruiter', 'url', 'https://jobs.example/123'), 'UK COMPANIES');
  perform pg_temp.add(b, 13, pg_temp.co('Acme Recruitment Ltd', 'acme-recruitment'), pg_temp.ct('Chris Fox', 'chris@other.com', '07700900111'));
  perform pg_temp.add(b, 14, pg_temp.co('Acme Recruitment Ltd', 'acme-recruitment'),
                      pg_temp.ct('Jane Doe', 'jane@acme-rec.co.uk', '0207 999 9999', null, 'CEO'));
  perform pg_temp.add(b, 15, pg_temp.co('Brand New Name', 'brand-new-name', 'https://acme-rec.co.uk'));
  perform pg_temp.add(b, 16, pg_temp.co(null, null, 'https://unknown-agency.co.uk'));

  perform pg_temp.deny('P0 classify refuses an unknown batch', 'service_role',
    format('select public.contact_import_classify(%L)', gen_random_uuid()), '^CI404');
  perform pg_temp.deny('P0 commit refuses a batch that was never previewed', 'service_role',
    format('select public.contact_import_commit(%L, %L)', b, pg_temp.id('A')), '^CI400');

  v := public.contact_import_classify(b);
  perform pg_temp.check('P1 counts: 16 rows', (v ->> 'total')::int = 16);
  perform pg_temp.expect('P1 per-row classification', null, format(
    $q$select string_agg(row_number || ':' || classification || ':' || coalesce(company_status, '-') || '/' || coalesce(contact_status, '-'), ' ' order by sheet_index, row_number)
         from public.contact_import_rows where batch_id = %L$q$, b),
    '1:matched:matched/matched 2:matched:matched/- 3:needs_review:needs_review/- 4:needs_review:needs_review/- '
    '5:matched:matched/matched 6:needs_review:matched/needs_review 7:needs_review:matched/needs_review '
    '8:new:new/new 9:matched:new_pending/duplicate_in_file 10:invalid:-/- 11:matched:matched/matched '
    '12:matched:matched/- 13:matched:matched/matched 14:matched:matched/matched 15:matched:matched/- 16:needs_review:needs_review/-');
  perform pg_temp.expect('P2 exact normalized name matches (row 1)', null, format(
    $q$select (company_match ->> 'id') = %L and company_match ->> 'method' = 'name' from public.contact_import_rows where batch_id = %L and row_number = 1$q$,
    pg_temp.id('E1'), b), 'true');
  perform pg_temp.expect('P2 domain + name agree → matched by domain (row 2)', null, format(
    $q$select company_match ->> 'method' from public.contact_import_rows where batch_id = %L and row_number = 2$q$, b), 'domain');
  perform pg_temp.expect('P2 a known domain under a different name is still one company (row 15)', null, format(
    $q$select company_match ->> 'method' from public.contact_import_rows where batch_id = %L and row_number = 15$q$, b), 'domain');
  perform pg_temp.expect('P3 two companies share the domain → review, both offered (row 3)', null, format(
    $q$select jsonb_array_length(company_candidates) from public.contact_import_rows where batch_id = %L and row_number = 3$q$, b), '2');
  perform pg_temp.expect('P3 slug-only resemblance is never merged (row 4)', null, format(
    $q$select (company_candidates -> 0 ->> 'id') = %L and (company_candidates -> 0 -> 'reasons') = '["similar_name"]'
         from public.contact_import_rows where batch_id = %L and row_number = 4$q$, pg_temp.id('E3'), b), 'true');
  perform pg_temp.expect('P4 contact: company + name + phone matches (row 5)', null, format(
    $q$select contact_match ->> 'method' from public.contact_import_rows where batch_id = %L and row_number = 5$q$, b), 'company_name_phone');
  perform pg_temp.check('P4 same name, unconfirmed phone → review, existing contact offered (row 6)',
    (select jsonb_array_length(contact_candidates) = 1 and contact_candidates -> 0 ->> 'id' = pg_temp.id('K2')::text
       from public.contact_import_rows where batch_id = b and row_number = 6));
  perform pg_temp.check('P4 email already at another company → review (row 7)',
    (select contact_candidates -> 0 ->> 'company_name' = 'Beta Talent' from public.contact_import_rows where batch_id = b and row_number = 7));
  perform pg_temp.expect('P4 LinkedIn profile URL matches regardless of www/case/slash (row 11)', null, format(
    $q$select contact_match ->> 'method' from public.contact_import_rows where batch_id = %L and row_number = 11$q$, b), 'linkedin');
  perform pg_temp.expect('P5 a job-board URL is not a company domain; the source link matches an existing job (row 12)', null, format(
    $q$select company_match ->> 'method' || '/' || (source_job_id is not null) from public.contact_import_rows where batch_id = %L and row_number = 12$q$, b), 'name/true');
  perform pg_temp.check('P6 invalid rows keep their parse errors as reasons (row 10)',
    (select reasons = array['No company name: the group ended at a blank row.'] from public.contact_import_rows where batch_id = b and row_number = 10));
  perform pg_temp.check('P6 a URL-only company with no matching domain is not given a guessed name (row 16)',
    (select company_status = 'needs_review' and reasons[1] like 'No company name%' from public.contact_import_rows where batch_id = b and row_number = 16));
  perform pg_temp.expect('P7 the batch is now previewed', null, format(
    $q$select status from public.contact_import_batches where id = %L$q$, b), 'previewed');
end $$;

-- =============================================================================
-- 2. Resolution and commit
-- =============================================================================
do $$
declare b uuid := pg_temp.b('B1'); v jsonb; v_before_companies int; v_before_contacts int;
begin
  update public.contact_import_rows set resolution = jsonb_build_object('company',
         jsonb_build_object('action', 'match', 'company_id', pg_temp.id('D1'), 'save_alias', true))
   where batch_id = b and row_number = 3;
  update public.contact_import_rows set resolution = '{"company": {"action": "skip"}}' where batch_id = b and row_number = 4;
  update public.contact_import_rows set resolution = '{"contact": {"action": "create"}}' where batch_id = b and row_number = 6;
  update public.contact_import_rows set resolution = '{"contact": {"action": "skip"}}' where batch_id = b and row_number = 7;
  update public.contact_import_rows set resolution = '{"company": {"action": "skip"}}' where batch_id = b and row_number = 16;

  v := public.contact_import_classify(b);
  perform pg_temp.check('R1 every needs_review row is resolved', (v ->> 'needs_review')::int = 0);
  perform pg_temp.expect('R1 resolved rows', null, format(
    $q$select string_agg(row_number || ':' || classification, ' ' order by row_number) from public.contact_import_rows
        where batch_id = %L and row_number in (3, 4, 6, 7, 16)$q$, b), '3:matched 4:skipped 6:new 7:matched 16:skipped');

  perform pg_temp.deny('C0 another admin cannot commit this batch', 'service_role',
    format('select public.contact_import_commit(%L, %L)', b, pg_temp.id('B')), '^CI403');
  perform pg_temp.deny('C0 anon cannot call the commit', 'anon',
    format('select public.contact_import_commit(%L, %L)', b, pg_temp.id('A')), '^42501');
  perform pg_temp.deny('C0 authenticated cannot call the commit', 'authenticated',
    format('select public.contact_import_commit(%L, %L)', b, pg_temp.id('A')), '^42501');

  v_before_companies := (select count(*) from public.companies);
  v_before_contacts := (select count(*) from public.contacts);
  set local role service_role;
  v := public.contact_import_commit(b, pg_temp.id('A'));
  reset role;
  perform pg_temp.check('C1 committed', v ->> 'status' = 'committed');
  perform pg_temp.check('C1 one company created (Newco, once for two rows)',
    (select count(*) from public.companies) = v_before_companies + 1 and (v -> 'companies' ->> 'created')::int = 1
    and (select count(*) from public.companies where slug = 'newco-staffing') = 1);
  perform pg_temp.check('C1 two contacts created (Alex New once, Sam Lee by admin decision)',
    (select count(*) from public.contacts) = v_before_contacts + 2 and (v -> 'contacts' ->> 'created')::int = 2);
  perform pg_temp.expect('C2 row results', null, format(
    $q$select string_agg(row_number || ':' || result_status, ' ' order by row_number) from public.contact_import_rows where batch_id = %L$q$, b),
    '1:updated 2:matched 3:matched 4:skipped 5:matched 6:created 7:matched 8:created 9:updated 10:skipped 11:matched 12:matched 13:updated 14:matched 15:matched 16:skipped');
  perform pg_temp.expect('C3 missing fields filled on the existing contact (row 1)', null, format(
    $q$select phone || '/' || job_title from public.contacts where id = %L$q$, pg_temp.id('K1')), '+44 20 1111 2222/Senior Recruiter');
  perform pg_temp.check('C3 never overwritten: row 14''s different phone and title are reported, not written',
    (select phone = '+44 20 1111 2222' and job_title = 'Senior Recruiter' from public.contacts where id = pg_temp.id('K1'))
    and (select jsonb_path_query_array(result -> 'conflicts', '$[*].field') = '["job_title", "phone"]'
           from public.contact_import_rows where batch_id = b and row_number = 14));
  perform pg_temp.check('C3 name never changed, and the existing title not replaced (row 13 fills email only)',
    (select full_name = 'Chris Fox' and email = 'chris@other.com' and job_title = 'Recruiter' from public.contacts where id = pg_temp.id('K4')));
  perform pg_temp.check('C4 the in-file duplicate filled the contact created two rows earlier (row 9)',
    (select job_title = 'Director' and email = 'alex@newco.example' from public.contacts where full_name = 'Alex New')
    and (select count(*) = 1 from public.contacts where full_name = 'Alex New'));
  perform pg_temp.check('C4 new contacts carry their provenance in notes',
    (select notes like 'Imported from contacts.xlsx (JOB AGENCIES UK, row 8)' from public.contacts where full_name = 'Alex New'));
  perform pg_temp.check('C5 the confirmed match saved a verified alias',
    (select company_id = pg_temp.id('D1') and verified_by = pg_temp.id('A') and normalized_alias = 'delta holdings'
       from public.company_aliases where import_batch_id = b) and (v ->> 'aliases_created')::int = 1);
  perform pg_temp.check('C6 a matched company with no website gains one; one with a website keeps it',
    (select website = 'https://newco.example' and canonical_domain = 'newco.example' from public.companies where slug = 'newco-staffing')
    and (select website = 'https://acme-rec.co.uk' from public.companies where id = pg_temp.id('E1')));
  perform pg_temp.check('C6 a differing company website is reported as a conflict (row 15 matched by domain, so none)',
    (select jsonb_array_length(result -> 'conflicts') = 0 from public.contact_import_rows where batch_id = b and row_number = 15));
  perform pg_temp.check('C7 raw source cells are kept',
    (select raw -> 'A' ->> 'value' = 'ACME  recruitment ltd.' from public.contact_import_rows where batch_id = b and row_number = 1));
  perform pg_temp.expect('C8 batch summary and status', null, format(
    $q$select status || '/' || (summary -> 'rows' ->> 'created') || '/' || (summary -> 'rows' ->> 'skipped') || '/' || (committed_by = %L)
         from public.contact_import_batches where id = %L$q$, pg_temp.id('A'), b), 'committed/2/3/true');
  perform pg_temp.deny('C9 the same batch cannot be committed twice', 'service_role',
    format('select public.contact_import_commit(%L, %L)', b, pg_temp.id('A')), '^CI409');
end $$;

-- =============================================================================
-- 3. Importing the same file again creates nothing
-- =============================================================================
do $$
declare b uuid := pg_temp.batch('A', 'contacts-again.xlsx'); v jsonb; v_co int; v_ct int;
begin
  insert into public.contact_import_rows (batch_id, sheet, sheet_index, row_number, raw, extracted, parse_errors)
  select b, sheet, sheet_index, row_number, raw, extracted, parse_errors from public.contact_import_rows where batch_id = pg_temp.b('B1');
  v := public.contact_import_classify(b);
  perform pg_temp.expect('D1 second preview: nothing new', null, format(
    $q$select string_agg(row_number || ':' || classification, ' ' order by row_number) from public.contact_import_rows
        where batch_id = %L and row_number in (5, 6, 8, 9)$q$, b), '5:matched 6:matched 8:matched 9:matched');
  perform pg_temp.check('D1 two Sam Lees now exist at Beta; each row''s phone confirms exactly its own one',
    (select count(*) = 2 from public.contacts where company_id = pg_temp.id('E2') and full_name = 'Sam Lee')
    and (select (contact_match ->> 'id')::uuid = pg_temp.id('K2') from public.contact_import_rows where batch_id = b and row_number = 5)
    and (select (contact_match ->> 'id')::uuid <> pg_temp.id('K2') from public.contact_import_rows where batch_id = b and row_number = 6));
  perform pg_temp.expect('D1 rows still needing a human stay that way', null, format(
    $q$select string_agg(row_number::text, ',' order by row_number) from public.contact_import_rows
        where batch_id = %L and classification = 'needs_review'$q$, b), '3,4,7,16');
  v_co := (select count(*) from public.companies); v_ct := (select count(*) from public.contacts);
  set local role service_role;
  v := public.contact_import_commit(b, pg_temp.id('A'));
  reset role;
  perform pg_temp.check('D2 re-import committed with zero companies and zero contacts created',
    v ->> 'status' = 'committed' and (v -> 'companies' ->> 'created')::int = 0 and (v -> 'contacts' ->> 'created')::int = 0
    and (select count(*) from public.companies) = v_co and (select count(*) from public.contacts) = v_ct);
end $$;

-- =============================================================================
-- 4. Aliases match on the next import
-- =============================================================================
do $$
declare b uuid := pg_temp.batch('A', 'alias.csv'); v jsonb;
begin
  perform pg_temp.add(b, 1, pg_temp.co('Delta  Holdings', 'delta'));
  v := public.contact_import_classify(b);
  perform pg_temp.expect('E1 a verified alias matches exactly', null, format(
    $q$select (company_match ->> 'id') = %L and company_match ->> 'method' = 'alias' from public.contact_import_rows where batch_id = %L$q$,
    pg_temp.id('D1'), b), 'true');
  perform pg_temp.deny('E2 one alias cannot point at two companies', null, format(
    $q$insert into public.company_aliases (company_id, alias, verified_by) values (%L, 'DELTA holdings', %L)$q$,
    pg_temp.id('D2'), pg_temp.id('A')), '^23505');
end $$;

-- =============================================================================
-- 5. Any row failure rolls the whole import back
-- =============================================================================
do $$
declare b uuid := pg_temp.batch('A', 'rollback.xlsx'); v jsonb; v_co int; v_ct int;
begin
  insert into batches values ('B4', b);
  perform pg_temp.add(b, 1, pg_temp.co('Rollback Co', 'rollback-co'), pg_temp.ct('Ann Roll', 'ann@rollback.example'));
  -- A blank name the extractor should never produce — the database still refuses it.
  perform pg_temp.add(b, 2, pg_temp.co('Beta Talent', 'beta-talent'), pg_temp.ct('   ', 'blank@beta.example'));
  perform public.contact_import_classify(b);
  v_co := (select count(*) from public.companies); v_ct := (select count(*) from public.contacts);
  set local role service_role;
  v := public.contact_import_commit(b, pg_temp.id('A'));
  reset role;
  perform pg_temp.check('F1 the commit reports failure', v ->> 'status' = 'failed' and (v ->> 'failed_rows')::int = 1);
  perform pg_temp.check('F1 nothing was written: no company, no contact',
    (select count(*) from public.companies) = v_co and (select count(*) from public.contacts) = v_ct
    and not exists (select 1 from public.companies where slug = 'rollback-co'));
  perform pg_temp.expect('F2 the failing row carries its error; the others are marked rolled back', null, format(
    $q$select string_agg(row_number || ':' || result_status || ':' || (error is not null), ' ' order by row_number)
         from public.contact_import_rows where batch_id = %L$q$, b), '1:rolled_back:false 2:failed:true');
  perform pg_temp.check('F2 the error names the violated constraint',
    (select error like '23514: %contacts_full_name_not_blank%' from public.contact_import_rows where batch_id = b and row_number = 2));
  perform pg_temp.expect('F3 the batch is failed with a reason', null, format(
    $q$select status || '/' || error from public.contact_import_batches where id = %L$q$, b), 'failed/1 row(s) failed; nothing was imported.');

  -- Fix the row (as an admin would by skipping it) and retry: a failed batch may be committed again.
  update public.contact_import_rows set resolution = '{"contact": {"action": "skip"}}' where batch_id = b and row_number = 2;
  set local role service_role;
  v := public.contact_import_commit(b, pg_temp.id('A'));
  reset role;
  perform pg_temp.check('F4 retry after fixing succeeds and creates exactly what the first attempt would have',
    v ->> 'status' = 'committed' and (select count(*) from public.companies where slug = 'rollback-co') = 1
    and (select count(*) from public.contacts where email = 'ann@rollback.example') = 1);
end $$;

-- =============================================================================
-- 5b. Partial rows, excluded sheets, warnings
-- =============================================================================
do $$
declare b uuid := pg_temp.batch('A', 'partial.xlsx'); v jsonb; v_id bigint;
begin
  insert into batches values ('B5', b);
  v_id := pg_temp.add(b, 1, pg_temp.co('Partial Agency', 'partial-agency'));
  update public.contact_import_rows
     set extracted = extracted || '{"contact_error": "Two people are listed in one cell.", "warnings": ["Phone kept as a note: ext 12"]}'
   where id = v_id;
  insert into public.contact_import_rows (batch_id, sheet, row_number, raw, extracted)
  values (b, 'NOTES', 1, '{"A": {"value": "x"}}', '{"excluded": true}');
  perform public.contact_import_classify(b);
  perform pg_temp.check('H1 an unusable contact holds the row for review, with the reason and the warning shown',
    (select classification = 'needs_review' and contact_status = 'needs_review'
            and reasons[1] = 'Phone kept as a note: ext 12' and reasons[2] like 'Contact not imported: Two people%'
       from public.contact_import_rows where id = v_id));
  perform pg_temp.check('H2 an excluded sheet''s rows are skipped, not invalid',
    (select classification = 'skipped' from public.contact_import_rows where batch_id = b and sheet = 'NOTES'));
  update public.contact_import_rows set resolution = '{"contact": {"action": "skip"}}' where id = v_id;
  perform public.contact_import_classify(b);
  set local role service_role;
  v := public.contact_import_commit(b, pg_temp.id('A'));
  reset role;
  perform pg_temp.check('H3 once the contact is skipped, the company alone imports',
    v ->> 'status' = 'committed' and (v -> 'companies' ->> 'created')::int = 1
    and (select result_status = 'created' and result ->> 'contact' is null from public.contact_import_rows where id = v_id));
end $$;

-- =============================================================================
-- 6. Privileges and the company-delete guard
-- =============================================================================
do $$
declare t text; r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach t in array array['company_aliases', 'contact_import_batches', 'contact_import_rows'] loop
      perform pg_temp.deny(format('G1 %s cannot read %s', r, t), r, format('select * from public.%I', t), '^42501');
    end loop;
    perform pg_temp.deny(format('G1 %s cannot classify', r), r,
      format('select public.contact_import_classify(%L)', pg_temp.b('B1')), '^42501');
  end loop;
  perform pg_temp.check('G2 RLS is on for every public table',
    not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity));
  perform pg_temp.check('G3 existing RPCs keep their grants (048 touches only its own functions)',
    has_function_privilege('service_role', 'public.delete_companies_permanently(uuid[])', 'EXECUTE')
    and not has_function_privilege('anon', 'public.delete_companies_permanently(uuid[])', 'EXECUTE'));
  perform pg_temp.ok('G4 permanently deleting a company that has an alias still works', 'service_role',
    format('select public.delete_companies_permanently(array[%L]::uuid[])', pg_temp.id('D1')));
  perform pg_temp.check('G4 …and its alias went with it',
    not exists (select 1 from public.company_aliases where company_id = pg_temp.id('D1')));
  perform pg_temp.check('G5 import history survives the company delete (no FK from staging rows)',
    exists (select 1 from public.contact_import_rows where batch_id = pg_temp.b('B1') and row_number = 3 and (result ->> 'company_id') = pg_temp.id('D1')::text));
end $$;

do $$ begin raise notice 'ALL CONTACT IMPORT SQL CHECKS PASSED'; end $$;

rollback;
