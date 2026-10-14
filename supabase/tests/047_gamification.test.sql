-- Self-checking test for migration 047 (gamification v2). SCRATCH DATABASES ONLY.
--
--   psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/047_gamification.test.sql
--   (or supabase/tests/run_local.sh, which builds the database first)
--
-- Needs a database with every migration through 047 applied, and Supabase's
-- roles (anon, authenticated, service_role, authenticator). Run it as a
-- superuser: it switches to each role with SET LOCAL ROLE, the way PostgREST
-- does. Everything runs in one transaction that is rolled back, and it refuses
-- to start if the database holds real users or cards. Any failed check raises
-- and stops the script; a clean run ends with "ALL GAMIFICATION SQL CHECKS PASSED".
--
-- Not covered here (needs two sessions): concurrent credit charges and the
-- READ COMMITTED guard — see 047_gamification_concurrency.test.sh.

\set ON_ERROR_STOP on
begin;

do $$
begin
  if exists (select 1 from public.users where id <> '00000000-0000-0000-0000-000000000000')
     or exists (select 1 from public.saved_jobs) or exists (select 1 from public.reward_intents) then
    raise exception 'this database has users, cards or intents — run this only against a scratch database';
  end if;
  if not (select rolsuper from pg_roles where rolname = current_user) then
    raise exception 'run this test as a superuser (it uses SET ROLE to every API and owner role)';
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

create function pg_temp.today() returns date language sql stable as $$
  select (now() at time zone 'Europe/London')::date
$$;

-- A hand-made intent, for judging rules the capture triggers can't easily reach.
create function pg_temp.intent(p_user uuid, p_kind text, p_source_id text, p_snapshot jsonb,
                               p_day date default null) returns bigint
language sql as $$
  insert into public.reward_intents (user_id, kind, source_table, source_id, snapshot, local_day, config_version)
  values (p_user, p_kind, 'test', p_source_id, p_snapshot, coalesce(p_day, pg_temp.today()), 1)
  returning seq
$$;

-- Fixtures ------------------------------------------------------------------
-- U1/U2: the core flow. A: an admin. B: every capture trigger. X: retries,
-- skip, cover-letter failures. E: the economy (caps, tiers, coins, streaks).
-- F: follow-up rules.
insert into public.users (id, email, credit_balance, is_admin) values
  ('11111111-1111-1111-1111-111111111111', 'u1@test.local', 1, false),
  ('22222222-2222-2222-2222-222222222222', 'u2@test.local', 1, false),
  ('33333333-3333-3333-3333-333333333333', 'admin@test.local', 0, true),
  ('44444444-4444-4444-4444-444444444444', 'b@test.local', 5, false),
  ('55555555-5555-5555-5555-555555555555', 'x@test.local', 5, false),
  ('66666666-6666-6666-6666-666666666666', 'e@test.local', 0, false),
  ('77777777-7777-7777-7777-777777777777', 'f@test.local', 0, false);

\set U1 '''11111111-1111-1111-1111-111111111111'''
\set U2 '''22222222-2222-2222-2222-222222222222'''
\set A  '''33333333-3333-3333-3333-333333333333'''
\set B  '''44444444-4444-4444-4444-444444444444'''
\set X  '''55555555-5555-5555-5555-555555555555'''
\set E  '''66666666-6666-6666-6666-666666666666'''
\set F  '''77777777-7777-7777-7777-777777777777'''
\set C1 '''aaaaaaaa-0000-0000-0000-000000000001'''
\set C2 '''aaaaaaaa-0000-0000-0000-000000000002'''
\set C3 '''aaaaaaaa-0000-0000-0000-000000000003'''
\set R1 '''bbbbbbbb-0000-0000-0000-000000000001'''

-- psql variables are not expanded inside dollar-quoted strings, so the checks
-- read the ids from this table instead.
create temp table ids (k text primary key, v uuid);
insert into ids values ('U1', :U1), ('U2', :U2), ('A', :A), ('B', :B), ('X', :X), ('E', :E), ('F', :F),
                       ('C1', :C1), ('C2', :C2), ('C3', :C3), ('R1', :R1);
grant select on ids to public;
create function pg_temp.id(k text) returns uuid language sql stable as $$ select v from ids where ids.k = $1 $$;

-- A JD over the 400-character "thin" threshold.
create temp table jd as select repeat('x', 450) as text;
grant select on jd to public;

-- ===========================================================================
-- A. The core flow, called the way the backend will call it (service_role)
-- ===========================================================================
do $$ begin
  perform pg_temp.ok('A1 service_role creates a card with a URL', 'service_role', format(
    $q$insert into public.saved_jobs (id, user_id, title, job_url, url_key, next_follow_up_at)
       values (%L, %L, 'Analyst', 'https://a.example/1', 'a.example/1', current_date + 7)$q$,
    pg_temp.id('C1'), pg_temp.id('U1')));
  perform pg_temp.expect('A1 one job_saved intent captured (the capture role read the card under RLS)', null, format(
    $q$select count(*) from public.reward_intents where kind = 'job_saved' and source_id = %L$q$, pg_temp.id('C1')), '1');

  perform pg_temp.ok('A2 service_role creates a CV run for its own card', 'service_role', format(
    $q$insert into public.cv_analysis_jobs (id, user_id, status, saved_job_id, input_json)
       values (%L, %L, 'running', %L, jsonb_build_object('jobDescription', %L))$q$,
    pg_temp.id('R1'), pg_temp.id('U1'), pg_temp.id('C1'), (select text from jd)));
  perform pg_temp.expect('A2 no cv_tailor intent while the run is not completed', null,
    $q$select count(*) from public.reward_intents where kind = 'cv_tailor'$q$, '0');
  perform pg_temp.ok('A2 the run completes', 'service_role', format(
    $q$update public.cv_analysis_jobs set status = 'completed', updated_at = now() - interval '1 minute' where id = %L$q$,
    pg_temp.id('R1')));
  perform pg_temp.expect('A2 cv_tailor captured with jd_chars=450 and card_status=saved', null,
    $q$select (snapshot->>'jd_chars') || '/' || (snapshot->>'card_status') from public.reward_intents where kind = 'cv_tailor'$q$,
    '450/saved');
  perform pg_temp.ok('A2 a second write to the completed run captures nothing new', 'service_role', format(
    $q$update public.cv_analysis_jobs set status = 'completed' where id = %L$q$, pg_temp.id('R1')));
  perform pg_temp.expect('A2 …still one cv_tailor intent', null,
    $q$select count(*) from public.reward_intents where kind = 'cv_tailor'$q$, '1');

  perform pg_temp.expect('A3 record_cover_letter charges and saves atomically', 'service_role', format(
    $q$select (public.record_cover_letter(%L, %L, 'Dear…', null, 1) is not null)::text$q$,
    pg_temp.id('U1'), pg_temp.id('C1')), 'true');
  perform pg_temp.expect('A3 balance 1→0, run id set, card preparing, one preparing event', null, format(
    $q$select (select credit_balance from public.users where id = %1$L)::text || '/'
           || (select (cover_letter_run_id is not null)::text || '/' || status from public.saved_jobs where id = %2$L) || '/'
           || (select count(*) from public.job_events where job_id = %2$L and to_status = 'preparing')$q$,
    pg_temp.id('U1'), pg_temp.id('C1')), '0/true/preparing/1');
  perform pg_temp.expect('A3 one cover_letter intent, card_status saved at write time', null,
    $q$select count(*) || '/' || max(snapshot->>'card_status') from public.reward_intents where kind = 'cover_letter'$q$,
    '1/saved');

  perform pg_temp.ok('A4 change_job_status records the application', 'service_role', format(
    $q$select public.change_job_status(%L, %L, 'applied')$q$, pg_temp.id('U1'), pg_temp.id('C1')));
  perform pg_temp.expect('A4 applied_at set and an applied event written', null, format(
    $q$select (applied_at is not null)::text || '/' || (select count(*) from public.job_events where job_id = %1$L and to_status = 'applied')
         from public.saved_jobs where id = %1$L$q$, pg_temp.id('C1')), 'true/1');
  perform pg_temp.expect('A4 application snapshot: CV JD 450, letter before, follow-up after', null,
    $q$select concat_ws('/', snapshot->>'best_cv_jd_chars', snapshot->>'letter_before', snapshot->>'follow_up_after')
         from public.reward_intents where kind = 'application'$q$, '450/true/true');

  perform pg_temp.ok('A5 an interview answer is stored', 'service_role', format(
    $q$insert into public.interview_sessions (id, user_id, persona_id) values ('cccccccc-0000-0000-0000-000000000001', %L, 'mentor');
       insert into public.interview_questions (id, session_id, question_text)
       values ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'Tell me about yourself');
       insert into public.answer_assessments (session_id, question_id, integrity_score, relevance_score, substance_score, overall_score)
       values ('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 3, 3, 3, 3)$q$,
    pg_temp.id('U1')));
  perform pg_temp.expect('A5 answer_practice captured with the question fingerprint', null,
    $q$select (snapshot->>'fingerprint' = md5('tell me about yourself'))::text from public.reward_intents where kind = 'answer_practice'$q$,
    'true');
  perform pg_temp.expect('A5 every intent carries config version 1 and a local day', null,
    $q$select count(*) from public.reward_intents where config_version <> 1 or local_day is null$q$, '0');

  perform pg_temp.expect('A6 service_role runs the processor: 5 intents judged', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('U1')), '5');
  perform pg_temp.expect('A6 decisions: save, CV, letter, power application, practice — all granted', null, format(
    $q$select string_agg(kind || ':' || outcome || coalesce(':' || tier, ''), ',' order by intent_seq)
         from public.reward_decisions where user_id = %L$q$, pg_temp.id('U1')),
    'job_saved:granted,cv_tailor:granted,cover_letter:granted,application:granted:power,answer_practice:granted');
  perform pg_temp.expect('A6 XP 2+10+5+25+5 = 47; one streak day', null, format(
    $q$select (select sum(xp) from public.xp_grants where user_id = %1$L)::text || '/'
           || (select count(*) from public.streak_days where user_id = %1$L and kind = 'active')$q$, pg_temp.id('U1')), '47/1');
  perform pg_temp.expect('A6 first_shot pays 10 coins; wallet and ledger agree', null, format(
    $q$select (select balance from public.coin_wallets where user_id = %1$L)::text || '/'
           || (select string_agg(reason || ':' || reference || ':' || delta || ':' || balance_after, ',')
                 from public.coin_transactions where user_id = %1$L)$q$, pg_temp.id('U1')), '10/achievement:first_shot:10:10');
  perform pg_temp.expect('A6 card and URL locks for save and application; card locks for CV and letter', null, format(
    $q$select string_agg(kind || ':' || scope, ',' order by kind, scope) from public.reward_locks where user_id = %L$q$,
    pg_temp.id('U1')), 'application:card,application:url,cover_letter:card,cv_tailor:card,job_saved:card,job_saved:url');
  perform pg_temp.expect('A6 service_role can read the results', 'service_role', format(
    $q$select count(*) from public.reward_decisions where user_id = %L$q$, pg_temp.id('U1')), '5');
  perform pg_temp.expect('A7 re-running the processor judges nothing', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('U1')), '0');
  perform pg_temp.expect('A7 still 5 decisions and 1 coin transaction', null,
    $q$select (select count(*) from public.reward_decisions)::text || '/' || (select count(*) from public.coin_transactions)$q$, '5/1');
end $$;

