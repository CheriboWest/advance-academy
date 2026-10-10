"""Self-check for automatic sponsorship resolution.

`python test_sponsor_worker.py` — offline. The database is a fake enforcing the
unique constraints that matter (one check row per company, one link per
company/licence pair), and the Anthropic client is a stub, so no API key and no
network are involved.

Covers the seven behaviours the workflow depends on:
  1. exact sponsor match      5. repeated resolution does not duplicate records
  2. ambiguous match          6. a crawl still succeeds when resolution fails
  3. no candidates            7. many companies resolve without concurrent overload
  4. Claude failure
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from app.crawler.models import CrawlStats
from app.sponsors.service import MAX_CUMULATIVE_ATTEMPTS
from app.sponsors.worker import (
    DEFAULT_CONCURRENCY,
    MAX_ATTEMPTS,
    BatchStats,
    resolve_companies,
)

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


LICENCE = {
    "id": "lic-1", "organisation_name": "Acme Fintech Limited", "town_city": "London",
    "county": "Greater London", "route": "Skilled Worker", "licence_type": "Worker",
    "rating": "A", "normalized_name": "acme fintech", "normalized_town": "london",
}


class FakeRest:
    """In-memory Supabase enforcing the constraints this workflow relies on."""

    def __init__(self, companies: list[dict], licences: Optional[list[dict]] = None):
        self.companies = companies
        self.licences = licences if licences is not None else [LICENCE]
        self.links: list[dict] = []
        self.checks: list[dict] = []
        self.imports = [{"id": "import-1", "status": "success"}]

    async def select(self, client, table, params=None, timeout=None):
        params = params or {}
        if table == "companies":
            if "id" in params:
                wanted = params["id"].removeprefix("eq.")
                return [dict(c) for c in self.companies if c["id"] == wanted]
            return [{"id": c["id"]} for c in self.companies]
        if table == "sponsor_licences":
            rows = self.licences
            name = params.get("normalized_name", "")
            if name.startswith("eq."):
                rows = [r for r in rows if r["normalized_name"] == name[3:]]
            elif name.startswith("like."):
                pattern = name[5:].strip("*")
                rows = [r for r in rows if pattern in r["normalized_name"]]
            return [dict(r) for r in rows][: int(params.get("limit", "50"))]
        if table == "sponsor_register_imports":
            # Production filters to successful imports; the fake must too, or a
            # failed import would look like a usable register edition.
            rows = self.imports
            status = params.get("status")
            if status and status.startswith("eq."):
                rows = [i for i in rows if i.get("status") == status[3:]]
            return [dict(i) for i in rows][: int(params.get("limit", "50"))]
        if table == "company_sponsorship_checks":
            if "company_id" in params:
                raw = params["company_id"]
                wanted = (
                    {v for v in raw[4:-1].split(",") if v}
                    if raw.startswith("in.(") else {raw.removeprefix("eq.")}
                )
                return [dict(c) for c in self.checks if c["company_id"] in wanted]
            return [dict(c) for c in self.checks]
        return []

    async def upsert(self, client, table, rows, on_conflict, prefer="", timeout=None):
        target = {"company_sponsorship": self.links,
                  "company_sponsorship_checks": self.checks}.get(table)
        if target is None:
            return []
        keys = on_conflict.split(",")
        for row in rows:
            existing = next(
                (r for r in target if all(r.get(k) == row.get(k) for k in keys)), None
            )
            if existing:
                existing.update(row)
            else:
                target.append(dict(row))
        seen = [tuple(r.get(k) for k in keys) for r in target]
        if len(seen) != len(set(seen)):
            raise AssertionError(f"unique index violated on {table} ({on_conflict})")
        return []

    async def update(self, client, table, match, values, prefer="", timeout=None):
        return None

    async def insert(self, client, table, rows, prefer="return=representation", timeout=None):
        return rows


class StubAnthropic:
    """Canned resolver output, or a raised error. Records call concurrency."""

    def __init__(self, payload: Optional[dict] = None, error: Optional[Exception] = None):
        self._payload = payload
        self._error = error
        self.calls = 0
        self.in_flight = 0
        self.peak_in_flight = 0
        self.messages = self

    def create(self, **kwargs):
        import json as _json
        import time as _time

        self.calls += 1
        self.in_flight += 1
        self.peak_in_flight = max(self.peak_in_flight, self.in_flight)
        try:
            _time.sleep(0.02)  # long enough for overlap to be observable
            if self._error is not None:
                raise self._error

            class _Block:
                type = "text"
                text = _json.dumps(self._payload)

            class _Message:
                stop_reason = "end_turn"
                content = [_Block()]

            return _Message()
        finally:
            self.in_flight -= 1


def company(cid: str, name: str = "Acme Fintech Ltd") -> dict:
    return {"id": cid, "name": name, "hq_location": "London", "website": "acme.co.uk"}


def run(rest: FakeRest, ids, stub, **kwargs) -> BatchStats:
    return asyncio.run(
        resolve_companies(
            None, rest, ids, api_key="k", model="claude-opus-5",
            anthropic_client=stub, sleeper=lambda _d: asyncio.sleep(0),
            **kwargs,
        )
    )


MATCH = {"selected_candidate_id": "lic-1", "confidence": 0.95, "decision": "match",
         "matched_on": ["name_exact", "city"], "reasoning": "Exact name and town."}
AMBIGUOUS = {"selected_candidate_id": None, "confidence": 0.5, "decision": "ambiguous",
             "matched_on": [], "reasoning": "Two candidates fit comparably."}


# ---------------------------------------------------------------------------
# 1. Exact sponsor match.
# ---------------------------------------------------------------------------
rest = FakeRest([company("co-1")])
stub = StubAnthropic(MATCH)
stats = run(rest, ["co-1"], stub)
check("MATCH: one company resolved", stats.resolved == 1 and stats.matched == 1,
      f"got {stats.as_dict()}")
check("MATCH: a sponsorship link is written", len(rest.links) == 1)
check("MATCH: the link points at the register row",
      rest.links[0]["sponsor_licence_id"] == "lic-1")
check("MATCH: the check records the decision",
      rest.checks[0]["last_decision"] == "match")
check("MATCH: the check pins the register edition",
      rest.checks[0]["register_import_id"] == "import-1")
check("MATCH: the candidate count is recorded", rest.checks[0]["candidate_count"] == 1)

# ---------------------------------------------------------------------------
# 2. Ambiguous match — recorded, never linked.
# ---------------------------------------------------------------------------
rest = FakeRest([company("co-2")])
stats = run(rest, ["co-2"], StubAnthropic(AMBIGUOUS))
check("AMBIGUOUS: counted as resolved but not matched",
      stats.resolved == 1 and stats.ambiguous == 1 and stats.matched == 0,
      f"got {stats.as_dict()}")
check("AMBIGUOUS: NO sponsorship link is created", rest.links == [], f"got {rest.links}")
check("AMBIGUOUS: the check records it for review",
      rest.checks[0]["last_decision"] == "ambiguous")
check("AMBIGUOUS: no licence is recorded on the check",
      rest.checks[0]["matched_licence_id"] is None)

# ---------------------------------------------------------------------------
# 3. No candidates — Claude is never called.
# ---------------------------------------------------------------------------
rest = FakeRest([company("co-3", "Totally Unlisted Business")], licences=[])
stub = StubAnthropic(MATCH)
stats = run(rest, ["co-3"], stub)
check("NO CANDIDATES: the model is not called", stub.calls == 0, f"got {stub.calls}")
check("NO CANDIDATES: recorded as no_match",
      stats.no_match == 1 and rest.checks[0]["last_decision"] == "no_match")
check("NO CANDIDATES: no link is created", rest.links == [])
check("NO CANDIDATES: the result is still persisted so it is not re-asked",
      len(rest.checks) == 1)

# ---------------------------------------------------------------------------
# 4. Claude failure — isolated, retried, recorded.
# ---------------------------------------------------------------------------
class RateLimited(Exception):
    status_code = 429


rest = FakeRest([company("co-4")])
stub = StubAnthropic(error=RateLimited("slow down"))
stats = run(rest, ["co-4"], stub)
check("FAILURE: the batch does not raise", isinstance(stats, BatchStats))
check("FAILURE: counted as failed", stats.failed == 1, f"got {stats.as_dict()}")
check("FAILURE: a transient error is retried to the attempt limit",
      stub.calls == MAX_ATTEMPTS, f"got {stub.calls}")
check("FAILURE: recorded as error so the company is retried later",
      rest.checks[0]["last_decision"] == "error")
check("FAILURE: the reason is stored", "RateLimited" in (rest.checks[0]["error"] or ""))
check("FAILURE: no link is created", rest.links == [])


class BadRequest(Exception):
    status_code = 400


rest = FakeRest([company("co-5")])
stub = StubAnthropic(error=BadRequest("malformed"))
stats = run(rest, ["co-5"], stub)
check("FAILURE: a non-transient error is NOT retried", stub.calls == 1, f"got {stub.calls}")
check("FAILURE: it is still recorded", rest.checks[0]["last_decision"] == "error")

# ---------------------------------------------------------------------------
# 5. Repeated resolution does not duplicate records.
# ---------------------------------------------------------------------------
rest = FakeRest([company("co-6")])
run(rest, ["co-6"], StubAnthropic(MATCH))
first_links, first_checks = len(rest.links), len(rest.checks)
stub = StubAnthropic(MATCH)
stats = run(rest, ["co-6"], stub)
check("REPEAT: a current conclusion is skipped, not re-resolved",
      stats.skipped_current == 1 and stub.calls == 0, f"got {stats.as_dict()}")
check("REPEAT: no duplicate link", len(rest.links) == first_links == 1)
check("REPEAT: no duplicate check row", len(rest.checks) == first_checks == 1)

stub = StubAnthropic(MATCH)
stats = run(rest, ["co-6"], stub, force=True)
check("FORCE: a forced recheck does call the model", stub.calls == 1)
check("FORCE: it still does not duplicate the link", len(rest.links) == 1)
check("FORCE: it still does not duplicate the check", len(rest.checks) == 1)

# A newer register edition makes the conclusion stale again.
rest.imports.insert(0, {"id": "import-2", "status": "success"})
stub = StubAnthropic(MATCH)
stats = run(rest, ["co-6"], stub)
check("REFRESH: a newer register edition reopens the question", stub.calls == 1)
check("REFRESH: the check is re-pinned to the new edition",
      rest.checks[0]["register_import_id"] == "import-2")
check("REFRESH: still no duplicates",
      len(rest.links) == 1 and len(rest.checks) == 1)

# ---------------------------------------------------------------------------
# 6. The crawl survives a sponsorship failure.
# ---------------------------------------------------------------------------
from app.crawler import pipeline  # noqa: E402


class ExplodingSettings:
    anthropic_api_key = "k"
    supabase_url = "https://example.supabase.co"
    supabase_service_role_key = "k"
    sponsor_resolver_model = "claude-opus-5"
    request_timeout = 5.0
    sponsor_resolve_concurrency = 2
    sponsor_resolve_max_per_crawl = 10


original_settings = pipeline.get_settings
pipeline.get_settings = lambda: ExplodingSettings()  # type: ignore[assignment]
try:
    # A total failure of the sponsorship path — not even a client can be built.
    import app.sponsors.worker as worker_module

    original_resolve = worker_module.resolve_companies

    async def exploding(*args, **kwargs):
        raise RuntimeError("sponsorship subsystem is down")

    worker_module.resolve_companies = exploding  # type: ignore[assignment]
    try:
        asyncio.run(pipeline._resolve_sponsorship(["co-1", "co-2"]))
        survived = True
    except Exception:
        survived = False
    finally:
        worker_module.resolve_companies = original_resolve  # type: ignore[assignment]
finally:
    pipeline.get_settings = original_settings  # type: ignore[assignment]

def finalize_precedes_sponsorship() -> bool:
    """The hook must be called after `_finalize`, outside the crawl's wait_for."""
    import inspect

    source = inspect.getsource(pipeline.run_crawl)
    return (
        source.index("_finalize(") < source.index("_resolve_sponsorship(")
        and source.index("asyncio.wait_for(") < source.index("_resolve_sponsorship(")
    )


