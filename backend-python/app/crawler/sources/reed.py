"""Reed API source adapter."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

from app.crawler.models import NormalizedJob

REED_URL = "https://www.reed.co.uk/api/1.0/search"

REQUEST_TIMEOUT = 20.0


def _to_int(value: object) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _parse_date(value: Optional[str]) -> Optional[str]:
    # Reed returns dates like "13/08/2026".
    if not value:
        return None
    try:
        return datetime.strptime(value, "%d/%m/%Y").date().isoformat()
    except ValueError:
        return None


def _parse_expiry(value: Optional[str]) -> Optional[str]:
    """Reed's `expirationDate` ("13/08/2026") as the moment the job closes.

    Reed gives a day, not a time, and the vacancy is open for all of it, so this
    is midnight UTC at the START of the next day. That is never earlier than
    the end of the day in London (exactly it in GMT, an hour after it in BST),
    so a job is never closed while Reed still lists it as open. Missing or
    unreadable → None, which means "no stated date", never "expired".
    """
    if not value:
        return None
    try:
        day = datetime.strptime(value.strip(), "%d/%m/%Y")
    except ValueError:
        return None
    return (day.replace(tzinfo=timezone.utc) + timedelta(days=1)).isoformat()


async def fetch(
    client: httpx.AsyncClient,
    api_key: str,
    query: str,
    city: str,
    limit: int = 25,
) -> list[NormalizedJob]:
    """Fetch jobs from Reed. Raises on transport/HTTP errors.

    Reed uses HTTP Basic auth with the API key as the username and an empty
    password.
    """
    params = {
        "keywords": query,
        "locationName": city,
        "resultsToTake": limit,
    }
    response = await client.get(
        REED_URL,
        params=params,
        auth=(api_key, ""),
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    data = response.json()

    jobs: list[NormalizedJob] = []
    for result in data.get("results", []):
        location = result.get("locationName") or city
        jobs.append(
            NormalizedJob(
                source="reed",
                source_job_id=str(result.get("jobId", "")),
                company_name=result.get("employerName") or "Unknown",
                title=result.get("jobTitle") or "",
                city=location,
                location_raw=location,
                salary_min=_to_int(result.get("minimumSalary")),
                salary_max=_to_int(result.get("maximumSalary")),
                source_url=result.get("jobUrl"),
                posted_at=_parse_date(result.get("date")),
                expires_at=_parse_expiry(result.get("expirationDate")),
            )
        )
    return jobs