-- A8–A13: cover-letter charging, G1, G2 --------------------------------------
do $$ begin
  perform pg_temp.ok('A8 a card without a URL', 'service_role', format(
    $q$insert into public.saved_jobs (id, user_id, title) values (%L, %L, 'No-URL card')$q$, pg_temp.id('C3'), pg_temp.id('U1')));
  perform pg_temp.expect('A8 …captures no job_saved intent', null, format(
    $q$select count(*) from public.reward_intents where source_id = %L$q$, pg_temp.id('C3')), '0');
  perform pg_temp.deny('A9 no credits left → GC001 CREDIT_EXHAUSTED', 'service_role', format(
    $q$select public.record_cover_letter(%L, %L, 'text', null, 1)$q$, pg_temp.id('U1'), pg_temp.id('C3')), '^GC001 CREDIT_EXHAUSTED');
  perform pg_temp.expect('A9 nothing written: no letter, no run id, no new intent, balance 0', null, format(
    $q$select (select (cover_letter_text is null and cover_letter_run_id is null)::text from public.saved_jobs where id = %1$L) || '/'
           || (select count(*) from public.reward_intents where kind = 'cover_letter') || '/'
           || (select credit_balance from public.users where id = %2$L)$q$, pg_temp.id('C3'), pg_temp.id('U1')), 'true/1/0');
  perform pg_temp.deny('A11 another user''s card → GN001, nothing charged', 'service_role', format(
    $q$select public.record_cover_letter(%L, %L, 'text', null, 1)$q$, pg_temp.id('U2'), pg_temp.id('C1')), '^GN001');
  perform pg_temp.expect('A11 …U2 still has its credit', null, format(
    $q$select credit_balance::text from public.users where id = %L$q$, pg_temp.id('U2')), '1');
  perform pg_temp.deny('A11 negative cost → refused', 'service_role', format(
    $q$select public.charge_credits(%L, -5)$q$, pg_temp.id('U2')), '^22023');

  perform pg_temp.ok('A12 a card for U2', 'service_role', format(
    $q$insert into public.saved_jobs (id, user_id, title) values (%L, %L, 'U2 card')$q$, pg_temp.id('C2'), pg_temp.id('U2')));
  perform pg_temp.deny('A12 G1: a CV run linked to another user''s card is rejected at creation', 'service_role', format(
    $q$insert into public.cv_analysis_jobs (user_id, status, saved_job_id) values (%L, 'queued', %L)$q$,
    pg_temp.id('U1'), pg_temp.id('C2')), '^23503 G1: saved_job_id must be one');
  perform pg_temp.expect('A12 …so no run and no intent exist for it', null, format(
    $q$select count(*) from public.cv_analysis_jobs where saved_job_id = %L$q$, pg_temp.id('C2')), '0');
  perform pg_temp.deny('A12 G1: re-pointing saved_job_id is refused', 'service_role', format(
    $q$update public.cv_analysis_jobs set saved_job_id = %L where id = %L$q$, pg_temp.id('C3'), pg_temp.id('R1')),
    'G1: saved_job_id is immutable');
  perform pg_temp.deny('A12 G1: clearing saved_job_id is refused too', 'service_role', format(
    $q$update public.cv_analysis_jobs set saved_job_id = null where id = %L$q$, pg_temp.id('R1')), 'G1: saved_job_id is immutable');
  perform pg_temp.ok('A12 a CV run with no card is fine', 'service_role', format(
    $q$insert into public.cv_analysis_jobs (user_id, status) values (%L, 'queued')$q$, pg_temp.id('U1')));

  perform pg_temp.deny('A13 G2: service_role cannot set the run id', 'service_role', format(
    $q$update public.saved_jobs set cover_letter_run_id = gen_random_uuid() where id = %L$q$, pg_temp.id('C3')), 'G2');
  perform pg_temp.deny('A13 G2: …nor generated_at', 'service_role', format(
    $q$update public.saved_jobs set cover_letter_generated_at = now() where id = %L$q$, pg_temp.id('C3')), 'G2');
  perform pg_temp.deny('A13 G2: …even after setting a GUC that looks like a writer flag', 'service_role', format(
    $q$select set_config('app.reward_writer', 'cover_letter', true);
       update public.saved_jobs set cover_letter_run_id = gen_random_uuid() where id = %L$q$, pg_temp.id('C3')), 'G2');
  perform pg_temp.deny('A13 G2: inserting a card with the marker preset is refused', 'service_role', format(
    $q$insert into public.saved_jobs (user_id, title, cover_letter_generated_at) values (%L, 't', now())$q$, pg_temp.id('U1')), 'G2');
  perform pg_temp.deny('A13 G2: …the table owner (migration role) is refused too',
    (select pg_get_userbyid(relowner)::text from pg_class where oid = 'public.saved_jobs'::regclass), format(
    $q$update public.saved_jobs set cover_letter_run_id = gen_random_uuid() where id = %L$q$, pg_temp.id('C3')), 'G2');
  perform pg_temp.ok('A13 hand-editing the letter text alone is allowed', 'service_role', format(
    $q$update public.saved_jobs set cover_letter_text = 'edited' where id = %L$q$, pg_temp.id('C3')));
  perform pg_temp.expect('A13 …and captures no cover_letter intent', null,
    $q$select count(*) from public.reward_intents where kind = 'cover_letter'$q$, '1');

  perform pg_temp.ok('A12 deleting a card that has CV runs is allowed', 'service_role', format(
    $q$delete from public.saved_jobs where id = %L$q$, pg_temp.id('C1')));
  perform pg_temp.expect('A12 …the run keeps its card id (provenance)', null, format(
    $q$select saved_job_id::text from public.cv_analysis_jobs where id = %L$q$, pg_temp.id('R1')), pg_temp.id('C1')::text);
  perform pg_temp.expect('A12 …the decisions survive the card', null, format(
    $q$select count(*) from public.reward_decisions where user_id = %L$q$, pg_temp.id('U1')), '5');
end $$;

-- ===========================================================================
-- B. Unauthorised callers stay blocked
-- ===========================================================================
do $$
declare t text; r text; g text;
begin
  foreach t in array array['reward_intents','reward_decisions','reward_locks','reward_audit','xp_grants','coin_wallets',
                           'coin_transactions','streak_days','gamification_config','daily_quest_assignments','user_achievements'] loop
    perform pg_temp.deny('B1 service_role cannot INSERT ' || t, 'service_role',
      format('insert into public.%I default values', t), '^42501 permission denied');
    perform pg_temp.deny('B1 service_role cannot DELETE ' || t, 'service_role',
      format('delete from public.%I', t), '^42501 permission denied');
  end loop;
  perform pg_temp.deny('B1 service_role cannot DELETE user_goal_settings', 'service_role',
    'delete from public.user_goal_settings', '^42501 permission denied');
  perform pg_temp.deny('B1 service_role cannot UPDATE reward_decisions', 'service_role',
    $q$update public.reward_decisions set outcome = 'granted'$q$, '^42501 permission denied');
  perform pg_temp.deny('B1 service_role cannot UPDATE coin_wallets', 'service_role',
    'update public.coin_wallets set balance = 999', '^42501 permission denied');
  perform pg_temp.deny('B1 service_role cannot UPDATE reward_intents', 'service_role',
    $q$update public.reward_intents set state = 'processed'$q$, '^42501 permission denied');
  perform pg_temp.deny('B1 service_role cannot UPDATE gamification_config', 'service_role',
    'update public.gamification_config set jd_thin_chars = 1', '^42501 permission denied');
  perform pg_temp.deny('B1 service_role cannot UPDATE user_achievements.decision_id', 'service_role',
    'update public.user_achievements set decision_id = 1', '^42501 permission denied');

  perform pg_temp.deny('B2 service_role cannot EXECUTE enqueue_reward_intent', 'service_role', format(
    $q$select public.enqueue_reward_intent(%L, 'job_saved', 'x', 'x', 'x', '{}')$q$, pg_temp.id('U1')), '^42501 permission denied');
  perform pg_temp.deny('B2 service_role cannot EXECUTE apply_coin_transaction', 'service_role', format(
    $q$select public.apply_coin_transaction(%L, 1000, 'gift', 'x')$q$, pg_temp.id('U1')), '^42501 permission denied');
  perform pg_temp.deny('B2 service_role cannot EXECUTE gam_decide', 'service_role',
    'select public.gam_decide(i) from public.reward_intents i limit 1', '^42501 permission denied');
  perform pg_temp.deny('B2 service_role cannot EXECUTE gam_award_achievement', 'service_role', format(
    $q$select public.gam_award_achievement(%L, 'you_did_it', null, c) from public.gamification_config c$q$, pg_temp.id('U1')),
    '^42501 permission denied');
  perform pg_temp.deny('B2 service_role cannot EXECUTE a capture trigger function', 'service_role',
    'select public.trg_saved_jobs_capture()', '^42501 permission denied');

  foreach r in array array['anon', 'authenticated'] loop
    foreach t in array array['reward_intents','reward_decisions','coin_wallets','coin_transactions','xp_grants',
                             'user_goal_settings','gamification_config','user_achievements','streak_days'] loop
      perform pg_temp.deny(format('B3 %s cannot SELECT %s', r, t), r, format('select * from public.%I', t), '^42501 permission denied');
    end loop;
    perform pg_temp.deny(format('B3 %s cannot EXECUTE record_cover_letter', r), r, format(
      $q$select public.record_cover_letter(%L, %L, 'x', null, 0)$q$, pg_temp.id('U1'), pg_temp.id('C3')), '^42501 permission denied');
    perform pg_temp.deny(format('B3 %s cannot EXECUTE charge_credits', r), r, format(
      $q$select public.charge_credits(%L, 0)$q$, pg_temp.id('U1')), '^42501 permission denied');
    perform pg_temp.deny(format('B3 %s cannot EXECUTE process_reward_intents', r), r, format(
      $q$select public.process_reward_intents(%L)$q$, pg_temp.id('U1')), '^42501 permission denied');
    perform pg_temp.deny(format('B3 %s cannot EXECUTE create_saved_job', r), r, format(
      $q$select public.create_saved_job(%L, '{"title":"x"}')$q$, pg_temp.id('U1')), '^42501 permission denied');
    perform pg_temp.deny(format('B3 %s cannot EXECUTE skip_reward_intent', r), r, format(
      $q$select public.skip_reward_intent(%L, 1, 'xxxxxxxxxxxxxxxx')$q$, pg_temp.id('A')), '^42501 permission denied');
    perform pg_temp.expect(format('B3 %s sees 0 saved_jobs rows (existing RLS, no policy)', r), r,
      'select count(*) from public.saved_jobs', '0');
    perform pg_temp.expect(format('B3 %s UPDATE of any card matches 0 rows under RLS', r), r,
      $q$with u as (update public.saved_jobs set cover_letter_text = 'pwn' returning 1) select count(*) from u$q$, '0');
  end loop;
  perform pg_temp.expect('B3 no card text was changed by anon/authenticated', null,
    $q$select count(*) from public.saved_jobs where cover_letter_text = 'pwn'$q$, '0');

  foreach r in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
    foreach g in array array['gamification_capture','gamification_processor','gamification_cover_letter_writer','gamification_admin'] loop
      perform pg_temp.check(format('B4 %s has no path to %s', r, g), not pg_has_role(r, g, 'MEMBER'));
    end loop;
  end loop;
  -- SET ROLE is checked against the session user, so the real login probe
  -- (authenticator → SET ROLE gamification_*) is in the concurrency script.
end $$;