check("CRAWL ISOLATION: a failing sponsorship hook never raises", survived)
check("CRAWL ISOLATION: the hook is a no-op with no companies",
      asyncio.run(pipeline._resolve_sponsorship([])) is None)
check("CRAWL ISOLATION: the hook runs after _finalize and outside the crawl timeout",
      finalize_precedes_sponsorship())
check("CRAWL ISOLATION: affected company ids reach the hook",
      "affected_company_ids" in CrawlStats().__dict__)

# ---------------------------------------------------------------------------
# 7. Many companies resolve without concurrent overload.
# ---------------------------------------------------------------------------
companies = [company(f"co-b{i}") for i in range(20)]
rest = FakeRest(companies)
stub = StubAnthropic(MATCH)
stats = run(rest, [c["id"] for c in companies], stub, concurrency=3, max_companies=50)
check("BATCH: every company is resolved", stats.resolved == 20, f"got {stats.as_dict()}")
check("BATCH: in-flight model requests never exceed the cap",
      stub.peak_in_flight <= 3, f"peak was {stub.peak_in_flight}")
check("BATCH: 20 companies did not open 20 simultaneous requests",
      stub.peak_in_flight < 20)
check("BATCH: one link per company", len(rest.links) == 20)
check("BATCH: one check per company", len(rest.checks) == 20)

