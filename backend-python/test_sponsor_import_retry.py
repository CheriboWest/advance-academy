"""Self-check for sponsor-register bulk-import reliability.

`python test_sponsor_import_retry.py` — offline.

The real import of 141,904 rows died on `httpx.ReadTimeout` during a later
batch: every request used the 15-second interactive default, and a 500-row
upsert into a six-figure table with a unique index outgrew it. These checks
cover the retry, the idempotent resume, and the property that matters most —
a partial import never withdraws anything.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

import httpx

from fake_supabase import FakeSupabase
from app.sponsors.importer import (
    BATCH_MAX_ATTEMPTS,
    IMPORT_REQUEST_TIMEOUT,
    UPSERT_CHUNK,
    run_import,
)

HEADER = "Organisation Name,Town/City,County,Type & Rating,Route\n"

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


def csv_of(rows: int, *, prefix: str = "Org") -> bytes:
    body = "".join(
        f"{prefix} {i} Ltd,London,Greater London,Worker (A rating),Skilled Worker\n"
        for i in range(rows)
    )
    return (HEADER + body).encode("utf-8")


def timeout_error() -> httpx.ReadTimeout:
    return httpx.ReadTimeout("timed out", request=httpx.Request("POST", "https://x/y"))


class FakeRest(FakeSupabase):
    """The shared double, plus a batch-numbered fail plan.

    `fail_plan` maps a 1-based batch number to how many consecutive times that
    batch raises before succeeding. Splitting re-sends subsets of a batch, so a
    plan keyed this way fails a batch and every chunk it is narrowed into —
    which is what these checks want.
    """

    def __init__(self, fail_plan: Optional[dict[int, int]] = None,
                 error_factory: Any = timeout_error) -> None:
        super().__init__()
        self.fail_plan = dict(fail_plan or {})
        self.error_factory = error_factory
        self.batch_no = 0
        self.timeouts_raised = 0
        self.committed_despite_timeout = False

    async def upsert(self, client, table, rows, on_conflict, prefer="", timeout=None):
        self.batch_no += 1
        remaining = self.fail_plan.get(self.batch_no, 0)
        if remaining:
            self.fail_plan[self.batch_no] = remaining - 1
            self.timeouts_raised += 1
            # A timeout does not prove the server discarded the write. Commit
            # the rows anyway on the first failure, so the retry has to be
            # genuinely idempotent rather than merely lucky.
            if not self.committed_despite_timeout:
                self.committed_despite_timeout = True
                self._apply(rows)
            self.batch_no -= 1  # the retry re-sends this same batch
            self.write_timeouts.append(timeout)
            raise self.error_factory()
        return await super().upsert(
            client, table, rows, on_conflict, prefer=prefer, timeout=timeout
        )


def ingest(rest: FakeRest, payload: bytes, force: bool = True):
    return asyncio.run(
        run_import(
            rest, client=object(), csv_bytes=payload, source_url="edition-A.csv",
            force=force, sleeper=lambda _d: asyncio.sleep(0),
        )
    )


def current_rows(rest: FakeRest) -> int:
    return len(rest.current())


# ---------------------------------------------------------------------------
# Settings the failure pointed at.
# ---------------------------------------------------------------------------
check("batch size is a few hundred, not thousands", 100 <= UPSERT_CHUNK <= 500,
      f"got {UPSERT_CHUNK}")
check("batch size is not one row per request", UPSERT_CHUNK > 1)
check("bulk writes get their own, longer timeout", IMPORT_REQUEST_TIMEOUT >= 60,
      f"got {IMPORT_REQUEST_TIMEOUT}")

rest = FakeRest()
ingest(rest, csv_of(600))
check("every bulk write carries the import timeout",
      all(t == IMPORT_REQUEST_TIMEOUT for t in rest.write_timeouts),
      f"got {set(rest.write_timeouts)}")
check("the interactive default is untouched elsewhere",
      __import__("inspect").signature(
          __import__("app.crawler.supabase_rest", fromlist=["SupabaseRest"])
          .SupabaseRest.__init__).parameters["timeout"].default == 15.0)

# ---------------------------------------------------------------------------
# Scenario 1 — batch 3 times out once, then succeeds.
# ---------------------------------------------------------------------------
ROWS = 5 * UPSERT_CHUNK  # five batches
rest = FakeRest(fail_plan={3: 1})
run_id, stats = ingest(rest, csv_of(ROWS))

check("SCENARIO 1: the import reports success",
      rest.imports[-1]["status"] == "success", f"got {rest.imports[-1]['status']}")
check("SCENARIO 1: a timeout really was raised", rest.timeouts_raised == 1)
check("SCENARIO 1: every row is stored", current_rows(rest) == ROWS,
      f"got {current_rows(rest)}")
check("SCENARIO 1: no duplicate natural keys",
      len(rest.rows) == len({r["natural_key"] for r in rest.rows}) == ROWS)
check("SCENARIO 1: the retried batch was not double-counted",
      stats.rows_processed == ROWS, f"got {stats.rows_processed}")
check("SCENARIO 1: nothing was withdrawn", stats.rows_withdrawn == 0)
check("SCENARIO 1: the run's statistics were persisted",
      rest.imports[-1]["rows_processed"] == ROWS,
      f"got {rest.imports[-1].get('rows_processed')}")

# The timed-out batch had in fact committed server-side; the retry must not
# have duplicated it.
check("SCENARIO 1: a batch that committed despite timing out is not duplicated",
      rest.committed_despite_timeout and current_rows(rest) == ROWS)

# ---------------------------------------------------------------------------
# Scenario 2 — a batch times out past the retry limit.
# ---------------------------------------------------------------------------
rest = FakeRest(fail_plan={3: 99})
try:
    ingest(rest, csv_of(ROWS))
    raised = False
except httpx.ReadTimeout:
    raised = True

check("SCENARIO 2: the import fails", raised)
# The fail plan is keyed on the batch, so batch 3 and every chunk it is split
# into fail: the retry budget is spent, then the halves are tried and fail too,
# all the way down to the split floor. Splitting itself is covered in
# test_sponsor_import_split.py; what matters here is that the full retry budget
# came first and that the import still ends up refusing to continue.
check("SCENARIO 2: the batch got its whole retry budget, then was narrowed",
      rest.timeouts_raised > BATCH_MAX_ATTEMPTS, f"got {rest.timeouts_raised}")
check("SCENARIO 2: the run is marked error",
      rest.imports[-1]["status"] == "error", f"got {rest.imports[-1]['status']}")
check("SCENARIO 2: the error detail is kept",
      "ReadTimeout" in (rest.imports[-1].get("error") or ""),
      f"got {rest.imports[-1].get('error')}")
partial = len(rest.rows)
check("SCENARIO 2: earlier batches remain in the database, staged", partial > 0,
      f"got {partial}")
check("SCENARIO 2: but nothing the failed run staged is live",
      current_rows(rest) == 0, f"got {current_rows(rest)}")
check("SCENARIO 2: NOTHING was withdrawn",
      not [r for r in rest.rows if r.get("withdrawn_at")])
check("SCENARIO 2: the failed run is not the latest successful edition",
      not [i for i in rest.imports if i.get("status") == "success"])
check("SCENARIO 2: statistics were not claimed for an unpublished edition",
      (rest.imports[-1].get("rows_current_after") or 0) == 0,
      f"got {rest.imports[-1].get('rows_current_after')}")

# ---------------------------------------------------------------------------
# Scenario 3 — rerunning the same file after a partial import.
# ---------------------------------------------------------------------------
rest.fail_plan = {}          # the transient condition has passed
rest.batch_no = 0
run_id, stats = ingest(rest, csv_of(ROWS))

check("RESUME: the rerun succeeds", rest.imports[-1]["status"] == "success")
check("RESUME: no manual cleanup was needed — the partial rows were reused",
      current_rows(rest) == ROWS, f"got {current_rows(rest)}")
check("RESUME: no duplicates after the rerun", len(rest.rows) == ROWS)
check("RESUME: the rows the failed attempt staged were reused, not re-created",
      len(rest.rows) == ROWS, f"staged {partial}, now {len(rest.rows)}")
check("RESUME: the whole edition is published",
      stats.rows_processed == ROWS, f"got {stats.rows_processed}")
check("RESUME: still nothing withdrawn", stats.rows_withdrawn == 0)

# ---------------------------------------------------------------------------
# A permanent error is not retried.
# ---------------------------------------------------------------------------
def bad_request() -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://x/y")
    return httpx.HTTPStatusError(
        "bad", request=request, response=httpx.Response(400, request=request)
    )


rest = FakeRest(fail_plan={2: 99}, error_factory=bad_request)
try:
    ingest(rest, csv_of(ROWS))
    raised4 = False
except httpx.HTTPStatusError:
    raised4 = True
check("PERMANENT ERROR: a 400 fails the import", raised4)
check("PERMANENT ERROR: it is attempted once, not retried",
      rest.timeouts_raised == 1, f"got {rest.timeouts_raised}")
check("PERMANENT ERROR: nothing is withdrawn",
      not [r for r in rest.rows if r.get("withdrawn_at")])

# A 503 is retried.
def unavailable() -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://x/y")
    return httpx.HTTPStatusError(
        "down", request=request, response=httpx.Response(503, request=request)
    )


rest = FakeRest(fail_plan={2: 1}, error_factory=unavailable)
ingest(rest, csv_of(ROWS))
check("TRANSIENT STATUS: a 503 is retried and the import completes",
      rest.imports[-1]["status"] == "success" and current_rows(rest) == ROWS)

# ---------------------------------------------------------------------------
# A later edition still withdraws correctly once it completes.
# ---------------------------------------------------------------------------
rest = FakeRest()
ingest(rest, csv_of(3 * UPSERT_CHUNK))
_, stats = ingest(rest, csv_of(2 * UPSERT_CHUNK))
check("WITHDRAWAL: a complete smaller edition does withdraw the difference",
      stats.rows_withdrawn == UPSERT_CHUNK, f"got {stats.rows_withdrawn}")
check("WITHDRAWAL: withdrawn rows are kept, not deleted",
      len(rest.rows) == 3 * UPSERT_CHUNK)

print()
if _failures:
    print(f"{len(_failures)} FAILED:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL SPONSOR IMPORT RETRY TESTS PASSED")