-- ===========================================================================
-- K. Catalog: roles, ownership, EXECUTE, policies, grants
-- ===========================================================================
create temp table k_funcs (sig text primary key, owner text, definer boolean, entry boolean);
insert into k_funcs values
  ('g1_cv_run_card()',                                         null,                               false, false),
  ('g2_cover_letter_marker()',                                 null,                               false, false),
  ('g3_goal_timezone()',                                       null,                               false, false),
  ('create_saved_job(uuid,jsonb)',                             null,                               false, true),
  ('change_job_status(uuid,uuid,text,text)',                   null,                               false, true),
  ('enqueue_reward_intent(uuid,text,text,text,text,jsonb)',    'gamification_capture',             true,  false),
  ('trg_saved_jobs_capture()',                                 'gamification_capture',             true,  false),
  ('trg_job_events_capture()',                                 'gamification_capture',             true,  false),
  ('trg_cv_completed_capture()',                               'gamification_capture',             true,  false),
  ('trg_answer_capture()',                                     'gamification_capture',             true,  false),
  ('trg_session_complete_capture()',                           'gamification_capture',             true,  false),
  ('trg_tool_results_capture()',                               'gamification_capture',             true,  false),
  ('charge_credits(uuid,integer)',                             'gamification_cover_letter_writer', true,  true),
  ('record_cover_letter(uuid,uuid,text,uuid,integer)',         'gamification_cover_letter_writer', true,  true),
  ('apply_coin_transaction(uuid,integer,text,text)',           'gamification_processor',           true,  false),
  ('gam_local_today(uuid)',                                    'gamification_processor',           true,  false),
  ('ensure_daily_quests(uuid)',                                'gamification_processor',           true,  true),
  ('book_rest_day(uuid,date)',                                 'gamification_processor',           true,  true),
  ('gam_streak_length(uuid,date)',                             'gamification_processor',           true,  false),
  ('gam_award_achievement(uuid,text,bigint,gamification_config)', 'gamification_processor',        true,  false),
  ('gam_decide(reward_intents)',                               'gamification_processor',           true,  false),
  ('process_reward_intents(uuid)',                             'gamification_processor',           true,  true),
  ('skip_reward_intent(uuid,bigint,text)',                     'gamification_admin',               true,  true);
grant select on k_funcs to public;

-- The EXECUTE grants every pre-047 function had (taken from a database built
-- through 046). 047 must not change any of them.
create temp table k_existing (sig text primary key, grantees text);
insert into k_existing values
  ('assert_job_staleness_args(interval,interval,integer,interval,text[])', 'service_role'),
  ('begin_sponsor_register_finalization(uuid)', 'service_role'),
  ('close_expired_jobs()', 'service_role'),
  ('close_stale_jobs(boolean,boolean,interval,interval,integer,interval,text[])', 'service_role'),
  ('complete_sponsor_register_import(uuid)', 'service_role'),
  ('delete_companies_permanently(uuid[])', 'service_role'),
  ('enforce_company_additional_url_limit()', 'anon,authenticated,service_role'),
  ('finalize_sponsor_register_import(uuid)', 'service_role'),
  ('handle_new_auth_user()', 'anon,authenticated,service_role'),
  ('job_crawl_coverage(integer,interval,text[])', 'service_role'),
  ('match_bullets(vector,uuid,double precision,integer)', 'anon,authenticated,service_role'),
  ('promote_sponsor_register_import_chunk(uuid,integer)', 'service_role'),
  ('stale_job_candidates(interval,interval,integer,interval,text[],boolean)', 'service_role'),
  ('user_engagement(uuid[])', 'anon,authenticated,service_role'),
  ('withdraw_sponsor_register_chunk(uuid,integer)', 'service_role');

create function pg_temp.fn(sig text) returns oid language sql stable as $$ select ('public.' || sig)::regprocedure::oid $$;
create function pg_temp.api_grantees(p oid) returns text language sql stable as $$
  select concat_ws(',',
    case when has_function_privilege('anon', p, 'EXECUTE') then 'anon' end,
    case when has_function_privilege('authenticated', p, 'EXECUTE') then 'authenticated' end,
    case when has_function_privilege('service_role', p, 'EXECUTE') then 'service_role' end)
$$;

do $$
declare f record; v_owner oid := (select relowner from pg_class where oid = 'public.reward_intents'::regclass);
begin
  perform pg_temp.check('K1 the four owner roles exist',
    (select count(*) from pg_roles where rolname in ('gamification_capture','gamification_processor',
                                                     'gamification_cover_letter_writer','gamification_admin')) = 4);
  perform pg_temp.check('K1 no owner role can log in, bypass RLS, or create roles/databases',
    not exists (select 1 from pg_roles where rolname like 'gamification\_%'
                 and (rolcanlogin or rolbypassrls or rolsuper or rolcreaterole or rolcreatedb or rolinherit)));
  perform pg_temp.check('K1 owner roles are granted only to the non-superuser migration owner (or to nobody)',
    not exists (select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles mem on mem.oid = m.member
                 where g.rolname like 'gamification\_%' and (mem.oid <> v_owner or mem.rolsuper)));
  perform pg_temp.check('K1 owner roles are not members of any other role',
    not exists (select 1 from pg_auth_members m join pg_roles mem on mem.oid = m.member where mem.rolname like 'gamification\_%'));
  perform pg_temp.check('K1 owner roles keep no CREATE on schema public after the hand-over',
    not exists (select 1 from pg_roles where rolname like 'gamification\_%' and has_schema_privilege(oid, 'public', 'CREATE')));

  for f in select k.*, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as actual_owner, p.proacl
             from k_funcs k join pg_proc p on p.oid = pg_temp.fn(k.sig) loop
    perform pg_temp.check(format('K2 %s is SECURITY %s', f.sig, case when f.definer then 'DEFINER' else 'INVOKER' end),
      f.prosecdef = f.definer);
    perform pg_temp.check(format('K2 %s pins search_path = pg_catalog, pg_temp', f.sig),
      'search_path=pg_catalog, pg_temp' = any (coalesce(f.proconfig, '{}')));
    if f.owner is not null then
      perform pg_temp.check(format('K2 %s is owned by %s', f.sig, f.owner), f.actual_owner = f.owner);
    else
      perform pg_temp.check(format('K2 %s (invoker) stays owned by the migration owner', f.sig),
        f.actual_owner = pg_get_userbyid(v_owner));
    end if;
    perform pg_temp.check(format('K3 PUBLIC has no EXECUTE on %s', f.sig),
      not exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0));
    perform pg_temp.check(format('K3 API EXECUTE on %s is exactly %s', f.sig, case when f.entry then 'service_role' else 'nobody' end),
      pg_temp.api_grantees(pg_temp.fn(f.sig)) = case when f.entry then 'service_role' else '' end);
  end loop;
  perform pg_temp.check('K3 service_role can EXECUTE exactly eight 047 functions',
    (select count(*) from k_funcs where has_function_privilege('service_role', pg_temp.fn(sig), 'EXECUTE')) = 8);
  perform pg_temp.check('K3 every SECURITY DEFINER function owned by an owner role is one of 047''s',
    not exists (select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
                 where r.rolname like 'gamification\_%' and p.oid::regprocedure::text not in (select sig from k_funcs)));

  for f in select * from k_existing loop
    perform pg_temp.check(format('K4 pre-047 RPC %s keeps EXECUTE for %s', f.sig, f.grantees),
      pg_temp.api_grantees(pg_temp.fn(f.sig)) = f.grantees);
  end loop;
  perform pg_temp.check('K4 no pre-047 function mentions an owner role in its ACL or is owned by one',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.oid::regprocedure::text not in (select sig from k_funcs)
                   and (pg_get_userbyid(p.proowner) like 'gamification\_%'
                        or exists (select 1 from aclexplode(p.proacl) a where pg_get_userbyid(a.grantee) like 'gamification\_%'))));
  perform pg_temp.check('K4 every public function outside 047 is accounted for in the snapshot',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.prokind = 'f'
                   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
                   and p.oid::regprocedure::text not in (select sig from k_funcs union all select sig from k_existing)
                   -- Functions added by later migrations (each tests its own grants):
                   -- 048 coach company page (checked just below), 049 contact importer.
                   and p.proname not in ('coach_company_page',
                                         'ci_norm_name', 'ci_norm_email', 'ci_norm_phone', 'ci_norm_linkedin', 'ci_norm_domain',
                                         'ci_generic_domain', 'contact_import_classify', 'contact_import_commit',
                                         'contact_import_merge_action')));
  perform pg_temp.check('K4 048''s coach_company_page is service_role only',
    has_function_privilege('service_role', 'public.coach_company_page(uuid, boolean, text, integer, integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.coach_company_page(uuid, boolean, text, integer, integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.coach_company_page(uuid, boolean, text, integer, integer)', 'EXECUTE'));

  perform pg_temp.check('K5 RLS is on for every public table',
    not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity));
  perform pg_temp.check('K5 anon/authenticated hold no privilege on any 047 table',
    not exists (select 1 from unnest(array['gamification_config','user_goal_settings','reward_intents','reward_decisions',
                  'reward_locks','reward_audit','xp_grants','coin_wallets','coin_transactions','streak_days',
                  'daily_quest_assignments','user_achievements']) t, unnest(array['anon','authenticated']) r
                 where has_table_privilege(r, 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                    or has_any_column_privilege(r, 'public.' || t, 'SELECT,INSERT,UPDATE,REFERENCES')));
  perform pg_temp.check('K5 no policy on any table names anon, authenticated or public for a gamification table',
    not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename in ('gamification_config','user_goal_settings','reward_intents','reward_decisions','reward_locks',
                                   'reward_audit','xp_grants','coin_wallets','coin_transactions','streak_days',
                                   'daily_quest_assignments','user_achievements')
                 and roles && array['anon','authenticated','public']::name[]));
end $$;

-- K6: the exact policy set 047 owns. One per (table, command, role).
do $$ begin
  perform pg_temp.expect('K6 policies match the privilege matrix', null, $q$
    select string_agg(tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, '+'), E'\n'
                      order by tablename, policyname)
      from pg_policies where schemaname = 'public' and policyname like 'gam\_%'$q$,
    $w$admin_actions:gam_admin_ins:INSERT:gamification_admin
answer_assessments:gam_capture_sel:SELECT:gamification_capture
coin_transactions:gam_proc_ins:INSERT:gamification_processor
coin_transactions:gam_proc_sel:SELECT:gamification_processor
coin_wallets:gam_proc_ins:INSERT:gamification_processor
coin_wallets:gam_proc_sel:SELECT:gamification_processor
coin_wallets:gam_proc_upd:UPDATE:gamification_processor
cv_analysis_jobs:gam_capture_sel:SELECT:gamification_capture
daily_quest_assignments:gam_proc_ins:INSERT:gamification_processor
daily_quest_assignments:gam_proc_sel:SELECT:gamification_processor
daily_quest_assignments:gam_proc_upd:UPDATE:gamification_processor
gamification_config:gam_capture_sel:SELECT:gamification_capture
gamification_config:gam_proc_sel:SELECT:gamification_processor
interview_questions:gam_capture_sel:SELECT:gamification_capture
interview_sessions:gam_capture_sel:SELECT:gamification_capture
job_events:gam_capture_sel:SELECT:gamification_capture
job_events:gam_clw_ins:INSERT:gamification_cover_letter_writer
reward_audit:gam_admin_ins:INSERT:gamification_admin
reward_audit:gam_proc_ins:INSERT:gamification_processor
reward_audit:gam_proc_sel:SELECT:gamification_processor
reward_decisions:gam_proc_ins:INSERT:gamification_processor
reward_decisions:gam_proc_sel:SELECT:gamification_processor
reward_intents:gam_admin_sel:SELECT:gamification_admin
reward_intents:gam_admin_upd:UPDATE:gamification_admin
reward_intents:gam_capture_ins:INSERT:gamification_capture
reward_intents:gam_capture_sel:SELECT:gamification_capture
reward_intents:gam_proc_sel:SELECT:gamification_processor
reward_intents:gam_proc_upd:UPDATE:gamification_processor
reward_locks:gam_proc_ins:INSERT:gamification_processor
reward_locks:gam_proc_sel:SELECT:gamification_processor
saved_jobs:gam_capture_sel:SELECT:gamification_capture
saved_jobs:gam_clw_sel:SELECT:gamification_cover_letter_writer
saved_jobs:gam_clw_upd:UPDATE:gamification_cover_letter_writer
streak_days:gam_proc_ins:INSERT:gamification_processor
streak_days:gam_proc_sel:SELECT:gamification_processor
tool_results:gam_capture_sel:SELECT:gamification_capture
user_achievements:gam_proc_ins:INSERT:gamification_processor
user_achievements:gam_proc_sel:SELECT:gamification_processor
user_goal_settings:gam_capture_sel:SELECT:gamification_capture
user_goal_settings:gam_proc_sel:SELECT:gamification_processor
users:gam_admin_sel:SELECT:gamification_admin
users:gam_clw_sel:SELECT:gamification_cover_letter_writer
users:gam_clw_upd:UPDATE:gamification_cover_letter_writer
xp_grants:gam_proc_ins:INSERT:gamification_processor
xp_grants:gam_proc_sel:SELECT:gamification_processor$w$);
end $$;

