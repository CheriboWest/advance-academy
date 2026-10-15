"""Sponsor-register ingestion and entity-resolution endpoints.

Both are coach-authenticated and run server-side with the service role key: the
register is shared reference data, and the browser has no business writing it.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import get_current_user
from app.config import Settings, get_settings
from app.crawler.supabase_rest import SupabaseRest
from app.schemas import (
    CompanySponsorshipStatus,
    CompanySponsorshipStatusCompact,
    SponsorImportResponse,
    SponsorResolutionResponse,
    SponsorshipStatsResponse,
    SponsorshipStatusBatchRequest,
)
from app.sponsors import govuk
from app.sponsors.importer import run_import
from app.sponsors.service import (
    bulk_company_sponsorship_status,
    company_sponsorship_status,
    load_company,
    resolve_company,
)
from app.sponsors.worker import resolve_companies

router = APIRouter(prefix="/sponsors", tags=["sponsors"])

logger = logging.getLogger(__name__)


def _require_supabase(settings: Settings) -> SupabaseRest:
    if not (settings.supabase_url and settings.supabase_service_role_key):
        raise HTTPException(
            status_code=500, detail="Server is not configured for Supabase access."
        )
    return SupabaseRest(settings.supabase_url, settings.supabase_service_role_key)


@router.post("/import", response_model=SponsorImportResponse)
async def import_register(
    _user_id: str = Depends(get_current_user),
) -> SponsorImportResponse:
    """Download the current GOV.UK register and ingest it.

    Safe to run repeatedly and the way to pick up a new edition: GOV.UK's
    publication page is read each time, so a newly published CSV is found
    without a code change. Re-running against an unchanged file reports every
    row as unchanged.
    """
    settings = get_settings()
    rest = _require_supabase(settings)

    try:
        run_id, stats = await run_import(rest)
    except govuk.RegisterUnavailableError as exc:
        logger.error("Register unavailable: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not obtain the register from GOV.UK: {exc}",
        ) from exc
    except httpx.HTTPError as exc:
        logger.exception("Register import failed")
        raise HTTPException(
            status_code=502, detail="The register import failed."
        ) from exc

    return SponsorImportResponse(
        import_id=run_id or None, status="success", **stats.as_columns()
    )


@router.get("/imports", response_model=list[dict])
async def import_history(
    limit: int = Query(10, ge=1, le=50),
    _user_id: str = Depends(get_current_user),
) -> list[dict]:
    """Recent ingestion runs, newest first — the audit trail for the register."""
    settings = get_settings()
    rest = _require_supabase(settings)

    async with httpx.AsyncClient() as client:
        return await rest.select(
            client,
            "sponsor_register_imports",
            {"select": "*", "order": "started_at.desc", "limit": str(limit)},
        )


@router.post("/resolve/{company_id}", response_model=SponsorResolutionResponse)
async def resolve_sponsorship(
    company_id: str,
    persist: bool = Query(True, description="Store a confirmed match."),
    _user_id: str = Depends(get_current_user),
) -> SponsorResolutionResponse:
    """Resolve one company against the register.

    The database narrows the register to a handful of candidates before Claude
    sees anything, and only a confident match is stored. `no_match` and
    `ambiguous` deliberately create no sponsorship link.
    """
    settings = get_settings()
    rest = _require_supabase(settings)

    if not settings.anthropic_api_key:
        raise HTTPException(
            status_code=500,
            detail="Server is not configured with an Anthropic API key.",
        )

    async with httpx.AsyncClient() as client:
        resolution, candidates, strategies = await resolve_company(
            client,
            rest,
            company_id,
            api_key=settings.anthropic_api_key,
            model=settings.sponsor_resolver_model,
            timeout=settings.request_timeout,
            persist=persist,
        )

    if resolution is None:
        raise HTTPException(status_code=404, detail="Company not found.")

    return SponsorResolutionResponse(
        **resolution.as_dict(),
        candidates_considered=len(candidates),
        search_strategies=strategies,
        persisted=persist and resolution.decision == "match",
    )


@router.post("/resolve", response_model=dict)
async def bulk_resolve(
    limit: int = Query(50, ge=1, le=500, description="Maximum companies to resolve."),
    force: bool = Query(False, description="Re-resolve even if already current."),
    _user_id: str = Depends(get_current_user),
) -> dict:
    """Resolve companies whose sponsorship conclusion is missing or stale.

    The backfill for companies crawled before sponsorship existed, and the way
    to sweep every company after a register refresh — a newer edition makes
    earlier conclusions stale, so they become eligible again automatically.

    Bounded by `limit` and by the configured concurrency, and never raises: a
    per-company failure is counted and reported rather than aborting the batch.
    """
    settings = get_settings()
    rest = _require_supabase(settings)

    if not settings.anthropic_api_key:
        raise HTTPException(
            status_code=500,
            detail="Server is not configured with an Anthropic API key.",
        )

    async with httpx.AsyncClient() as client:
        stats = await resolve_companies(
            client,
            rest,
            None,
            api_key=settings.anthropic_api_key,
            model=settings.sponsor_resolver_model,
            timeout=settings.request_timeout,
            concurrency=settings.sponsor_resolve_concurrency,
            max_companies=limit,
            force=force,
        )

    return {"status": "completed", **stats.as_dict(), "errors": stats.errors[:10]}


@router.get("/stats", response_model=SponsorshipStatsResponse)
async def sponsorship_stats(
    _user_id: str = Depends(get_current_user),
) -> SponsorshipStatsResponse:
    """How many companies hold a confirmed, currently-live sponsor licence.

    For the coach dashboard's headline KPI, which cannot read this from
    Supabase directly: the sponsorship tables are deny-by-default RLS,
    service-role-only, same as every other route on this router.

    Counted from `company_sponsorship_current` — the same view a single
    company's `licensed` status is derived from — so the KPI and the list
    badges can never disagree about what "sponsored" means. This is the
    global count, not scoped to the coach's visible companies: scoping it
    would mean shipping every company id to this endpoint on each dashboard
    load, which is not worth it for one number.
    """
    settings = get_settings()
    rest = _require_supabase(settings)

    async with httpx.AsyncClient() as client:
        # ponytail: row count, not count(distinct company_id) — PostgREST has
        # no distinct count, and the view is one row per company today
        # (221 rows / 221 companies). If a company ever matches two live
        # licences this over-counts; move to an RPC then.
        licensed = await rest.count(
            client, "company_sponsorship_current", {"select": "company_id"}
        )

    return SponsorshipStatsResponse(licensed_companies=licensed or 0)


COMPANY_PAGE_SIZE = 30


def _company_page_error(exc: httpx.HTTPStatusError) -> HTTPException:
    """What a failed `coach_company_page` call tells the coach.

    `coach_company_page` was added to migration 048 after 048 was first
    published, so a database that ran the earlier 048 (or none) has no such
    function and PostgREST answers 404 PGRST202. That is a deployment step, not
    a transient error, so it gets its own message naming the fix — as
    companies.py does for the permanent-delete function.
    """
    try:
        body = exc.response.json()
    except ValueError:
        body = None
    code = body.get("code") if isinstance(body, dict) else None
    logger.warning("coach_company_page failed: HTTP %s %s", exc.response.status_code, code or "")
    if code == "PGRST202":
        return HTTPException(
            status_code=503,
            detail=(
                "The database is missing coach_company_page(): section 4 of "
                "supabase/migrations/048_all_companies_and_hourly_expiry.sql "
                "has not been applied."
            ),
        )
    suffix = f" ({code})" if isinstance(code, str) and code else ""
    return HTTPException(
        status_code=502,
        detail=f"The company list could not be loaded: the database returned an error{suffix}.",
    )


@router.get("/companies", response_model=dict)
async def sponsored_company_page(
    scope: str = Query("licensed", pattern="^(licensed|all)$"),
    q: str = Query("", max_length=100),
    page: int = Query(1, ge=1),
    user_id: str = Depends(get_current_user),
) -> dict:
    """One page of the coach Sponsored Companies list (migration 048's
    `coach_company_page`): confirmed sponsors (`company_sponsorship_current`)
    by default or every company with `scope=all`, a name search, this coach's
    hidden companies left out, each row with its contact count, plus the total.

    Replaces the list downloading every company and then sending every id
    back as a `?company_ids=` URL for the contact counts.
    """
    settings = get_settings()
    rest = _require_supabase(settings)

    try:
        async with httpx.AsyncClient() as client:
            rows = await rest.rpc(
                client,
                "coach_company_page",
                {
                    "p_coach": user_id,
                    "p_licensed": scope == "licensed",
                    "p_q": q.strip() or None,
                    "p_offset": (page - 1) * COMPANY_PAGE_SIZE,
                    "p_limit": COMPANY_PAGE_SIZE,
                },
            )
    except httpx.HTTPStatusError as exc:
        # rest.rpc has already logged PostgREST's code and message. Before this
        # handler every database failure surfaced as a bare "500 Internal
        # Server Error" and the page could only say "Could not load companies
        # (500)".
        raise _company_page_error(exc) from exc
    except httpx.TimeoutException as exc:
        logger.warning("coach_company_page timed out")
        raise HTTPException(
            status_code=504, detail="The company list took too long to load. Try again."
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning("coach_company_page: could not reach Supabase (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=502, detail="The company list could not be loaded: the database didn't respond."
        ) from exc

    rows = rows or []
    return {
        "companies": [{k: v for k, v in row.items() if k != "total"} for row in rows],
        "total": rows[0]["total"] if rows else 0,
        "page_size": COMPANY_PAGE_SIZE,
    }


@router.post("/companies/statuses", response_model=dict[str, CompanySponsorshipStatusCompact])
async def bulk_company_sponsorship_statuses(
    body: SponsorshipStatusBatchRequest,
    _user_id: str = Depends(get_current_user),
) -> dict[str, CompanySponsorshipStatusCompact]:
    """Compact sponsorship status for many companies at once, keyed by id.

    For a list/badge view (e.g. the outreach company list) that would
    otherwise call GET /sponsors/companies/{id} once per company — an N+1
    the browser would pay for on every page load. This is the batched
    alternative: one request regardless of how many companies are shown,
    reusing the exact same status classification
    `GET /sponsors/companies/{id}` uses (`_classify_check` in service.py) —
    nothing about what counts as licensed/ambiguous/stale is redecided here.

    Returns only `{status, stale, checked_at}` per company — no organisation
    name, routes, confidence or error text. A requested id with no row in the
    response was not found; that is not raised as an error, so one bad id in
    a batch does not fail the rest of the list.
    """
    settings = get_settings()
    rest = _require_supabase(settings)

    async with httpx.AsyncClient() as client:
        statuses = await bulk_company_sponsorship_status(
            client, rest, body.company_ids
        )

    return {
        company_id: CompanySponsorshipStatusCompact(**status)
        for company_id, status in statuses.items()
    }


@router.get("/companies/{company_id}", response_model=CompanySponsorshipStatus)
async def get_company_sponsorship_status(
    company_id: str,
    _user_id: str = Depends(get_current_user),
) -> CompanySponsorshipStatus:
    """This company's coach-facing sponsorship status.

    One of five normalized states — licensed | ambiguous | no_match | error |
    not_checked — never the raw register/check rows. Coach-only like every
    route on this router: `get_current_user` admits `users.is_admin` or
    `ADMIN_USER_IDS` (app/auth.py). The sponsorship tables stay
    service-role-only; nothing here is queried by the browser directly.

    See `CompanySponsorshipStatus` for exactly what each field means and why
    `licensed` and the other four states are trusted for freshness differently.
    """
    settings = get_settings()
    rest = _require_supabase(settings)

    async with httpx.AsyncClient() as client:
        if await load_company(client, rest, company_id) is None:
            raise HTTPException(status_code=404, detail="Company not found.")
        status = await company_sponsorship_status(client, rest, company_id)

    return CompanySponsorshipStatus(**status)


@router.post("/companies/{company_id}/recheck", response_model=CompanySponsorshipStatus)
async def recheck_company_sponsorship(
    company_id: str,
    _user_id: str = Depends(get_current_user),
) -> CompanySponsorshipStatus:
    """Force a fresh sponsorship check for one company, then return its status.

    Reuses the batch worker (`resolve_companies`, force=True, one company) —
    NOT `service.resolve_company` — because the worker is the only path that
    writes `company_sponsorship_checks` as well as `company_sponsorship`;
    calling the one-shot resolver directly would leave the check row stale for
    an ambiguous/no_match outcome. No matching logic is duplicated here.
    """
    settings = get_settings()
    rest = _require_supabase(settings)

    if not settings.anthropic_api_key:
        raise HTTPException(
            status_code=500,
            detail="Server is not configured with an Anthropic API key.",
        )

    async with httpx.AsyncClient() as client:
        if await load_company(client, rest, company_id) is None:
            raise HTTPException(status_code=404, detail="Company not found.")

        batch = await resolve_companies(
            client,
            rest,
            [company_id],
            api_key=settings.anthropic_api_key,
            model=settings.sponsor_resolver_model,
            timeout=settings.request_timeout,
            concurrency=1,
            max_companies=1,
            force=True,
        )
        if batch.skipped_reason:
            raise HTTPException(
                status_code=409,
                detail="No sponsor register has been imported yet.",
            )
        status = await company_sponsorship_status(client, rest, company_id)

    return CompanySponsorshipStatus(**status)
