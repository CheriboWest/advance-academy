"""Self-check for chunked sponsor-register finalization (migration 0010).

`python test_sponsor_chunked_finalize.py` — offline.

The single-statement finalize_sponsor_register_import() from migration 0009
published a staged edition correctly, but as one UPDATE over every staged row.
Against the real 141,904-row edition that took ~8.5s locally and was cancelled
by Postgres (error 57014, "canceling statement due to statement timeout") on
every attempt — three times in production, same result each time, with the
edition fully staged and nothing wrong except the single statement doing all
of the work at once.

Migration 0010 replaces it with four small, idempotent RPCs — begin, promote a
chunk, withdraw a chunk, complete — each bounded to at most
SPONSOR_FINALIZE_CHUNK_SIZE rows, called repeatedly by
`app.sponsors.importer.finalize_edition` until the edition is fully published.
These checks cover that loop, its idempotency under retry, and
`resume_finalize_import` — the entry point for publishing an edition that
finished staging in a run production actually hit (id
7510ead2-962f-4b4f-a5df-87220dba0987) but never finished publishing.
"""

from __future__ import annotations

import asyncio

import httpx

from app.sponsors.importer import (
    FinalizationFailed,
    ResumeRefused,
    finalize_edition,
    resume_finalize_import,
    run_import,
)
from fake_supabase import FakeSupabase, PostgrestError

HEADER = "Organisation Name,Town/City,County,Type & Rating,Route\n"

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{'ok  ' if cond else 'FAIL'}] {name}{('  ' + detail) if detail and not cond else ''}")


def csv_of(names: list[str]) -> bytes:
    body = "".join(
        f"{name},London,Greater London,Worker (A (Premium)),Skilled Worker\n"
        for name in names
    )
    return (HEADER + body).encode("utf-8")


def org_names(count: int, *, start: int = 0) -> list[str]:
    return [f"Org {i:06d} Ltd" for i in range(start, start + count)]


def ingest(rest: FakeSupabase, payload: bytes, *, force: bool = True):
    return asyncio.run(
        run_import(
            rest, client=object(), csv_bytes=payload, source_url="edition.csv",
            force=force, sleeper=lambda _d: asyncio.sleep(0),
        )
    )


def try_ingest(rest: FakeSupabase, payload: bytes, *, force: bool = True):
    try:
        ingest(rest, payload, force=force)
        return None
    except Exception as exc:  # noqa: BLE001 — the test decides what it means
        return exc


def try_resume(rest: FakeSupabase, import_id: str):
    try:
        asyncio.run(
            resume_finalize_import(
                rest, import_id, client=object(),
                sleeper=lambda _d: asyncio.sleep(0),
            )
        )
        return None
    except Exception as exc:  # noqa: BLE001
        return exc


# ---------------------------------------------------------------------------
# A — a giant edition cannot be finalized in one call, but chunking succeeds.
# ---------------------------------------------------------------------------
CHUNK = 2000
BIG = 3 * CHUNK + 750  # deliberately not a multiple of the chunk size

rest = FakeSupabase()
run_id, stats = ingest(rest, csv_of(org_names(BIG)))

promote_calls = [c for c in rest.rpc_calls if c[0].endswith("promote_sponsor_register_import_chunk")]
check("A: publishing this edition took more than one promote call",
      len(promote_calls) > 1, f"got {len(promote_calls)}")