-- K7: the exact table- and column-level grants held by the owner roles and by
-- service_role on 047's tables. Anything added later must be added here too.
create function pg_temp.grants_of(p_role text, p_tables text[]) returns text language sql stable as $$
  select string_agg(x, ' ' order by x) from (
    select c.relname || ':' || a.privilege_type as x
      from pg_class c cross join lateral aclexplode(c.relacl) a
     where c.relnamespace = 'public'::regnamespace and a.grantee = p_role::regrole
       and (p_tables is null or c.relname = any (p_tables))
    union all
    select c.relname || '.' || att.attname || ':' || a.privilege_type
      from pg_class c join pg_attribute att on att.attrelid = c.oid
      cross join lateral aclexplode(att.attacl) a
     where c.relnamespace = 'public'::regnamespace and a.grantee = p_role::regrole
       and (p_tables is null or c.relname = any (p_tables))) s
$$;

do $$
declare v_047 text[] := array['gamification_config','user_goal_settings','reward_intents','reward_decisions','reward_locks',
                              'reward_audit','xp_grants','coin_wallets','coin_transactions','streak_days',
                              'daily_quest_assignments','user_achievements'];
begin
  perform pg_temp.expect('K7 gamification_capture grants', null, $q$select pg_temp.grants_of('gamification_capture', null)$q$,
    'answer_assessments.id:SELECT answer_assessments.question_id:SELECT answer_assessments.session_id:SELECT '
    'cv_analysis_jobs.id:SELECT cv_analysis_jobs.input_json:SELECT cv_analysis_jobs.saved_job_id:SELECT '
    'cv_analysis_jobs.status:SELECT cv_analysis_jobs.updated_at:SELECT cv_analysis_jobs.user_id:SELECT '
    'gamification_config:SELECT interview_questions.id:SELECT interview_questions.question_text:SELECT '
    'interview_questions.session_id:SELECT interview_sessions.id:SELECT interview_sessions.status:SELECT '
    'interview_sessions.user_id:SELECT job_events.created_at:SELECT job_events.id:SELECT job_events.job_id:SELECT '
    'job_events.to_status:SELECT job_events.user_id:SELECT reward_intents:INSERT reward_intents:SELECT '
    'saved_jobs.cover_letter_generated_at:SELECT saved_jobs.id:SELECT saved_jobs.next_follow_up_at:SELECT '
    'saved_jobs.status:SELECT saved_jobs.url_key:SELECT saved_jobs.user_id:SELECT tool_results.id:SELECT '
    'tool_results.tool:SELECT tool_results.user_id:SELECT user_goal_settings.timezone:SELECT user_goal_settings.user_id:SELECT');
  perform pg_temp.expect('K7 gamification_processor grants (047 tables only, no source table)', null,
    $q$select pg_temp.grants_of('gamification_processor', null)$q$,
    'coin_transactions:INSERT coin_transactions:SELECT coin_wallets.balance:UPDATE coin_wallets:INSERT coin_wallets:SELECT '
    'daily_quest_assignments.completed_at:UPDATE daily_quest_assignments.progress:UPDATE daily_quest_assignments:INSERT '
    'daily_quest_assignments:SELECT gamification_config:SELECT reward_audit:INSERT reward_audit:SELECT '
    'reward_decisions:INSERT reward_decisions:SELECT reward_intents.attempts:UPDATE reward_intents.last_error:UPDATE '
    'reward_intents.next_attempt_at:UPDATE reward_intents.processed_at:UPDATE reward_intents.state:UPDATE '
    'reward_intents:SELECT reward_locks:INSERT reward_locks:SELECT streak_days:INSERT streak_days:SELECT '
    'user_achievements:INSERT user_achievements:SELECT user_goal_settings.intensity:SELECT '
    'user_goal_settings.timezone:SELECT user_goal_settings.user_id:SELECT xp_grants:INSERT xp_grants:SELECT');
  perform pg_temp.expect('K7 gamification_cover_letter_writer grants', null,
    $q$select pg_temp.grants_of('gamification_cover_letter_writer', null)$q$,
    'job_events.from_status:INSERT job_events.job_id:INSERT job_events.note:INSERT job_events.to_status:INSERT '
    'job_events.user_id:INSERT saved_jobs.cover_letter_generated_at:UPDATE saved_jobs.cover_letter_run_id:UPDATE '
    'saved_jobs.cover_letter_text:UPDATE saved_jobs.cv_version_id:UPDATE saved_jobs.id:SELECT saved_jobs.status:SELECT '
    'saved_jobs.status:UPDATE saved_jobs.updated_at:UPDATE saved_jobs.user_id:SELECT users.credit_balance:SELECT '
    'users.credit_balance:UPDATE users.first_tool_used_at:SELECT users.first_tool_used_at:UPDATE users.id:SELECT');
  perform pg_temp.expect('K7 gamification_admin grants', null, $q$select pg_temp.grants_of('gamification_admin', null)$q$,
    'admin_actions.action:INSERT admin_actions.actor_id:INSERT admin_actions.detail:INSERT admin_actions.target_user_id:INSERT '
    'reward_audit:INSERT reward_intents.last_error:UPDATE reward_intents.processed_at:UPDATE reward_intents.seq:SELECT '
    'reward_intents.state:SELECT reward_intents.state:UPDATE reward_intents.user_id:SELECT users.id:SELECT users.is_admin:SELECT');
  perform pg_temp.expect('K7 service_role on 047 tables: read-only, plus goal settings and achievement seen_at', null,
    format($q$select pg_temp.grants_of('service_role', %L)$q$, v_047),
    'coin_transactions:SELECT coin_wallets:SELECT daily_quest_assignments:SELECT gamification_config:SELECT '
    'reward_audit:SELECT reward_decisions:SELECT reward_intents:SELECT streak_days:SELECT user_achievements.seen_at:UPDATE '
    'user_achievements:SELECT user_goal_settings.goal_type:INSERT user_goal_settings.goal_type:UPDATE '
    'user_goal_settings.intensity:INSERT user_goal_settings.intensity:UPDATE user_goal_settings.timeline:INSERT '
    'user_goal_settings.timeline:UPDATE user_goal_settings.timezone:INSERT user_goal_settings.timezone:UPDATE '
    'user_goal_settings.updated_at:UPDATE user_goal_settings.user_id:INSERT user_goal_settings:SELECT xp_grants:SELECT');
end $$;

-- ===========================================================================
-- C. Least privilege of the owner roles (probed by SET ROLE as superuser)
-- ===========================================================================
do $$ begin
  perform pg_temp.deny('C1 capture cannot read saved_jobs.description', 'gamification_capture',
    'select description from public.saved_jobs', '^42501 permission denied');
  perform pg_temp.deny('C1 capture cannot UPDATE saved_jobs', 'gamification_capture',
    $q$update public.saved_jobs set status = 'saved'$q$, '^42501 permission denied');
  perform pg_temp.deny('C1 capture cannot INSERT decisions', 'gamification_capture',
    'insert into public.reward_decisions default values', '^42501 permission denied');
  perform pg_temp.deny('C1 capture cannot insert an already-processed intent (RLS WITH CHECK)', 'gamification_capture', format(
    $q$insert into public.reward_intents (user_id, kind, source_table, source_id, snapshot, local_day, config_version, state)
       values (%L, 'x', 'x', 'x', '{}', current_date, 1, 'processed')$q$, pg_temp.id('U1')), '^42501 new row violates row-level security');
  perform pg_temp.deny('C2 processor cannot read saved_jobs', 'gamification_processor',
    'select id from public.saved_jobs', '^42501 permission denied');
  perform pg_temp.deny('C2 processor cannot UPDATE users', 'gamification_processor',
    'update public.users set credit_balance = 100', '^42501 permission denied');
  perform pg_temp.deny('C2 processor cannot INSERT intents', 'gamification_processor', format(
    $q$insert into public.reward_intents (user_id, kind, source_table, source_id, snapshot, local_day, config_version)
       values (%L, 'x', 'x', 'x', '{}', current_date, 1)$q$, pg_temp.id('U1')), '^42501 permission denied');
  perform pg_temp.deny('C2 processor cannot rewrite a decision', 'gamification_processor',
    $q$update public.reward_decisions set outcome = 'granted'$q$, '^42501 permission denied');
  perform pg_temp.deny('C2 processor cannot push a wallet negative (RLS WITH CHECK / CHECK)', 'gamification_processor',
    'update public.coin_wallets set balance = -1', '^(42501|23514)');
  perform pg_temp.deny('C3 writer cannot read saved_jobs.notes', 'gamification_cover_letter_writer',
    'select notes from public.saved_jobs', '^42501 permission denied');
  perform pg_temp.deny('C3 writer cannot UPDATE saved_jobs.description', 'gamification_cover_letter_writer',
    $q$update public.saved_jobs set description = 'x'$q$, '^42501 permission denied');
  perform pg_temp.deny('C3 writer cannot UPDATE users.is_admin', 'gamification_cover_letter_writer',
    'update public.users set is_admin = true', '^42501 permission denied');
  perform pg_temp.deny('C3 writer cannot insert an applied event (RLS WITH CHECK)', 'gamification_cover_letter_writer', format(
    $q$insert into public.job_events (job_id, user_id, to_status) values (%L, %L, 'applied')$q$, pg_temp.id('C3'), pg_temp.id('U1')),
    '^42501 new row violates row-level security');
  perform pg_temp.deny('C3 writer cannot INSERT intents', 'gamification_cover_letter_writer',
    'insert into public.reward_intents default values', '^42501 permission denied');
  perform pg_temp.deny('C3 admin role cannot read intent snapshots', 'gamification_admin',
    'select snapshot from public.reward_intents', '^42501 permission denied');
  perform pg_temp.deny('C3 admin role cannot log any other admin action (RLS WITH CHECK)', 'gamification_admin', format(
    $q$insert into public.admin_actions (actor_id, target_user_id, action) values (%L, %L, 'set_admin')$q$,
    pg_temp.id('A'), pg_temp.id('U1')), '^42501 new row violates row-level security');

  perform pg_temp.expect_undone('C4 without its RLS policy the writer''s users UPDATE silently matches 0 rows',
    'drop policy gam_clw_upd on public.users', 'gamification_cover_letter_writer', format(
    $q$with u as (update public.users set credit_balance = credit_balance where id = %L returning 1) select count(*) from u$q$,
    pg_temp.id('U2')), '0');
  perform pg_temp.deny('C4 …so record_cover_letter reports an invariant failure (GX001), not CREDIT_EXHAUSTED', null, format(
    $q$drop policy gam_clw_upd on public.users;
       update public.users set credit_balance = 5 where id = %1$L;
       select public.record_cover_letter(%1$L, %2$L, 'x', null, 1)$q$, pg_temp.id('U2'), pg_temp.id('C2')), '^GX001');

  perform pg_temp.intent(pg_temp.id('U1'), 'application', 'c5-bad', '{"card_id":"z","url_key":"q","best_cv_jd_chars":"abc"}');
  perform pg_temp.intent(pg_temp.id('U1'), 'job_saved', 'c5-after', '{"card_id":"y","url_key":"y"}');
  perform pg_temp.expect('C5 a failing intent stops the queue (head-of-line)', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('U1')), '0');
  perform pg_temp.expect('C5 …attempts=1, backoff set, the later intent still pending', null,
    $q$select string_agg(source_id || ':' || state || ':' || attempts || ':' || coalesce((next_attempt_at > now())::text, 'none'), ','
                         order by seq) from public.reward_intents where source_table = 'test' and source_id like 'c5-%'$q$,
    'c5-bad:pending:1:true,c5-after:pending:0:none');
  perform pg_temp.expect('C5 …and the failed attempt wrote nothing', null, format(
    $q$select count(*) from public.reward_decisions where user_id = %L$q$, pg_temp.id('U1')), '5');
