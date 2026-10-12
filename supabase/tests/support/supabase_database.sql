-- Per-database stand-ins for hosted Supabase. LOCAL SCRATCH DATABASES ONLY.
-- Run as a superuser on a freshly created database owned by `postgres`,
-- before the migrations (run_local.sh does this).

-- Extensions the migrations expect to be available. On hosted Supabase they
-- are enabled from the dashboard; `vector` is not a trusted extension, so a
-- non-superuser migration owner could not create it here.
create extension if not exists vector;
create extension if not exists pgcrypto;

-- auth schema: just what the migrations and policies touch.
create schema if not exists auth;
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb,
  created_at         timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to postgres, anon, authenticated, service_role;
grant all on auth.users to postgres;
grant execute on function auth.uid() to public;

-- Supabase's default privileges: everything `postgres` creates in public is
-- granted to the API roles. 047 must revoke these for its own objects.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
-- The same for objects the superuser creates, for MIGRATION_ROLE=<superuser> runs.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