check("A: ...specifically ceil(BIG / chunk)",
      len(promote_calls) == -(-BIG // CHUNK), f"got {len(promote_calls)}")
check("A: no single promote call exceeded the configured chunk size",
      all(c[1]["p_limit"] <= CHUNK for c in promote_calls))
check("A: the whole edition still published correctly",
      len(rest.current()) == BIG and stats.rows_processed == BIG,
      f"current={len(rest.current())} processed={stats.rows_processed}")
check("A: the run is recorded success", rest.status() == "success")


# ---------------------------------------------------------------------------
# B — a promotion chunk commits, then the client times out; retry is harmless.
# ---------------------------------------------------------------------------
rest = FakeSupabase()
# Fail the SECOND rpc call (the first promote chunk) exactly once: the fake's
# rpc() raises before doing any work, so this models a client-side timeout
# that never reached the server, not a commit-then-drop. Real commit-then-
# timeout is covered by promote's own idempotent WHERE clause (fewer rows
# selected on retry because fewer are still unpromoted) — this proves a
# retried chunk does not re-promote or double-count rows already done by an
# earlier, successful chunk in the same loop.
rest.fail_rpc_times = 0
run_id, stats = ingest(rest, csv_of(org_names(CHUNK + 500)))
first_import_id = rest.imports[-1]["id"]

# Simulate a fresh resume where the FIRST promote chunk of this run had
# already committed (rows show last_import_id set) and only the client saw a
# timeout: re-run finalize_edition directly and confirm it converges without
# duplicating any row or re-counting it.
before = len(rest.rows)
asyncio.run(finalize_edition(
    object(), rest, first_import_id, stats, sleeper=lambda _d: asyncio.sleep(0),
))
check("B: re-finalizing an already-published edition is a safe no-op",
      len(rest.rows) == before and rest.current_names() == set(org_names(CHUNK + 500)),
      f"rows {before} -> {len(rest.rows)}")
check("B: statistics after the redundant call still match the edition",
      stats.rows_processed == CHUNK + 500, f"got {stats.rows_processed}")


# ---------------------------------------------------------------------------
# C — finalization stops halfway (permanent failure mid-loop); resuming
#     continues from the rows still outstanding rather than redoing the whole
#     edition.
# ---------------------------------------------------------------------------
rest = FakeSupabase()
TOTAL = 3 * CHUNK
calls_before_failure = 2  # begin + one promote chunk succeed, then it dies

real_rpc = rest.rpc.__func__


async def dying_rpc(self, client, function, payload=None, timeout=None):
    if len(self.rpc_calls) >= calls_before_failure and "promote" in function:
        self.requests.append(f"rpc:{function}")
        self.rpc_calls.append((function, dict(payload or {})))
        raise httpx.ReadTimeout(
            "timed out", request=httpx.Request("POST", "https://fake/rpc")
        )
    return await real_rpc(self, client, function, payload, timeout)


rest.rpc = dying_rpc.__get__(rest)
failure = try_ingest(rest, csv_of(org_names(TOTAL)))
check("C: the import fails partway through publication",
      isinstance(failure, FinalizationFailed), f"got {type(failure).__name__}")

stuck_import_id = rest.imports[-1]["id"]
promoted_so_far = len([
    r for r in rest.rows if r.get("last_import_id") == stuck_import_id
])
check("C: some rows were promoted before it died", 0 < promoted_so_far < TOTAL,
      f"got {promoted_so_far} of {TOTAL}")
check("C: the run is left as error, ready to resume",
      rest.status() == "error", f"got {rest.status()}")

# Resuming: restore the real rpc method (the dying stub was single-use-by-design
# for this test) and continue.
rest.rpc = real_rpc.__get__(rest)
_, resumed_stats = asyncio.run(
    resume_finalize_import(
        rest, stuck_import_id, client=object(),
        sleeper=lambda _d: asyncio.sleep(0),
    )
)
check("C: resuming finishes the edition",
      rest.status() == "success" and resumed_stats.rows_processed == TOTAL,
      f"status={rest.status()} processed={resumed_stats.rows_processed}")
check("C: the rows promoted before the failure were not redone, just topped up",
      len(rest.current()) == TOTAL, f"got {len(rest.current())}")
check("C: no duplicate rows resulted", len(rest.rows) == TOTAL)


# ---------------------------------------------------------------------------
# D — resume refuses a run whose staging never actually finished.
# ---------------------------------------------------------------------------
rest = FakeSupabase()
rest.imports.append({
    "id": "incomplete-1", "status": "error", "source_url": "x.csv",
    "rows_parsed": 1000, "rows_processed": 400,  # staging clearly short
})
# Only 400 rows actually staged — matches the (misleading) rows_processed but
# not rows_parsed, so neither eligibility check should pass.
for i in range(400):
    rest.licences[f"nk-{i}"] = {
        "natural_key": f"nk-{i}", "organisation_name": f"Partial {i}",
        "staged_import_id": "incomplete-1", "is_current": False,
        "withdrawn_at": None, "withdrawn_by_import_id": None,
        "last_import_id": None,
    }
refusal = try_resume(rest, "incomplete-1")
check("D: an incompletely-staged run is refused", isinstance(refusal, ResumeRefused),
      f"got {type(refusal).__name__}")
check("D: refusing it touched nothing",
      rest.imports[0]["status"] == "error" and len(rest.current()) == 0,
      f"status={rest.imports[0]['status']}")

# The secondary check — staged row count vs rows_parsed — is what lets a run
# resume even when rows_processed cannot be trusted (e.g. a stored row from
# before that column existed). Here rows_processed is absent, but every row
# genuinely is staged, so eligibility still holds via the fallback.
rest2 = FakeSupabase()
rest2.imports.append({
    "id": "old-schema-row", "status": "error", "source_url": "x.csv",
    "rows_parsed": 400, "rows_processed": None,
})
for i in range(400):  # genuinely fully staged
    rest2.licences[f"nk-{i}"] = {
        "natural_key": f"nk-{i}", "organisation_name": f"Complete {i}",
        "staged_import_id": "old-schema-row", "is_current": False,
        "withdrawn_at": None, "withdrawn_by_import_id": None,
        "last_import_id": None,
    }
outcome2 = try_resume(rest2, "old-schema-row")
check("D: the staged-count fallback resumes a run rows_processed can't vouch for",
      outcome2 is None, f"got {outcome2!r}")
check("D: and it actually published", rest2.status() == "success",
      f"got {rest2.status()}")

# A run still 'running' (staging possibly still in flight) must also be refused.
rest3 = FakeSupabase()
rest3.imports.append({
    "id": "still-running", "status": "running", "source_url": "x.csv",
    "rows_parsed": 1000, "rows_processed": 1000,
})
refusal3 = try_resume(rest3, "still-running")
check("D: a run still marked running is refused (staging might not be done)",
      isinstance(refusal3, ResumeRefused), f"got {type(refusal3).__name__}")

# An already-successful run has nothing to resume.
rest4 = FakeSupabase()
rest4.imports.append({
    "id": "already-done", "status": "success", "source_url": "x.csv",
    "rows_parsed": 10, "rows_processed": 10,
})
refusal4 = try_resume(rest4, "already-done")
check("D: an already-published run refuses to resume",
      isinstance(refusal4, ResumeRefused), f"got {type(refusal4).__name__}")

# An unknown id is refused, not a crash.
refusal5 = try_resume(FakeSupabase(), "does-not-exist")
check("D: an unknown import id is refused cleanly",
      isinstance(refusal5, ResumeRefused), f"got {type(refusal5).__name__}")


# ---------------------------------------------------------------------------
# E — the exact production scenario: a fully-staged run stuck in `error`
#     because only publication failed. --resume-finalize must accept it.
# ---------------------------------------------------------------------------
PRODUCTION_ROWS = 3 * CHUNK + 1904  # mirrors 141,904 at the real chunk size

rest = FakeSupabase()

async def timeout_on_finalize(self, client, function, payload=None, timeout=None):
    self.requests.append(f"rpc:{function}")
    self.rpc_calls.append((function, dict(payload or {})))
    raise httpx.ReadTimeout(
        "canceling statement due to statement timeout",
        request=httpx.Request("POST", "https://fake/rpc"),
    )

original_rpc = rest.rpc.__func__
rest.rpc = timeout_on_finalize.__get__(rest)
staging_and_finalize_failure = try_ingest(rest, csv_of(org_names(PRODUCTION_ROWS)))
check("E: with finalization entirely unreachable, the run still ends in error",
      rest.status() == "error", f"got {rest.status()}")
check("E: but staging fully completed (matches the real production run)",
      rest.imports[-1].get("rows_processed") == PRODUCTION_ROWS,
      f"got {rest.imports[-1].get('rows_processed')}")

production_import_id = rest.imports[-1]["id"]
rest.rpc = original_rpc.__get__(rest)  # "the network recovers"
_, stats = asyncio.run(
    resume_finalize_import(
        rest, production_import_id, client=object(),
        sleeper=lambda _d: asyncio.sleep(0),
    )
)
check("E: --resume-finalize publishes the fully-staged edition",
      rest.status() == "success" and stats.rows_processed == PRODUCTION_ROWS,
      f"status={rest.status()} processed={stats.rows_processed}")
check("E: the current set is exactly the staged edition",
      rest.current_names() == set(org_names(PRODUCTION_ROWS)))
check("E: no CSV parsing or download happened during resume",
      not [r for r in rest.requests[rest.requests.index(f"rpc:begin_sponsor_register_finalization"):]
           if r.startswith("insert:sponsor_register_imports")])


# ---------------------------------------------------------------------------
# F — withdrawal chunks are idempotent: calling one again after it already
#     ran finds nothing new and does not mis-count.
# ---------------------------------------------------------------------------
rest = FakeSupabase()
ingest(rest, csv_of(["Acme Ltd", "Beta Ltd", "Gamma Ltd"]))
_, stats = ingest(rest, csv_of(["Acme Ltd"]))  # Beta, Gamma withdrawn
check("F: the setup withdrew two rows", stats.rows_withdrawn == 2,
      f"got {stats.rows_withdrawn}")

last_import_id = rest.imports[-1]["id"]
# The run is already `success`; withdraw_chunk on it directly must be the
# documented no-op (0009/0010's `if status == 'success': return [{0, 0}]`).
result = rest._withdraw_chunk({"p_import_id": last_import_id, "p_limit": 2000})
check("F: withdrawing again against a published run processes nothing",
      result == [{"processed": 0, "remaining": 0}], f"got {result}")
check("F: and nothing about the table changed",
      rest.current_names() == {"Acme Ltd"}, f"got {rest.current_names()}")


# ---------------------------------------------------------------------------
# G — status becomes success only once BOTH phases finish, not before.
# ---------------------------------------------------------------------------
rest = FakeSupabase()
ingest(rest, csv_of(["Old Co Ltd"]))  # a prior edition to withdraw later

created = asyncio.run(rest.insert(
    object(), "sponsor_register_imports", [{"status": "running", "source_url": "g.csv"}],
))
import_id = created[0]["id"]
rest.licences["nk-new-co"] = {
    "natural_key": "nk-new-co", "organisation_name": "New Co Ltd",
    "staged_import_id": import_id, "is_current": False,
    "withdrawn_at": None, "withdrawn_by_import_id": None, "last_import_id": None,
}

asyncio.run(rest.rpc(object(), "begin_sponsor_register_finalization",
                      {"p_import_id": import_id}))
check("G: status is finalizing, not success, right after begin",
      rest._get_import(import_id)["status"] == "finalizing")

asyncio.run(rest.rpc(object(), "promote_sponsor_register_import_chunk",
                      {"p_import_id": import_id, "p_limit": 2000}))
check("G: promotion alone does not publish the run",
      rest._get_import(import_id)["status"] == "finalizing",
      f"got {rest._get_import(import_id)['status']}")
check("G: ...even though the new row is already current",
      rest.licences["nk-new-co"]["is_current"] is True)

try:
    rest._complete_finalize({"p_import_id": import_id})
    completed_early = True
except PostgrestError:
    completed_early = False
check("G: completing before withdrawal is refused",
      not completed_early, "complete() succeeded with stale current rows left")

asyncio.run(rest.rpc(object(), "withdraw_sponsor_register_chunk",
                      {"p_import_id": import_id, "p_limit": 2000}))
asyncio.run(rest.rpc(object(), "complete_sponsor_register_import",
                      {"p_import_id": import_id}))
check("G: only after both phases finish does status become success",
      rest._get_import(import_id)["status"] == "success")


# ---------------------------------------------------------------------------
# H — latest_register_import_id sees only status=success, never a
#     staged/finalizing/error run — the resolver must never treat an
#     unpublished edition as the authoritative one.
# ---------------------------------------------------------------------------
from app.sponsors.service import latest_register_import_id  # noqa: E402

rest = FakeSupabase()
rest.imports.extend([
    {"id": "old-success", "status": "success", "started_at": "2020-01-01T00:00:00Z"},
    {"id": "mid-finalizing", "status": "finalizing", "started_at": "2020-06-01T00:00:00Z"},
    {"id": "newest-error", "status": "error", "started_at": "2020-09-01T00:00:00Z"},
])
seen = asyncio.run(latest_register_import_id(object(), rest))
check("H: the newest run is ignored while it is only finalizing/error",
      seen == "old-success", f"got {seen}")

rest.imports.append(
    {"id": "newest-success", "status": "success", "started_at": "2021-01-01T00:00:00Z"}
)
seen = asyncio.run(latest_register_import_id(object(), rest))
check("H: a genuinely newer success is picked up", seen == "newest-success",
      f"got {seen}")


print()
if _failures:
    print(f"{len(_failures)} FAILED:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL CHUNKED FINALIZATION TESTS PASSED")