end $$;

-- ===========================================================================
-- D. Every capture trigger, judged (user B)
-- ===========================================================================
do $$
declare v_card uuid; v_nourl uuid;
begin
  perform pg_temp.expect('D1 create_saved_job as applied, with a URL', 'service_role', format(
    $q$select (public.create_saved_job(%L, '{"title":"Analyst","job_url":"https://b.example/1","url_key":"b.example/1","status":"applied","source":"career_hub"}')).status$q$,
    pg_temp.id('B')), 'applied');
  perform pg_temp.expect('D1 card + applied_at + one event + save and application intents, in one transaction', null, format(
    $q$select (select count(*) from public.saved_jobs where user_id = %1$L and applied_at is not null)::text || '/'
           || (select count(*) from public.job_events where user_id = %1$L) || '/'
           || (select string_agg(kind, ',' order by seq) from public.reward_intents where user_id = %1$L)$q$,
    pg_temp.id('B')), '1/1/job_saved,application');
  perform pg_temp.deny('D1 the same URL again → unique violation', 'service_role', format(
    $q$select public.create_saved_job(%L, '{"title":"Dup","job_url":"https://b.example/1","url_key":"b.example/1","status":"applied"}')$q$,
    pg_temp.id('B')), '^23505');
  perform pg_temp.expect('D1 …nothing partial: still 1 card, 1 event, 2 intents', null, format(
    $q$select (select count(*) from public.saved_jobs where user_id = %1$L)::text || '/'
           || (select count(*) from public.job_events where user_id = %1$L) || '/'
           || (select count(*) from public.reward_intents where user_id = %1$L)$q$, pg_temp.id('B')), '1/1/2');
  perform pg_temp.deny('D1 an unknown status is refused by the existing CHECK', 'service_role', format(
    $q$select public.create_saved_job(%L, '{"title":"Bad","status":"hired"}')$q$, pg_temp.id('B')), '^23514');
  perform pg_temp.expect('D1 create_saved_job ignores a smuggled cover-letter marker', 'service_role', format(
    $q$select ((public.create_saved_job(%L, '{"title":"Smuggle","cover_letter_run_id":"aaaaaaaa-0000-0000-0000-00000000ffff"}')).cover_letter_run_id is null)::text$q$,
    pg_temp.id('B')), 'true');
end $$;

-- D2–D9 ---------------------------------------------------------------------
do $$
declare v_card text; v_nourl text;
begin
  perform pg_temp.ok('D2 a card without a URL', 'service_role', format(
    $q$select public.create_saved_job(%L, '{"title":"NoUrl"}')$q$, pg_temp.id('B')));
  v_nourl := (select id::text from public.saved_jobs where user_id = pg_temp.id('B') and title = 'NoUrl');
  v_card  := (select id::text from public.saved_jobs where user_id = pg_temp.id('B') and url_key = 'b.example/1');
  perform pg_temp.expect('D2 no save intent without a URL', null, format(
    $q$select count(*) from public.reward_intents where source_id = %L$q$, v_nourl), '0');
  perform pg_temp.ok('D2 add a URL, then change it (the card edit endpoint)', 'service_role', format(
    $q$update public.saved_jobs set job_url = 'https://b.example/2', url_key = 'b.example/2' where id = %1$L;
       update public.saved_jobs set job_url = 'https://b.example/3', url_key = 'b.example/3' where id = %1$L;
       update public.saved_jobs set notes = 'unrelated edit' where id = %1$L$q$, v_nourl));
  perform pg_temp.expect('D2 one intent per URL the card has had; other edits capture nothing', null, format(
    $q$select string_agg(subject, ',' order by seq) from public.reward_intents where source_id = %L$q$, v_nourl),
    'b.example/2,b.example/3');

  -- D3 follow-ups: the application happened five days ago.
  update public.job_events set created_at = now() - interval '5 days' where job_id = v_card::uuid and to_status = 'applied';
  perform pg_temp.ok('D3 follow-up five days after applying', 'service_role', format(
    $q$select public.change_job_status(%L, %L, 'follow_up')$q$, pg_temp.id('B'), v_card));
  -- (A function's writes are invisible to the rest of the statement that
  -- called it, so every "call, then check" below is two statements.)
  perform pg_temp.expect('D3 re-sending the same status returns the card…', 'service_role', format(
    $q$select (public.change_job_status(%L, %L, 'follow_up')).status$q$, pg_temp.id('B'), v_card), 'follow_up');
  perform pg_temp.expect('D3 …and writes no event', null, format(
    $q$select count(*) from public.job_events where job_id = %L and to_status = 'follow_up'$q$, v_card), '1');
  perform pg_temp.expect('D3 another user''s card → NULL…', 'service_role', format(
    $q$select coalesce((public.change_job_status(%L, %L, 'offer')).status, 'null')$q$, pg_temp.id('X'), v_card), 'null');
  perform pg_temp.expect('D3 …and nothing written', null, format(
    $q$select count(*) from public.job_events where job_id = %L and to_status = 'offer'$q$, v_card), '0');
  perform pg_temp.ok('D3 back to applied, then a second follow-up the same day', 'service_role', format(
    $q$select public.change_job_status(%1$L, %2$L, 'applied');
       select public.change_job_status(%1$L, %2$L, 'follow_up')$q$, pg_temp.id('B'), v_card));
  perform pg_temp.expect('D3 applied_at keeps the first application', null, format(
    $q$select (applied_at < now() - interval '1 day')::text from public.saved_jobs where id = %L$q$, v_card), 'false');

  perform pg_temp.ok('D4 interview then offer; then interview on the second card', 'service_role', format(
    $q$select public.change_job_status(%1$L, %2$L, 'interview');
       select public.change_job_status(%1$L, %2$L, 'offer');
       select public.change_job_status(%1$L, %3$L, 'interview')$q$, pg_temp.id('B'), v_card, v_nourl));
  perform pg_temp.expect('D4 three milestone intents (interview, offer, interview)', null, format(
    $q$select string_agg(subject, ',' order by seq) from public.reward_intents where user_id = %L and kind = 'milestone'$q$,
    pg_temp.id('B')), 'interview,offer,interview');

  -- D5 mock interviews: session 1 has three distinct questions (one asked
  -- twice), session 2 one — the same text, but practice dedups per session.
  insert into public.interview_sessions (id, user_id, persona_id) values
    ('e0000000-0000-0000-0000-000000000001', pg_temp.id('B'), 'mentor'),
    ('e0000000-0000-0000-0000-000000000002', pg_temp.id('B'), 'mentor');
  insert into public.interview_questions (id, session_id, question_text) values
    ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'Q one'),
    ('f0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', '  q ONE  '),
    ('f0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001', 'Q two'),
    ('f0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001', 'Q three'),
    ('f0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000002', 'Q one');
  perform pg_temp.ok('D5 five answers (the same question re-asked with different spacing/case)', 'service_role', $q$
    insert into public.answer_assessments (session_id, question_id, integrity_score, relevance_score, substance_score, overall_score) values
      ('e0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 3, 3, 3, 3),
      ('e0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000002', 3, 3, 3, 3),
      ('e0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000003', 3, 3, 3, 3),
      ('e0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000004', 3, 3, 3, 3),
      ('e0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000005', 3, 3, 3, 3)$q$);
  perform pg_temp.ok('D5 complete both sessions, then re-evaluate session 1', 'service_role', format(
    $q$update public.interview_sessions set status = 'complete' where user_id = %L;
       update public.interview_sessions set status = 'evaluating' where id = 'e0000000-0000-0000-0000-000000000001';
       update public.interview_sessions set status = 'complete' where id = 'e0000000-0000-0000-0000-000000000001'$q$,
    pg_temp.id('B')));
  perform pg_temp.expect('D5 one mock intent per session; distinct answers 3 and 1', null, format(
    $q$select string_agg(snapshot->>'distinct_answers', ',' order by seq) from public.reward_intents
        where user_id = %L and kind = 'mock_complete'$q$, pg_temp.id('B')), '3,1');

  perform pg_temp.ok('D6 three Dream Company runs and one Interview Lab run', 'service_role', format(
    $q$insert into public.tool_results (user_id, tool, result) values (%1$L, 'dream', '{}'), (%1$L, 'dream', '{}'),
                                                               (%1$L, 'dream', '{}'), (%1$L, 'interview', '{}')$q$,
    pg_temp.id('B')));
  perform pg_temp.expect('D6 only Dream runs are captured', null, format(
    $q$select count(*) from public.reward_intents where user_id = %L and kind = 'company_research'$q$, pg_temp.id('B')), '3');

  perform pg_temp.expect('D7 ensure_daily_quests assigns three quests', 'service_role', format(
    $q$select string_agg(quest_key || ':' || target, ',') from public.ensure_daily_quests(%L)$q$, pg_temp.id('B')),
    'practice_answer:1,save_jobs:2,tailor_cv:1');
  perform pg_temp.expect('D7 …and is idempotent', 'service_role', format(
    $q$select count(*) from public.ensure_daily_quests(%L)$q$, pg_temp.id('B')), '3');
  perform pg_temp.deny('D7 service_role cannot set quest progress', 'service_role',
    'update public.daily_quest_assignments set progress = 2', '^42501 permission denied');

  perform pg_temp.expect('D8 process B: every intent judged', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('B')), '20');
  perform pg_temp.expect('D8 decisions and audit rows by kind', null, format(
    $q$select string_agg(k, ',' order by k) from (
         select kind || ':' || outcome || coalesce(':' || reason, '') || coalesce(':' || tier, '') k
           from public.reward_decisions where user_id = %1$L
         union all
         select 'audit:' || outcome || ':' || reason from public.reward_audit where user_id = %1$L) x$q$, pg_temp.id('B')),
    'answer_practice:granted,answer_practice:granted,answer_practice:granted,answer_practice:granted,application:granted:quick,'
    'audit:duplicate:achievement_held,audit:duplicate:card_locked,audit:duplicate:card_locked,audit:duplicate:same_question,'
    'company_research:capped,company_research:granted,company_research:granted,follow_up:granted,'
    'follow_up:ineligible:week_limit,job_saved:granted,job_saved:granted,milestone:granted,milestone:granted,'
    'mock_complete:granted,mock_complete:ineligible:too_few_answers');
  perform pg_temp.expect('D8 every intent is processed and has exactly one decision or audit row', null, format(
    $q$select count(*) from public.reward_intents i where i.user_id = %L and (i.state <> 'processed'
         or (select count(*) from public.reward_decisions d where d.intent_seq = i.seq)
          + (select count(*) from public.reward_audit a where a.intent_seq = i.seq) <> 1)$q$, pg_temp.id('B')), '0');
  perform pg_temp.expect('D8 XP: saves 4 + quick 5 + follow-up 5 + practice 20 + mock 20 + research 10 = 64 (under the weekly 80)', null, format(
    $q$select sum(xp)::text || '/' || (select count(*) from public.coin_transactions where user_id = %1$L and reason = 'weekly_challenge')
         from public.xp_grants where user_id = %1$L$q$, pg_temp.id('B')), '64/0');
  perform pg_temp.expect('D8 achievements: first_shot 10 + first_mock 10 + interview_unlocked 25 + you_did_it 50 = 95 coins', null, format(
    $q$select (select string_agg(achievement_key, ',' order by achievement_key) from public.user_achievements where user_id = %1$L)
           || '/' || (select balance from public.coin_wallets where user_id = %1$L)$q$, pg_temp.id('B')),
    'first_mock,first_shot,interview_unlocked,you_did_it/95');
  perform pg_temp.expect('D8 milestones and capped decisions give no XP', null, format(
    $q$select count(*) from public.xp_grants g join public.reward_decisions d on d.id = g.decision_id
        where d.user_id = %L and (d.kind = 'milestone' or d.outcome <> 'granted')$q$, pg_temp.id('B')), '0');
  perform pg_temp.expect('D8 quests: save_jobs 2/2 and practice 1/1 done, tailor_cv not; no daily coins yet', null, format(
    $q$select (select string_agg(quest_key || ':' || progress || ':' || (completed_at is not null), ',' order by quest_key)
                 from public.daily_quest_assignments where user_id = %1$L) || '/'
           || (select count(*) from public.coin_transactions where user_id = %1$L and reason = 'daily_quests')$q$,
    pg_temp.id('B')), 'practice_answer:1:true,save_jobs:2:true,tailor_cv:0:false/0');

  perform pg_temp.ok('D9 service_role marks an achievement seen', 'service_role', format(
    $q$update public.user_achievements set seen_at = now() where user_id = %L and achievement_key = 'first_shot'$q$, pg_temp.id('B')));
  perform pg_temp.deny('D9 …but cannot change its key', 'service_role', format(
    $q$update public.user_achievements set achievement_key = 'x' where user_id = %L$q$, pg_temp.id('B')), '^42501 permission denied');