rest = FakeRest([company(f"co-c{i}") for i in range(20)])
stub = StubAnthropic(MATCH)
stats = run(rest, [f"co-c{i}" for i in range(20)], stub, max_companies=5)
check("BATCH: the per-run ceiling is honoured", stats.resolved == 5, f"got {stats.resolved}")
check("BATCH: the default concurrency is conservative", DEFAULT_CONCURRENCY <= 5)

# One failure must not stop the rest of the batch.
class SometimesFails(StubAnthropic):
    """Fails for one identifiable company. The prompt carries the company's
    name, not its id, so the name is what the stub keys on."""

    def create(self, **kwargs):
        if "Acme Fintech Doomed" in kwargs["messages"][0]["content"]:
            raise BadRequest("nope")
        return super().create(**kwargs)


batch = [company(f"co-d{i}") for i in range(6)]
batch[3]["name"] = "Acme Fintech Doomed"
rest = FakeRest(batch)
stub = SometimesFails(MATCH)
stats = run(rest, [f"co-d{i}" for i in range(6)], stub)
check("BATCH: one company's failure does not stop the others",
      stats.resolved == 5 and stats.failed == 1, f"got {stats.as_dict()}")

# ---------------------------------------------------------------------------
# 8. Empty register — "not checked", never "not a sponsor".
# ---------------------------------------------------------------------------
rest = FakeRest([company("co-e1"), company("co-e2")], licences=[])
rest.imports = []  # no register has ever been imported successfully
stub = StubAnthropic(MATCH)
stats = run(rest, ["co-e1", "co-e2"], stub)

