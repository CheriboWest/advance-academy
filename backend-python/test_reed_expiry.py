"""Self-check for Reed closing dates: `python test_reed_expiry.py` (no pytest).

Reed's search results carry `expirationDate` ("13/08/2026"), the day the vacancy
closes. The adapter used to drop it, so nothing in Career Hub knew any job had
closed (see migration 046). Covered here:

  1. A date becomes midnight UTC at the start of the NEXT day — never earlier
     than the end of that day in London, so a job is never closed while Reed
     still lists it as open.
  2. Missing, blank or unreadable dates are None ("no stated date"), never a
     past date that would close the job.
  3. The real `reed.fetch` carries it through to NormalizedJob, and leaves
     `posted_at` as before.
  4. Adzuna, which states no closing date, never sets one.

Offline: the HTTP calls go to an httpx.MockTransport.
"""

from __future__ import annotations

import asyncio
import sys

import httpx

from app.crawler.sources import adzuna, reed
from app.crawler.sources.reed import _parse_expiry

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"[{'ok  ' if cond else 'FAIL'}] {name}{('  ' + detail) if detail and not cond else ''}")
    if not cond:
        failures.append(name)


# 1–2. Parsing ---------------------------------------------------------------
check("13/08/2026 closes at the start of 14 Aug UTC",
      _parse_expiry("13/08/2026") == "2026-08-14T00:00:00+00:00",
      repr(_parse_expiry("13/08/2026")))
check("surrounding whitespace is tolerated",
      _parse_expiry(" 01/12/2026 ") == "2026-12-02T00:00:00+00:00")
check("31/12 rolls into the next year",
      _parse_expiry("31/12/2026") == "2027-01-01T00:00:00+00:00")
for bad in (None, "", "2026-08-13", "31/02/2026", "13/13/2026", "soon"):
    check(f"unreadable {bad!r} is None, not a closing date", _parse_expiry(bad) is None)


# 3–4. Through the real adapters --------------------------------------------
def _client(payload: dict) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    )


async def _reed_jobs():
    payload = {"results": [
        {"jobId": 1, "employerName": "Acme", "jobTitle": "Engineer",
         "locationName": "London", "jobUrl": "https://reed.example/1",
         "date": "01/08/2026", "expirationDate": "13/08/2026"},
        {"jobId": 2, "employerName": "Acme", "jobTitle": "Analyst",
         "locationName": "London", "jobUrl": "https://reed.example/2",
         "date": "02/08/2026"},
    ]}
    async with _client(payload) as client:
        return await reed.fetch(client, "key", "engineer", "London")


async def _adzuna_jobs():
    payload = {"results": [
        {"id": "a1", "title": "Engineer", "company": {"display_name": "Acme"},
         "location": {"display_name": "London"}, "redirect_url": "https://adzuna.example/a1",
         "created": "2026-08-01T10:00:00Z"},
    ]}
    async with _client(payload) as client:
        return await adzuna.fetch(client, "id", "key", "engineer", "London")


reed_jobs = asyncio.run(_reed_jobs())
check("reed.fetch carries expirationDate into expires_at",
      reed_jobs[0].expires_at == "2026-08-14T00:00:00+00:00", repr(reed_jobs[0].expires_at))
check("reed.fetch keeps posted_at from `date` as before",
      reed_jobs[0].posted_at == "2026-08-01")
check("a Reed result without expirationDate has no closing date",
      reed_jobs[1].expires_at is None)

adzuna_jobs = asyncio.run(_adzuna_jobs())
check("Adzuna never states a closing date", adzuna_jobs[0].expires_at is None)

if failures:
    print(f"\n{len(failures)} REED EXPIRY CHECK(S) FAILED")
    sys.exit(1)
print("\nALL REED EXPIRY CHECKS PASSED")