end $$;

-- D10–D11: retries, backoff, stuck, the secured skip (user X) ----------------
do $$
declare v_bad bigint; v_next bigint;
begin
  v_bad  := pg_temp.intent(pg_temp.id('X'), 'application', 'x-bad', '{"card_id":"z","url_key":"q","best_cv_jd_chars":"abc"}');
  v_next := pg_temp.intent(pg_temp.id('X'), 'company_research', 'x-next', '{"tool_result_id":"t1"}');
  perform pg_temp.expect('D10 the first run fails the head intent', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('X')), '0');
  perform pg_temp.expect('D10 an immediate re-run respects the backoff', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('X')), '0');
  perform pg_temp.expect('D10 attempts=1, the error recorded with its SQLSTATE, backoff ≈ 1 minute', null, format(
    $q$select attempts || ':' || (last_error like '22P02:%%')::text || ':' || (next_attempt_at = now() + interval '1 minute')::text
         from public.reward_intents where seq = %s$q$, v_bad), '1:true:true');
  update public.reward_intents set attempts = 5, next_attempt_at = now() - interval '1 second' where seq = v_bad;
  perform public.process_reward_intents(pg_temp.id('X'));
  perform pg_temp.expect('D10 the backoff doubles per attempt (attempt 6 → 32 minutes)', null, format(
    $q$select (next_attempt_at = now() + interval '32 minutes')::text from public.reward_intents where seq = %s$q$, v_bad), 'true');
  update public.reward_intents set attempts = 7, next_attempt_at = now() - interval '1 second' where seq = v_bad;
  perform public.process_reward_intents(pg_temp.id('X'));
  perform pg_temp.expect('D10 …and is capped at one hour', null, format(
    $q$select (next_attempt_at = now() + interval '1 hour')::text from public.reward_intents where seq = %s$q$, v_bad), 'true');
  update public.reward_intents set attempts = 9, next_attempt_at = now() - interval '1 second' where seq = v_bad;
  perform pg_temp.ok('D10 the tenth failure', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('X')));
  perform pg_temp.expect('D10 → stuck; the next intent still waits', null, format(
    $q$select string_agg(source_id || ':' || state, ',' order by seq) from public.reward_intents where user_id = %L$q$,
    pg_temp.id('X')), 'x-bad:stuck,x-next:pending');
  perform pg_temp.expect('D10 a stuck intent keeps blocking the queue on later runs', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('X')), '0');
  perform pg_temp.expect('D10 …the next intent is still pending', null, format(
    $q$select state from public.reward_intents where seq = %s$q$, v_next), 'pending');
  perform pg_temp.expect('D10 the processor role cannot touch a stuck intent (0 rows)', 'gamification_processor', format(
    $q$with u as (update public.reward_intents set state = 'processed' where seq = %s returning 1) select count(*) from u$q$, v_bad), '0');
  perform pg_temp.deny('D10 the processor role cannot set skipped (RLS WITH CHECK)', 'gamification_processor', format(
    $q$update public.reward_intents set state = 'skipped' where seq = %s$q$, v_next), '^42501 new row violates row-level security');

  perform pg_temp.deny('D11 a non-admin actor is refused', 'service_role', format(
    $q$select public.skip_reward_intent(%L, %s, 'corrupt snapshot from a test')$q$, pg_temp.id('B'), v_bad), '^42501 .*not an admin');
  perform pg_temp.deny('D11 an unknown actor is refused', 'service_role', format(
    $q$select public.skip_reward_intent(gen_random_uuid(), %s, 'corrupt snapshot from a test')$q$, v_bad), '^42501 .*not an admin');
  perform pg_temp.deny('D11 a short reason is refused', 'service_role', format(
    $q$select public.skip_reward_intent(%L, %s, '  bad     ')$q$, pg_temp.id('A'), v_bad), '^22023 .*at least 10');
  perform pg_temp.deny('D11 a pending intent cannot be skipped → GN002', 'service_role', format(
    $q$select public.skip_reward_intent(%L, %s, 'should not be skippable')$q$, pg_temp.id('A'), v_next), '^GN002');
  perform pg_temp.ok('D11 an admin skips the stuck intent', 'service_role', format(
    $q$select public.skip_reward_intent(%L, %s, 'corrupt snapshot from a test')$q$, pg_temp.id('A'), v_bad));
  perform pg_temp.expect('D11 skipped + an audit row + an admin_actions row', null, format(
    $q$select (select state from public.reward_intents where seq = %1$s) || '/'
           || (select outcome || ':' || reason from public.reward_audit where intent_seq = %1$s) || '/'
           || (select count(*) from public.admin_actions where action = 'skip_reward_intent' and actor_id = %2$L
                 and target_user_id = %3$L and (detail->>'intent_seq')::bigint = %1$s)$q$, v_bad, pg_temp.id('A'), pg_temp.id('X')),
    'skipped/skipped:corrupt snapshot from a test/1');
  perform pg_temp.deny('D11 skipping twice → GN002', 'service_role', format(
    $q$select public.skip_reward_intent(%L, %s, 'corrupt snapshot from a test')$q$, pg_temp.id('A'), v_bad), '^GN002');
  perform pg_temp.expect('D11 the queue moves on: the next intent is processed', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('X')), '1');
  perform pg_temp.expect('D11 the admin role cannot reopen a skipped intent (RLS USING state = stuck: 0 rows)', 'gamification_admin', format(
    $q$with u as (update public.reward_intents set state = 'pending' where seq = %s returning 1) select count(*) from u$q$, v_bad), '0');
  perform pg_temp.deny('D11 the admin role cannot write a stuck intent back to pending (RLS WITH CHECK)', null, format(
    $q$update public.reward_intents set state = 'stuck' where seq = %1$s;
       set local role gamification_admin;
       update public.reward_intents set state = 'pending' where seq = %1$s$q$, v_bad), '^42501 new row violates row-level security');
  perform pg_temp.expect('D11 the admin role cannot skip a pending intent directly (0 rows)', 'gamification_admin',
    $q$with u as (update public.reward_intents set state = 'skipped' where state = 'pending' returning 1) select count(*) from u$q$, '0');
end $$;

-- D12: cover-letter failures are told apart, and all roll back (user X) ------
do $$
declare v_card text;
begin
  perform pg_temp.ok('D12 a card for X', 'service_role', format(
    $q$select public.create_saved_job(%L, '{"title":"Letter","job_url":"https://x.example/1","url_key":"x.example/1"}')$q$,
    pg_temp.id('X')));
  v_card := (select id::text from public.saved_jobs where user_id = pg_temp.id('X'));
  perform pg_temp.deny('D12a cost over balance → GC001 CREDIT_EXHAUSTED', 'service_role', format(
    $q$select public.record_cover_letter(%L, %L, 't', null, 50)$q$, pg_temp.id('X'), v_card), '^GC001 CREDIT_EXHAUSTED');
  perform pg_temp.deny('D12b users UPDATE policy missing → GX001, not GC001', null, format(
    $q$drop policy gam_clw_upd on public.users; select public.record_cover_letter(%L, %L, 't', null, 1)$q$, pg_temp.id('X'), v_card),
    '^GX001');
  perform pg_temp.deny('D12c saved_jobs UPDATE policy missing → the card is invisible to FOR UPDATE → GN001', null, format(
    $q$drop policy gam_clw_upd on public.saved_jobs; select public.record_cover_letter(%L, %L, 't', null, 1)$q$, pg_temp.id('X'), v_card),
    '^GN001');
  perform pg_temp.deny('D12d job_events INSERT policy missing → RLS violation 42501', null, format(
    $q$drop policy gam_clw_ins on public.job_events; select public.record_cover_letter(%L, %L, 't', null, 1)$q$, pg_temp.id('X'), v_card),
    '^42501 new row violates row-level security');
  perform pg_temp.deny('D12e another user''s card → GN001', 'service_role', format(
    $q$select public.record_cover_letter(%L, %L, 't', null, 1)$q$, pg_temp.id('X'),
    (select id from public.saved_jobs where user_id = pg_temp.id('B') limit 1)), '^GN001');
  perform pg_temp.deny('D12f a missing user → GX001', 'service_role', format(
    $q$select public.charge_credits(gen_random_uuid(), 1)$q$), '^GX001');
  perform pg_temp.expect('D12 after every failure: balance 5, no letter, no cover_letter intent, no preparing event', null, format(
    $q$select (select credit_balance from public.users where id = %1$L)::text || '/'
           || (select count(*) from public.saved_jobs where user_id = %1$L and cover_letter_run_id is not null) || '/'
           || (select count(*) from public.reward_intents where user_id = %1$L and kind = 'cover_letter') || '/'
           || (select count(*) from public.job_events where user_id = %1$L and to_status = 'preparing')$q$, pg_temp.id('X')), '5/0/0/0');
  perform pg_temp.expect('D12 a free charge (cost 0, as for admins) changes nothing', 'service_role', format(
    $q$select public.charge_credits(%L, 0)$q$, pg_temp.id('X')), '5');
  perform pg_temp.expect('D12 …and does not count as a first tool use', null, format(
    $q$select (first_tool_used_at is null)::text from public.users where id = %L$q$, pg_temp.id('X')), 'true');
  perform pg_temp.expect('D12 charge_credits for a letter with no card: 5 → 4', 'service_role', format(
    $q$select public.charge_credits(%L, 1)$q$, pg_temp.id('X')), '4');
  perform pg_temp.expect('D12 …and first_tool_used_at is set', null, format(
    $q$select credit_balance || '/' || (first_tool_used_at is not null) from public.users where id = %L$q$, pg_temp.id('X')), '4/true');
  perform pg_temp.deny('D12 charge_credits over the balance → GC001', 'service_role', format(
    $q$select public.charge_credits(%L, 99)$q$, pg_temp.id('X')), '^GC001');
  perform pg_temp.ok('D12 a cost of 0 writes the letter…', 'service_role', format(
    $q$select public.record_cover_letter(%L, %L, 'free', null, 0)$q$, pg_temp.id('X'), v_card));
  perform pg_temp.expect('D12 …without charging; the card moves to preparing', null, format(
    $q$select (select credit_balance from public.users where id = %L) || '/' || status from public.saved_jobs where id = %L$q$,
    pg_temp.id('X'), v_card), '4/preparing');
  perform pg_temp.ok('D12 a second letter on the preparing card', 'service_role', format(
    $q$select public.record_cover_letter(%L, %L, 'again', null, 1)$q$, pg_temp.id('X'), v_card));
  perform pg_temp.expect('D12 …replaces the text, writes no second event, captures a second intent', null, format(
    $q$select (select cover_letter_text from public.saved_jobs where id = %1$L) || '/'
           || (select count(*) from public.job_events where job_id = %1$L and to_status = 'preparing') || '/'
           || (select count(*) from public.reward_intents where source_id = %1$L::text and kind = 'cover_letter') || '/'
           || (select credit_balance from public.users where id = %2$L)$q$, v_card, pg_temp.id('X')), 'again/1/2/3');
  perform pg_temp.expect('D12 X''s three intents judged (save, two letters)', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('X')), '3');
  perform pg_temp.expect('D12 the first letter granted, the second audit-only (card locked)', null, format(
    $q$select (select string_agg(outcome, ',') from public.reward_decisions where user_id = %1$L and kind = 'cover_letter') || '/'
           || (select count(*) from public.reward_audit where user_id = %1$L and reason = 'card_locked')$q$,
    pg_temp.id('X')), 'granted/1');
