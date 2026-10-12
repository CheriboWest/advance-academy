"""Self-check for how the crawler writes job expiry: `python test_job_expiry_ingest.py`.

Migration 046 gave jobs a stated closing date (`expires_at`), an observation
time (`last_seen_at`) and a closed state (`closed_at` / `closed_reason`). Before
it, the crawler upserted `is_active = true` on every sighting and nothing ever
closed a job. Covered here:

  1. A Reed job whose closing date has passed is stored closed ('expired');
     one with a future date is stored open with the date.
  2. A source that states no date (Adzuna) never erases a stored date: its
     upsert request does not even name the column.
  3. ...nor reopens a job whose stored date has passed, and the original
     closed_at is kept.
  4. Seeing a job the stale sweep closed reopens it.
  5. The same job from both sources in one pair keeps Reed's date and is
     sighted under both sources.
  6. Every upsert request names one uniform column set.
  7. Every stored row gets last_seen_at, equal to its sightings' time.
  8. Before 046 is applied the crawl still works, exactly as before.
  9. close_expired_jobs() runs after the crawl; if it fails, the crawl doesn't.

Offline: FakeRest stands in for Supabase and the source adapters are stubbed.
"""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")

import sys  # noqa: E402
from datetime import timedelta  # noqa: E402

import httpx  # noqa: E402

from app.crawler.normalize import company_slug, content_hash  # noqa: E402
from crawl_test_support import (  # noqa: E402
    NOW,
    FakeRest,
    check,
    crawl_run_updates,
    failures,
    job,
    run_crawl_with_sources,
)

PAST = (NOW - timedelta(days=2)).isoformat()
FUTURE = (NOW + timedelta(days=10)).isoformat()
LATER = (NOW + timedelta(days=30)).isoformat()


def h(title: str, company: str = "Acme", city: str = "London") -> str:
    return content_hash(company_slug(company), title, city)


def stored(rest: FakeRest, title: str) -> dict:
    return next(j for j in rest.jobs if j.get("content_hash") == h(title))


def job_requests(rest: FakeRest) -> list[list[dict]]:
    return [rows for table, _, rows in rest.upsert_calls if table == "jobs"]


# 1. Explicit expiry on a new job ---------------------------------------------
rest = FakeRest()
run_crawl_with_sources(rest, reed=[
    job("Closed Role", source="reed", expires_at=PAST),
    job("Open Role", source="reed", expires_at=FUTURE),
])
closed, open_ = stored(rest, "Closed Role"), stored(rest, "Open Role")
check("1a. past Reed date → stored closed with reason 'expired'",
      closed["is_active"] is False and closed["closed_reason"] == "expired"
      and closed["closed_at"] == closed["last_seen_at"], str(closed))
check("1b. future Reed date → stored open, date kept",
      open_["is_active"] is True and open_["expires_at"] == FUTURE
      and open_["closed_reason"] is None and open_["closed_at"] is None, str(open_))

# 2–3. Another source omits the date --------------------------------------------
T0 = (NOW - timedelta(days=1)).isoformat()
rest = FakeRest(jobs=[
    {"content_hash": h("Kept Date"), "source": "reed", "is_active": True,
     "expires_at": FUTURE, "closed_at": None, "closed_reason": None},
    {"content_hash": h("Already Closed"), "source": "reed", "is_active": False,
     "expires_at": PAST, "closed_at": T0, "closed_reason": "expired"},
])
run_crawl_with_sources(rest, adzuna=[job("Kept Date"), job("Already Closed")])
kept, still_closed = stored(rest, "Kept Date"), stored(rest, "Already Closed")
check("2a. Adzuna sighting leaves Reed's stored closing date untouched",
      kept["expires_at"] == FUTURE and kept["is_active"] is True, str(kept))
check("2b. ...because no jobs upsert request even names expires_at",
      all("expires_at" not in row for rows in job_requests(rest) for row in rows))
check("3a. Adzuna sighting does not reopen a job whose stated date passed",
      still_closed["is_active"] is False and still_closed["closed_reason"] == "expired",
      str(still_closed))
check("3b. ...and keeps the original closed_at", still_closed["closed_at"] == T0)
check("3c. ...while still recording that it was seen",
      still_closed["last_seen_at"] is not None)

# A later Reed posting with a new, future date does reopen it.
run_crawl_with_sources(rest, reed=[job("Already Closed", source="reed", expires_at=LATER)])
reopened = stored(rest, "Already Closed")
check("3d. a newer Reed date in the future reopens the job",
      reopened["is_active"] is True and reopened["expires_at"] == LATER
      and reopened["closed_reason"] is None, str(reopened))