check("EMPTY REGISTER: the model is never called", stub.calls == 0, f"got {stub.calls}")
check("EMPTY REGISTER: no sponsorship rows are written", rest.links == [])
check("EMPTY REGISTER: no no_match check rows are written", rest.checks == [],
      f"got {rest.checks}")
check("EMPTY REGISTER: no check rows of any kind are written", len(rest.checks) == 0)
check("EMPTY REGISTER: the batch reports why it skipped",
      stats.skipped_reason == "no_register_imported", f"got {stats.skipped_reason}")
check("EMPTY REGISTER: nothing is counted as resolved",
      stats.resolved == 0 and stats.no_match == 0 and stats.failed == 0,
      f"got {stats.as_dict()}")

# A register with rows but no *successful* import row is still not a register.
rest.licences = [LICENCE]
rest.imports = [{"id": "import-x", "status": "error"}]
stub = StubAnthropic(MATCH)
stats = run(rest, ["co-e1"], stub)
check("EMPTY REGISTER: a failed import does not count as an edition",
      stub.calls == 0 and rest.checks == [])

# After a successful import the same company resolves normally.
rest.imports = [{"id": "import-1", "status": "success"}]
stub = StubAnthropic(MATCH)
stats = run(rest, ["co-e1"], stub)
check("AFTER IMPORT: the same company becomes eligible",
      stub.calls == 1 and stats.matched == 1, f"got {stats.as_dict()}")
check("AFTER IMPORT: the check is written and pinned to the edition",
      rest.checks[0]["register_import_id"] == "import-1")

# ---------------------------------------------------------------------------
# 9. Cumulative retry cap across runs.
# ---------------------------------------------------------------------------
rest = FakeRest([company("co-f1")])
crawl_calls = []
for crawl in ("A", "B", "C"):
    stub = StubAnthropic(error=RateLimited("slow down"))
    run(rest, ["co-f1"], stub)
    crawl_calls.append(stub.calls)

