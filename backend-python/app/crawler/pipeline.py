"""Crawl pipeline: fetch → normalize → dedup → ingest → score → record stats."""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Iterable, Optional

import httpx

from app.config import get_settings
from app.crawler.enrich import enrich_company
from app.crawler.models import CrawlStats, NormalizedJob
from app.crawler.normalize import (
    canonical_company_name,
    company_slug,
    content_hash,
    normalize_city,
    normalize_query,
    normalize_title,
    split_terms,
)
from app.crawler.scoring import compute_lead_score
from app.crawler.sources import adzuna, reed
from app.crawler.supabase_rest import SupabaseRest
from app.crawler.timing import log_stage, stage

# How many jobs one (role, city) pair may pull. These were the MVP limits (50
# / 25) and they were the binding constraint on company discovery, not the job
# boards: a "Nurse / London" search returns thousands, and asking for 25 of them
# left every company past the 25th undiscovered. Raising the ask costs NOTHING
# extra — it is the same one request per source per pair, with a larger
# `results_per_page` / `resultsToTake` — and 50 sits under both providers'
# per-request ceilings (Adzuna caps a page at 50; Reed allows 100).
#
# ponytail: 50 is the single-request ceiling. Going past it needs pagination in
# both source modules — do that only if company discovery per crawl is still
# the bottleneck after a sweep of new cities.
MAX_RAW_JOBS = 100
PER_SOURCE_LIMIT = 50
# How long a crawled (query, location) pair stays fresh. Lives here rather than
# in the router because the crawl loop reads it too, and the router already
# imports from this module — the other direction would be a circular import.
CACHE_TTL_HOURS = 24.0
# Hard ceiling so a background task can never stay "running" forever.
OVERALL_TIMEOUT_SECONDS = 90.0
# Sponsorship resolution runs after the crawl has already been finalized, so
# this ceiling only bounds the background work — it can never make a crawl fail.
SPONSORSHIP_TIMEOUT_SECONDS = 240.0
# Same reasoning as SPONSORSHIP_TIMEOUT_SECONDS: company-summary generation
# also runs after the crawl is finalized, so this only bounds that background
# sweep — a slow or failing summary call can never make a crawl fail.
SUMMARY_TIMEOUT_SECONDS = 240.0
# Same again for sector classification (one Claude call per 50 companies).
SECTOR_TIMEOUT_SECONDS = 120.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def hours_since(iso: Optional[str]) -> Optional[float]:
    """Hours between an ISO timestamp and now, or None if it cannot be read."""
    if not iso:
        return None
    try:
        parsed = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - parsed).total_seconds() / 3600.0


async def cached_refresh_time(
    client: httpx.AsyncClient,
    rest: SupabaseRest,
    normalized_query: str,
    normalized_city: str,
) -> Optional[str]:
    """`last_refreshed_at` while this pair is still inside the 24h cache.

    None means "go crawl it" — either never crawled, or crawled long enough ago
    to be worth refreshing.
    """
    rows = await rest.select(
        client,
        "discovery_queries",
        {
            "query": f"eq.{normalized_query}",
            "location": f"eq.{normalized_city}",
            "select": "last_refreshed_at",
            "limit": "1",
        },
    )
    if not rows:
        return None
    last_refreshed = rows[0].get("last_refreshed_at")
    hours = hours_since(last_refreshed)
    return last_refreshed if hours is not None and hours < CACHE_TTL_HOURS else None


def _safe_error(exc: Exception) -> str:
    """A message safe to store/log — never includes URLs or credentials.

    (Adzuna passes app_id/app_key as query params, so the raw error string can
    leak secrets — we deliberately avoid stringifying the exception.)
    """
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code} from upstream source."
    if isinstance(exc, httpx.TimeoutException):
        return "Upstream request timed out."
    if isinstance(exc, httpx.HTTPError):
        return "Upstream request failed."
    return "Unexpected error during crawl."


def _csv(values: Iterable[str]) -> str:
    return ",".join(values)