end $$;

-- D13: goal settings and the timezone guard (G3) ------------------------------
do $$ begin
  perform pg_temp.deny('D13 an unknown IANA zone is refused', 'service_role', format(
    $q$insert into public.user_goal_settings (user_id, timezone) values (%L, 'Mars/Olympus')$q$, pg_temp.id('B')), '^22023 G3: unknown IANA');
  perform pg_temp.deny('D13 an unknown intensity is refused', 'service_role', format(
    $q$insert into public.user_goal_settings (user_id, intensity) values (%L, 'heroic')$q$, pg_temp.id('B')), '^23514');
  perform pg_temp.ok('D13 a valid zone and goal', 'service_role', format(
    $q$insert into public.user_goal_settings (user_id, timezone, intensity, goal_type, timeline)
       values (%L, 'Asia/Ho_Chi_Minh', 'light', 'graduate_scheme', 'asap')$q$, pg_temp.id('B')));
  perform pg_temp.expect('D13 the change time is stamped by the trigger', null, format(
    $q$select (timezone_changed_at = now())::text from public.user_goal_settings where user_id = %L$q$, pg_temp.id('B')), 'true');
  perform pg_temp.deny('D13 a second timezone change within 24 hours is refused', 'service_role', format(
    $q$update public.user_goal_settings set timezone = 'Europe/London' where user_id = %L$q$, pg_temp.id('B')), '^23514 G3: .*once per 24 hours');
  perform pg_temp.ok('D13 other fields can change any time', 'service_role', format(
    $q$update public.user_goal_settings set intensity = 'intensive', timeline = 'exploring' where user_id = %L$q$, pg_temp.id('B')));
  perform pg_temp.deny('D13 service_role cannot forge timezone_changed_at', 'service_role', format(
    $q$update public.user_goal_settings set timezone_changed_at = now() - interval '2 days' where user_id = %L$q$, pg_temp.id('B')),
    '^42501 permission denied');
  perform pg_temp.expect('D13 even the table owner cannot backdate timezone_changed_at (G3 keeps the old value)',
    (select pg_get_userbyid(relowner)::text from pg_class where oid = 'public.user_goal_settings'::regclass), format(
    $q$with u as (update public.user_goal_settings set timezone_changed_at = now() - interval '25 hours' where user_id = %L
                 returning timezone_changed_at = now() as kept) select bool_and(kept)::text from u$q$, pg_temp.id('B')), 'true');
  -- Pretend a day has passed (triggers off for this one statement).
  set local session_replication_role = replica;
  update public.user_goal_settings set timezone_changed_at = now() - interval '25 hours' where user_id = pg_temp.id('B');
  set local session_replication_role = origin;
  perform pg_temp.ok('D13 after 24 hours the timezone can change again', 'service_role', format(
    $q$update public.user_goal_settings set timezone = 'America/New_York' where user_id = %L$q$, pg_temp.id('B')));
  perform pg_temp.ok('D13 a card saved after the change…', 'service_role', format(
    $q$select public.create_saved_job(%L, '{"title":"TZ","url_key":"b.example/tz"}')$q$, pg_temp.id('B')));
  perform pg_temp.expect('D13 …is captured on the local day in the user''s new timezone', null, format(
    $q$select (local_day = (now() at time zone 'America/New_York')::date)::text from public.reward_intents
        where user_id = %L and subject = 'b.example/tz'$q$, pg_temp.id('B')), 'true');
end $$;

-- ===========================================================================
-- E. The economy: tiers, caps, URL locks, achievements, quests, weekly
--    challenge (user E, hand-made intents)
-- ===========================================================================
do $$
declare i int;
begin
  insert into public.user_goal_settings (user_id, intensity) values (pg_temp.id('E'), 'active');
  -- Five power and six quality applications today (cap 10), on distinct cards and URLs.
  for i in 1..5 loop
    perform pg_temp.intent(pg_temp.id('E'), 'application', 'e-power-' || i, jsonb_build_object(
      'card_id', 'ep' || i, 'url_key', 'e.example/p' || i, 'best_cv_jd_chars', 450, 'letter_before', true, 'follow_up_after', true));
  end loop;
  for i in 1..6 loop
    perform pg_temp.intent(pg_temp.id('E'), 'application', 'e-quality-' || i, jsonb_build_object(
      'card_id', 'eq' || i, 'url_key', 'e.example/q' || i, 'best_cv_jd_chars', 400, 'letter_before', true, 'follow_up_after', false));
  end loop;
  perform pg_temp.intent(pg_temp.id('E'), 'application', 'e-thin', jsonb_build_object(
    'card_id', 'et', 'url_key', 'e.example/t', 'best_cv_jd_chars', 399, 'letter_before', true, 'follow_up_after', true), pg_temp.today() - 1);
  perform pg_temp.intent(pg_temp.id('E'), 'application', 'e-nourl', jsonb_build_object('card_id', 'en'), pg_temp.today() - 1);
  perform pg_temp.intent(pg_temp.id('E'), 'application', 'e-sameurl', jsonb_build_object(
    'card_id', 'es', 'url_key', 'e.example/p1', 'best_cv_jd_chars', 450, 'letter_before', true, 'follow_up_after', true), pg_temp.today() - 1);
  perform pg_temp.intent(pg_temp.id('E'), 'application', 'e-nourl-again', jsonb_build_object('card_id', 'en'), pg_temp.today() - 1);
  perform pg_temp.expect('E1 fifteen application intents judged', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('E')), '15');
  perform pg_temp.expect('E1 tiers and outcomes', null, format(
    $q$select string_agg(outcome || ':' || coalesce(tier, reason), ',' order by intent_seq) from public.reward_decisions where user_id = %L$q$,
    pg_temp.id('E')),
    'granted:power,granted:power,granted:power,granted:power,granted:power,granted:quality,granted:quality,granted:quality,'
    'granted:quality,granted:quality,capped:quality,granted:quick,ineligible:no_url,ineligible:url_already_rewarded');
  perform pg_temp.expect('E1 the second intent on an ineligible card is audit-only (its first decision locked it)', null, format(
    $q$select string_agg(outcome || ':' || reason, ',') from public.reward_audit where user_id = %L$q$, pg_temp.id('E')),
    'duplicate:card_locked');
  perform pg_temp.expect('E1 XP: 5×25 + 5×15 today; the capped one earns nothing; quick 5 yesterday', null, format(
    $q$select string_agg(local_day - pg_temp.today() || ':' || s, ',' order by local_day) from
         (select local_day, sum(xp) s from public.xp_grants where user_id = %L group by 1) x$q$, pg_temp.id('E')), '-1:5,0:200');
  perform pg_temp.expect('E1 a capped application still locks its card and URL', null, format(
    $q$select count(*) from public.reward_locks l join public.reward_decisions d on d.id = l.decision_id
        where d.user_id = %L and d.outcome = 'capped'$q$, pg_temp.id('E')), '2');
  perform pg_temp.expect('E1 an ineligible application locks its card but not a URL', null, format(
    $q$select string_agg(l.scope, ',') from public.reward_locks l join public.reward_decisions d on d.id = l.decision_id
        where d.user_id = %L and d.outcome = 'ineligible'$q$, pg_temp.id('E')), 'card,card');
  perform pg_temp.expect('E2 achievements: first_shot, quality_over_quantity (5 power), ten_quality (capped counts)', null, format(
    $q$select string_agg(achievement_key || ':' || (d.tier is not null)::text, ',' order by achievement_key)
         from public.user_achievements a join public.reward_decisions d on d.id = a.decision_id where a.user_id = %L$q$,
    pg_temp.id('E')), 'first_shot:true,quality_over_quantity:true,ten_quality:true');
  perform pg_temp.expect('E2 coins: 10 + 50 + 25, then the weekly challenge (≥ 80 XP) + 20 = 105, ledger agrees', null, format(
    $q$select (select balance from public.coin_wallets where user_id = %1$L)::text || '/'
           || (select sum(delta) from public.coin_transactions where user_id = %1$L) || '/'
           || (select string_agg(reason, ',' order by id) from public.coin_transactions where user_id = %1$L and reason <> 'achievement')$q$,
    pg_temp.id('E')), '105/105/weekly_challenge');
  perform pg_temp.expect('E2 the weekly challenge pays once per week', null, format(
    $q$select reference = date_trunc('week', pg_temp.today())::date::text from public.coin_transactions
        where user_id = %L and reason = 'weekly_challenge'$q$, pg_temp.id('E')), 'true');

  -- Daily quests: all three done → +5 coins, once.
  perform public.ensure_daily_quests(pg_temp.id('E'));
  perform pg_temp.intent(pg_temp.id('E'), 'job_saved', 'e-s1', '{"card_id":"es1","url_key":"e.example/s1"}');
  perform pg_temp.intent(pg_temp.id('E'), 'job_saved', 'e-s2', '{"card_id":"es2","url_key":"e.example/s2"}');
  perform pg_temp.intent(pg_temp.id('E'), 'cv_tailor', 'e-cv1', '{"card_id":"es1","card_status":"saved","jd_chars":500}');
  perform pg_temp.intent(pg_temp.id('E'), 'answer_practice', 'e-a1', '{"session_id":"s","fingerprint":"f1"}');
  perform pg_temp.intent(pg_temp.id('E'), 'answer_practice', 'e-a2', '{"session_id":"s","fingerprint":"f2"}');
  perform pg_temp.expect('E3 five more intents judged', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('E')), '5');
  perform pg_temp.expect('E3 every quest completed, progress never past its target, daily coins paid once', null, format(
    $q$select (select string_agg(quest_key || ':' || progress || '/' || target, ',' order by quest_key)
                 from public.daily_quest_assignments where user_id = %1$L) || '/'
           || (select count(*) || ':' || sum(delta) from public.coin_transactions where user_id = %1$L and reason = 'daily_quests')$q$,
    pg_temp.id('E')), 'practice_answer:1/1,save_jobs:2/2,tailor_cv:1/1/1:5');

  -- CV tailor rules.
  perform pg_temp.intent(pg_temp.id('E'), 'cv_tailor', 'e-cv-thin', '{"card_id":"ec1","card_status":"saved","jd_chars":399}');
  perform pg_temp.intent(pg_temp.id('E'), 'cv_tailor', 'e-cv-ok', '{"card_id":"ec1","card_status":"preparing","jd_chars":400}');
  perform pg_temp.intent(pg_temp.id('E'), 'cv_tailor', 'e-cv-late', '{"card_id":"ec2","card_status":"applied","jd_chars":900}');
  perform pg_temp.intent(pg_temp.id('E'), 'cv_tailor', 'e-cv-gone', '{"card_id":"ec3","jd_chars":900}');
  perform pg_temp.intent(pg_temp.id('E'), 'cover_letter', 'e-cl-late', '{"card_id":"ec2","card_status":"interview"}');
  perform public.process_reward_intents(pg_temp.id('E'));
  perform pg_temp.expect('E4 thin JD → audit only, and the card stays open for a later full run', null, format(
    $q$select (select outcome || ':' || reason from public.reward_audit a join public.reward_intents i on i.seq = a.intent_seq
                where i.source_id = 'e-cv-thin') || '/'
           || (select outcome from public.reward_decisions d join public.reward_intents i on i.seq = d.intent_seq
                where i.source_id = 'e-cv-ok')$q$), 'insufficient:thin_jd/granted');
  perform pg_temp.expect('E4 after submission / card deleted → ineligible', null,
    $q$select string_agg(i.source_id || ':' || d.outcome || ':' || d.reason, ',' order by i.seq)
         from public.reward_decisions d join public.reward_intents i on i.seq = d.intent_seq
        where i.source_id in ('e-cv-late', 'e-cv-gone', 'e-cl-late')$q$,
    'e-cv-late:ineligible:after_submission,e-cv-gone:ineligible:card_deleted,e-cl-late:ineligible:after_submission');

  -- Save rules: a URL earns once across cards; a card earns once across URLs.
  perform pg_temp.intent(pg_temp.id('E'), 'job_saved', 'e-s3', '{"card_id":"es3","url_key":"e.example/s1"}');
  perform pg_temp.intent(pg_temp.id('E'), 'job_saved', 'e-s3b', '{"card_id":"es3","url_key":"e.example/s3"}');
  perform pg_temp.intent(pg_temp.id('E'), 'job_saved', 'e-s1b', '{"card_id":"es1","url_key":"e.example/s9"}');
  perform public.process_reward_intents(pg_temp.id('E'));
  perform pg_temp.expect('E5 URL already earned → audit url_locked, card stays free; new URL on it earns; re-URL of an earning card → card_locked',
    null, $q$select string_agg(i.source_id || ':' || coalesce(d.outcome, a.reason), ',' order by i.seq)
               from public.reward_intents i left join public.reward_decisions d on d.intent_seq = i.seq
               left join public.reward_audit a on a.intent_seq = i.seq where i.source_id in ('e-s3', 'e-s3b', 'e-s1b')$q$,
    'e-s3:url_locked,e-s3b:granted,e-s1b:card_locked');

  -- Practice and research: per-day caps; mock thresholds.
  for i in 1..6 loop
    perform pg_temp.intent(pg_temp.id('E'), 'answer_practice', 'e-p' || i, jsonb_build_object('session_id', 's2', 'fingerprint', 'g' || i));
  end loop;
  perform public.process_reward_intents(pg_temp.id('E'));
  perform pg_temp.expect('E6 answer practice caps at five a day (two earlier today + three more, then capped)', null, format(
    $q$select string_agg(outcome, ',' order by intent_seq) from public.reward_decisions where user_id = %L and kind = 'answer_practice'$q$,
    pg_temp.id('E')), 'granted,granted,granted,granted,granted,capped,capped,capped');
  perform pg_temp.expect('E6 every decision records the config version it was judged under', null,
    $q$select count(*) from public.reward_decisions d join public.reward_intents i on i.seq = d.intent_seq
        where d.config_version <> i.config_version$q$, '0');
