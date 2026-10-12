-- ============================================================================
--  047 — Gamification v2: verified-action rewards, streaks, quests, coins.
--  Run in Supabase SQL Editor (Dashboard → SQL Editor → New query).
--  Idempotent where Postgres allows it; additive only. Ships dark: nothing
--  reads these tables until the backend runs with GAMIFICATION_V2_ENABLED=true.
--  Design and threat model: supabase/CLAUDE.md (summary); full write-up in
--  `git show 062d0e5:docs/GAMIFICATION_V2.md`.
--
--  Depends on: 001 (users, interview_*), 005 + 018a (cv_analysis_jobs,
--  tool_results.input_json), 015 (users.credit_balance / is_admin /
--  first_tool_used_at), 016 + 020 (admin_actions), 023 (saved_jobs, job_events),
--  044 (tool_results 'cover_letter'), 045 (points_ledger stays as history).
--
--  How rewards work
--    1. Capture. Thin AFTER triggers on the source tables write one row to
--       reward_intents in the SAME transaction as the action — an action that
--       commits always has its intent. Each intent carries a snapshot of the
--       facts needed to judge it, so judging never reads live state.
--    2. Process. process_reward_intents(user) judges a user's pending intents
--       strictly in seq order (per-user advisory lock; seq can have gaps after
--       rollbacks — the processor never relies on contiguity) and writes, in
--       one transaction per intent: an immutable first decision + its locks,
--       or an audit row; an XP grant; streak, quest, achievement and coin rows.
--    3. Nothing is ever awarded for reading a page.
--
--  Privilege model (matrix: `git show 062d0e5:docs/GAMIFICATION_V2.md`)
--    * Four NOLOGIN, NOBYPASSRLS owner roles. Each SECURITY DEFINER function is
--      owned by the narrowest one, with column-level grants and one RLS policy
--      per (table, command, role). Source tables keep RLS on with no policies
--      for anon/authenticated, exactly as before.
--    * service_role (BYPASSRLS on Supabase) is limited by GRANTs: read-only on
--      every ledger, EXECUTE on the eight entry points below and nothing else.
--    * REVOKE/GRANT statements touch ONLY functions this migration creates —
--      existing RPCs (match_bullets, user_engagement, sponsor-register,
--      delete_companies_permanently, 046 job expiry, …) are left alone.
--    * Every SECURITY DEFINER function pins search_path = pg_catalog, pg_temp
--      and schema-qualifies every object. Guards are SECURITY INVOKER so they
--      see the statement's real role.
--
--  Error codes raised to the backend: GC001 credits exhausted · GN001 card not
--  found for this user · GN002 intent not stuck · GX00n invariant broken
--  (missing policy/grant, unexpected row count) · plus standard SQLSTATEs.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Owner roles. Created NOLOGIN NOBYPASSRLS and granted to no API role. A
--    non-superuser migration owner (hosted Supabase's `postgres`) must be a
--    member to hand functions over (SET) and to CREATE OR REPLACE them when
--    this file is re-run (INHERIT: ownership checks need it). It already owns
--    every table these roles touch, so this gives it nothing new. A superuser
--    needs neither, so it gets no membership.
-- ---------------------------------------------------------------------------
do $$
declare r text; v_super boolean;
begin
  select rolsuper into v_super from pg_roles where rolname = current_user;
  foreach r in array array['gamification_capture','gamification_processor',
                           'gamification_cover_letter_writer','gamification_admin'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin nobypassrls noinherit', r);
    end if;
    execute format('grant usage on schema public to %I', r);
    if not v_super then
      if current_setting('server_version_num')::int >= 160000 then
        execute format('grant %I to %I with inherit true, set true', r, current_user);
      else
        execute format('grant %I to %I', r, current_user);
      end if;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Columns on existing tables
-- ---------------------------------------------------------------------------
-- Which card a CV run was for. No FK on purpose: it is immutable provenance
-- (G1) and must survive the card being deleted.
alter table public.cv_analysis_jobs add column if not exists saved_job_id uuid;
-- Set only by record_cover_letter (G2). The text itself stays user-editable.
alter table public.saved_jobs
  add column if not exists cover_letter_run_id uuid,
  add column if not exists cover_letter_generated_at timestamptz;

-- admin_actions gains the skip action. Keep in sync with admin.service.ts.
alter table public.admin_actions drop constraint if exists admin_actions_action_check;
alter table public.admin_actions add constraint admin_actions_action_check
  check (action in ('set_tier', 'adjust_credits', 'set_admin', 'set_status', 'adjust_coaching', 'skip_reward_intent'));

-- ---------------------------------------------------------------------------
-- 3. New tables
-- ---------------------------------------------------------------------------
-- The reward economy, versioned. Every intent records the version it was
-- captured under, so a config change never re-judges earlier actions. Values
-- are PROPOSED and await product approval (supabase/CLAUDE.md).
create table if not exists public.gamification_config (
  version        integer primary key,
  jd_thin_chars  integer not null,
  max_attempts   integer not null,
  xp             jsonb   not null,   -- action -> XP
  caps           jsonb   not null,   -- action -> per-local-day cap
  coins          jsonb   not null,   -- reward -> coins
  quests         jsonb   not null,   -- [{key, kind, target}]
  weekly_targets jsonb   not null,   -- intensity -> weekly XP target
  rest_days_per_month integer not null,
  created_at     timestamptz not null default now()
);
insert into public.gamification_config
  (version, jd_thin_chars, max_attempts, xp, caps, coins, quests, weekly_targets, rest_days_per_month)
values (1, 400, 10,
  '{"job_saved":2,"quick":5,"quality":15,"power":25,"cv_tailor":10,"cover_letter":5,"follow_up":5,"mock_complete":20,"answer_practice":5,"company_research":5}',
  '{"job_saved":5,"application":10,"follow_up":3,"answer_practice":5,"company_research":2}',
  '{"daily_quests":5,"weekly_challenge":20,"first_shot":10,"first_mock":10,"on_a_roll":25,"interview_unlocked":25,"ten_quality":25,"quality_over_quantity":50,"interview_ready":50,"you_did_it":50}',
  '[{"key":"save_jobs","kind":"job_saved","target":2},{"key":"tailor_cv","kind":"cv_tailor","target":1},{"key":"practice_answer","kind":"answer_practice","target":1}]',
  '{"light":40,"active":80,"intensive":120}',
  2)
on conflict (version) do nothing;

create table if not exists public.user_goal_settings (
  user_id             uuid primary key references public.users (id) on delete cascade,
  timezone            text not null default 'Europe/London',
  timezone_changed_at timestamptz,
  intensity           text not null default 'active' check (intensity in ('light', 'active', 'intensive')),
  goal_type           text check (goal_type in ('graduate_scheme', 'internship', 'first_role', 'career_change', 'experienced', 'visa_sponsored')),
  timeline            text check (timeline in ('asap', '1_3_months', '3_6_months', 'exploring')),
  updated_at          timestamptz not null default now()
);

create table if not exists public.reward_intents (
  seq             bigint generated always as identity primary key,
  user_id         uuid not null references public.users (id) on delete cascade,
  kind            text not null,
  source_table    text not null,
  source_id       text not null,
  subject         text not null default '',
  snapshot        jsonb not null,
  local_day       date not null,
  config_version  integer not null,
  state           text not null default 'pending' check (state in ('pending', 'processed', 'stuck', 'skipped')),
  attempts        integer not null default 0,
  last_error      text,
  next_attempt_at timestamptz,
  captured_at     timestamptz not null default now(),
  processed_at    timestamptz,
  unique (source_table, source_id, kind, subject)
);
create index if not exists reward_intents_user_open_idx on public.reward_intents (user_id, seq) where state in ('pending', 'stuck');

-- Immutable first decisions: one per (user, kind, primary subject). Duplicates
-- never land here — they go to reward_audit.
create table if not exists public.reward_decisions (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.users (id) on delete cascade,
  kind            text not null,
  primary_subject text not null,
  outcome         text not null check (outcome in ('granted', 'capped', 'ineligible')),
  reason          text,
  tier            text check (tier in ('quick', 'quality', 'power')),
  intent_seq      bigint not null unique,
  local_day       date not null,
  config_version  integer not null,
  decided_at      timestamptz not null default now(),
  unique (user_id, kind, primary_subject),
  constraint reward_decisions_reason_check check (case
    when outcome in ('granted', 'capped') then reason is null
    when kind = 'application'   then reason in ('no_url', 'url_already_rewarded')
    when kind = 'cv_tailor'     then reason in ('after_submission', 'card_deleted')
    when kind = 'cover_letter'  then reason in ('after_submission')
    when kind = 'follow_up'     then reason in ('no_rewarded_application', 'too_soon', 'week_limit', 'card_limit')
    when kind = 'mock_complete' then reason in ('too_few_answers')
    else false end)
);
create index if not exists reward_decisions_user_day_idx on public.reward_decisions (user_id, kind, local_day);

create table if not exists public.reward_locks (
  user_id     uuid not null references public.users (id) on delete cascade,
  kind        text not null,
  scope       text not null check (scope in ('card', 'url')),
  subject_key text not null,
  decision_id bigint not null references public.reward_decisions (id) on delete cascade,
  primary key (user_id, kind, scope, subject_key)
);

create table if not exists public.reward_audit (
  id                   bigint generated always as identity primary key,
  user_id              uuid not null references public.users (id) on delete cascade,
  intent_seq           bigint not null unique,
  outcome              text not null check (outcome in ('duplicate', 'insufficient', 'skipped')),
  reason               text,
  blocking_decision_id bigint,
  created_at           timestamptz not null default now()
);

create table if not exists public.xp_grants (
  decision_id bigint primary key references public.reward_decisions (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  xp          integer not null check (xp > 0),
  local_day   date not null
);
create index if not exists xp_grants_user_day_idx on public.xp_grants (user_id, local_day);

create table if not exists public.coin_wallets (
  user_id uuid primary key references public.users (id) on delete cascade,
  balance integer not null default 0 check (balance >= 0)
);
create table if not exists public.coin_transactions (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.users (id) on delete cascade,
  delta         integer not null,
  reason        text not null,
  reference     text not null,
  balance_after integer not null,
  created_at    timestamptz not null default now(),
  unique (user_id, reason, reference)
);

create table if not exists public.streak_days (
  user_id uuid not null references public.users (id) on delete cascade,
  day     date not null,
  kind    text not null check (kind in ('active', 'rest')),
  primary key (user_id, day)
);

create table if not exists public.daily_quest_assignments (
  user_id      uuid not null references public.users (id) on delete cascade,
  day          date not null,
  quest_key    text not null,
  kind         text not null,
  target       integer not null check (target > 0),
  progress     integer not null default 0,
  completed_at timestamptz,
  primary key (user_id, day, quest_key)
);

create table if not exists public.user_achievements (
  user_id         uuid not null references public.users (id) on delete cascade,
  achievement_key text not null,
  decision_id     bigint,
  source          text not null default 'live' check (source in ('live', 'backfill')),
  earned_at       timestamptz not null default now(),
  seen_at         timestamptz,
  primary key (user_id, achievement_key)
);

-- ---------------------------------------------------------------------------
-- 4. RLS on, Supabase's default grants revoked, then granted precisely.
-- ---------------------------------------------------------------------------
do $$
declare t text; r text;
begin
  foreach t in array array['gamification_config','user_goal_settings','reward_intents','reward_decisions','reward_locks',
                           'reward_audit','xp_grants','coin_wallets','coin_transactions','streak_days',
                           'daily_quest_assignments','user_achievements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end
$$;

-- service_role: read-only on ledgers; preferences and "seen" are its to write.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on public.reward_intents, public.reward_decisions, public.reward_audit, public.xp_grants,
                    public.coin_wallets, public.coin_transactions, public.streak_days,
                    public.daily_quest_assignments, public.user_achievements, public.user_goal_settings,
                    public.gamification_config to service_role;
    grant insert (user_id, timezone, intensity, goal_type, timeline) on public.user_goal_settings to service_role;
    grant update (timezone, intensity, goal_type, timeline, updated_at) on public.user_goal_settings to service_role;
    grant update (seen_at) on public.user_achievements to service_role;
  end if;
end
$$;

-- gamification_capture: insert intents; read exactly the snapshot columns.
grant select, insert on public.reward_intents to gamification_capture;
grant select (user_id, timezone) on public.user_goal_settings to gamification_capture;
grant select on public.gamification_config to gamification_capture;
grant select (id, user_id, url_key, status, next_follow_up_at, cover_letter_generated_at) on public.saved_jobs to gamification_capture;
grant select (id, job_id, user_id, to_status, created_at) on public.job_events to gamification_capture;
grant select (id, user_id, status, saved_job_id, input_json, updated_at) on public.cv_analysis_jobs to gamification_capture;
grant select (id, user_id, status) on public.interview_sessions to gamification_capture;
grant select (id, session_id, question_text) on public.interview_questions to gamification_capture;
grant select (id, session_id, question_id) on public.answer_assessments to gamification_capture;
grant select (id, user_id, tool) on public.tool_results to gamification_capture;

-- gamification_processor: gamification tables only — no source table.
grant select, update (state, attempts, last_error, next_attempt_at, processed_at) on public.reward_intents to gamification_processor;
grant select, insert on public.reward_decisions, public.reward_locks, public.reward_audit, public.xp_grants,
                         public.coin_transactions, public.user_achievements to gamification_processor;
grant select, insert on public.streak_days to gamification_processor;
grant select, insert, update (balance) on public.coin_wallets to gamification_processor;
grant select, insert, update (progress, completed_at) on public.daily_quest_assignments to gamification_processor;
grant select on public.gamification_config to gamification_processor;
grant select (user_id, timezone, intensity) on public.user_goal_settings to gamification_processor;

-- gamification_cover_letter_writer: the card, its event, the credit balance.
grant select (id, user_id, status),
      update (cover_letter_text, cv_version_id, cover_letter_run_id, cover_letter_generated_at, status, updated_at)
  on public.saved_jobs to gamification_cover_letter_writer;
grant insert (job_id, user_id, from_status, to_status, note) on public.job_events to gamification_cover_letter_writer;
grant select (id, credit_balance, first_tool_used_at), update (credit_balance, first_tool_used_at)
  on public.users to gamification_cover_letter_writer;

-- gamification_admin: the skip path only.
grant select (seq, user_id, state), update (state, last_error, processed_at) on public.reward_intents to gamification_admin;
grant insert on public.reward_audit to gamification_admin;
grant select (id, is_admin) on public.users to gamification_admin;
grant insert (actor_id, target_user_id, action, detail) on public.admin_actions to gamification_admin;

-- ── Policies. One per (table, command, role); none for anon/authenticated. ──
do $$
declare t text;
begin
  -- capture
  drop policy if exists gam_capture_ins on public.reward_intents;
  create policy gam_capture_ins on public.reward_intents for insert to gamification_capture
    with check (state = 'pending' and attempts = 0 and next_attempt_at is null);
  foreach t in array array['reward_intents','user_goal_settings','gamification_config','saved_jobs','job_events','cv_analysis_jobs',
                           'interview_sessions','interview_questions','answer_assessments','tool_results'] loop
    execute format('drop policy if exists gam_capture_sel on public.%I', t);
    execute format('create policy gam_capture_sel on public.%I for select to gamification_capture using (true)', t);
  end loop;

  -- processor
  drop policy if exists gam_proc_sel on public.reward_intents;
  create policy gam_proc_sel on public.reward_intents for select to gamification_processor using (true);
  drop policy if exists gam_proc_upd on public.reward_intents;
  create policy gam_proc_upd on public.reward_intents for update to gamification_processor
    using (state = 'pending') with check (state in ('pending', 'processed', 'stuck'));
  foreach t in array array['reward_decisions','reward_locks','reward_audit','xp_grants','coin_transactions',
                           'streak_days','user_achievements','coin_wallets','daily_quest_assignments'] loop
    execute format('drop policy if exists gam_proc_sel on public.%I', t);
    execute format('create policy gam_proc_sel on public.%I for select to gamification_processor using (true)', t);
    execute format('drop policy if exists gam_proc_ins on public.%I', t);
    execute format('create policy gam_proc_ins on public.%I for insert to gamification_processor with check (true)', t);
  end loop;
  drop policy if exists gam_proc_upd on public.coin_wallets;
  create policy gam_proc_upd on public.coin_wallets for update to gamification_processor using (true) with check (balance >= 0);
  drop policy if exists gam_proc_upd on public.daily_quest_assignments;
  create policy gam_proc_upd on public.daily_quest_assignments for update to gamification_processor using (true) with check (progress <= target);
  foreach t in array array['gamification_config','user_goal_settings'] loop
    execute format('drop policy if exists gam_proc_sel on public.%I', t);
    execute format('create policy gam_proc_sel on public.%I for select to gamification_processor using (true)', t);
  end loop;

  -- cover-letter writer
  drop policy if exists gam_clw_sel on public.saved_jobs;
  create policy gam_clw_sel on public.saved_jobs for select to gamification_cover_letter_writer using (true);
  drop policy if exists gam_clw_upd on public.saved_jobs;
  create policy gam_clw_upd on public.saved_jobs for update to gamification_cover_letter_writer using (true) with check (true);
  drop policy if exists gam_clw_ins on public.job_events;
  create policy gam_clw_ins on public.job_events for insert to gamification_cover_letter_writer with check (to_status = 'preparing');
  drop policy if exists gam_clw_sel on public.users;
  create policy gam_clw_sel on public.users for select to gamification_cover_letter_writer using (true);
  drop policy if exists gam_clw_upd on public.users;
  create policy gam_clw_upd on public.users for update to gamification_cover_letter_writer using (true) with check (credit_balance >= 0);

  -- admin
  drop policy if exists gam_admin_sel on public.reward_intents;
  create policy gam_admin_sel on public.reward_intents for select to gamification_admin using (true);
  drop policy if exists gam_admin_upd on public.reward_intents;
  create policy gam_admin_upd on public.reward_intents for update to gamification_admin using (state = 'stuck') with check (state = 'skipped');
  drop policy if exists gam_admin_ins on public.reward_audit;
  create policy gam_admin_ins on public.reward_audit for insert to gamification_admin with check (outcome = 'skipped');
  drop policy if exists gam_admin_sel on public.users;
  create policy gam_admin_sel on public.users for select to gamification_admin using (true);
  drop policy if exists gam_admin_ins on public.admin_actions;
  create policy gam_admin_ins on public.admin_actions for insert to gamification_admin with check (action = 'skip_reward_intent');
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Guards (SECURITY INVOKER — they must see the statement's real role)
-- ---------------------------------------------------------------------------
-- G1: a CV run may only point at its own user's card, and never be re-pointed.
create or replace function public.g1_cv_run_card() returns trigger
language plpgsql security invoker set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.saved_job_id is not null and not exists (
         select 1 from public.saved_jobs s where s.id = new.saved_job_id and s.user_id = new.user_id) then
      raise exception 'G1: saved_job_id must be one of this user''s cards' using errcode = 'foreign_key_violation';
    end if;
  elsif new.saved_job_id is distinct from old.saved_job_id then
    raise exception 'G1: saved_job_id is immutable';
  end if;
  return new;
end
$$;
drop trigger if exists g1_cv_run_card on public.cv_analysis_jobs;
create trigger g1_cv_run_card before insert or update on public.cv_analysis_jobs
  for each row execute function public.g1_cv_run_card();

-- G2: the cover-letter marker is written only by record_cover_letter.
create or replace function public.g2_cover_letter_marker() returns trigger
language plpgsql security invoker set search_path = pg_catalog, pg_temp as $$
begin
  if current_user <> 'gamification_cover_letter_writer' and (
       (tg_op = 'INSERT' and (new.cover_letter_run_id is not null or new.cover_letter_generated_at is not null)) or
       (tg_op = 'UPDATE' and (new.cover_letter_run_id is distinct from old.cover_letter_run_id
                           or new.cover_letter_generated_at is distinct from old.cover_letter_generated_at))) then
    raise exception 'G2: the cover-letter marker is written only by record_cover_letter (current_user=%)', current_user;
  end if;
  return new;
end
$$;
drop trigger if exists g2_cover_letter_marker on public.saved_jobs;
create trigger g2_cover_letter_marker before insert or update on public.saved_jobs
  for each row execute function public.g2_cover_letter_marker();

-- G3: a valid IANA timezone, changed at most once per 24 hours.
create or replace function public.g3_goal_timezone() returns trigger
language plpgsql security invoker set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.timezone is distinct from old.timezone then
    if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
      raise exception 'G3: unknown IANA timezone %', new.timezone using errcode = 'invalid_parameter_value';
    end if;
    if tg_op = 'UPDATE' and old.timezone_changed_at is not null
       and old.timezone_changed_at > pg_catalog.now() - interval '24 hours' then
      raise exception 'G3: the timezone can change once per 24 hours' using errcode = 'check_violation';
    end if;
    new.timezone_changed_at := pg_catalog.now();
  elsif tg_op = 'UPDATE' then
    new.timezone_changed_at := old.timezone_changed_at;
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end
$$;
drop trigger if exists g3_goal_timezone on public.user_goal_settings;
create trigger g3_goal_timezone before insert or update on public.user_goal_settings
  for each row execute function public.g3_goal_timezone();

-- ---------------------------------------------------------------------------
-- 6. Job-card entry points (SECURITY INVOKER: the caller is service_role).
--    One transaction for the card and its event, so capture sees both.
-- ---------------------------------------------------------------------------
create or replace function public.create_saved_job(p_user uuid, p_card jsonb)
returns public.saved_jobs language plpgsql security invoker set search_path = pg_catalog, pg_temp as $$
declare v_row public.saved_jobs; v_status text := coalesce(p_card->>'status', 'saved');
begin
  insert into public.saved_jobs (user_id, source, title, company_name, location, job_url, url_key, description,
                                 salary_text, sponsor_visa, status, notes, deadline_at, next_follow_up_at, applied_at)
  values (p_user, coalesce(p_card->>'source', 'manual'), p_card->>'title', p_card->>'company_name', p_card->>'location',
          p_card->>'job_url', p_card->>'url_key', p_card->>'description', p_card->>'salary_text',
          (p_card->>'sponsor_visa')::boolean, v_status, p_card->>'notes', (p_card->>'deadline_at')::date,
          (p_card->>'next_follow_up_at')::date, case when v_status = 'applied' then pg_catalog.now() end)
  returning * into v_row;
  insert into public.job_events (job_id, user_id, from_status, to_status) values (v_row.id, p_user, null, v_status);
  return v_row;
end
$$;

-- Returns the card, or NULL when this user has no such card. Re-sending the
-- current status is a no-op (no event), as in job-tracking.service.ts.
create or replace function public.change_job_status(p_user uuid, p_job uuid, p_status text, p_note text default null)
returns public.saved_jobs language plpgsql security invoker set search_path = pg_catalog, pg_temp as $$
declare v_from text; v_row public.saved_jobs; n int;
begin
  select s.status into v_from from public.saved_jobs s where s.id = p_job and s.user_id = p_user for update;
  if not found then return null; end if;
  if v_from = p_status then
    select * into v_row from public.saved_jobs s where s.id = p_job;
    return v_row;
  end if;
  update public.saved_jobs s
     set status = p_status, updated_at = pg_catalog.now(),
         applied_at = case when p_status = 'applied' and s.applied_at is null then pg_catalog.now() else s.applied_at end
   where s.id = p_job and s.user_id = p_user
  returning * into v_row;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'GAM_INVARIANT: card update affected % rows', n using errcode = 'GX003'; end if;
  insert into public.job_events (job_id, user_id, from_status, to_status, note) values (p_job, p_user, v_from, p_status, p_note);
  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Capture (owner gamification_capture)
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_reward_intent(p_user uuid, p_kind text, p_source_table text,
                                                        p_source_id text, p_subject text, p_snapshot jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_tz text; v_cfg int;
begin
  -- Held to commit: a user's committed intents are in seq order, and the
  -- processor (same lock) never sees a capture in flight.
  perform pg_catalog.pg_advisory_xact_lock(4711, pg_catalog.hashtext(p_user::text));
  select g.timezone into v_tz from public.user_goal_settings g where g.user_id = p_user;
  select max(c.version) into v_cfg from public.gamification_config c;
  insert into public.reward_intents (user_id, kind, source_table, source_id, subject, snapshot, local_day, config_version)
  values (p_user, p_kind, p_source_table, p_source_id, coalesce(p_subject, ''), p_snapshot,
          (pg_catalog.now() at time zone coalesce(v_tz, 'Europe/London'))::date, v_cfg)
  on conflict (source_table, source_id, kind, subject) do nothing;
end
$$;

create or replace function public.trg_saved_jobs_capture() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.url_key is not null and (tg_op = 'INSERT' or new.url_key is distinct from old.url_key) then
    perform public.enqueue_reward_intent(new.user_id, 'job_saved', 'saved_jobs', new.id::text, new.url_key,
      pg_catalog.jsonb_build_object('card_id', new.id, 'url_key', new.url_key));
  end if;
  if tg_op = 'UPDATE' and new.cover_letter_run_id is not null and new.cover_letter_run_id is distinct from old.cover_letter_run_id then
    perform public.enqueue_reward_intent(new.user_id, 'cover_letter', 'saved_jobs', new.id::text, new.cover_letter_run_id::text,
      pg_catalog.jsonb_build_object('card_id', new.id, 'card_status', old.status));
  end if;
  return null;
end
$$;
drop trigger if exists trg_saved_jobs_capture on public.saved_jobs;
create trigger trg_saved_jobs_capture after insert or update on public.saved_jobs
  for each row execute function public.trg_saved_jobs_capture();

create or replace function public.trg_job_events_capture() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare c record; v_jd int; v_first timestamptz;
begin
  select min(e.created_at) into v_first from public.job_events e
   where e.job_id = new.job_id and e.to_status = 'applied' and e.id <> new.id;
  if new.to_status = 'applied' then
    select s.url_key, s.next_follow_up_at, s.cover_letter_generated_at into c from public.saved_jobs s where s.id = new.job_id;
    select max(pg_catalog.char_length(pg_catalog.btrim(j.input_json->>'jobDescription'))) into v_jd
      from public.cv_analysis_jobs j
     where j.saved_job_id = new.job_id and j.status = 'completed' and j.updated_at <= new.created_at;
    perform public.enqueue_reward_intent(new.user_id, 'application', 'job_events', new.id::text, '',
      pg_catalog.jsonb_build_object('card_id', new.job_id, 'url_key', c.url_key, 'submitted_at', new.created_at,
        'best_cv_jd_chars', v_jd,
        'letter_before', coalesce(c.cover_letter_generated_at <= new.created_at, false),
        'follow_up_after', coalesce(c.next_follow_up_at > new.created_at::date, false)));
  elsif new.to_status = 'follow_up' then
    perform public.enqueue_reward_intent(new.user_id, 'follow_up', 'job_events', new.id::text, '',
      pg_catalog.jsonb_build_object('card_id', new.job_id, 'event_at', new.created_at, 'first_applied_at', v_first));
  elsif new.to_status in ('interview', 'offer') then
    perform public.enqueue_reward_intent(new.user_id, 'milestone', 'job_events', new.id::text, new.to_status,
      pg_catalog.jsonb_build_object('card_id', new.job_id, 'status', new.to_status));
  end if;
  return null;
end
$$;
drop trigger if exists trg_job_events_capture on public.job_events;
create trigger trg_job_events_capture after insert on public.job_events
  for each row execute function public.trg_job_events_capture();

create or replace function public.trg_cv_completed_capture() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_status text;
begin
  if new.saved_job_id is null or new.status <> 'completed' or old.status = 'completed' then return null; end if;
  select s.status into v_status from public.saved_jobs s where s.id = new.saved_job_id;
  perform public.enqueue_reward_intent(new.user_id, 'cv_tailor', 'cv_analysis_jobs', new.id::text, '',
    pg_catalog.jsonb_build_object('card_id', new.saved_job_id, 'card_status', v_status,
      'jd_chars', coalesce(pg_catalog.char_length(pg_catalog.btrim(new.input_json->>'jobDescription')), 0)));
  return null;
end
$$;
drop trigger if exists trg_cv_completed_capture on public.cv_analysis_jobs;
create trigger trg_cv_completed_capture after update of status on public.cv_analysis_jobs
  for each row execute function public.trg_cv_completed_capture();

create or replace function public.trg_answer_capture() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_user uuid; v_fp text;
begin
  select s.user_id into v_user from public.interview_sessions s where s.id = new.session_id;
  if v_user is null then return null; end if;
  select pg_catalog.md5(pg_catalog.lower(pg_catalog.btrim(q.question_text))) into v_fp
    from public.interview_questions q where q.id = new.question_id;
  perform public.enqueue_reward_intent(v_user, 'answer_practice', 'answer_assessments', new.id::text, '',
    pg_catalog.jsonb_build_object('session_id', new.session_id, 'fingerprint', v_fp));
  return null;
end
$$;
drop trigger if exists trg_answer_capture on public.answer_assessments;
create trigger trg_answer_capture after insert on public.answer_assessments
  for each row execute function public.trg_answer_capture();

create or replace function public.trg_session_complete_capture() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_n int;
begin
  if new.user_id is null or new.status <> 'complete' or old.status = 'complete' then return null; end if;
  select count(distinct pg_catalog.md5(pg_catalog.lower(pg_catalog.btrim(q.question_text)))) into v_n
    from public.answer_assessments a join public.interview_questions q on q.id = a.question_id
   where a.session_id = new.id;
  perform public.enqueue_reward_intent(new.user_id, 'mock_complete', 'interview_sessions', new.id::text, '',
    pg_catalog.jsonb_build_object('session_id', new.id, 'distinct_answers', v_n));
  return null;
end
$$;
drop trigger if exists trg_session_complete_capture on public.interview_sessions;
create trigger trg_session_complete_capture after update of status on public.interview_sessions
  for each row execute function public.trg_session_complete_capture();

-- Interview Lab mocks are rewarded from interview_sessions only, so only Dream
-- Company runs are captured here.
create or replace function public.trg_tool_results_capture() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.tool = 'dream' then
    perform public.enqueue_reward_intent(new.user_id, 'company_research', 'tool_results', new.id::text, '',
      pg_catalog.jsonb_build_object('tool_result_id', new.id));
  end if;
  return null;
end
$$;
drop trigger if exists trg_tool_results_capture on public.tool_results;
create trigger trg_tool_results_capture after insert on public.tool_results
  for each row execute function public.trg_tool_results_capture();

-- ---------------------------------------------------------------------------
-- 8. Credits and cover letters (owner gamification_cover_letter_writer).
--    Lock order everywhere: users row, then the card. Any error rolls back
--    the whole call — the charge, the letter, the event, the captured intent.
-- ---------------------------------------------------------------------------
create or replace function public.charge_credits(p_user uuid, p_cost integer)
returns integer language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_bal int; n int;
begin
  if p_cost is null or p_cost < 0 then raise exception 'cost must be >= 0' using errcode = 'invalid_parameter_value'; end if;
  select u.credit_balance into v_bal from public.users u where u.id = p_user for update;
  if not found then
    raise exception 'GAM_INVARIANT: user row not visible to the credit writer' using errcode = 'GX001';
  end if;
  if v_bal < p_cost then
    raise exception 'CREDIT_EXHAUSTED' using errcode = 'GC001', detail = pg_catalog.format('balance %s, cost %s', v_bal, p_cost);
  end if;
  -- A free run (admins: the backend passes 0) is not a first paid tool use.
  update public.users u set credit_balance = u.credit_balance - p_cost,
         first_tool_used_at = case when p_cost > 0 then coalesce(u.first_tool_used_at, pg_catalog.now())
                                   else u.first_tool_used_at end
   where u.id = p_user;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'GAM_INVARIANT: credit update affected % rows', n using errcode = 'GX002'; end if;
  return v_bal - p_cost;
end
$$;

create or replace function public.record_cover_letter(p_user uuid, p_job uuid, p_text text, p_cv_version uuid, p_cost integer)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_status text; v_run uuid := pg_catalog.gen_random_uuid(); n int;
begin
  perform public.charge_credits(p_user, p_cost);
  select s.status into v_status from public.saved_jobs s where s.id = p_job and s.user_id = p_user for update;
  if not found then raise exception 'card not found for this user' using errcode = 'GN001'; end if;
  update public.saved_jobs s
     set cover_letter_text = p_text, cv_version_id = p_cv_version, cover_letter_run_id = v_run,
         cover_letter_generated_at = pg_catalog.now(), updated_at = pg_catalog.now(),
         status = case when s.status = 'saved' then 'preparing' else s.status end
   where s.id = p_job and s.user_id = p_user;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'GAM_INVARIANT: card update affected % rows', n using errcode = 'GX003'; end if;
  if v_status = 'saved' then
    insert into public.job_events (job_id, user_id, from_status, to_status, note)
    values (p_job, p_user, 'saved', 'preparing', 'Cover letter written');
  end if;
  return v_run;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Processor (owner gamification_processor)
-- ---------------------------------------------------------------------------
create or replace function public.apply_coin_transaction(p_user uuid, p_delta integer, p_reason text, p_ref text)
returns integer language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_bal int; n int;
begin
  if exists (select 1 from public.coin_transactions t where t.user_id = p_user and t.reason = p_reason and t.reference = p_ref) then
    return null;                                    -- already paid: idempotent
  end if;
  insert into public.coin_wallets (user_id) values (p_user) on conflict do nothing;
  update public.coin_wallets w set balance = w.balance + p_delta
   where w.user_id = p_user and w.balance + p_delta >= 0 returning w.balance into v_bal;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'GAM_INVARIANT: coin balance would go negative' using errcode = 'GX004'; end if;
  insert into public.coin_transactions (user_id, delta, reason, reference, balance_after)
  values (p_user, p_delta, p_reason, p_ref, v_bal);
  return v_bal;
end
$$;

create or replace function public.gam_local_today(p_user uuid) returns date
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select (pg_catalog.now() at time zone coalesce(
            (select g.timezone from public.user_goal_settings g where g.user_id = p_user), 'Europe/London'))::date
$$;

create or replace function public.ensure_daily_quests(p_user uuid) returns setof public.daily_quest_assignments
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_day date := public.gam_local_today(p_user); q jsonb;
begin
  for q in select pg_catalog.jsonb_array_elements(
             (select c.quests from public.gamification_config c order by c.version desc limit 1)) loop
    insert into public.daily_quest_assignments (user_id, day, quest_key, kind, target)
    values (p_user, v_day, q->>'key', q->>'kind', (q->>'target')::int)
    on conflict do nothing;
  end loop;
  return query select * from public.daily_quest_assignments d where d.user_id = p_user and d.day = v_day order by d.quest_key;
end
$$;

-- Rest days: today or a future day in the user's timezone, within the monthly
-- allowance. Never backdated, never on a day already active.
create or replace function public.book_rest_day(p_user uuid, p_day date) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_today date := public.gam_local_today(p_user); v_allow int; v_used int;
begin
  if p_day < v_today or p_day > v_today + 31 then
    raise exception 'rest days can be booked for today or up to 31 days ahead' using errcode = 'invalid_parameter_value';
  end if;
  select c.rest_days_per_month into v_allow from public.gamification_config c order by c.version desc limit 1;
  select count(*) into v_used from public.streak_days s
   where s.user_id = p_user and s.kind = 'rest' and pg_catalog.date_trunc('month', s.day) = pg_catalog.date_trunc('month', p_day);
  if v_used >= v_allow then
    raise exception 'no rest days left this month' using errcode = 'check_violation';
  end if;
  insert into public.streak_days (user_id, day, kind) values (p_user, p_day, 'rest');
  return v_allow - v_used - 1;
exception when unique_violation then
  raise exception 'that day is already in your streak' using errcode = 'check_violation';
end
$$;

-- Consecutive active-or-rest days ending at p_day (rest days bridge, only
-- active days count towards the length).
create or replace function public.gam_streak_length(p_user uuid, p_day date) returns integer
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare d date := p_day; n int := 0; k text;
begin
  loop
    select s.kind into k from public.streak_days s where s.user_id = p_user and s.day = d;
    exit when not found;
    if k = 'active' then n := n + 1; end if;
    d := d - 1;
  end loop;
  return n;
end
$$;

create or replace function public.gam_award_achievement(p_user uuid, p_key text, p_decision bigint, cfg public.gamification_config)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  insert into public.user_achievements (user_id, achievement_key, decision_id) values (p_user, p_key, p_decision)
  on conflict do nothing;
  if found then
    perform public.apply_coin_transaction(p_user, (cfg.coins->>p_key)::int, 'achievement', p_key);
  end if;
end
$$;

create or replace function public.gam_decide(r public.reward_intents) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  s jsonb := r.snapshot; cfg public.gamification_config;
  v_card text := s->>'card_id'; v_url text := s->>'url_key';
  v_lock bigint; v_dec bigint; v_xp int; v_outcome text; v_reason text; v_tier text; v_subject text;
  v_ach text; v_week date; v_target int; v_week_xp int; v_quests_total int; v_quests_done int;
begin
  select * into cfg from public.gamification_config c where c.version = r.config_version;
  if cfg.version is null then raise exception 'GAM_INVARIANT: config version % missing', r.config_version using errcode = 'GX005'; end if;

  -- Card-locked kinds: the card's first decision is final; later intents are audit-only.
  if r.kind in ('job_saved', 'application', 'cv_tailor', 'cover_letter') then
    select l.decision_id into v_lock from public.reward_locks l
     where l.user_id = r.user_id and l.kind = r.kind and l.scope = 'card' and l.subject_key = v_card;
    if v_lock is not null then
      insert into public.reward_audit (user_id, intent_seq, outcome, reason, blocking_decision_id)
      values (r.user_id, r.seq, 'duplicate', 'card_locked', v_lock);
      return;
    end if;
  end if;
  v_subject := v_card;

  if r.kind = 'job_saved' then
    select l.decision_id into v_lock from public.reward_locks l
     where l.user_id = r.user_id and l.kind = 'job_saved' and l.scope = 'url' and l.subject_key = v_url;
    if v_lock is not null then          -- the URL earned elsewhere; this card stays free for a new URL
      insert into public.reward_audit (user_id, intent_seq, outcome, reason, blocking_decision_id)
      values (r.user_id, r.seq, 'duplicate', 'url_locked', v_lock);
      return;
    end if;
    v_outcome := 'granted'; v_xp := (cfg.xp->>'job_saved')::int;

  elsif r.kind = 'application' then
    if v_url is null then
      v_outcome := 'ineligible'; v_reason := 'no_url';
    elsif exists (select 1 from public.reward_locks l where l.user_id = r.user_id and l.kind = 'application'
                     and l.scope = 'url' and l.subject_key = v_url) then
      v_outcome := 'ineligible'; v_reason := 'url_already_rewarded';
    else
      v_tier := case
        when coalesce((s->>'best_cv_jd_chars')::int, 0) >= cfg.jd_thin_chars
             and (s->>'letter_before')::boolean and (s->>'follow_up_after')::boolean then 'power'
        when coalesce((s->>'best_cv_jd_chars')::int, 0) >= cfg.jd_thin_chars then 'quality'
        else 'quick' end;
      v_outcome := 'granted'; v_xp := (cfg.xp->>v_tier)::int;
    end if;

  elsif r.kind = 'cv_tailor' then
    if coalesce((s->>'jd_chars')::int, 0) < cfg.jd_thin_chars then
      insert into public.reward_audit (user_id, intent_seq, outcome, reason) values (r.user_id, r.seq, 'insufficient', 'thin_jd');
      return;
    elsif s->>'card_status' is null then v_outcome := 'ineligible'; v_reason := 'card_deleted';
    elsif s->>'card_status' not in ('saved', 'preparing') then v_outcome := 'ineligible'; v_reason := 'after_submission';
    else v_outcome := 'granted'; v_xp := (cfg.xp->>'cv_tailor')::int; end if;

  elsif r.kind = 'cover_letter' then
    if s->>'card_status' not in ('saved', 'preparing') then v_outcome := 'ineligible'; v_reason := 'after_submission';
    else v_outcome := 'granted'; v_xp := (cfg.xp->>'cover_letter')::int; end if;

  elsif r.kind = 'follow_up' then
    v_subject := v_card || ':' || r.seq;
    if not exists (select 1 from public.reward_decisions d where d.user_id = r.user_id and d.kind = 'application'
                      and d.primary_subject = v_card and d.outcome in ('granted', 'capped')) then
      v_outcome := 'ineligible'; v_reason := 'no_rewarded_application';
    elsif (s->>'first_applied_at') is null
       or (s->>'first_applied_at')::timestamptz > (s->>'event_at')::timestamptz - interval '3 days' then
      v_outcome := 'ineligible'; v_reason := 'too_soon';
    elsif exists (select 1 from public.reward_decisions d join public.reward_intents i on i.seq = d.intent_seq
                   where d.user_id = r.user_id and d.kind = 'follow_up' and d.outcome = 'granted'
                     and i.snapshot->>'card_id' = v_card
                     and (i.snapshot->>'event_at')::timestamptz > (s->>'event_at')::timestamptz - interval '7 days') then
      v_outcome := 'ineligible'; v_reason := 'week_limit';
    elsif (select count(*) from public.reward_decisions d where d.user_id = r.user_id and d.kind = 'follow_up'
             and d.outcome = 'granted' and d.primary_subject like v_card || ':%') >= 3 then
      v_outcome := 'ineligible'; v_reason := 'card_limit';
    else v_outcome := 'granted'; v_xp := (cfg.xp->>'follow_up')::int; end if;

  elsif r.kind = 'milestone' then
    -- Outcomes: an achievement once ever, coins, no XP, no streak credit.
    v_ach := case s->>'status' when 'interview' then 'interview_unlocked' else 'you_did_it' end;
    v_subject := v_ach;
    select d.id into v_lock from public.reward_decisions d where d.user_id = r.user_id and d.kind = 'milestone' and d.primary_subject = v_ach;
    if v_lock is not null then
      insert into public.reward_audit (user_id, intent_seq, outcome, reason, blocking_decision_id)
      values (r.user_id, r.seq, 'duplicate', 'achievement_held', v_lock);
      return;
    end if;
    v_outcome := 'granted';

  elsif r.kind = 'mock_complete' then
    v_subject := s->>'session_id';
    if coalesce((s->>'distinct_answers')::int, 0) < 3 then v_outcome := 'ineligible'; v_reason := 'too_few_answers';
    else v_outcome := 'granted'; v_xp := (cfg.xp->>'mock_complete')::int; end if;

  elsif r.kind = 'answer_practice' then
    v_subject := (s->>'session_id') || ':' || coalesce(s->>'fingerprint', '');
    select d.id into v_lock from public.reward_decisions d
     where d.user_id = r.user_id and d.kind = 'answer_practice' and d.primary_subject = v_subject;
    if v_lock is not null then
      insert into public.reward_audit (user_id, intent_seq, outcome, reason, blocking_decision_id)
      values (r.user_id, r.seq, 'duplicate', 'same_question', v_lock);
      return;
    end if;
    v_outcome := 'granted'; v_xp := (cfg.xp->>'answer_practice')::int;

  elsif r.kind = 'company_research' then
    v_subject := s->>'tool_result_id';
    v_outcome := 'granted'; v_xp := (cfg.xp->>'company_research')::int;

  else
    raise exception 'GAM_INVARIANT: unknown intent kind %', r.kind using errcode = 'GX005';
  end if;

  -- Daily caps (per kind, per local day, counting earlier decisions only).
  if v_outcome = 'granted' and cfg.caps ? r.kind then
    if (select count(*) from public.reward_decisions d
         where d.user_id = r.user_id and d.kind = r.kind and d.local_day = r.local_day
           and d.outcome in ('granted', 'capped')) >= (cfg.caps->>r.kind)::int then
      v_outcome := 'capped';
    end if;
  end if;

  insert into public.reward_decisions (user_id, kind, primary_subject, outcome, reason, tier, intent_seq, local_day, config_version)
  values (r.user_id, r.kind, v_subject, v_outcome, v_reason, v_tier, r.seq, r.local_day, r.config_version)
  returning id into v_dec;

  if r.kind in ('job_saved', 'application', 'cv_tailor', 'cover_letter') then
    insert into public.reward_locks values (r.user_id, r.kind, 'card', v_card, v_dec);
    if v_outcome in ('granted', 'capped') and v_url is not null and r.kind in ('job_saved', 'application') then
      insert into public.reward_locks values (r.user_id, r.kind, 'url', v_url, v_dec);
    end if;
  end if;

  -- Achievements that count tiers include capped decisions (the tier is real).
  if r.kind = 'application' and v_outcome in ('granted', 'capped') then
    perform public.gam_award_achievement(r.user_id, 'first_shot', v_dec, cfg);
    if (select count(*) from public.reward_decisions d where d.user_id = r.user_id and d.kind = 'application'
          and d.tier in ('quality', 'power')) >= 10 then
      perform public.gam_award_achievement(r.user_id, 'ten_quality', v_dec, cfg);
    end if;
    if (select count(*) from public.reward_decisions d where d.user_id = r.user_id and d.kind = 'application' and d.tier = 'power') >= 5 then
      perform public.gam_award_achievement(r.user_id, 'quality_over_quantity', v_dec, cfg);
    end if;
  elsif r.kind = 'milestone' then
    perform public.gam_award_achievement(r.user_id, v_ach, v_dec, cfg);
  elsif r.kind = 'mock_complete' and v_outcome = 'granted' then
    perform public.gam_award_achievement(r.user_id, 'first_mock', v_dec, cfg);
    if (select count(*) from public.reward_decisions d where d.user_id = r.user_id and d.kind = 'mock_complete' and d.outcome = 'granted') >= 5 then
      perform public.gam_award_achievement(r.user_id, 'interview_ready', v_dec, cfg);
    end if;
  end if;

  if v_outcome = 'granted' and v_xp is not null then
    insert into public.xp_grants values (v_dec, r.user_id, v_xp, r.local_day);
    insert into public.streak_days values (r.user_id, r.local_day, 'active')
    on conflict (user_id, day) do nothing;
    if public.gam_streak_length(r.user_id, r.local_day) >= 7 then
      perform public.gam_award_achievement(r.user_id, 'on_a_roll', v_dec, cfg);
    end if;

    -- Quests for that local day.
    update public.daily_quest_assignments q
       set progress = least(q.progress + 1, q.target),
           completed_at = case when q.progress + 1 >= q.target then coalesce(q.completed_at, pg_catalog.now()) else q.completed_at end
     where q.user_id = r.user_id and q.day = r.local_day and q.kind = r.kind;
    select count(*), count(*) filter (where q.completed_at is not null) into v_quests_total, v_quests_done
      from public.daily_quest_assignments q where q.user_id = r.user_id and q.day = r.local_day;
    if v_quests_total > 0 and v_quests_done = v_quests_total then
      perform public.apply_coin_transaction(r.user_id, (cfg.coins->>'daily_quests')::int, 'daily_quests', r.local_day::text);
    end if;

    -- Weekly challenge (Monday-start weeks in the user's timezone).
    v_week := pg_catalog.date_trunc('week', r.local_day)::date;
    select (cfg.weekly_targets->>coalesce(g.intensity, 'active'))::int into v_target
      from (select 1) x left join public.user_goal_settings g on g.user_id = r.user_id;
    select coalesce(sum(x.xp), 0) into v_week_xp from public.xp_grants x
     where x.user_id = r.user_id and x.local_day >= v_week and x.local_day < v_week + 7;
    if v_week_xp >= v_target then
      perform public.apply_coin_transaction(r.user_id, (cfg.coins->>'weekly_challenge')::int, 'weekly_challenge', v_week::text);
    end if;
  end if;
end
$$;

create or replace function public.process_reward_intents(p_user uuid) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare r public.reward_intents; n int := 0; v_max int;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'process_reward_intents must run in READ COMMITTED' using errcode = 'GX006';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(4711, pg_catalog.hashtext(p_user::text));
  select c.max_attempts into v_max from public.gamification_config c order by c.version desc limit 1;
  -- A stuck intent blocks everything after it until an admin skips it, and a
  -- pending one in backoff blocks until its next attempt is due.
  for r in select * from public.reward_intents i
            where i.user_id = p_user and i.state in ('pending', 'stuck') order by i.seq loop
    exit when r.state = 'stuck';
    exit when r.next_attempt_at is not null and r.next_attempt_at > pg_catalog.now();
    begin
      perform public.gam_decide(r);
      update public.reward_intents i set state = 'processed', processed_at = pg_catalog.now(), next_attempt_at = null
       where i.seq = r.seq;
      n := n + 1;
    exception when others then
      update public.reward_intents i
         set attempts = i.attempts + 1,
             last_error = left(sqlstate || ': ' || sqlerrm, 500),
             next_attempt_at = pg_catalog.now() + least(interval '1 minute' * power(2, i.attempts), interval '1 hour'),
             state = case when i.attempts + 1 >= v_max then 'stuck' else 'pending' end
       where i.seq = r.seq;
      exit;                                         -- later intents wait behind it
    end;
  end loop;
  return n;
end
$$;

-- ---------------------------------------------------------------------------
-- 10. Admin skip (owner gamification_admin). The backend also checks admin
--     rights; this re-checks users.is_admin so the database never trusts it.
-- ---------------------------------------------------------------------------
create or replace function public.skip_reward_intent(p_actor uuid, p_seq bigint, p_reason text) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_user uuid; n int;
begin
  if not exists (select 1 from public.users u where u.id = p_actor and u.is_admin) then
    raise exception 'skip_reward_intent: actor is not an admin' using errcode = 'insufficient_privilege';
  end if;
  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 10 then
    raise exception 'skip_reward_intent: a reason of at least 10 characters is required' using errcode = 'invalid_parameter_value';
  end if;
  update public.reward_intents i set state = 'skipped', processed_at = pg_catalog.now(), last_error = 'skipped by admin: ' || p_reason
   where i.seq = p_seq and i.state = 'stuck'
  returning i.user_id into v_user;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'skip_reward_intent: intent % is not stuck', p_seq using errcode = 'GN002'; end if;
  insert into public.reward_audit (user_id, intent_seq, outcome, reason) values (v_user, p_seq, 'skipped', p_reason);
  insert into public.admin_actions (actor_id, target_user_id, action, detail)
  values (p_actor, v_user, 'skip_reward_intent', pg_catalog.jsonb_build_object('intent_seq', p_seq, 'reason', p_reason));
end
$$;

-- ---------------------------------------------------------------------------
-- 11. EXECUTE — only on functions this migration creates. Revoke first, then
--     grant the entry points, then hand ownership to the narrowest role
--     (ALTER OWNER carries the ACL across).
-- ---------------------------------------------------------------------------
do $$
declare f text; r text;
  v_all text[] := array[
    'public.g1_cv_run_card()', 'public.g2_cover_letter_marker()', 'public.g3_goal_timezone()',
    'public.create_saved_job(uuid, jsonb)', 'public.change_job_status(uuid, uuid, text, text)',
    'public.enqueue_reward_intent(uuid, text, text, text, text, jsonb)',
    'public.trg_saved_jobs_capture()', 'public.trg_job_events_capture()', 'public.trg_cv_completed_capture()',
    'public.trg_answer_capture()', 'public.trg_session_complete_capture()', 'public.trg_tool_results_capture()',
    'public.charge_credits(uuid, integer)', 'public.record_cover_letter(uuid, uuid, text, uuid, integer)',
    'public.apply_coin_transaction(uuid, integer, text, text)', 'public.gam_local_today(uuid)',
    'public.ensure_daily_quests(uuid)', 'public.book_rest_day(uuid, date)', 'public.gam_streak_length(uuid, date)',
    'public.gam_award_achievement(uuid, text, bigint, public.gamification_config)',
    'public.gam_decide(public.reward_intents)', 'public.process_reward_intents(uuid)',
    'public.skip_reward_intent(uuid, bigint, text)'];
  v_entry text[] := array[
    'public.create_saved_job(uuid, jsonb)', 'public.change_job_status(uuid, uuid, text, text)',
    'public.record_cover_letter(uuid, uuid, text, uuid, integer)', 'public.charge_credits(uuid, integer)',
    'public.process_reward_intents(uuid)', 'public.ensure_daily_quests(uuid)', 'public.book_rest_day(uuid, date)',
    'public.skip_reward_intent(uuid, bigint, text)'];
begin
  foreach f in array v_all loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array v_entry loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;

  -- ALTER OWNER needs the new owner to hold CREATE on the schema (superusers
  -- skip that check). Grant it only for the hand-over, then take it back.
  foreach r in array array['gamification_capture', 'gamification_processor',
                           'gamification_cover_letter_writer', 'gamification_admin'] loop
    execute format('grant create on schema public to %I', r);
  end loop;

  foreach f in array array['public.enqueue_reward_intent(uuid, text, text, text, text, jsonb)',
                           'public.trg_saved_jobs_capture()', 'public.trg_job_events_capture()', 'public.trg_cv_completed_capture()',
                           'public.trg_answer_capture()', 'public.trg_session_complete_capture()', 'public.trg_tool_results_capture()'] loop
    execute format('alter function %s owner to gamification_capture', f);
  end loop;
  foreach f in array array['public.apply_coin_transaction(uuid, integer, text, text)', 'public.gam_local_today(uuid)',
                           'public.ensure_daily_quests(uuid)', 'public.book_rest_day(uuid, date)', 'public.gam_streak_length(uuid, date)',
                           'public.gam_award_achievement(uuid, text, bigint, public.gamification_config)',
                           'public.gam_decide(public.reward_intents)', 'public.process_reward_intents(uuid)'] loop
    execute format('alter function %s owner to gamification_processor', f);
  end loop;
  foreach f in array array['public.charge_credits(uuid, integer)', 'public.record_cover_letter(uuid, uuid, text, uuid, integer)'] loop
    execute format('alter function %s owner to gamification_cover_letter_writer', f);
  end loop;
  execute 'alter function public.skip_reward_intent(uuid, bigint, text) owner to gamification_admin';

  foreach r in array array['gamification_capture', 'gamification_processor',
                           'gamification_cover_letter_writer', 'gamification_admin'] loop
    execute format('revoke create on schema public from %I', r);
  end loop;
end
$$;

-- Verify after running (expect zero rows):
--   select tablename from pg_tables where schemaname = 'public' and rowsecurity = false;
-- and run supabase/tests/047_gamification.test.sql against a scratch copy.
