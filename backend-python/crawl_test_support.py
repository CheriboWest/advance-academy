"""Shared test doubles for the crawl-pipeline self-check scripts.

Not itself a test — `test_crawl_stats.py` and `test_crawl_display_stats.py`
both import from here so the in-memory Supabase stand-in and the
`run_crawl_with` driver are defined exactly once.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

from app.crawler import pipeline
from app.crawler.models import NormalizedJob

NOW = datetime.now(timezone.utc)

# The crawl_runs columns _finalize actually persists to (confirmed live —
# see CrawlStats.as_persisted_columns). NOT the migration-0002/0005 columns
# (raw_jobs, normalized_jobs, inserted_jobs, companies_created, updated_jobs)
# — those are never written; a table with only them and not these would look
# identical, to this fake, to one with neither.
PERSISTED_KEYS = (
    "new_jobs",
    "duplicate_jobs",
    "companies_discovered",
    "companies_updated",
    "jobs_found",
)

# The columns migrations 0002/0005 added, which this codebase's _finalize
# must NEVER attempt to write — that was the root cause of every statistic
# being silently discarded (see test_crawl_stats.py scenario 8).
UNPERSISTED_LEGACY_KEYS = (
    "raw_jobs",
    "normalized_jobs",
    "inserted_jobs",
    "companies_created",
    "updated_jobs",
)

# The `crawl_runs` columns the live database actually has, read straight off a
# `select=*` against it. An allowlist, not an opt-out list: `missing_columns`
# below only rejects what a scenario thinks to name, which is precisely why a
# green suite still shipped a `_finalize` that wrote a nonexistent `error`
# column and left every crawl stuck at "running".
LIVE_CRAWL_RUNS_COLUMNS = frozenset({
    "id",
    "source",
    "status",
    "query",
    "location",
    "started_at",
    "completed_at",
    "created_at",
    "error_message",
    "jobs_found",
    "new_jobs",
    "duplicate_jobs",
    "companies_discovered",
    "companies_updated",
})

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


def failures() -> list[str]:
    return _failures


def crawled(
    title: str, company: str, days_ago: float = 1, source: str = "adzuna"
) -> NormalizedJob:
    return NormalizedJob(
        source=source,
        source_job_id=f"{source}:{company}:{title}",
        company_name=company,
        title=title,
        city="London",
        location_raw="London",
        posted_at=(NOW - timedelta(days=days_ago)).isoformat(),
    )


class FakeRest:
    """In-memory stand-in for SupabaseRest, recording every write."""

    def __init__(
        self,
        companies: Optional[list[dict]] = None,
        jobs: Optional[list[dict]] = None,
        missing_columns: Optional[set] = None,
        known_columns: Optional[frozenset] = None,
    ) -> None:
        self.companies = companies or []
        self.jobs = jobs or []
        self.crawl_runs: dict[str, dict] = {}
        self.updates: list[tuple[str, dict, dict]] = []
        # Column names this fake table does NOT have. A crawl_runs UPDATE
        # touching any of them fails the *entire* statement — matching real
        # Postgres/PostgREST all-or-nothing UPDATE semantics — not just that
        # field.
        self.missing_columns = missing_columns or set()
        # Every column this fake table DOES have. When set, any other column
        # fails the statement — the same all-or-nothing rejection PostgREST
        # gives, but derived from the real schema instead of from whatever a
        # scenario remembered to exclude. Pass LIVE_CRAWL_RUNS_COLUMNS to hold
        # `_finalize` to the live database.
        self.known_columns = known_columns
        # --- job expiry (migration 046) ---------------------------------
        # Every upsert request as sent: (table, on_conflict, rows). Lets a
        # scenario check which columns each request named.
        self.upsert_calls: list[tuple[str, str, list[dict]]] = []
        # job_sightings, keyed by its primary key.
        self.sightings: dict[tuple[str, str, str, str], dict] = {}
        # Rows inserted per table (crawl_fetches, ...).
        self.inserted: dict[str, list[dict]] = {}
        self.rpc_calls: list[tuple[str, Optional[dict]]] = []
        self.rpc_results: dict[str, object] = {}
        # Simulated failures.
        self.missing_job_columns: set[str] = set()  # pre-046 jobs table
        self.fail_upsert_tables: set[str] = set()
        self.fail_insert_tables: set[str] = set()
        self.rpc_error: Optional[Exception] = None

    async def select(self, client, table, params=None):
        params = params or {}
        if table == "companies":
            wanted = _in_list(params.get("slug", ""))
            return [c for c in self.companies if c["slug"] in wanted]
        if table == "jobs":
            if "content_hash" in params:
                wanted = _in_list(params["content_hash"])
                columns = (params.get("select") or "content_hash").split(",")
                unknown = [c for c in columns if c in self.missing_job_columns]
                if unknown:
                    raise _postgrest_error(
                        "GET", "jobs", "42703",
                        f"column jobs.{unknown[0]} does not exist",
                    )
                by_hash = {j.get("content_hash"): j for j in self.jobs}
                return [{c: by_hash[h].get(c) for c in columns}
                        for h in by_hash if h in wanted]
            wanted = _in_list(params.get("company_id", ""))
            return [j for j in self.jobs
                    if j.get("company_id") in wanted and j.get("is_active")]
        return []

    async def insert(self, client, table, rows, prefer="return=representation"):
        if table in self.fail_insert_tables:
            raise _postgrest_error("POST", table, "500", "insert failed")
        self.inserted.setdefault(table, []).extend(dict(r) for r in rows)
        return rows

    async def rpc(self, client, function, payload=None, timeout=None):
        self.rpc_calls.append((function, payload))
        if self.rpc_error is not None:
            raise self.rpc_error
        return self.rpc_results.get(function)

    async def upsert(self, client, table, rows, on_conflict, prefer=""):
        self.upsert_calls.append((table, on_conflict, [dict(r) for r in rows]))
        if table in self.fail_upsert_tables:
            raise _postgrest_error("POST", table, "500", "upsert failed")
        if table == "job_sightings":
            for row in rows:
                key = (row["content_hash"], row["source"], row["query"], row["location"])
                self.sightings.setdefault(key, {}).update(row)
            return []
        if table == "companies":
            out = []
            for row in rows:
                if on_conflict == "id":
                    target = next(c for c in self.companies if c["id"] == row["id"])
                    target.update(row)
                    out.append({"slug": target["slug"], "id": target["id"]})
                else:
                    existing = next(
                        (c for c in self.companies if c["slug"] == row["slug"]), None
                    )
                    if existing:
                        existing.update(row)
                    else:
                        existing = {**row, "id": f"new:{row['slug']}"}
                        self.companies.append(existing)
                    out.append({"slug": existing["slug"], "id": existing["id"]})
            return out
        if table == "jobs":
            for row in rows:
                existing = next(
                    (j for j in self.jobs
                     if j.get("content_hash") == row.get("content_hash")), None)
                if existing:
                    existing.update(row)
                else:
                    self.jobs.append({**row, "id": f"job:{row.get('content_hash')}"})
        return []

    async def update(self, client, table, match, values, prefer="return=minimal"):
        self.updates.append((table, dict(match), dict(values)))

        if table == "crawl_runs":
            unknown = [
                k
                for k in values
                if k in self.missing_columns
                or (self.known_columns is not None and k not in self.known_columns)
            ]
            if unknown:
                request = httpx.Request("PATCH", "https://example.test/crawl_runs")
                response = httpx.Response(
                    400,
                    json={
                        "code": "PGRST204",
                        "message": (
                            f"Could not find the '{unknown[0]}' column of "
                            "'crawl_runs' in the schema cache"
                        ),
                    },
                    request=request,
                )
                # Real Postgres UPDATEs are all-or-nothing: none of `values`
                # is applied when any column is unknown.
                raise httpx.HTTPStatusError(
                    "bad request", request=request, response=response
                )

            run_id = match.get("id", "").removeprefix("eq.")
            self.crawl_runs.setdefault(run_id, {"id": run_id}).update(values)


def _postgrest_error(method: str, table: str, code: str, message: str) -> httpx.HTTPStatusError:
    request = httpx.Request(method, f"https://example.test/{table}")
    response = httpx.Response(
        400 if code != "500" else 500,
        json={"code": code, "message": message},
        request=request,
    )
    return httpx.HTTPStatusError(message, request=request, response=response)


def _in_list(raw: str) -> set[str]:
    if not raw.startswith("in.("):
        return set()
    return {v for v in raw[4:-1].split(",") if v}


class FakeSettings:
    supabase_url = "https://example.supabase.co"
    supabase_service_role_key = "service-role-test-key"
    adzuna_app_id = "id"
    adzuna_app_key = "key"
    reed_api_key = "key"
    # No API key, so the post-crawl sponsorship and summary hooks stay offline.
    # They run for real now that `affected_company_ids` is actually populated —
    # these scenarios are about `_finalize`, not about what happens after it.
    anthropic_api_key = ""
    anthropic_model = "claude-sonnet-5"
    request_timeout = 5.0
    sponsor_resolver_model = "claude-opus-5"
    sponsor_resolve_concurrency = 3
    sponsor_resolve_max_per_crawl = 50


def run_crawl_with(
    rest: FakeRest,
    jobs: list[NormalizedJob],
    run_id: str,
    sources: Optional[list[str]] = None,
    fetch_all=None,
    query: str = "software engineer",
    city: str = "London",
    force: bool = False,
):
    """Drive the real `run_crawl` with the network and database stubbed out.

    By default `_fetch_all` is stubbed to return `jobs` verbatim regardless of
    `sources` — good enough for single-source scenarios. Pass `fetch_all` (an
    async callable matching `_fetch_all`'s signature) to exercise real
    multi-source merging instead.

    `query`/`city` default to a single pair. Pass multi-value strings (newlines
    or commas) to exercise the cross-product loop — see test_crawl_multi_query.
    """
    import asyncio

    original_settings = pipeline.get_settings
    original_rest_cls = pipeline.SupabaseRest
    original_fetch = pipeline._fetch_all

    async def default_fetch_all(client, settings, query, city, sources, stats):
        return list(jobs)

    pipeline.get_settings = lambda: FakeSettings()  # type: ignore[assignment]
    pipeline.SupabaseRest = lambda *a, **k: rest  # type: ignore[assignment]
    pipeline._fetch_all = fetch_all or default_fetch_all  # type: ignore[assignment]
    try:
        asyncio.run(
            pipeline.run_crawl(
                run_id, query, city, sources or ["adzuna"], force
            )
        )
    finally:
        pipeline.get_settings = original_settings  # type: ignore[assignment]
        pipeline.SupabaseRest = original_rest_cls  # type: ignore[assignment]
        pipeline._fetch_all = original_fetch  # type: ignore[assignment]


def crawl_run_updates(rest: FakeRest) -> list[dict]:
    return [values for table, _, values in rest.updates if table == "crawl_runs"]


def job(
    title: str,
    company: str = "Acme",
    source: str = "adzuna",
    expires_at: Optional[str] = None,
    city: str = "London",
) -> NormalizedJob:
    """A NormalizedJob as a source adapter would return it."""
    return NormalizedJob(
        source=source,
        source_job_id=f"{source}:{company}:{title}",
        company_name=company,
        title=title,
        city=city,
        location_raw=city,
        posted_at=(NOW - timedelta(days=3)).isoformat(),
        expires_at=expires_at,
    )


def run_crawl_with_sources(
    rest: FakeRest,
    *,
    adzuna=(),
    reed=(),
    run_id: str = "run-1",
    query: str = "Software Engineer",
    city: str = "London",
    sources: tuple[str, ...] = ("adzuna", "reed"),
    settings: Optional[object] = None,
    timeout_seconds: Optional[float] = None,
) -> None:
    """Drive the real `run_crawl` — real `_fetch_all` / `_fetch_source`, so the
    per-pair fetch outcomes are produced the way production produces them — with
    only the two source adapters stubbed.

    `adzuna` / `reed` are each a list of NormalizedJob, an Exception to raise,
    or a callable (query, city) -> list | Exception | awaitable, for per-pair
    behaviour in multi-pair runs.
    """
    import asyncio
    import inspect

    from app.crawler.sources import adzuna as adzuna_mod
    from app.crawler.sources import reed as reed_mod

    def _stub(spec):
        async def fetch(client, *args, **kwargs):
            # adzuna.fetch(client, app_id, app_key, query, city, limit)
            # reed.fetch(client, api_key, query, city, limit)
            query_arg, city_arg = args[-2], args[-1]
            outcome = spec(query_arg, city_arg) if callable(spec) else spec
            if inspect.isawaitable(outcome):
                outcome = await outcome
            if isinstance(outcome, Exception):
                raise outcome
            return list(outcome)
        return fetch

    async def _offline(company_ids):  # post-crawl hooks: not under test here
        return None

    originals = (pipeline.get_settings, pipeline.SupabaseRest,
                 adzuna_mod.fetch, reed_mod.fetch, pipeline.OVERALL_TIMEOUT_SECONDS,
                 pipeline._resolve_sponsorship, pipeline._generate_company_summaries,
                 pipeline._classify_sectors)
    pipeline._resolve_sponsorship = _offline  # type: ignore[assignment]
    pipeline._generate_company_summaries = _offline  # type: ignore[assignment]
    pipeline._classify_sectors = _offline  # type: ignore[assignment]
    pipeline.get_settings = lambda: settings or FakeSettings()  # type: ignore[assignment]
    pipeline.SupabaseRest = lambda *a, **k: rest  # type: ignore[assignment]
    adzuna_mod.fetch = _stub(adzuna)  # type: ignore[assignment]
    reed_mod.fetch = _stub(reed)  # type: ignore[assignment]
    if timeout_seconds is not None:
        pipeline.OVERALL_TIMEOUT_SECONDS = timeout_seconds  # type: ignore[assignment]
    try:
        asyncio.run(pipeline.run_crawl(run_id, query, city, list(sources), True))
    finally:
        (pipeline.get_settings, pipeline.SupabaseRest,
         adzuna_mod.fetch, reed_mod.fetch, pipeline.OVERALL_TIMEOUT_SECONDS,
         pipeline._resolve_sponsorship, pipeline._generate_company_summaries,
         pipeline._classify_sectors) = originals  # type: ignore[assignment]
