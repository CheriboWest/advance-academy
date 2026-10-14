"""Orchestration: company → candidate search → resolution → stored link."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.crawler.supabase_rest import SupabaseRest
from app.sponsors.candidates import CandidateSearch
from app.sponsors.resolver import Resolution, resolve

logger = logging.getLogger("careerhub.sponsors.service")

COMPANY_COLUMNS = "id,name,slug,website,sector,region,hq_location"
LINK_TABLE = "company_sponsorship"
CHECK_TABLE = "company_sponsorship_checks"
IMPORTS_TABLE = "sponsor_register_imports"
LICENCES_TABLE = "sponsor_licences"
# PostgREST's per-response row cap.
COMPANY_PAGE = 1000


async def latest_register_import_id(
    client: httpx.AsyncClient, rest: SupabaseRest
) -> Optional[str]:
    """The id of the most recent successful register import, if any.

    A company's conclusion is pinned to the edition it was drawn against, so a
    newer edition is what makes that conclusion stale.
    """
    rows = await rest.select(
        client,
        IMPORTS_TABLE,
        {
            "select": "id",
            "status": "eq.success",
            "order": "started_at.desc",
            "limit": "1",
        },
    )
    return str(rows[0]["id"]) if rows else None


async def record_check(
    client: httpx.AsyncClient,
    rest: SupabaseRest,
    company_id: str,
    *,
    decision: str,
    candidate_count: int,
    matched_licence_id: Optional[str] = None,
    register_import_id: Optional[str] = None,
    attempts: int = 0,
    error: Optional[str] = None,
) -> None:
    """Record what the last attempt concluded for this company.

    `attempts` is the CUMULATIVE COUNT OF FAILED MODEL HTTP ATTEMPTS for this
    company against `register_import_id`, since its last successful conclusion —
    not resolution runs, and not successful calls. Three transient failures in
    one run advance it by 3. A run that reaches any conclusion (match,
    ambiguous or no_match) resets it to 0, because the company is no longer
    failing. The caller owns that arithmetic; this function just stores it.

    Upserted on `company_id`, so repeating a resolution overwrites the state
    rather than accumulating rows.
    """
    now = datetime.now(timezone.utc).isoformat()
    await rest.upsert(
        client,
        CHECK_TABLE,
        [
            {
                "company_id": company_id,
                "last_decision": decision,
                "candidate_count": candidate_count,
                "matched_licence_id": matched_licence_id,
                "register_import_id": register_import_id,
                "attempts": attempts,
                "error": error,
                "checked_at": now,
                "updated_at": now,
            }
        ],
        on_conflict="company_id",
        prefer="resolution=merge-duplicates,return=minimal",
    )


# A company that keeps failing must stop costing model calls. Nine cumulative
# failed attempts against one register edition — three runs at the per-run limit
# — is where automatic retrying stops and manual review takes over.
MAX_CUMULATIVE_ATTEMPTS = 9


async def companies_needing_resolution(
    client: httpx.AsyncClient,
    rest: SupabaseRest,
    company_ids: Optional[list[str]] = None,
    *,
    limit: int = 200,
    current_import: Optional[str] = None,
) -> list[str]:
    """Company ids whose sponsorship conclusion is missing or stale.

    A company needs resolving when it has never been checked, when it was
    checked against an older register edition, or when its last attempt errored
    AND it has not yet exhausted its retry budget. Everything else is skipped —
    that is what keeps a crawl from re-resolving the same companies every run,
    and what stops a permanently failing company from burning model calls
    forever.

    A newer register edition reopens everything, exhausted budget included: the
    candidate data has changed, so the previous failure says nothing about the
    new question.
    """
    if current_import is None:
        current_import = await latest_register_import_id(client, rest)

    if company_ids is not None:
        if not company_ids:
            return []
        return _stale_ids(
            company_ids, await checks_for(client, rest, company_ids), current_import, limit
        )

    # Walk every company, newest first, one PostgREST page (COMPANY_PAGE rows,
    # its cap) at a time, until `limit` stale ones are found. This used to look
    # only at the newest `limit * 4` companies, so once those were checked older
    # ones were never reached and stayed "Not checked". `id` breaks created_at
    # ties so pages don't overlap.
    stale: list[str] = []
    offset = 0
    while len(stale) < limit:
        rows = await rest.select(
            client,
            "companies",
            {
                "select": "id",
                "order": "created_at.desc,id",
                "limit": str(COMPANY_PAGE),
                "offset": str(offset),
            },
        )
        page = [str(row["id"]) for row in rows]
        if page:
            stale += _stale_ids(
                page, await checks_for(client, rest, page), current_import, limit - len(stale)
            )
        if len(rows) < COMPANY_PAGE:
            break
        offset += len(rows)
    return stale


def _stale_ids(
    pool: list[str],
    checks: dict[str, dict[str, Any]],
    current_import: Optional[str],
    limit: int,
) -> list[str]:
    """The ids in `pool` whose check is missing, from an older register
    edition, or an error still under its retry budget — at most `limit`."""
    stale: list[str] = []
    for company_id in pool:
        check = checks.get(str(company_id))
        same_edition = (
            check is not None
            and current_import is not None
            and str(check.get("register_import_id") or "") == current_import
        )

        if check is None:
            stale.append(str(company_id))
        elif current_import is not None and not same_edition:
            # A newer edition reopens the question regardless of past failures.
            stale.append(str(company_id))
        elif check.get("last_decision") == "error":
            attempts = int(check.get("attempts") or 0)
            if attempts < MAX_CUMULATIVE_ATTEMPTS:
                stale.append(str(company_id))
            else:
                logger.info(
                    "company_id=%s left for manual review: %d cumulative failed "
                    "attempts against the current register edition (cap %d). "
                    "Use force to retry.",
                    company_id, attempts, MAX_CUMULATIVE_ATTEMPTS,
                )
        if len(stale) >= limit:
            break
    return stale


async def checks_for(
    client: httpx.AsyncClient, rest: SupabaseRest, company_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """Existing check rows for these companies, keyed by company id.

    Chunked at 100 to keep the `in.(...)` URL a sane length, and the chunks are
    gathered rather than awaited one after another — a serial loop here put
    ceil(n/100) round trips end to end on the critical path of every Sponsored
    Companies page load.
    """
    chunks = [
        company_ids[index : index + 100]
        for index in range(0, len(company_ids), 100)
    ]
    results = await asyncio.gather(
        *(
            rest.select(
                client,
                CHECK_TABLE,
                {
                    "select": (
                        "company_id,last_decision,register_import_id,attempts,"
                        "checked_at,candidate_count"
                    ),
                    "company_id": f"in.({','.join(chunk)})",
                },
            )
            for chunk in chunks
        )
    )

    found: dict[str, dict[str, Any]] = {}
    for rows in results:
        for row in rows:
            found[str(row["company_id"])] = row
    return found


async def load_company(
    client: httpx.AsyncClient, rest: SupabaseRest, company_id: str
) -> Optional[dict[str, Any]]:
    rows = await rest.select(
        client,
        "companies",
        {"id": f"eq.{company_id}", "select": COMPANY_COLUMNS, "limit": "1"},
    )
    return rows[0] if rows else None


async def store_resolution(
    client: httpx.AsyncClient,
    rest: SupabaseRest,
    resolution: Resolution,
    model: str,
) -> None:
    """Persist the resolution.

    Only a `match` carries a licence id, so only a match can ever be read as a
    sponsorship link. An `ambiguous` result has no candidate to key on, so there
    is nothing to store — it is logged for review instead of being written as a
    half-link that a later reader might mistake for a match.
    """
    if resolution.decision != "match" or not resolution.selected_candidate_id:
        logger.info(
            "No link stored for company %s (decision=%s, confidence=%.2f)",
            resolution.company_id, resolution.decision, resolution.confidence,
        )
        return

    await rest.upsert(
        client,
        LINK_TABLE,
        [
            {
                "company_id": resolution.company_id,
                "sponsor_licence_id": resolution.selected_candidate_id,
                "decision": resolution.decision,
                "confidence": round(resolution.confidence, 2),
                "matched_on": resolution.matched_on,
                "reasoning": resolution.reasoning,
                "resolved_by": "claude",
                "model": model,
                "resolved_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        ],
        on_conflict="company_id,sponsor_licence_id",
        prefer="resolution=merge-duplicates,return=minimal",
    )
    logger.info(
        "Linked company %s to licence %s (confidence %.2f)",
        resolution.company_id,
        resolution.selected_candidate_id,
        resolution.confidence,
    )


async def _current_match(
    client: httpx.AsyncClient, rest: SupabaseRest, company_id: str
) -> Optional[dict[str, Any]]:
    """The confirmed, currently-live sponsor match for a company, or None.

    Reads `company_sponsorship` directly rather than the
    `company_sponsorship_current` view: the view gives everything the response
    needs about the matched row EXCEPT `normalized_name`/`normalized_town`,
    which grouping sibling routes needs, so this queries `sponsor_licences`
    itself for both the matched row's display fields and its grouping key in
    one place.

    `None` when there is no `match` link, or when the matched licence has
    stopped being current — the latter cannot happen for a check run against
    today's edition (identity is confirmed at the moment the row was live), but
    is handled rather than assumed, since it costs nothing to check.
    """
    links = await rest.select(
        client,
        LINK_TABLE,
        {
            "select": "sponsor_licence_id,confidence,resolved_at",
            "company_id": f"eq.{company_id}",
            "decision": "eq.match",
            "limit": "1",
        },
    )
    if not links:
        return None
    link = links[0]

    licences = await rest.select(
        client,
        LICENCES_TABLE,
        {
            "select": (
                "organisation_name,town_city,county,type_rating,licence_type,"
                "rating,route,normalized_name,normalized_town,is_current"
            ),
            "id": f"eq.{link['sponsor_licence_id']}",
            "limit": "1",
        },
    )
    if not licences or not licences[0].get("is_current"):
        return None
    licence = licences[0]

    # Sibling routes for the same organisation at the same registered site —
    # the register carries no organisation-level id, so (normalized_name,
    # normalized_town) is the closest safe grouping key, and it is the same
    # key the candidate matcher itself uses for exact identity lookup.
    town = licence.get("normalized_town")
    sibling_filter = {
        "select": "route",
        "is_current": "eq.true",
        "normalized_name": f"eq.{licence['normalized_name']}",
    }
    sibling_filter["normalized_town"] = (
        f"eq.{town}" if town else "is.null"
    )
    siblings = await rest.select(client, LICENCES_TABLE, sibling_filter)
    routes = sorted({s["route"] for s in siblings if s.get("route")})
    if licence.get("route") and licence["route"] not in routes:
        routes.append(licence["route"])
        routes.sort()

    return {
        "organisation_name": licence["organisation_name"],
        "town_city": licence.get("town_city"),
        "county": licence.get("county"),
        "type_rating": licence.get("type_rating"),
        "licence_type": licence.get("licence_type"),
        "rating": licence.get("rating"),
        "routes": routes,
        "confidence": float(link.get("confidence") or 0.0),
        "resolved_at": link.get("resolved_at"),
    }


def _classify_check(
    *,
    matched: bool,
    check: Optional[dict[str, Any]],
    latest_import: Optional[str],
    match_checked_at: Optional[str] = None,
) -> dict[str, Any]:
    """The one place `status`/`stale`/`checked_at`/`candidate_count` are decided.

    Both `company_sponsorship_status` (full detail, one company) and
    `bulk_company_sponsorship_status` (compact, many companies) call this —
    neither re-derives the state machine itself, only what feeds it differs
    (a per-company `_current_match` lookup for the former, a batched set
    membership check for the latter). See `CompanySponsorshipStatus` in
    app/schemas.py for why `licensed` needs no staleness check while the other
    four states do.
    """
    if matched:
        return {
            "status": "licensed",
            "checked_at": (check or {}).get("checked_at") or match_checked_at,
            "candidate_count": (check or {}).get("candidate_count"),
            "stale": False,
        }

    if check is None:
        return {
            "status": "not_checked",
            "checked_at": None,
            "candidate_count": None,
            "stale": False,
        }

    check_import = check.get("register_import_id")
    is_stale = (
        latest_import is not None and str(check_import or "") != latest_import
    )
    if is_stale:
        return {
            "status": "not_checked",
            "checked_at": check.get("checked_at"),
            "candidate_count": check.get("candidate_count"),
            "stale": True,
        }

    decision = check.get("last_decision")
    status_value = (
        decision if decision in ("ambiguous", "no_match", "error") else "not_checked"
    )
    return {
        "status": status_value,
        "checked_at": check.get("checked_at"),
        "candidate_count": check.get("candidate_count"),
        "stale": False,
    }


async def company_sponsorship_status(
    client: httpx.AsyncClient, rest: SupabaseRest, company_id: str
) -> dict[str, Any]:
    """The coach-facing sponsorship status for one company, full detail.

    See `CompanySponsorshipStatus` (app/schemas.py) for the field-by-field
    contract. For many companies at once, see
    `bulk_company_sponsorship_status` — this makes 2-3 database round trips
    per call and is not meant to be called in a per-company loop.
    """
    latest_import = await latest_register_import_id(client, rest)
    match = await _current_match(client, rest, company_id)
    checks = await checks_for(client, rest, [company_id])
    check = checks.get(str(company_id))

    classified = _classify_check(
        matched=match is not None,
        check=check,
        latest_import=latest_import,
        match_checked_at=(match or {}).get("resolved_at"),
    )
    return {
        "company_id": company_id,
        "register_import_id": latest_import,
        "match": {k: v for k, v in match.items() if k != "resolved_at"}
        if match is not None
        else None,
        **classified,
    }


async def _current_matches_bulk(
    client: httpx.AsyncClient, rest: SupabaseRest, company_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """Which of these companies have a confirmed, currently-live match.

    Keyed by company id; each value carries only `resolved_at` — the compact
    status the list badge needs has no use for organisation name, routes or
    confidence, so this skips the per-company sibling-route lookup
    `_current_match` does and stays to two batched queries regardless of how
    many companies are asked for.
    """
    if not company_ids:
        return {}

    link_results = await asyncio.gather(
        *(
            rest.select(
                client,
                LINK_TABLE,
                {
                    "select": "company_id,sponsor_licence_id,resolved_at",
                    "company_id": f"in.({','.join(company_ids[index : index + 100])})",
                    "decision": "eq.match",
                },
            )
            for index in range(0, len(company_ids), 100)
        )
    )

    links: dict[str, dict[str, Any]] = {}
    for rows in link_results:
        for row in rows:
            links[str(row["company_id"])] = row

    if not links:
        return {}

    # The licence lookup genuinely depends on the links above (it needs their
    # licence ids), so these are two waves, not one — but each wave is itself
    # concurrent rather than a serial chunk loop.
    licence_ids = sorted({row["sponsor_licence_id"] for row in links.values()})
    licence_results = await asyncio.gather(
        *(
            rest.select(
                client,
                LICENCES_TABLE,
                {
                    "select": "id,is_current",
                    "id": f"in.({','.join(licence_ids[index : index + 100])})",
                    "is_current": "eq.true",
                },
            )
            for index in range(0, len(licence_ids), 100)
        )
    )

    current_licence_ids: set[str] = set()
    for rows in licence_results:
        current_licence_ids.update(str(row["id"]) for row in rows)

    return {
        company_id: {"resolved_at": row.get("resolved_at")}
        for company_id, row in links.items()
        if str(row["sponsor_licence_id"]) in current_licence_ids
    }


async def bulk_company_sponsorship_status(
    client: httpx.AsyncClient, rest: SupabaseRest, company_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """Compact sponsorship status for many companies, for a list/badge view.

    Keyed by company id: `{status, stale, checked_at}` — deliberately not the
    organisation name, routes, confidence or error text
    `company_sponsorship_status` returns; a coach scanning a list of company
    names has no use for those, and the full detail stays one click away at
    the single-company endpoint. A company id with no row in the result was
    not found (the caller decides what that means — this function does not
    raise for an unknown id, so one bad id in a batch does not fail the rest).

    Three *phases*, however many companies are asked for — the latest
    successful register, the confirmed matches, and the existing check rows —
    for `1 + 2*ceil(n/100) + ceil(licences/100)` queries in total, not the
    "three queries" an earlier version of this docstring claimed. What matters
    is that the per-company work is O(1) round trips rather than O(n), which is
    the reason this function exists instead of the caller looping
    `company_sponsorship_status` once per id.

    The three phases are independent of each other, so they are gathered rather
    than awaited in sequence: run serially they were three full round trips to
    PostgREST stacked end to end on every Sponsored Companies page load.
    """
    if not company_ids:
        return {}

    latest_import, matches, checks = await asyncio.gather(
        latest_register_import_id(client, rest),
        _current_matches_bulk(client, rest, company_ids),
        checks_for(client, rest, company_ids),
    )

    result: dict[str, dict[str, Any]] = {}
    for company_id in company_ids:
        match = matches.get(company_id)
        check = checks.get(company_id)
        result[company_id] = _classify_check(
            matched=match is not None,
            check=check,
            latest_import=latest_import,
            match_checked_at=(match or {}).get("resolved_at"),
        )
    return result


async def resolve_company(
    client: httpx.AsyncClient,
    rest: SupabaseRest,
    company_id: str,
    *,
    api_key: str,
    model: str,
    timeout: float = 30.0,
    anthropic_client: Any = None,
    persist: bool = True,
) -> tuple[Optional[Resolution], list[dict[str, Any]], list[str]]:
    """Resolve one company end to end.

    Returns `(resolution, candidates, strategies)`; the resolution is None when
    the company id does not exist.
    """
    company = await load_company(client, rest, company_id)
    if company is None:
        return None, [], []

    candidates, strategies = await CandidateSearch(rest).find(
        client, name=company.get("name") or "", city=company.get("hq_location")
        or company.get("region"),
    )

    resolution = resolve(
        company,
        candidates,
        api_key=api_key,
        model=model,
        timeout=timeout,
        client=anthropic_client,
    )

    if persist:
        await store_resolution(client, rest, resolution, model)

    return resolution, candidates, strategies
