"""An in-memory stand-in for Supabase, shared by the sponsor-import self-checks.

Shared on purpose. These tests turn on properties the database enforces — the
unique index on `natural_key`, PostgREST updating only the columns a payload
carries, `is_current` defaulting to false since migration 0009, and the four
chunked finalization functions from migration 0010 (begin / promote / withdraw
/ complete). A double that drifts from any of those turns a test suite into a
suite of reassurances, which is exactly how earlier bugs here survived their
tests.

The RPC dispatch mirrors `supabase/migrations/033_ch0010_...sql` function for
function — including its status-transition guards (finalizing-only, refuse an
empty stage, refuse withdrawal before promotion is complete) and its
idempotent early-returns on an already-`success` import. Change one and change
the other.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Optional

import httpx

LICENCES = "sponsor_licences"
IMPORTS = "sponsor_register_imports"
BEGIN_FINALIZE = "begin_sponsor_register_finalization"
PROMOTE_CHUNK = "promote_sponsor_register_import_chunk"
WITHDRAW_CHUNK = "withdraw_sponsor_register_chunk"
COMPLETE_FINALIZE = "complete_sponsor_register_import"

# Column defaults `sponsor_licences` applies to a row PostgREST inserts without
# them. `is_current` is false as of 0009: a row is not live until an import
# finishes.
_INSERT_DEFAULTS = {
    "is_current": False,
    "withdrawn_at": None,
    "withdrawn_by_import_id": None,
    "staged_import_id": None,
    "staged_seen_at": None,
    "last_import_id": None,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PostgrestError(httpx.HTTPStatusError):
    """What PostgREST returns when a plpgsql RAISE reaches it: a 4xx, not a crash."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        request = httpx.Request("POST", "https://fake/rest/v1/rpc")
        super().__init__(
            message,
            request=request,
            response=httpx.Response(status_code, request=request, text=message),
        )


