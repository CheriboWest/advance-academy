#!/usr/bin/env bash
# Build a throwaway database from every migration and run the SQL tests.
# LOCAL SCRATCH CLUSTERS ONLY — it drops and recreates $SCRATCH_DB.
#
#   PGHOST=127.0.0.1 PGPORT=54340 supabase/tests/run_local.sh
#
# Needs a Postgres 16 cluster with pgvector installed and a superuser
# ($PG_SUPERUSER, default supabase_admin). Migrations run as the non-superuser
# `postgres` role, the way hosted Supabase runs them (see MIGRATION_ROLE). Every migration in
# supabase/migrations is applied in file-name order (except the schema_* dumps),
# 046 and 047 are applied a second time to prove they are re-runnable, then the
# 046 and 047 tests run, then the 047 concurrency test.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PG_SUPERUSER:=supabase_admin}"
: "${SCRATCH_DB:=aa_migration_scratch}"
# Who applies the migrations: `postgres` (non-superuser, as on hosted
# Supabase) by default; set MIGRATION_ROLE=$PG_SUPERUSER to check the
# superuser path too — on a fresh cluster, since roles are cluster-wide and a
# non-superuser run leaves `postgres` a member of 047's owner roles.
: "${MIGRATION_ROLE:=postgres}"
export PGHOST PGPORT

case "$PGHOST" in
  127.0.0.1|localhost|::1) ;;
  *) echo "refusing: PGHOST=$PGHOST is not local — this script drops databases" >&2; exit 2 ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
migrations="$here/../migrations"
su_psql=(psql -X -q -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER")
owner_psql=(env PGOPTIONS="-c client_min_messages=warning" psql -X -q -v ON_ERROR_STOP=1 -U "$MIGRATION_ROLE" -d "$SCRATCH_DB")

PGOPTIONS="-c client_min_messages=warning" "${su_psql[@]}" -d postgres -f "$here/support/supabase_roles.sql" >/dev/null
"${su_psql[@]}" -d postgres -c "drop database if exists $SCRATCH_DB with (force)" -c "create database $SCRATCH_DB owner $MIGRATION_ROLE" >/dev/null
"${su_psql[@]}" -d "$SCRATCH_DB" -f "$here/support/supabase_database.sql" >/dev/null

applied=0
while IFS= read -r f; do
  if ! out=$("${owner_psql[@]}" -f "$migrations/$f" 2>&1 >/dev/null); then
    echo "FAILED applying $f:"; echo "$out"; exit 1
  fi
  applied=$((applied + 1))
done < <(cd "$migrations" && LC_ALL=C ls -1 -- *.sql | grep -v '^schema_')
echo "applied $applied migrations to $SCRATCH_DB as $MIGRATION_ROLE"

for f in 046_job_expiry.sql 047_gamification.sql; do
  if ! out=$("${owner_psql[@]}" -f "$migrations/$f" 2>&1 >/dev/null); then
    echo "FAILED re-applying $f:"; echo "$out"; exit 1
  fi
done
echo "re-applied 046 and 047 cleanly"

status=0
for t in 046_job_expiry 047_gamification; do
  if out=$("${su_psql[@]}" -d "$SCRATCH_DB" -f "$here/$t.test.sql" 2>&1); then
    echo "$out" | grep -E 'PASSED' || true
    echo "  $(echo "$out" | grep -c '^psql:.*NOTICE:  ok') checks in $t"
  else
    echo "FAILED $t:"; echo "$out" | grep -v 'NOTICE:  ok' | tail -20; status=1
  fi
done

if [ -x "$here/047_gamification_concurrency.test.sh" ]; then
  PG_SUPERUSER="$PG_SUPERUSER" SCRATCH_DB="$SCRATCH_DB" "$here/047_gamification_concurrency.test.sh" || status=1
fi
exit $status
