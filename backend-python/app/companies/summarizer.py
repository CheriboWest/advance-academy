"""Short, factual company summaries — generated at write time, not on render.

A summary is (re)generated exactly three ways (see callers): when a company
is first created by the crawler, after crawl enrichment for a company that
doesn't have one yet, or via a coach's manual refresh
(POST /companies/{id}/summary/refresh). It is never generated inside a page
request — every page just reads the stored `companies.ai_summary` column
(exposed through `public_company_summary`, see migration 0013).

Grounded in stored data only: name, sector, location, website domain,
current open jobs (as role *types*, not a raw title dump), and sponsorship
status — and sponsorship only when the confirmed status is "licensed".
When there isn't enough stored data to say anything specific, or the AI call
fails, `as_columns()`'s caller falls back to `fallback_summary()`, a plain
template with no model call and nothing invented.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx

from app.crawler.supabase_rest import SupabaseRest
from app.sponsors.service import company_sponsorship_status

COMPANY_COLUMNS = "id,name,sector,region,hq_location,website,ai_summary"

# How many distinct job titles to hand to the model as hiring signal — a
# sample for it to generalise from ("engineering and technical roles"), not
# a listing to reproduce verbatim.
MAX_JOB_TITLES = 8

SYSTEM_PROMPT = (
    "You write short, factual company summaries for a UK company/job "
    "discovery platform used by students and career coaches.\n\n"
    "Write exactly 2 to 4 sentences, plain and informative, no marketing "
    "language, no exclamation marks, no superlatives. State only what the "
    "supplied data supports — never invent an industry, location, "
    "headcount, founding date, or anything else not given to you. "
    "Generalise job titles into role types (e.g. 'engineering and "
    "technical roles') rather than listing them verbatim. Mention "
    "sponsorship only if it is explicitly given as confirmed — if no "
    "sponsorship information is provided, do not speculate about it either "
    "way.\n\n"
    "Return only the summary text."
)

SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {"summary": {"type": "string"}},
    "required": ["summary"],
    "additionalProperties": False,
}


@dataclass
class CompanySummaryContext:
    company_id: str
    name: str
    sector: Optional[str]
    location: Optional[str]
    website_domain: Optional[str]
    open_jobs: int
    job_titles: list[str]
    sponsorship_status: Optional[str]
    sponsorship_organisation_name: Optional[str]


def _domain(website: Optional[str]) -> Optional[str]:
    if not website:
        return None
    try:
        netloc = urlparse(website if "//" in website else f"//{website}").netloc
    except ValueError:
        return None
    return netloc.removeprefix("www.") or None


async def load_context(
    client: httpx.AsyncClient, rest: SupabaseRest, company_id: str
) -> Optional[CompanySummaryContext]:
    """Gather everything the summary can draw on, fresh — not from whatever
    a crawl happened to have in memory, so this works identically whether
    called from the crawler or the manual-refresh endpoint."""
    rows = await rest.select(
        client,
        "companies",
        {"id": f"eq.{company_id}", "select": COMPANY_COLUMNS, "limit": "1"},
    )
    if not rows:
        return None
    company = rows[0]

    jobs = await rest.select(
        client,
        "jobs",
        {
            "company_id": f"eq.{company_id}",
            "is_active": "eq.true",
            "select": "title",
        },
    )
    titles: list[str] = []
    seen: set[str] = set()
    for job in jobs:
        title = (job.get("title") or "").strip()
        if title and title.lower() not in seen:
            seen.add(title.lower())
            titles.append(title)
        if len(titles) >= MAX_JOB_TITLES:
            break

    status = await company_sponsorship_status(client, rest, company_id)
    sponsorship_status = status.get("status")
    match = status.get("match") or {}

    return CompanySummaryContext(
        company_id=company_id,
        name=company.get("name") or "This company",
        sector=company.get("sector"),
        location=company.get("hq_location") or company.get("region"),
        website_domain=_domain(company.get("website")),
        open_jobs=len(jobs),
        job_titles=titles,
        sponsorship_status=sponsorship_status,
        sponsorship_organisation_name=match.get("organisation_name"),
    )


def has_enough_data(context: CompanySummaryContext) -> bool:
    """At least one concrete fact beyond the bare name — otherwise even a
    template summary would be nothing but filler."""
    return bool(context.sector or context.location or context.open_jobs > 0)


def _role_types_phrase(context: CompanySummaryContext) -> Optional[str]:
    if context.open_jobs <= 0:
        return None
    plural = "role" if context.open_jobs == 1 else "roles"
    return f"{context.open_jobs} open {plural}"


def fallback_summary(context: CompanySummaryContext) -> str:
    """Deterministic, template-based — no model call, nothing invented.
    Used when there isn't enough data for a worthwhile AI summary, and as
    the safety net if the AI call itself fails."""
    if not has_enough_data(context):
        return f"{context.name} does not yet have enough information for a summary."

    clauses: list[str] = [context.name]
    if context.location and context.sector:
        clauses.append(f"is a {context.location}-based company in the {context.sector} sector")
    elif context.location:
        clauses.append(f"is based in {context.location}")
    elif context.sector:
        clauses.append(f"operates in the {context.sector} sector")
    sentence_one = " ".join(clauses) + "."

    sentences = [sentence_one]

    jobs_phrase = _role_types_phrase(context)
    if jobs_phrase:
        sentences.append(f"It currently has {jobs_phrase} listed.")

    if context.sponsorship_status == "licensed":
        org = context.sponsorship_organisation_name
        sentences.append(
            "It is listed on the UK sponsor register"
            + (f" as {org}" if org else "")
            + "."
        )

    return " ".join(sentences)


def build_prompt(context: CompanySummaryContext) -> str:
    lines = [
        "Write a short summary of this company from the data below.\n",
        f"Name: {context.name}",
    ]
    if context.sector:
        lines.append(f"Sector: {context.sector}")
    if context.location:
        lines.append(f"Location: {context.location}")
    if context.website_domain:
        lines.append(f"Website domain: {context.website_domain}")
    lines.append(f"Currently open jobs: {context.open_jobs}")
    if context.job_titles:
        lines.append("Open job titles: " + "; ".join(context.job_titles))
    if context.sponsorship_status == "licensed":
        lines.append(
            "Sponsorship: confirmed on the UK sponsor register"
            + (
                f" (registered as {context.sponsorship_organisation_name})"
                if context.sponsorship_organisation_name
                else ""
            )
        )
    return "\n".join(lines) + "\n"


def generate_ai_summary(context: CompanySummaryContext, *, api_key: str, model: str, timeout: float) -> str:
    """Calls Claude. Raises on any failure — callers decide whether to fall
    back to `fallback_summary()` or surface the error."""
    import anthropic

    client = anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=1)
    message = client.messages.create(
        model=model,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        output_config={
            "format": {"type": "json_schema", "schema": SUMMARY_SCHEMA},
        },
        messages=[{"role": "user", "content": build_prompt(context)}],
    )

    if getattr(message, "stop_reason", None) == "refusal":
        raise ValueError("The AI declined to generate this summary.")

    text = "".join(
        block.text for block in message.content if getattr(block, "type", None) == "text"
    ).strip()
    data = json.loads(text)
    summary = data["summary"].strip()
    if not summary:
        raise ValueError("The AI returned an empty summary.")
    return summary


async def store_summary(
    client: httpx.AsyncClient, rest: SupabaseRest, company_id: str, summary: str
) -> None:
    await rest.update(
        client,
        "companies",
        {"id": f"eq.{company_id}"},
        {
            "ai_summary": summary,
            "ai_summary_generated_at": datetime.now(timezone.utc).isoformat(),
        },
    )


async def generate_and_store_summary(
    client: httpx.AsyncClient,
    rest: SupabaseRest,
    company_id: str,
    *,
    api_key: Optional[str],
    model: str,
    timeout: float,
    fallback_on_error: bool,
) -> Optional[str]:
    """Full flow for one company: load context, generate (AI if there's
    enough data and a key is configured, otherwise the template), store,
    return the text. `None` if the company doesn't exist.

    `fallback_on_error`: if the AI call itself fails, True quietly stores
    the template instead (the post-crawl sweep's contract: never surface a
    generation failure as a crawl failure); False re-raises (the manual
    refresh endpoint's contract: the coach who clicked "Regenerate" should
    see that it failed, not silently get a worse result).
    """
    context = await load_context(client, rest, company_id)
    if context is None:
        return None

    if has_enough_data(context) and api_key:
        try:
            # The model call is synchronous, so it runs in a worker thread —
            # awaiting it on the event loop froze the entire API for up to
            # `timeout` seconds per company (same reasoning as
            # app/sponsors/worker.py's `_resolve_with_retry`).
            summary = await asyncio.to_thread(
                generate_ai_summary,
                context,
                api_key=api_key,
                model=model,
                timeout=timeout,
            )
        except Exception:
            if not fallback_on_error:
                raise
            summary = fallback_summary(context)
    else:
        summary = fallback_summary(context)

    await store_summary(client, rest, company_id, summary)
    return summary