# 4. Stale-closed job seen again ---------------------------------------------------
rest = FakeRest(jobs=[
    {"content_hash": h("Back Again"), "source": "adzuna", "is_active": False,
     "expires_at": None, "closed_at": T0, "closed_reason": "stale"},
])
run_crawl_with_sources(rest, adzuna=[job("Back Again")])
back = stored(rest, "Back Again")
check("4. a stale-closed job that is seen again reopens",
      back["is_active"] is True and back["closed_reason"] is None and back["closed_at"] is None,
      str(back))

# 5–7. Both sources in one pair, mixed column sets ----------------------------------
rest = FakeRest()
run_crawl_with_sources(
    rest,
    adzuna=[job("Shared Role"), job("Adzuna Only")],
    reed=[job("Shared Role", source="reed", expires_at=FUTURE)],
)
shared = stored(rest, "Shared Role")
check("5a. same job from both sources keeps Reed's date even though Adzuna's copy was kept",
      shared["expires_at"] == FUTURE, str(shared))
check("5b. ...and is sighted under both sources",
      {k[1] for k in rest.sightings if k[0] == h("Shared Role")} == {"adzuna", "reed"})
requests = job_requests(rest)
check("6. mixed rows go in separate requests, each naming one column set",
      len(requests) == 2
      and all(len({tuple(sorted(r)) for r in rows}) == 1 for rows in requests),
      str([sorted(rows[0]) for rows in requests]))
sighted_at = {row["last_seen_at"] for row in rest.sightings.values()}
check("7a. every stored crawled row has last_seen_at",
      all(j.get("last_seen_at") for j in rest.jobs))
check("7b. jobs.last_seen_at equals the pair's sighting time",
      len(sighted_at) == 1 and {j["last_seen_at"] for j in rest.jobs} == sighted_at)
check("7c. sightings use the normalised scope, as discovery_queries does",
      {(k[2], k[3]) for k in rest.sightings} == {("software engineer", "london")})
check("7d. sightings are only ever for crawled sources",
      {k[1] for k in rest.sightings} <= {"adzuna", "reed"})

# 8. Migration 046 not applied --------------------------------------------------------
rest = FakeRest()
rest.missing_job_columns = {"expires_at", "closed_at", "closed_reason", "last_seen_at"}
run_crawl_with_sources(rest, reed=[job("Legacy Shape", source="reed", expires_at=PAST)])
legacy = stored(rest, "Legacy Shape")
statuses = [u.get("status") for u in crawl_run_updates(rest) if "status" in u]
check("8a. without 046 the crawl still succeeds", statuses[-1:] == ["success"], str(statuses))
check("8b. ...storing the job open, in the pre-046 row shape",
      legacy["is_active"] is True
      and not {"expires_at", "last_seen_at", "closed_at", "closed_reason"} & set(legacy),
      str(legacy))
check("8c. ...and recording no sightings or fetch evidence",
      not rest.sightings and not rest.inserted.get("crawl_fetches"))

# 9. The post-crawl expired sweep --------------------------------------------------------
rest = FakeRest()
rest.rpc_results["close_expired_jobs"] = 3
run_crawl_with_sources(rest, adzuna=[job("Any Role")])
check("9a. close_expired_jobs() is called once after the crawl",
      [name for name, _ in rest.rpc_calls] == ["close_expired_jobs"], str(rest.rpc_calls))

rest = FakeRest()
request = httpx.Request("POST", "https://example.test/rpc/close_expired_jobs")
rest.rpc_error = httpx.HTTPStatusError(
    "missing", request=request, response=httpx.Response(404, request=request))
run_crawl_with_sources(rest, adzuna=[job("Any Role")])
statuses = [u.get("status") for u in crawl_run_updates(rest) if "status" in u]
check("9b. a failing sweep (e.g. 046 not applied) never fails the crawl",
      statuses[-1:] == ["success"], str(statuses))

rest = FakeRest()
run_crawl_with_sources(rest, adzuna=RuntimeError("down"), reed=RuntimeError("down"))
check("9c. the sweep runs even when the crawl itself failed (it needs no crawl evidence)",
      [name for name, _ in rest.rpc_calls] == ["close_expired_jobs"])

if failures():
    print(f"\n{len(failures())} JOB EXPIRY INGEST CHECK(S) FAILED")
    sys.exit(1)
print("\nALL JOB EXPIRY INGEST CHECKS PASSED")
