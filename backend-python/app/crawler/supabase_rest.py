"""Thin async Supabase REST (PostgREST) client using the service role key.

Server-side only — the service role key is never exposed to the frontend.

Every method takes an optional per-call `timeout` that overrides the client
default. Bulk operations need it: the sponsor-register import writes hundreds of
batches into a table with a unique index, and those upserts take far longer than
the interactive requests the 15-second default was chosen for. Raising the
default instead would let an interactive endpoint hang for minutes.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx


def _error_summary(response: httpx.Response) -> str:
    """Status plus PostgREST's error code and message, for the logs.

    Never the request payload or the error's `details`/`hint`: those carry
    row values (a unique violation's details quote the duplicate key), and
    the rows written through here include people's names, emails and phones.
    """
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        return f"HTTP {response.status_code} {body.get('code') or ''} {body.get('message') or ''}".strip()
    return f"HTTP {response.status_code}"


class SupabaseRest:
    def __init__(self, base_url: str, service_role_key: str, timeout: float = 15.0):
        self._rest = f"{base_url.rstrip('/')}/rest/v1"
        self._headers = {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Content-Type": "application/json",
        }
        self._timeout = timeout

    async def select(
        self,
        client: httpx.AsyncClient,
        table: str,
        params: Optional[dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> list[dict[str, Any]]:
        response = await client.get(
            f"{self._rest}/{table}",
            params=params or {},
            headers=self._headers,
            timeout=timeout or self._timeout,
        )
        response.raise_for_status()
        return response.json()

    async def count(
        self,
        client: httpx.AsyncClient,
        table: str,
        params: Optional[dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> Optional[int]:
        """Number of rows matching `params`, or None if the count is unavailable.

        Uses PostgREST's `Prefer: count=exact`, which reports the total in the
        `Content-Range` header as `<start>-<end>/<total>`. A HEAD request keeps
        the body empty, so counting a six-figure table costs one small response
        rather than the rows themselves.
        """
        response = await client.head(
            f"{self._rest}/{table}",
            params=params or {},
            headers={**self._headers, "Prefer": "count=exact"},
            timeout=timeout or self._timeout,
        )
        response.raise_for_status()
        content_range = response.headers.get("content-range", "")
        _, _, total = content_range.partition("/")
        try:
            return int(total)
        except ValueError:
            return None

    async def rpc(
        self,
        client: httpx.AsyncClient,
        function: str,
        payload: Optional[dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Call a Postgres function through PostgREST's /rpc endpoint.

        Used for work that belongs in the database rather than in Python — a
        statement over six figures of rows costs one request here and hundreds
        of pages if it is assembled client-side.
        """
        response = await client.post(
            f"{self._rest}/rpc/{function}",
            headers=self._headers,
            json=payload or {},
            timeout=timeout or self._timeout,
        )
        if response.status_code >= 400:
            print(f"SUPABASE RPC ERROR {function}: {_error_summary(response)}", flush=True)
        response.raise_for_status()
        if not response.content:
            return None
        return response.json()

    async def insert(
        self,
        client: httpx.AsyncClient,
        table: str,
        rows: list[dict[str, Any]],
        prefer: str = "return=representation",
        timeout: Optional[float] = None,
    ) -> list[dict[str, Any]]:
        if not rows:
            return []
        response = await client.post(
            f"{self._rest}/{table}",
            headers={**self._headers, "Prefer": prefer},
            json=rows,
            timeout=timeout or self._timeout,
        )
        if response.status_code >= 400:
            print(f"SUPABASE INSERT ERROR {table} ({len(rows)} rows): {_error_summary(response)}", flush=True)
        response.raise_for_status()
        if prefer.startswith("return=representation"):
            return response.json()
        return []

    async def upsert(
        self,
        client: httpx.AsyncClient,
        table: str,
        rows: list[dict[str, Any]],
        on_conflict: str,
        prefer: str = "resolution=merge-duplicates,return=representation",
        timeout: Optional[float] = None,
    ) -> list[dict[str, Any]]:
        if not rows:
            return []
        response = await client.post(
            f"{self._rest}/{table}",
            params={"on_conflict": on_conflict},
            headers={**self._headers, "Prefer": prefer},
            json=rows,
            timeout=timeout or self._timeout,
        )
        response.raise_for_status()
        if "return=representation" in prefer:
            return response.json()
        return []

    async def delete(
        self,
        client: httpx.AsyncClient,
        table: str,
        match: dict[str, str],
        prefer: str = "return=representation",
        timeout: Optional[float] = None,
    ) -> list[dict[str, Any]]:
        """Delete rows matching `match`. Returns the deleted rows (default
        `return=representation`) so a caller can tell "deleted one row" from
        "matched nothing" without a separate existence check."""
        response = await client.delete(
            f"{self._rest}/{table}",
            params=match,
            headers={**self._headers, "Prefer": prefer},
            timeout=timeout or self._timeout,
        )
        response.raise_for_status()
        if prefer.startswith("return=representation"):
            return response.json()
        return []

    async def update(
        self,
        client: httpx.AsyncClient,
        table: str,
        match: dict[str, str],
        values: dict[str, Any],
        prefer: str = "return=minimal",
        timeout: Optional[float] = None,
    ) -> list[dict[str, Any]]:
        """Update rows matching `match`. Returns the updated rows when `prefer`
        requests representation (existing callers all use the `return=minimal`
        default and ignore the return value, so this is purely additive)."""
        response = await client.patch(
            f"{self._rest}/{table}",
            params=match,
            headers={**self._headers, "Prefer": prefer},
            json=values,
            timeout=timeout or self._timeout,
        )
        response.raise_for_status()
        if prefer.startswith("return=representation"):
            return response.json()
        return []