def _chunks(items: list[Any], size: int) -> Iterable[list[Any]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


async def _fetch_source(
    name: str,
    coro: Awaitable[list[NormalizedJob]],
    stats: CrawlStats,
) -> list[NormalizedJob]:
    """Await a single source, timing it and isolating its failure."""
    start = time.perf_counter()
    try:
        return await coro
    except Exception as exc:  # noqa: BLE001 - partial failure is expected
        stats.source_errors[name] = _safe_error(exc)
        return []
    finally:
        log_stage(f"fetch:{name}", time.perf_counter() - start)


async def _fetch_all(
    client: httpx.AsyncClient,
    settings: Any,
    query: str,
    city: str,
    sources: list[str],
    stats: CrawlStats,
) -> list[NormalizedJob]:
    """Fetch up to MAX_RAW_JOBS. Sources run concurrently; failures are isolated."""
    tasks: list[Awaitable[list[NormalizedJob]]] = []

    if "adzuna" in sources:
        if settings.adzuna_app_id and settings.adzuna_app_key:
            tasks.append(
                _fetch_source(
                    "adzuna",
                    adzuna.fetch(
                        client,
                        settings.adzuna_app_id,
                        settings.adzuna_app_key,
                        query,
                        city,
                        limit=PER_SOURCE_LIMIT,
                    ),
                    stats,
                )
            )
        else:
            stats.source_errors["adzuna"] = "Adzuna credentials not configured."

    if "reed" in sources:
        if settings.reed_api_key:
            tasks.append(
                _fetch_source(
                    "reed",
                    reed.fetch(
                        client,
                        settings.reed_api_key,
                        query,
                        city,
                        limit=PER_SOURCE_LIMIT,
                    ),
                    stats,
                )
            )
        else:
            stats.source_errors["reed"] = "Reed credentials not configured."

    # Run all sources concurrently — total time is the slowest source, not the sum.
    results = await asyncio.gather(*tasks) if tasks else []

    jobs: list[NormalizedJob] = []
    for result in results:
        if len(jobs) >= MAX_RAW_JOBS:
            break
        jobs.extend(result[:PER_SOURCE_LIMIT])
        jobs = jobs[:MAX_RAW_JOBS]
    return jobs


async def _ingest(
    client: httpx.AsyncClient,
    rest: SupabaseRest,
    jobs: list[NormalizedJob],
    stats: CrawlStats,
) -> None:
    """Ingest one pair's jobs, accumulating into `stats`.

    Every counter here accumulates rather than assigns: a run walks a list of
    (query, city) pairs sharing one CrawlStats, so assigning would report only
    whichever pair happened to finish last.
    """
    if not jobs:
        return

    # Group jobs by canonical company slug.
    with stage("group_by_company"):
        groups: dict[str, dict[str, Any]] = {}
        for job in jobs:
            slug = company_slug(job.company_name)
            group = groups.setdefault(
                slug, {"name": canonical_company_name(job.company_name), "jobs": []}
            )
            group["jobs"].append(job)
        slugs = list(groups.keys())

    with stage("select_companies", f"({len(slugs)} slugs)"):
        # `ai_summary` (migration 0013) is included so the summary sweep
        # below knows which companies still need one — but this SELECT must
        # not be how a missing migration breaks ingestion itself. If the
        # column isn't live yet, retry without it and simply skip the
        # summary worklist for this crawl (summaries stay a page-render
        # concern to fix, never a "the crawl broke" one).
        summary_column_available = True
        try:
            existing_companies = await rest.select(
                client,
                "companies",
                {
                    "slug": f"in.({_csv(slugs)})",
                    "select": "id,slug,website,sector,ai_summary",
                },
            )
        except httpx.HTTPStatusError as exc:
            if not _is_missing_column_error(exc):
                raise
            summary_column_available = False
            print(
                "[ingest] companies.ai_summary is missing — apply "
                "supabase/migrations/036_ch0013_company_ai_summary.sql. "
                "Skipping the summary worklist for this crawl.",
                flush=True,
            )
            existing_companies = await rest.select(
                client,
                "companies",
                {"slug": f"in.({_csv(slugs)})", "select": "id,slug,website,sector"},
            )
        existing_by_slug = {row["slug"]: row for row in existing_companies}

    # Enrich all companies concurrently (a no-op for those without a website).
    with stage("enrich_companies"):
        websites = [(existing_by_slug.get(s) or {}).get("website") for s in slugs]
        enrichments = await asyncio.gather(
            *[enrich_company(client, website) for website in websites]
        )
        enrichment_by_slug = dict(zip(slugs, enrichments))

    # Build company rows (lead scoring is in-memory/cheap).
    with stage("score_and_build_companies"):
        company_rows: list[dict[str, Any]] = []
        slugs_needing_summary: list[str] = []
        for slug in slugs:
            group = groups[slug]
            group_jobs: list[NormalizedJob] = group["jobs"]
            prior = existing_by_slug.get(slug)
            enrichment = enrichment_by_slug.get(slug, {})
            score = compute_lead_score(group_jobs)
            hq = normalize_city(group_jobs[0].city) if group_jobs else None

            row: dict[str, Any] = {
                "slug": slug,
                "name": group["name"],
                "hq_location": hq,
                "region": hq,
                "lead_score": score,
            }
            if enrichment.get("description"):
                row["description"] = enrichment["description"]
            # No sector here: the post-crawl _classify_sectors sweep owns it,
            # and leaving the key out keeps an existing value on upsert.
            if enrichment.get("careers_url"):
                row["careers_url"] = enrichment["careers_url"]

            company_rows.append(row)
            # Attributed to whichever source's job appears first in this
            # company's group — a company crawled from both sources at once
            # is credited to one of them, deterministically, purely for the
            # per-source log line; the combined companies_created total below
            # is unaffected either way.
            first_source = group_jobs[0].source if group_jobs else None
            if prior:
                stats.companies_updated += 1
            else:
                stats.companies_created += 1
                if first_source:
                    stats.record_source_outcome(first_source, companies_created=1)

            # Brand new (no prior row at all) or pre-existing but never
            # summarised — either way it needs one. A company that already
            # has an ai_summary is left alone here; a fresh one is only ever
            # produced by a manual refresh, not by every later crawl touch.
            if summary_column_available and not (prior or {}).get("ai_summary"):
                slugs_needing_summary.append(slug)

    with stage("upsert_companies", f"({len(company_rows)} rows)"):
        upserted = await rest.upsert(
            client,
            "companies",
            company_rows,
            on_conflict="slug",
            prefer="resolution=merge-duplicates,return=representation",
        )
        company_id_by_slug = {row["slug"]: row["id"] for row in upserted}
        # Every company this crawl created or updated — the post-crawl
        # sponsorship hook's worklist. The worker filters it down itself
        # (companies_needing_resolution + sponsor_resolve_max_per_crawl), so
        # handing it everything touched is both correct and bounded.
        stats.affected_company_ids.extend(company_id_by_slug.values())
        stats.companies_needing_summary.extend(
            company_id_by_slug[slug]
            for slug in slugs_needing_summary
            if slug in company_id_by_slug
        )

    # Build normalized job rows, deduplicating within this crawl by content_hash.
    with stage("normalize_jobs"):
        unique_rows: list[dict[str, Any]] = []
        # Parallel to unique_rows (same index) — which source produced it, so
        # the new-vs-updated split below can still be attributed per source
        # even though existing_hashes is looked up for all rows at once.
        unique_row_sources: list[str] = []
        seen_hashes: set[str] = set()
        for slug in slugs:
            company_id = company_id_by_slug.get(slug)
            if not company_id:
                continue
            for job in groups[slug]["jobs"]:
                digest = content_hash(slug, job.title, job.city)
                if digest in seen_hashes:
                    stats.duplicate_jobs += 1
                    stats.record_source_outcome(job.source, duplicate=1, verified=1)
                    continue
                seen_hashes.add(digest)
                unique_rows.append(
                    {
                        "company_id": company_id,
                        "title": normalize_title(job.title),
                        "location_raw": job.location_raw or job.city,
                        "city": normalize_city(job.city),
                        "salary_min": job.salary_min,
                        "salary_max": job.salary_max,
                        "posted_at": job.posted_at,
                        "is_active": True,
                        "source": job.source,
                        "source_job_id": job.source_job_id,
                        "source_url": job.source_url,
                        "content_hash": digest,
                    }
                )
                unique_row_sources.append(job.source)
        stats.normalized_jobs += len(unique_rows)

    # Which of the unique rows already exist (updated vs inserted)?
    with stage("select_existing_jobs", f"({len(unique_rows)} hashes)"):
        all_hashes = [row["content_hash"] for row in unique_rows]
        existing_hashes: set[str] = set()
        for chunk in _chunks(all_hashes, 100):
            rows = await rest.select(
                client,
                "jobs",
                {"content_hash": f"in.({_csv(chunk)})", "select": "content_hash"},
            )
            existing_hashes.update(row["content_hash"] for row in rows)
        updated = sum(
            1 for row in unique_rows if row["content_hash"] in existing_hashes
        )
        stats.updated_jobs += updated
        stats.inserted_jobs += len(unique_rows) - updated
        for row, row_source in zip(unique_rows, unique_row_sources):
            if row["content_hash"] in existing_hashes:
                stats.record_source_outcome(row_source, duplicate=1, verified=1)
            else:
                stats.record_source_outcome(row_source, new=1, verified=1)

    # Batch upsert (insert new + refresh existing) by content_hash.
    with stage("upsert_jobs", f"({len(unique_rows)} rows)"):
        for chunk in _chunks(unique_rows, 100):
            await rest.upsert(
                client,
                "jobs",
                chunk,
                on_conflict="content_hash",
                prefer="resolution=merge-duplicates,return=minimal",
            )


async def _execute(
    rest: SupabaseRest,
    settings: Any,
    query: str,
    city: str,
    sources: list[str],
    stats: CrawlStats,
    normalized_query: str,
    normalized_city: str,
) -> None:
    async with httpx.AsyncClient() as client:
        with stage("fetch_total"):
            jobs = await _fetch_all(client, settings, query, city, sources, stats)
        stats.raw_jobs += len(jobs)

        with stage("ingest_total", f"({len(jobs)} raw jobs)"):
            await _ingest(client, rest, jobs, stats)

        # Refresh the 24h cache marker.
        with stage("upsert_discovery_query"):
            await rest.upsert(
                client,
                "discovery_queries",
                [
                    {
                        "query": normalized_query,
                        "location": normalized_city,
                        "last_refreshed_at": _now_iso(),
                    }
                ],
                on_conflict="query,location",
                prefer="resolution=merge-duplicates,return=minimal",
            )


def _is_missing_column_error(exc: httpx.HTTPStatusError) -> bool:
    """True when PostgREST rejected a write because a column does not exist."""
    body = exc.response.text or ""
    return "PGRST204" in body or "does not exist" in body


async def _write_crawl_run(
    client: httpx.AsyncClient,
    rest: SupabaseRest,
    run_id: str,
    tiers: list[dict[str, Any]],
) -> dict[str, Any]:
    """Try each payload tier, most complete first; use the first that the live
    schema actually accepts.

    A PostgREST UPDATE is all-or-nothing: bundling even one column the table
    doesn't have fails the *entire* statement, not just that field. Earlier,
    the crawl statistics were only ever attempted in a single payload
    alongside columns (`raw_jobs`, `normalized_jobs`, `inserted_jobs`,
    `companies_created`) that migration 0005 added but was never actually
    applied to the live database — so that one statement always failed, and
    the fallback threw away every statistic, including the ones the table
    genuinely had a column for (`duplicate_jobs`, `companies_updated`). The
    tiers below only ever combine columns whose existence is independently
    justified (see `as_persisted_columns`), narrowing on failure instead of
    collapsing straight to nothing.

    Returns the payload that was actually written, for logging.
    """
    last_exc: httpx.HTTPStatusError | None = None
    for index, payload in enumerate(tiers):
        try:
            await rest.update(client, "crawl_runs", {"id": f"eq.{run_id}"}, payload)
        except httpx.HTTPStatusError as exc:
            if not _is_missing_column_error(exc):
                raise
            last_exc = exc
            print(
                f"[finalize] crawl_runs rejected payload tier {index} "
                f"(missing column) — trying a narrower tier. run_id={run_id} "
                f"rejected={sorted(payload)} detail={exc.response.text}",
                flush=True,
            )
            continue
        return payload
    # Every tier failed, including the bare {status, completed_at} tier —
    # nothing left to narrow to. Re-raise rather than silently no-op.
    assert last_exc is not None
    raise last_exc


async def _finalize(
    rest: SupabaseRest,
    run_id: str,
    status: str,
    stats: CrawlStats,
    error_note: str | None,
) -> None:
    """Persist the terminal state *and* this run's statistics to crawl_runs.

    Both go in a **single** UPDATE, deliberately: the frontend stops polling the
    moment it sees a terminal `status`, so writing the status first and the
    counts second would leave a window where the completion screen renders zeros
    for a run that actually ingested data. One statement means a poll either
    sees the run still running, or sees it terminal *with* its statistics.

    The counts come from the same `CrawlStats` instance the ingest mutated —
    there is no second tally anywhere, and nothing is recomputed from database
    totals.

    Writes to `crawl_runs` using the columns confirmed to exist on the live
    table (see `CrawlStats.as_persisted_columns`), narrowing via
    `_write_crawl_run` if even those turn out to be incomplete. A run must
    always reach a terminal state, on any schema; every narrowing step is
    logged loudly and nothing is ever silently swallowed.
    """
    completed_at = _now_iso()
    # The live column is `error_message`, NOT `error`. Writing `error` here is
    # exactly what stranded every run at "running": it sat in `base`, so all
    # three tiers carried it, PostgREST rejected all three (PGRST204), and
    # `_write_crawl_run` re-raised with nothing left to narrow to.
    base: dict[str, Any] = {
        "status": status,
        "completed_at": completed_at,
        "error_message": error_note,
    }
    persisted = stats.as_persisted_columns()
    # The last tier may only contain columns without which the run cannot reach
    # a terminal state at all. Anything else belongs in a higher tier: a column
    # in the bottom tier is a column that can strand a run forever.
    tiers = [
        {**base, **persisted},
        {**base, **{k: v for k, v in persisted.items() if k != "jobs_found"}},
        dict(base),
        {"status": status, "completed_at": completed_at},
    ]

    async with httpx.AsyncClient() as client:
        with stage("update_crawl_run"):
            written = await _write_crawl_run(client, rest, run_id, tiers)

    print(
        f"[finalize] persisted run_id={run_id} status={status} payload={written}",
        flush=True,
    )

    for source, bucket in stats.per_source.items():
        print(
            f"[crawl-source] {source}: new={bucket['new']} "
            f"duplicate={bucket['duplicate']} "
            f"companies_created={bucket['companies_created']} "
            f"verified={bucket['verified']}",
            flush=True,
        )

    columns = stats.as_columns()
    display = stats.as_display_columns()
    print(
        "[finalize] crawl finalized: "
        f"raw={columns['raw_jobs']} normalized={columns['normalized_jobs']} "
        f"inserted={columns['inserted_jobs']} updated={columns['updated_jobs']} "
        f"duplicates={columns['duplicate_jobs']} "
        f"companies_created={columns['companies_created']} "
        f"companies_updated={columns['companies_updated']} run_id={run_id}",
        flush=True,
    )
    print(
        "[crawl-final] manual_discovery: "
        f"new_jobs={display['new_jobs']} "
        f"duplicate_jobs={display['duplicate_jobs_total']} "
        f"companies_created={columns['companies_created']} "
        f"jobs_verified={display['jobs_verified']} run_id={run_id}",
        flush=True,
    )
    print(f"[finalize] payload written to crawl_runs: {written}", flush=True)
    if error_note:
        print(f"[finalize] run_id={run_id} note={error_note!r}", flush=True)


async def _resolve_sponsorship(company_ids: list[str]) -> None:
    """Check newly crawled companies against the sponsor register.

    Isolated from the crawl in every direction: it never raises, it has its own
    timeout, and it is skipped entirely when the API key is absent. Imported
    lazily so the crawler does not depend on the sponsors package at import
    time.
    """
    if not company_ids:
        return

    settings = get_settings()
    if not settings.anthropic_api_key:
        log_stage("sponsorship_skipped", 0.0, "(no Anthropic API key configured)")
        return

    started = time.perf_counter()
    try:
        from app.crawler.supabase_rest import SupabaseRest as _Rest
        from app.sponsors.worker import resolve_companies

        rest = _Rest(settings.supabase_url, settings.supabase_service_role_key)
        async with httpx.AsyncClient() as client:
            stats = await asyncio.wait_for(
                resolve_companies(
                    client,
                    rest,
                    company_ids,
                    api_key=settings.anthropic_api_key,
                    model=settings.sponsor_resolver_model,
                    timeout=settings.request_timeout,
                    concurrency=settings.sponsor_resolve_concurrency,
                    max_companies=settings.sponsor_resolve_max_per_crawl,
                ),
                timeout=SPONSORSHIP_TIMEOUT_SECONDS,
            )
        log_stage(
            "sponsorship_total", time.perf_counter() - started, f"{stats.as_dict()}"
        )
    except asyncio.TimeoutError:
        log_stage(
            "sponsorship_total",
            time.perf_counter() - started,
            "[timed out — crawl unaffected]",
        )
    except Exception as exc:  # noqa: BLE001 — never fails the crawl
        log_stage(
            "sponsorship_total",
            time.perf_counter() - started,
            f"[failed: {type(exc).__name__} — crawl unaffected]",
        )
        print(
            f"[sponsorship] resolution failed after the crawl: "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )


async def _generate_company_summaries(company_ids: list[str]) -> None:
    """Generate ai_summary for companies this crawl touched that don't have
    one yet.

    Isolated exactly like `_resolve_sponsorship`: runs after the crawl has
    already been finalized, has its own timeout, and never raises — a slow
    or failing summary call can never turn a successful crawl into a
    failure or timeout. Skipped entirely when there is no API key, in which
    case each company still gets a deterministic template summary (never
    just left blank).
    """
    if not company_ids:
        return

    settings = get_settings()
    started = time.perf_counter()
    try:
        from app.companies.summarizer import generate_and_store_summary
        from app.crawler.supabase_rest import SupabaseRest as _Rest

        rest = _Rest(settings.supabase_url, settings.supabase_service_role_key)

        async def _generate_all() -> int:
            generated = 0
            async with httpx.AsyncClient() as client:
                for company_id in company_ids:
                    summary = await generate_and_store_summary(
                        client,
                        rest,
                        company_id,
                        api_key=settings.anthropic_api_key,
                        model=settings.anthropic_model,
                        timeout=settings.request_timeout,
                        fallback_on_error=True,
                    )
                    if summary is not None:
                        generated += 1
            return generated

        generated = await asyncio.wait_for(
            _generate_all(), timeout=SUMMARY_TIMEOUT_SECONDS
        )
        log_stage(
            "company_summaries_total",
            time.perf_counter() - started,
            f"generated={generated}/{len(company_ids)}",
        )
    except asyncio.TimeoutError:
        log_stage(
            "company_summaries_total",
            time.perf_counter() - started,
            "[timed out — crawl unaffected]",
        )
    except Exception as exc:  # noqa: BLE001 — never fails the crawl
        log_stage(
            "company_summaries_total",
            time.perf_counter() - started,
            f"[failed: {type(exc).__name__} — crawl unaffected]",
        )
        print(
            f"[company_summaries] generation failed after the crawl: "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )


async def _classify_sectors(company_ids: list[str]) -> None:
    """Give a sector to companies this crawl touched that have none yet.

    Isolated like `_generate_company_summaries`: after the crawl is
    finalized, own timeout, never raises."""
    settings = get_settings()
    if not company_ids or not settings.anthropic_api_key:
        return

    started = time.perf_counter()
    try:
        from app.companies.sector import classify_and_store, unclassified
        from app.crawler.supabase_rest import SupabaseRest as _Rest

        rest = _Rest(settings.supabase_url, settings.supabase_service_role_key)

        async def _classify_all() -> int:
            async with httpx.AsyncClient() as client:
                companies = await unclassified(client, rest, company_ids)
                return await classify_and_store(
                    client,
                    rest,
                    companies,
                    api_key=settings.anthropic_api_key,
                    model=settings.anthropic_model,
                    timeout=settings.request_timeout,
                )

        stored = await asyncio.wait_for(_classify_all(), timeout=SECTOR_TIMEOUT_SECONDS)
        log_stage("sectors_total", time.perf_counter() - started, f"classified={stored}")
    except Exception as exc:  # noqa: BLE001 — never fails the crawl (incl. timeout)
        log_stage(
            "sectors_total",
            time.perf_counter() - started,
            f"[failed: {type(exc).__name__} — crawl unaffected]",
        )


async def run_crawl(
    run_id: str,
    query: str,
    city: str,
    sources: list[str],
    force: bool = False,
) -> None:
    """Background entrypoint. Always finalizes crawl_runs to success/error.

    `query` and `city` may each carry several values separated by newlines or
    commas (see `split_terms`), so one coach action can cover a whole list of
    roles instead of one. The cross product runs sequentially — that is also
    the rate limiting, since the providers cap requests per minute — and every
    pair shares one `CrawlStats`, so the "Crawl complete" cards report the
    totals for the run rather than for whichever pair happened to finish last.
    """
    settings = get_settings()
    rest = SupabaseRest(settings.supabase_url, settings.supabase_service_role_key)
    stats = CrawlStats()

    pairs = [(q, c) for q in split_terms(query) for c in split_terms(city)]
    crawled = 0
    skipped = 0
    status = "success"
    error_note: str | None = None
    started = time.perf_counter()

    async with httpx.AsyncClient() as client:
        for pair_query, pair_city in pairs:
            normalized_query = normalize_query(pair_query)
            normalized_city = normalize_query(pair_city)

            # A single pair was already cache-checked by the router, so this
            # only does work for multi-pair runs. It is what lets a run that
            # died halfway through resume on the next click instead of
            # re-spending the provider's daily quota on pairs already crawled.
            if (
                not force
                and len(pairs) > 1
                and await cached_refresh_time(
                    client, rest, normalized_query, normalized_city
                )
            ):
                skipped += 1
                continue

            try:
                await asyncio.wait_for(
                    _execute(
                        rest,
                        settings,
                        pair_query,
                        pair_city,
                        sources,
                        stats,
                        normalized_query,
                        normalized_city,
                    ),
                    timeout=OVERALL_TIMEOUT_SECONDS,
                )
                crawled += 1
            except asyncio.TimeoutError:
                stats.source_errors[f"{pair_query} / {pair_city}"] = "Crawl timed out."
            except Exception as exc:  # noqa: BLE001 - record failure, never raise
                stats.source_errors[f"{pair_query} / {pair_city}"] = _safe_error(exc)

    if stats.source_errors:
        error_note = "; ".join(
            f"{source}: {message}" for source, message in stats.source_errors.items()
        )
    # Only a run where nothing at all got through is a failed run: one bad role
    # out of twenty must not throw away the nineteen that worked. With a single
    # pair this is exactly the old behaviour — it failed, so the run failed.
    if not crawled and not skipped:
        status = "error"

    await _finalize(rest, run_id, status, stats, error_note)

    # Sponsorship resolution runs AFTER the crawl reaches a terminal state, on
    # purpose. Inside `_execute` it would spend the crawl's timeout budget and a
    # slow or failing lookup could turn a good crawl into a timeout; here the
    # status and statistics are already written, so nothing this does can change
    # what the crawl recorded. It is also swallowed whole — a crawl that
    # ingested jobs correctly is a successful crawl whether or not the register
    # could be consulted.
    await _resolve_sponsorship(stats.affected_company_ids)

    # Same reasoning as sponsorship resolution above: runs after the crawl's
    # terminal state is already written, so it can only add summaries for
    # companies that need them, never affect what the crawl itself recorded.
    await _generate_company_summaries(stats.companies_needing_summary)

    await _classify_sectors(stats.affected_company_ids)

    log_stage("crawl_total", time.perf_counter() - started, f"[{status}]")