class FakeSupabase:
    """Enough of PostgREST and the sponsor schema to test the import path."""

    def __init__(self, rows: Optional[list[dict]] = None) -> None:
        self.licences: dict[str, dict] = {}
        for row in rows or []:
            self.licences[row["natural_key"]] = {**_INSERT_DEFAULTS, **row}
        self.imports: list[dict] = []

        # Observations the tests assert on.
        self.requests: list[str] = []
        self.licence_selects: list[dict] = []
        self.upsert_sizes: list[int] = []
        self.write_timeouts: list[Optional[float]] = []
        self.rpc_calls: list[tuple[str, dict]] = []
        self.update_clients: list[Any] = []

        # Injected failure. `should_fail(rows)` decides whether an upsert
        # raises; the decision is made on the rows because a split re-sends
        # subsets and a batch number would not survive it.
        self.should_fail: Callable[[list[dict]], bool] = lambda rows: False
        self.commit_on_failure = False
        self.failures = 0
        self.rpc_failures = 0
        self.fail_rpc_times = 0
        self.error_factory: Callable[[], Exception] = lambda: httpx.ReadTimeout(
            "timed out", request=httpx.Request("POST", "https://fake/rest/v1")
        )

    # -- reads --------------------------------------------------------------
    async def select(self, client, table, params=None, timeout=None):
        params = params or {}
        self.requests.append(f"select:{table}")
        if table == IMPORTS:
            rows = list(self.imports)
            status = params.get("status")
            if status and status.startswith("eq."):
                rows = [r for r in rows if r.get("status") == status[3:]]
            if (params.get("order") or "").startswith("started_at.desc"):
                rows = list(reversed(rows))
            return [dict(r) for r in rows][: int(params.get("limit", "50"))]
        if table == LICENCES:
            # Recorded so a test can prove the importer no longer pages the
            # whole table before writing anything.
            self.licence_selects.append(dict(params))
            offset = int(params.get("offset", "0"))
            limit = int(params.get("limit", "1000"))
            ordered = sorted(self.licences.values(), key=lambda r: r["natural_key"])
            return [dict(r) for r in ordered[offset : offset + limit]]
        return []

    async def count(self, client, table, params=None, timeout=None):
        params = params or {}
        if table == LICENCES:
            rows = self.licences.values()
            if not params:
                return len([r for r in rows if r.get("is_current")])
            return len([r for r in rows if self._matches(r, params)])
        return len(self.imports)

    @staticmethod
    def _matches(row: dict, params: dict) -> bool:
        """A crude `eq.`-filter matcher, enough for what these tests send."""
        for key, value in params.items():
            if not isinstance(value, str) or not value.startswith("eq."):
                continue
            target = value[3:]
            actual = row.get(key)
            if target in ("true", "false"):
                if bool(actual) != (target == "true"):
                    return False
            elif str(actual) != target:
                return False
        return True

    # -- writes -------------------------------------------------------------
    async def insert(self, client, table, rows, prefer="return=representation",
                     timeout=None):
        self.requests.append(f"insert:{table}")
        if table == IMPORTS:
            created = [
                {**row, "id": f"import-{len(self.imports) + 1}"} for row in rows
            ]
            self.imports.extend(created)
            return created
        return rows

    async def upsert(self, client, table, rows, on_conflict, prefer="", timeout=None):
        assert table == LICENCES, table
        assert on_conflict == "natural_key", on_conflict
        assert "resolution=merge-duplicates" in prefer, prefer
        assert "return=minimal" in prefer, prefer
        # PostgREST builds one INSERT for the whole array, so every object has
        # to carry the same keys.
        shapes = {tuple(sorted(row)) for row in rows}
        assert len(shapes) <= 1, f"rows in one batch differ in shape: {shapes}"

        self.requests.append(f"upsert:{table}")
        self.upsert_sizes.append(len(rows))
        self.write_timeouts.append(timeout)

        if self.should_fail(rows):
            self.failures += 1
            if self.commit_on_failure:
                # A timeout does not prove the server discarded the write.
                self._apply(rows)
            raise self.error_factory()

        self._apply(rows)
        return []

    def _apply(self, rows: list[dict]) -> None:
        for row in rows:
            key = row["natural_key"]
            existing = self.licences.get(key)
            if existing is None:
                self.licences[key] = {
                    **_INSERT_DEFAULTS,
                    "id": f"lic-{len(self.licences) + 1}",
                    "first_seen_at": _now(),
                    "last_seen_at": _now(),
                    **row,
                }
            else:
                # ON CONFLICT DO UPDATE SET only the columns the payload
                # carries. Everything else — crucially is_current, withdrawn_at
                # and last_seen_at — is left exactly as it was.
                existing.update(row)

    async def update(self, client, table, match, values, prefer="", timeout=None):
        self.requests.append(f"update:{table}")
        self.update_clients.append(client)
        if getattr(client, "should_fail", False):
            raise self.error_factory()
        if table == IMPORTS:
            run_id = match.get("id", "").removeprefix("eq.")
            for record in self.imports:
                if record["id"] == run_id:
                    record.update(values)
        return None

    # -- chunked finalization (mirrors migration 0010) --------------------
    async def rpc(self, client, function, payload=None, timeout=None):
        payload = payload or {}
        self.requests.append(f"rpc:{function}")
        self.rpc_calls.append((function, dict(payload)))

        if self.fail_rpc_times > 0:
            self.fail_rpc_times -= 1
            self.rpc_failures += 1
            raise self.error_factory()

        dispatch = {
            BEGIN_FINALIZE: self._begin_finalize,
            PROMOTE_CHUNK: self._promote_chunk,
            WITHDRAW_CHUNK: self._withdraw_chunk,
            COMPLETE_FINALIZE: self._complete_finalize,
        }
        handler = dispatch.get(function)
        assert handler is not None, f"unknown RPC: {function}"
        return handler(payload)

    def _get_import(self, import_id: str) -> dict:
        record = next((r for r in self.imports if r["id"] == import_id), None)
        if record is None:
            raise PostgrestError(f"import {import_id} does not exist")
        return record

    def _staged(self, import_id: str) -> list[dict]:
        return [
            r for r in self.licences.values()
            if r.get("staged_import_id") == import_id
        ]

    def _unpromoted(self, import_id: str) -> list[dict]:
        return [
            r for r in self._staged(import_id)
            if r.get("last_import_id") != import_id
        ]

    def _stale_current(self, import_id: str) -> list[dict]:
        return [
            r for r in self.licences.values()
            if r.get("is_current") and r.get("staged_import_id") != import_id
        ]

    def _begin_finalize(self, payload: dict) -> list[dict]:
        import_id = payload["p_import_id"]
        record = self._get_import(import_id)
        status = record.get("status")

        if status == "success":
            return [{
                "staged_rows": len(self._staged(import_id)), "status": "success",
            }]
        if status not in ("running", "error", "finalizing"):
            raise PostgrestError(
                f"import {import_id} has unrecognised status {status}"
            )

        staged = self._staged(import_id)
        if not staged:
            raise PostgrestError(
                f"import {import_id} staged no rows; there is nothing to publish"
            )

        record["status"] = "finalizing"
        record["error"] = None
        return [{"staged_rows": len(staged), "status": "finalizing"}]

    def _require_finalizing(self, import_id: str) -> Optional[list[dict]]:
        """Returns an early-return payload of (0, 0) if already success, else None."""
        record = self._get_import(import_id)
        status = record.get("status")
        if status == "success":
            return [{"processed": 0, "remaining": 0}]
        if status != "finalizing":
            raise PostgrestError(
                f"import {import_id} is not finalizing (status={status}); call "
                "begin_sponsor_register_finalization() first"
            )
        return None

    def _promote_chunk(self, payload: dict) -> list[dict]:
        import_id = payload["p_import_id"]
        limit = payload.get("p_limit", 2000)
        early = self._require_finalizing(import_id)
        if early is not None:
            return early

        chunk = self._unpromoted(import_id)[:limit]
        now = _now()
        for row in chunk:
            row.update({
                "is_current": True,
                "withdrawn_at": None,
                "last_seen_at": now,
                "last_import_id": import_id,
            })
        remaining = len(self._unpromoted(import_id))
        return [{"processed": len(chunk), "remaining": remaining}]

    def _withdraw_chunk(self, payload: dict) -> list[dict]:
        import_id = payload["p_import_id"]
        limit = payload.get("p_limit", 2000)
        early = self._require_finalizing(import_id)
        if early is not None:
            return early

        if self._unpromoted(import_id):
            raise PostgrestError(
                f"import {import_id} still has unpromoted rows; finish "
                "promote_sponsor_register_import_chunk() first"
            )

        chunk = self._stale_current(import_id)[:limit]
        now = _now()
        for row in chunk:
            row.update({
                "is_current": False,
                "withdrawn_at": now,
                "withdrawn_by_import_id": import_id,
            })
        remaining = len(self._stale_current(import_id))
        return [{"processed": len(chunk), "remaining": remaining}]

    def _complete_finalize(self, payload: dict) -> list[dict]:
        import_id = payload["p_import_id"]
        record = self._get_import(import_id)
        status = record.get("status")

        if status == "success":
            return [{
                "rows_processed": record.get("rows_processed") or 0,
                "rows_current_after": record.get("rows_current_after") or 0,
                "rows_withdrawn": record.get("rows_withdrawn") or 0,
            }]
        if status != "finalizing":
            raise PostgrestError(
                f"import {import_id} is not finalizing (status={status})"
            )

        unpromoted = self._unpromoted(import_id)
        if unpromoted:
            raise PostgrestError(
                f"{len(unpromoted)} staged row(s) are still unpromoted"
            )
        stale = self._stale_current(import_id)
        if stale:
            raise PostgrestError(
                f"{len(stale)} live row(s) do not belong to this edition"
            )

        promoted = [
            r for r in self.licences.values()
            if r.get("staged_import_id") == import_id
            and r.get("last_import_id") == import_id
        ]
        current = self.current()
        if len(current) != len(promoted):
            raise PostgrestError(
                f"{len(current) - len(promoted)} row(s) are current but not "
                f"credited to import {import_id}"
            )
        withdrawn = [
            r for r in self.licences.values()
            if r.get("withdrawn_by_import_id") == import_id
        ]

        record.update({
            "status": "success",
            "rows_processed": len(promoted),
            "rows_current_after": len(current),
            "rows_withdrawn": len(withdrawn),
            "error": None,
        })
        return [{
            "rows_processed": len(promoted),
            "rows_current_after": len(current),
            "rows_withdrawn": len(withdrawn),
        }]

    # -- convenience for assertions ----------------------------------------
    @property
    def rows(self) -> list[dict]:
        return list(self.licences.values())

    def current(self) -> list[dict]:
        return [r for r in self.licences.values() if r.get("is_current")]

    def current_names(self) -> set[str]:
        return {r["organisation_name"] for r in self.current()}

    def status(self) -> str:
        return self.imports[-1].get("status", "?") if self.imports else "?"
