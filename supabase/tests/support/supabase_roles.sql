-- Cluster-wide stand-ins for hosted Supabase's roles. LOCAL SCRATCH CLUSTERS ONLY.
-- Run once per cluster as a superuser (run_local.sh does this). Idempotent.
--
-- What matters for the migrations and their tests, as on hosted Supabase:
--   * `postgres` (the migration owner) is NOT a superuser: CREATEROLE + CREATEDB
--     + BYPASSRLS. Migrations that only work as superuser fail here too.
--   * anon / authenticated are plain NOLOGIN roles; service_role has BYPASSRLS.
--   * authenticator (PostgREST's login role) can SET ROLE to the three API roles.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'postgres') then
    create role postgres login createrole createdb bypassrls nosuperuser;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end
$$;
grant anon, authenticated, service_role to authenticator;
-- Hosted Supabase lets `postgres` hand these roles out (dashboard grants).
grant anon, authenticated, service_role to postgres with admin option;
