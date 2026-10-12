"""Self-check for stale-job evidence: `python test_crawl_fetch_evidence.py`.

A row in `crawl_fetches` is the only thing that lets the stale-job sweep
(migration 046) treat a job's absence as meaningful, so it must exist only for
a fetch that is beyond doubt complete. Covered here:

  1. A clean pair records one row per source: normalised scope, result count,
     run id, and the same timestamp as the pair's sightings.
  2. A partial crawl records NOTHING for the pair — one source failing, or
     requested but not configured — though the jobs it did get are still
     stored and sighted (sightings only ever delay a closure).
  3. An empty fetch is recorded with result_count 0 (visible as a coverage gap;
     the SQL never counts it as evidence).
  4. Truncated results record nothing.
  5. A pair that fails or times out after fetching records nothing — including
     a failure as late as the discovery_queries write.
  6. A failed sightings write records nothing (a fetch with no matching
     sighting would read as the job having disappeared).
  7. In a multi-pair run only the complete pairs record evidence.
  8. A failed evidence write never fails the crawl.

Offline: FakeRest stands in for Supabase and the source adapters are stubbed.
"""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")

import asyncio  # noqa: E402
import sys  # noqa: E402

import httpx  # noqa: E402

from crawl_test_support import (  # noqa: E402
    FakeRest,
    FakeSettings,
    check,
    crawl_run_updates,
    failures,
    job,
    run_crawl_with_sources,
)


def fetch_rows(rest: FakeRest) -> list[dict]:
    return rest.inserted.get("crawl_fetches", [])


def final_status(rest: FakeRest) -> str:
    statuses = [u["status"] for u in crawl_run_updates(rest) if "status" in u]
    return statuses[-1] if statuses else ""


def upstream_error() -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "https://source.example/search")
    return httpx.HTTPStatusError(
        "boom", request=request, response=httpx.Response(503, request=request))


# 1. Clean pair -----------------------------------------------------------------------
rest = FakeRest()
run_crawl_with_sources(
    rest,
    run_id="run-clean",
    adzuna=[job("Engineer"), job("Analyst")],
    reed=[job("Designer", source="reed")],
)
rows = fetch_rows(rest)
by_source = {r["source"]: r for r in rows}
check("1a. one fetch row per source", sorted(by_source) == ["adzuna", "reed"], str(rows))
check("1b. result counts are what each source returned",
      by_source.get("adzuna", {}).get("result_count") == 2
      and by_source.get("reed", {}).get("result_count") == 1)
check("1c. scope is normalised like discovery_queries",
      {(r["query"], r["location"]) for r in rows} == {("software engineer", "london")})
check("1d. rows carry the run id", {r["run_id"] for r in rows} == {"run-clean"})
check("1e. fetched_at is the very instant stamped on the pair's sightings",
      {r["fetched_at"] for r in rows} == {s["last_seen_at"] for s in rest.sightings.values()})

# 2. Partial crawls ------------------------------------------------------------------------
rest = FakeRest()
run_crawl_with_sources(rest, adzuna=[job("Engineer")], reed=upstream_error())
check("2a. one source failing → no fetch rows for the pair", not fetch_rows(rest))
check("2b. ...but the other source's jobs are stored and sighted",
      len(rest.jobs) == 1 and {k[1] for k in rest.sightings} == {"adzuna"})
check("2c. ...and the run itself still succeeds", final_status(rest) == "success")


class NoReed(FakeSettings):
    reed_api_key = ""


rest = FakeRest()
run_crawl_with_sources(rest, adzuna=[job("Engineer")], settings=NoReed())
check("2d. a requested source with no credentials → no fetch rows", not fetch_rows(rest))

rest = FakeRest()
run_crawl_with_sources(rest, adzuna=[job("Engineer")], sources=("adzuna",), settings=NoReed())
check("2e. not requesting the unconfigured source is a complete crawl",
      [r["source"] for r in fetch_rows(rest)] == ["adzuna"])

# 3. Empty fetch ------------------------------------------------------------------------------
rest = FakeRest()
run_crawl_with_sources(rest, adzuna=[], reed=[])
check("3. empty fetches are recorded with result_count 0",
      sorted((r["source"], r["result_count"]) for r in fetch_rows(rest))
      == [("adzuna", 0), ("reed", 0)], str(fetch_rows(rest)))

# 4. Truncation --------------------------------------------------------------------------------
rest = FakeRest()
run_crawl_with_sources(rest, adzuna=[job(f"Role {i}") for i in range(60)], reed=[])
check("4. a source returning more than the per-source limit → no fetch rows",
      not fetch_rows(rest))

# 5. Pair fails after fetching ----------------------------------------------------------------------
rest = FakeRest()
rest.fail_upsert_tables = {"jobs"}
run_crawl_with_sources(rest, adzuna=[job("Engineer")], reed=[])
check("5a. jobs upsert fails → no fetch rows", not fetch_rows(rest))
check("5b. ...and the single-pair run is an error", final_status(rest) == "error")

rest = FakeRest()
rest.fail_upsert_tables = {"discovery_queries"}
run_crawl_with_sources(rest, adzuna=[job("Engineer")], reed=[])
check("5c. even a failure as late as the discovery_queries write → no fetch rows",
      not fetch_rows(rest))


async def _slow(query, city):
    await asyncio.sleep(1.0)
    return [job("Engineer")]

rest = FakeRest()
run_crawl_with_sources(rest, adzuna=_slow, reed=[], timeout_seconds=0.2)
check("5d. a pair that times out → no fetch rows", not fetch_rows(rest))

# 6. Sightings write fails --------------------------------------------------------------------------
rest = FakeRest()
rest.fail_upsert_tables = {"job_sightings"}
run_crawl_with_sources(rest, adzuna=[job("Engineer")], reed=[])
check("6a. failed sightings write → no fetch rows", not fetch_rows(rest))
check("6b. ...while the jobs are stored and the crawl succeeds",
      len(rest.jobs) == 1 and final_status(rest) == "success")

# 7. Multi-pair run -------------------------------------------------------------------------------------
def reed_by_city(query, city):
    return upstream_error() if city == "Leeds" else [job("Nurse", source="reed", city=city)]

rest = FakeRest()
run_crawl_with_sources(
    rest, query="Nurse", city="London, Leeds",
    adzuna=lambda q, c: [job("Nurse", city=c)], reed=reed_by_city,
)
check("7. only the complete pair records evidence",
      sorted({(r["location"], r["source"]) for r in fetch_rows(rest)})
      == [("london", "adzuna"), ("london", "reed")], str(fetch_rows(rest)))

# 8. Evidence write fails ------------------------------------------------------------------------------
rest = FakeRest()
rest.fail_insert_tables = {"crawl_fetches"}
run_crawl_with_sources(rest, adzuna=[job("Engineer")], reed=[])
check("8. a failed crawl_fetches insert never fails the crawl",
      final_status(rest) == "success" and len(rest.jobs) == 1)

if failures():
    print(f"\n{len(failures())} CRAWL FETCH EVIDENCE CHECK(S) FAILED")
    sys.exit(1)
print("\nALL CRAWL FETCH EVIDENCE CHECKS PASSED")
