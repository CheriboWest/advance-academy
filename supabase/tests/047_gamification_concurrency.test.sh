#!/usr/bin/env bash
# Two-session checks for migration 047 that one transaction cannot express.
# LOCAL SCRATCH DATABASES ONLY. Run by run_local.sh after the SQL tests, or:
#
#   PGHOST=127.0.0.1 PGPORT=54340 SCRATCH_DB=aa_migration_scratch \
#     supabase/tests/047_gamification_concurrency.test.sh
#
# Unlike the .sql tests these fixtures must be committed (other sessions have
# to see them), so the script refuses to run on a database with real users and
# deletes its own users on exit, which cascades to everything they own.
#
#   1. Two cover letters racing for the last credit: one wins, the other gets
#      GC001 after waiting on the row lock — never a double spend.
#   2. process_reward_intents refuses REPEATABLE READ / SERIALIZABLE (GX006).
#   3. A capture in flight blocks the processor (per-user advisory lock), which
#      then judges the intent as soon as the capture commits.
#   4. PostgREST's login role cannot SET ROLE to any owner role.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PG_SUPERUSER:=supabase_admin}"
: "${SCRATCH_DB:=aa_migration_scratch}"
export PGHOST PGPORT

case "$PGHOST" in
  127.0.0.1|localhost|::1) ;;
  *) echo "refusing: PGHOST=$PGHOST is not local" >&2; exit 2 ;;
esac

U1=c0ffee00-0000-0000-0000-000000000001
U2=c0ffee00-0000-0000-0000-000000000002
su() { psql -X -qAt -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d "$SCRATCH_DB" "$@"; }
# A PostgREST-style session: log in as authenticator, then SET ROLE.
api() { local sql=$1; printf 'set role service_role;\n%s\n' "$sql" | psql -X -qAt -v ON_ERROR_STOP=1 -U authenticator -d "$SCRATCH_DB" 2>&1; }

if [ "$(su -c "select count(*) from public.users where id <> '00000000-0000-0000-0000-000000000000'")" != 0 ]; then
  echo "refusing: $SCRATCH_DB has users — run this only against a scratch database" >&2; exit 2
fi
cleanup() { su -c "delete from public.users where id in ('$U1', '$U2')" >/dev/null 2>&1 || true; }
trap cleanup EXIT

pass=0; fail=0
check() { # label, got, want
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok   $1"; else fail=$((fail + 1)); echo "FAIL $1 — got '$2', want '$3'"; fi
}
matches() { # label, got, regex
  if echo "$2" | grep -qE "$3"; then pass=$((pass + 1)); echo "ok   $1"; else fail=$((fail + 1)); echo "FAIL $1 — got '$2', want /$3/"; fi
}

su <<SQL >/dev/null
insert into public.users (id, email, credit_balance) values ('$U1', 'conc1@test.local', 1), ('$U2', 'conc2@test.local', 0);
insert into public.saved_jobs (id, user_id, title) values
  ('c0ffee00-0000-0000-0000-0000000000a1', '$U1', 'First'),
  ('c0ffee00-0000-0000-0000-0000000000a2', '$U1', 'Second');
SQL

# 1. Concurrent charges on a balance of 1 ---------------------------------------
first=$(mktemp)
( api "begin;
       select public.record_cover_letter('$U1', 'c0ffee00-0000-0000-0000-0000000000a1', 'first', null, 1) is not null;
       select pg_sleep(2);
       commit;" > "$first" ) &
sleep 0.7
t0=$(date +%s.%N)
second=$(api "select public.record_cover_letter('$U1', 'c0ffee00-0000-0000-0000-0000000000a2', 'second', null, 1);" || true)
t1=$(date +%s.%N)
wait
matches "1 the second caller is refused with GC001 CREDIT_EXHAUSTED" "$second" "CREDIT_EXHAUSTED"
matches "1 …after waiting for the first to commit (blocked ≥ 1s)" "$(echo "$t1 - $t0 >= 1" | bc)" '^1$'
matches "1 the first caller succeeded" "$(cat "$first")" "^t$"
check "1 exactly one letter written, one intent, balance 0" \
  "$(su -c "select (select count(*) from public.saved_jobs where user_id = '$U1' and cover_letter_run_id is not null) || '/' ||
                   (select count(*) from public.reward_intents where user_id = '$U1' and kind = 'cover_letter') || '/' ||
                   (select credit_balance from public.users where id = '$U1')")" "1/1/0"
rm -f "$first"

# 2. The processor needs READ COMMITTED -----------------------------------------
for iso in "repeatable read" "serializable"; do
  out=$(api "begin isolation level $iso; select public.process_reward_intents('$U1'); commit;" || true)
  matches "2 process_reward_intents refuses $iso" "$out" "must run in READ COMMITTED"
done
check "2 a READ COMMITTED run judges the letter" "$(api "select public.process_reward_intents('$U1');")" "1"

# 3. A capture in flight blocks the processor until it commits -------------------
( api "begin;
       select public.create_saved_job('$U2', '{\"title\":\"Racing\",\"url_key\":\"race.example/1\"}') is not null;
       select pg_sleep(2);
       commit;" > /dev/null ) &
sleep 0.7
t0=$(date +%s.%N)
judged=$(api "select public.process_reward_intents('$U2');")
t1=$(date +%s.%N)
wait
matches "3 the processor waited for the capture's transaction" "$(echo "$t1 - $t0 >= 1" | bc)" '^1$'
check "3 …and judged the intent it committed" "$judged" "1"
check "3 the save was granted" \
  "$(su -c "select string_agg(kind || ':' || outcome, ',') from public.reward_decisions where user_id = '$U2'")" "job_saved:granted"

# 4. No API login can become an owner role ----------------------------------------
for g in gamification_capture gamification_processor gamification_cover_letter_writer gamification_admin; do
  out=$(printf 'set role %s;\n' "$g" | psql -X -qAt -v ON_ERROR_STOP=1 -U authenticator -d "$SCRATCH_DB" 2>&1 || true)
  matches "4 authenticator cannot SET ROLE $g" "$out" "permission denied to set role"
  out=$(api "set role $g;" || true)
  matches "4 …nor can it after SET ROLE service_role" "$out" "permission denied to set role"
done

echo "concurrency: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