check("RETRY CAP: each crawl spends the per-run limit",
      crawl_calls == [MAX_ATTEMPTS] * 3, f"got {crawl_calls}")
check("RETRY CAP: failed attempts accumulate across crawls",
      rest.checks[0]["attempts"] == MAX_CUMULATIVE_ATTEMPTS,
      f"got {rest.checks[0]['attempts']}")
check("RETRY CAP: the company is still in error state",
      rest.checks[0]["last_decision"] == "error")

stub_d = StubAnthropic(error=RateLimited("slow down"))
stats = run(rest, ["co-f1"], stub_d)
check("RETRY CAP: crawl D makes ZERO automatic model calls",
      stub_d.calls == 0, f"got {stub_d.calls}")
check("RETRY CAP: the company is reported as skipped, not failed",
      stats.skipped_current == 1 and stats.failed == 0, f"got {stats.as_dict()}")

forced = StubAnthropic(MATCH)
stats = run(rest, ["co-f1"], forced, force=True)
check("RETRY CAP: force overrides the cap", forced.calls == 1, f"got {forced.calls}")
check("RETRY CAP: a conclusion clears the failure budget",
      rest.checks[0]["attempts"] == 0 and rest.checks[0]["last_decision"] == "match",
      f"got attempts={rest.checks[0]['attempts']} decision={rest.checks[0]['last_decision']}")

# A capped company is reopened by a new register edition.
rest2 = FakeRest([company("co-f2")])
for _ in range(3):
    run(rest2, ["co-f2"], StubAnthropic(error=RateLimited("slow")))
check("RETRY CAP: co-f2 is capped", rest2.checks[0]["attempts"] == MAX_CUMULATIVE_ATTEMPTS)
blocked = StubAnthropic(MATCH)
run(rest2, ["co-f2"], blocked)
check("RETRY CAP: capped company is not auto-enqueued", blocked.calls == 0)

rest2.imports.insert(0, {"id": "import-2", "status": "success"})
reopened = StubAnthropic(MATCH)
stats = run(rest2, ["co-f2"], reopened)
check("NEW EDITION: a capped company is reopened", reopened.calls == 1,
      f"got {reopened.calls}")
check("NEW EDITION: the budget starts fresh against the new edition",
      rest2.checks[0]["attempts"] == 0
      and rest2.checks[0]["register_import_id"] == "import-2",
      f"got {rest2.checks[0]}")

# A failure that never reached the model must not consume the budget.
class BrokenRest(FakeRest):
    async def select(self, client, table, params=None, timeout=None):
        if table == "sponsor_licences":
            raise RuntimeError("database unavailable")
        return await super().select(client, table, params)


rest3 = BrokenRest([company("co-g1")])
stub = StubAnthropic(MATCH)
stats = run(rest3, ["co-g1"], stub)
check("BUDGET: a database failure is recorded as error", stats.failed == 1)
check("BUDGET: a failure that never reached the model costs no budget",
      rest3.checks[0]["attempts"] == 0, f"got {rest3.checks[0]['attempts']}")
check("BUDGET: and the model really was not called", stub.calls == 0)

# PostgREST returns at most 1000 rows per request whatever `limit` asks for;
# the backfill must page past that or it only ever sees the newest 1000.
class CappedRest(FakeRest):
    async def select(self, client, table, params=None, timeout=None):
        if table == "companies" and "id" not in (params or {}):
            start = int(params.get("offset", "0"))
            end = start + min(int(params.get("limit", "1000")), 1000)
            return [{"id": c["id"]} for c in self.companies[start:end]]
        return await super().select(client, table, params)


from app.sponsors.service import companies_needing_resolution  # noqa: E402

capped = CappedRest([company(f"co-p{i}") for i in range(2500)])
pending = asyncio.run(
    companies_needing_resolution(None, capped, limit=8000, current_import="import-1")
)
check("PAGING: every unchecked company past the 1000-row cap is found",
      len(pending) == 2500 and len(set(pending)) == 2500, f"got {len(pending)}")

print()
if _failures:
    print(f"{len(_failures)} FAILED:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL SPONSORSHIP WORKER TESTS PASSED")
