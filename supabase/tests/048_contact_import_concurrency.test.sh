#!/usr/bin/env bash
# Two admins commit overlapping imports at the same moment (migration 048).
# LOCAL SCRATCH DATABASES ONLY. Run by run_local.sh, or:
#
#   PGHOST=127.0.0.1 PGPORT=54340 SCRATCH_DB=aa_migration_scratch \
#     supabase/tests/048_contact_import_concurrency.test.sh
#
# Both files contain the same new company and contact. Commits are serialized
# by an advisory lock and re-classify inside their own transaction, so the
# second waits, then MATCHES what the first created: one company, one contact.
# A second race has both admins decide "create" for the same new contact: the
# second commit must still see the first's contact and hold its row for review.
# Fixtures are committed (another session must see them) and deleted on exit.
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

A=0a000000-0000-0000-0000-0000000000aa
B=0b000000-0000-0000-0000-0000000000bb
SLUG=racecorp-concurrency-test
su() { psql -X -qAt -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d "$SCRATCH_DB" "$@"; }
api() { printf 'set role service_role;\n%s\n' "$1" | psql -X -qAt -v ON_ERROR_STOP=1 -U authenticator -d "$SCRATCH_DB" 2>&1; }

if [ "$(su -c "select count(*) from public.contact_import_batches") $(su -c "select count(*) from public.companies where slug = '$SLUG'")" != "0 0" ]; then
  echo "refusing: $SCRATCH_DB already has import batches or the test company" >&2; exit 2
fi
cleanup() {
  su -c "delete from public.contact_import_batches where created_by in ('$A', '$B');
         select public.delete_companies_permanently(array(select id from public.companies where slug = '$SLUG'));" >/dev/null 2>&1 || true
}
trap cleanup EXIT

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok   $1"; else fail=$((fail + 1)); echo "FAIL $1 — got '$2', want '$3'"; fi; }

stage() { # actor [name email resolution] -> batch id
  su -c "with b as (insert into public.contact_import_batches (created_by, file_name, file_kind, file_sha256, file_size)
                    values ('$1', 'race-$1.xlsx', 'xlsx', md5(random()::text), 1) returning id)
         insert into public.contact_import_rows (batch_id, sheet, row_number, raw, extracted, resolution)
         select id, 'S', 1, '{}', jsonb_build_object(
                  'company', jsonb_build_object('name', 'Racecorp Concurrency Test', 'slug', '$SLUG'),
                  'contact', jsonb_build_object('full_name', '${2:-Rae Race}', 'email', '${3:-rae@racecorp.example}')),
                ${4:-null}::jsonb
           from b returning batch_id;" | head -1
}
race() { # B1 B2 -> "<first status>|<second summary json>|<seconds the second waited>"
  local first; first=$(mktemp)
  ( api "begin; select public.contact_import_commit('$1', '$A') ->> 'status'; select pg_sleep(2); commit;" > "$first" ) &
  sleep 0.7
  local t0 t1 second
  t0=$(date +%s.%N)
  second=$(api "select (public.contact_import_commit('$2', '$B'))::text;")
  t1=$(date +%s.%N)
  wait
  echo "$(head -1 "$first")|$second|$(echo "$t1 - $t0" | bc)"
  rm -f "$first"
}
B1=$(stage "$A"); B2=$(stage "$B")
su -c "select public.contact_import_classify('$B1'); select public.contact_import_classify('$B2');" >/dev/null
check "both previews say the company and contact are new" \
  "$(su -c "select string_agg(classification, ',') from public.contact_import_rows where batch_id in ('$B1', '$B2')")" "new,new"

IFS='|' read -r first second waited <<< "$(race "$B1" "$B2")"
check "the first commit succeeded" "$first" "committed"
check "the second waited for the first (≥ 1s)" "$(echo "$waited >= 1" | bc)" "1"
check "…then matched instead of creating" \
  "$(echo "$second" | python3 -c 'import json,sys; s=json.loads(sys.stdin.read()); print(s["status"], s["companies"]["created"], s["contacts"]["created"])')" \
  "committed 0 0"
check "exactly one company and one contact exist" \
  "$(su -c "select (select count(*) from public.companies where slug = '$SLUG') || '/' || (select count(*) from public.contacts where email = 'rae@racecorp.example')")" "1/1"

# Race 2: both admins decided "create" for the same new contact.
CREATE='{"contact": {"action": "create"}}'
B3=$(stage "$A" "Ray Race" "ray@racecorp.example" "'$CREATE'"); B4=$(stage "$B" "Ray Race" "RAY@racecorp.example" "'$CREATE'")
su -c "select public.contact_import_classify('$B3'); select public.contact_import_classify('$B4');" >/dev/null
check "both 'create' decisions preview as a new contact" \
  "$(su -c "select string_agg(contact_status, ',') from public.contact_import_rows where batch_id in ('$B3', '$B4')")" "new,new"
IFS='|' read -r first second waited <<< "$(race "$B3" "$B4")"
check "the first 'create' commit succeeded" "$first" "committed"
check "…the second created no contact" \
  "$(echo "$second" | python3 -c 'import json,sys; s=json.loads(sys.stdin.read()); print(s["status"], s["contacts"]["created"])')" "committed 0"
check "…its row is held for review instead" \
  "$(su -c "select classification || '/' || result_status from public.contact_import_rows where batch_id = '$B4'")" "needs_review/skipped"
check "exactly one contact has that email" \
  "$(su -c "select count(*) from public.contacts where lower(email) = 'ray@racecorp.example'")" "1"

echo "contact import concurrency: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