end $$;

-- ===========================================================================
-- F. Follow-up rules (user F, hand-made intents)
-- ===========================================================================
do $$
declare t0 timestamptz := now() - interval '40 days';
begin
  perform pg_temp.intent(pg_temp.id('F'), 'follow_up', 'f-noapp', jsonb_build_object(
    'card_id', 'f1', 'event_at', t0 + interval '5 days', 'first_applied_at', t0), (t0 + interval '5 days')::date);
  perform pg_temp.intent(pg_temp.id('F'), 'application', 'f-app', jsonb_build_object(
    'card_id', 'f1', 'url_key', 'f.example/1', 'best_cv_jd_chars', 0), t0::date);
  perform pg_temp.intent(pg_temp.id('F'), 'follow_up', 'f-soon', jsonb_build_object(
    'card_id', 'f1', 'event_at', t0 + interval '2 days', 'first_applied_at', t0), (t0 + interval '2 days')::date);
  perform pg_temp.intent(pg_temp.id('F'), 'follow_up', 'f-ok1', jsonb_build_object(
    'card_id', 'f1', 'event_at', t0 + interval '4 days', 'first_applied_at', t0), (t0 + interval '4 days')::date);
  perform pg_temp.intent(pg_temp.id('F'), 'follow_up', 'f-week', jsonb_build_object(
    'card_id', 'f1', 'event_at', t0 + interval '8 days', 'first_applied_at', t0), (t0 + interval '8 days')::date);
  perform pg_temp.intent(pg_temp.id('F'), 'follow_up', 'f-ok2', jsonb_build_object(
    'card_id', 'f1', 'event_at', t0 + interval '12 days', 'first_applied_at', t0), (t0 + interval '12 days')::date);
  perform pg_temp.intent(pg_temp.id('F'), 'follow_up', 'f-ok3', jsonb_build_object(
    'card_id', 'f1', 'event_at', t0 + interval '20 days', 'first_applied_at', t0), (t0 + interval '20 days')::date);
  perform pg_temp.intent(pg_temp.id('F'), 'follow_up', 'f-limit', jsonb_build_object(
    'card_id', 'f1', 'event_at', t0 + interval '30 days', 'first_applied_at', t0), (t0 + interval '30 days')::date);
  perform pg_temp.intent(pg_temp.id('F'), 'follow_up', 'f-noapplied', jsonb_build_object(
    'card_id', 'f1', 'event_at', t0 + interval '31 days'), (t0 + interval '31 days')::date);
  perform pg_temp.expect('F1 all nine judged', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('F')), '9');
  perform pg_temp.expect('F1 no application yet / too soon / ok / within a week / ok / ok / card limit (3) / no applied date', null,
    $q$select string_agg(i.source_id || ':' || d.outcome || coalesce(':' || d.reason, ''), ',' order by i.seq)
         from public.reward_intents i join public.reward_decisions d on d.intent_seq = i.seq
        where i.source_id like 'f-%' and i.kind = 'follow_up'$q$,
    'f-noapp:ineligible:no_rewarded_application,f-soon:ineligible:too_soon,f-ok1:granted,f-week:ineligible:week_limit,'
    'f-ok2:granted,f-ok3:granted,f-limit:ineligible:card_limit,f-noapplied:ineligible:too_soon');
end $$;

-- ===========================================================================
-- G. Streaks, rest days, sequence gaps (user F)
-- ===========================================================================
do $$
declare d int; v_today date := pg_temp.today();
begin
  -- Six active days from today-7 to today-2, a rest day on today-1, then today.
  for d in 2..7 loop
    insert into public.streak_days values (pg_temp.id('F'), v_today - d, 'active');
  end loop;
  perform pg_temp.expect('G1 book a rest day for today: one of two left this month', 'service_role', format(
    $q$select public.book_rest_day(%L, %L)$q$, pg_temp.id('F'), v_today), '1');
  perform pg_temp.deny('G1 the same day again is refused', 'service_role', format(
    $q$select public.book_rest_day(%L, %L)$q$, pg_temp.id('F'), v_today), '^23514 that day is already');
  perform pg_temp.deny('G1 a past day is refused (no backdating)', 'service_role', format(
    $q$select public.book_rest_day(%L, %L)$q$, pg_temp.id('F'), v_today - 1), '^22023');
  perform pg_temp.deny('G1 more than 31 days ahead is refused', 'service_role', format(
    $q$select public.book_rest_day(%L, %L)$q$, pg_temp.id('F'), v_today + 32), '^22023');
  perform pg_temp.deny('G1 an already-active day is refused', null, format(
    $q$insert into public.streak_days values (%1$L, %2$L, 'active');
       set local role service_role;
       select public.book_rest_day(%1$L, %2$L)$q$, pg_temp.id('F'), v_today + 3), '^23514 that day is already');
  -- The monthly allowance (2): fill a month ten days out, then ask for a third.
  delete from public.streak_days where user_id = pg_temp.id('F') and kind = 'rest';
  insert into public.streak_days
  select pg_temp.id('F'), g::date, 'rest'
    from generate_series(date_trunc('month', v_today + 10), date_trunc('month', v_today + 10) + interval '27 days', interval '1 day') g
   where g::date <> v_today + 10
     and not exists (select 1 from public.streak_days s where s.user_id = pg_temp.id('F') and s.day = g::date)
   limit 2;
  perform pg_temp.deny('G1 a third rest day in a month is refused', 'service_role', format(
    $q$select public.book_rest_day(%L, %L)$q$, pg_temp.id('F'), v_today + 10), '^23514 no rest days left');
  delete from public.streak_days where user_id = pg_temp.id('F') and (kind = 'rest' or day >= v_today);

  -- Rest days bridge a streak but do not count towards it: the rest day on
  -- today-1 joins the six active days to an active today.
  insert into public.streak_days values (pg_temp.id('F'), v_today - 1, 'rest');
  perform pg_temp.intent(pg_temp.id('F'), 'company_research', 'g-r1', '{"tool_result_id":"g1"}');
  perform public.process_reward_intents(pg_temp.id('F'));
  perform pg_temp.expect('G2 seven active days bridged by a rest day → on_a_roll (+25)', null, format(
    $q$select count(*)::text || '/' || (select count(*) from public.coin_transactions where user_id = %1$L and reference = 'on_a_roll')
         from public.user_achievements where user_id = %1$L and achievement_key = 'on_a_roll'$q$, pg_temp.id('F')), '1/1');

  -- A capture rolled back mid-transaction leaves a gap in seq; the processor
  -- does not care.
  begin
    perform pg_temp.intent(pg_temp.id('F'), 'company_research', 'g-gap', '{"tool_result_id":"gap"}');
    raise exception using errcode = 'TT003', message = 'roll back the capture';
  exception when sqlstate 'TT003' then null;
  end;
  perform pg_temp.intent(pg_temp.id('F'), 'company_research', 'g-r2', '{"tool_result_id":"g2"}');
  perform pg_temp.expect('G3 a sequence gap before the next intent', null,
    $q$select ((select seq from public.reward_intents where source_id = 'g-r2')
              - (select seq from public.reward_intents where source_id = 'g-r1') > 1)::text$q$, 'true');
  perform pg_temp.expect('G3 …and it is processed normally', 'service_role', format(
    $q$select public.process_reward_intents(%L)$q$, pg_temp.id('F')), '1');
end $$;

do $$ begin raise notice 'ALL GAMIFICATION SQL CHECKS PASSED'; end $$;

rollback;
