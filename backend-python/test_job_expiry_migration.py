"""Static check that the crawler and migration 046 agree:
`python test_job_expiry_migration.py` (no pytest, no network, no database).

The crawler now writes jobs.expires_at / last_seen_at / closed_at /
closed_reason, job_sightings and crawl_fetches, and calls the 046 functions.
This drives a real crawl through FakeRest, collects every column and function
it actually used, and checks each one is declared in the migrations — so a
rename on either side fails here instead of as a live "does not exist" error.
It also pins the safety properties of the SQL that need no database to see:
service_role-only access, dry run by default, manual imports excluded.

The SQL behaviour itself is exercised against a real Postgres by
supabase/tests/046_job_expiry.test.sql.
"""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")

import re  # noqa: E402
import sys  # noqa: E402
from datetime import timedelta  # noqa: E402

from crawl_test_support import NOW, FakeRest, check, failures, job, run_crawl_with_sources  # noqa: E402
from repo_paths import MIGRATIONS_DIR, REPO_ROOT  # noqa: E402

MIGRATION = MIGRATIONS_DIR / "046_job_expiry.sql"
sql = MIGRATION.read_text(encoding="utf-8")
all_sql = "\n".join(
    p.read_text(encoding="utf-8")
    for p in sorted(MIGRATIONS_DIR.glob("0*.sql"))
    if not p.name.startswith("schema_")
).lower()


def table_columns(source: str, table: str) -> set[str]:
    """Columns a `create table if not exists public.<table> (...)` declares."""
    match = re.search(
        rf"create table if not exists public\.{table}\s*\((.*?)\n\);", source, re.S | re.I)
    if not match:
        return set()
    cols = set()
    for line in match.group(1).splitlines():
        line = line.split("--")[0].strip()
        word = re.match(r"([a-z_]+)\s+(uuid|text|bigint|integer|timestamptz|boolean|numeric)", line)
        if word:
            cols.add(word.group(1))
    return cols


# What the crawler actually writes -----------------------------------------------------------
rest = FakeRest()
rest.rpc_results["close_expired_jobs"] = 0
run_crawl_with_sources(
    rest,
    adzuna=[job("Engineer")],
    reed=[job("Engineer", source="reed", expires_at=(NOW + timedelta(days=5)).isoformat()),
          job("Closed", source="reed", expires_at=(NOW - timedelta(days=5)).isoformat())],
)
written: dict[str, set[str]] = {}
for table, _, rows in rest.upsert_calls:
    for row in rows:
        written.setdefault(table, set()).update(row)
for table, rows in rest.inserted.items():
    for row in rows:
        written.setdefault(table, set()).update(row)

new_job_columns = {"expires_at", "last_seen_at", "closed_at", "closed_reason"}
check("crawler writes all four new jobs columns",
      new_job_columns <= written.get("jobs", set()), str(written.get("jobs")))
# jobs predates the numbered migrations: 023a creates it, 024 and 046 add to it.
declared_jobs = table_columns(all_sql, "jobs") | set(
    re.findall(r"add column if not exists\s+([a-z_]+)", all_sql))
for column in sorted(written.get("jobs", set())):
    check(f"jobs.{column} is declared by a migration", column in declared_jobs)

for table in ("job_sightings", "crawl_fetches"):
    declared = table_columns(sql, table)
    check(f"{table} is created by 046", bool(declared))
    missing = written.get(table, set()) - declared
    check(f"every {table} column the crawler writes is declared", not missing, str(missing))

check("sightings upsert targets the table's primary key",
      {oc for t, oc, _ in rest.upsert_calls if t == "job_sightings"}
      == {"content_hash,source,query,location"}
      and "primary key (content_hash, source, query, location)" in sql)

# Functions --------------------------------------------------------------------------------------
script = (REPO_ROOT / "backend-python" / "scripts" / "job_expiry.py").read_text(encoding="utf-8")
called = {name for name, _ in rest.rpc_calls} | set(
    re.findall(r'rpc\(\s*client,\s*"([a-z_]+)"', script))
check("the crawler and script call close_expired_jobs, close_stale_jobs, job_crawl_coverage",
      {"close_expired_jobs", "close_stale_jobs", "job_crawl_coverage"} <= called, str(called))
for name in sorted(called):
    check(f"public.{name} is defined by 046",
          f"create or replace function public.{name}(" in sql)
    check(f"public.{name} is granted to service_role only",
          re.search(rf"'public\.{name}\(", sql) is not None)

# Safety properties visible in the SQL ------------------------------------------------------------------
check("close_stale_jobs defaults to a dry run",
      re.search(r"close_stale_jobs\(\s*p_dry_run\s+boolean\s+default true", sql) is not None)
check("legacy closure is opt-in",
      re.search(r"p_include_legacy\s+boolean\s+default false", sql) is not None)
check("a real stale run refuses without verified coverage",
      "Refusing to close stale jobs" in sql and "jsonb_array_length(v_uncovered) > 0" in sql)
check("empty fetches never count as evidence",
      sql.count("result_count > 0") >= 2)
check("manual_import_xlsx is excluded from expiry and staleness",
      sql.count("source is distinct from 'manual_import_xlsx'") >= 2
      and "manual_import_xlsx jobs are never crawled" in sql)
check("new tables are revoked from anon and authenticated",
      "array['public.crawl_fetches', 'public.job_sightings']" in sql
      and "array['anon', 'authenticated']" in sql)
check("046 schedules nothing itself (pg_cron lines stay commented)",
      not re.search(r"^\s*select\s+cron\.schedule", sql, re.M | re.I))

if failures():
    print(f"\n{len(failures())} JOB EXPIRY MIGRATION CHECK(S) FAILED")
    sys.exit(1)
print("\nALL JOB EXPIRY MIGRATION CHECKS PASSED")
