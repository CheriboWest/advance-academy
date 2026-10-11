"""Shared data models for the crawler."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class NormalizedJob:
    """A job normalized to a source-agnostic shape."""

    source: str
    source_job_id: str
    company_name: str
    title: str
    city: str
    salary_min: Optional[int] = None
    salary_max: Optional[int] = None
    source_url: Optional[str] = None
    posted_at: Optional[str] = None  # ISO 8601
    location_raw: Optional[str] = None
    website: Optional[str] = None
    # When the source says the vacancy closes (ISO 8601, UTC). Only Reed
    # states one; Adzuna's search API has no closing date, so it stays None and
    # the pipeline never lets a None overwrite a date already stored.
    expires_at: Optional[str] = None


def compute_display_stats(
    *,
    normalized_jobs: int,
    inserted_jobs: int,
    updated_jobs: int,
    duplicate_jobs: int,
) -> dict[str, int]:
    """The four coach-facing metrics, derived from the internal counters.

    Single source of truth for both a live `CrawlStats` (mid-crawl / just
    finalized) and a `crawl_runs` row read back later — the two are computed
    the same way so the log line, the API response, and the frontend cards
    can never drift from each other.

    Decision (an already-existing job that gets refreshed, i.e.
    `updated_jobs`, is shown to the coach as a duplicate, not as new): from
    the coach's point of view nothing new appeared in the pipeline — the same
    posting was recognized again, whether that happened within this crawl
    (`duplicate_jobs`) or against a posting from an earlier crawl
    (`updated_jobs`). `updated_jobs` itself is NOT deleted or renamed — it
    stays a distinct internal counter (is the upsert-refresh path actually
    being exercised?) — it is simply folded into "Duplicate jobs" here.

    `jobs_verified` = `normalized_jobs + duplicate_jobs`, i.e. every raw job
    that made it far enough to be normalized and content-hashed, whether it
    then became a new job, a refresh of an existing one, or an in-crawl
    repeat. This is deliberately NOT "only inserted jobs", NOT "jobs
    currently active in the whole database", and NOT "manually reviewed" —
    it is jobs from *this* crawl that the pipeline successfully processed.
    Today every raw job reaches normalization (nothing is rejected earlier),
    so this equals `raw_jobs`; the formula is expressed in terms of
    `normalized_jobs + duplicate_jobs` rather than reusing `raw_jobs`
    directly so that a future validation step that drops malformed raw jobs
    before normalization would correctly lower `jobs_verified` below
    `raw_jobs` without any change here.
    """
    return {
        "new_jobs": inserted_jobs,
        "duplicate_jobs_total": duplicate_jobs + updated_jobs,
        "jobs_verified": normalized_jobs + duplicate_jobs,
    }


def _empty_source_bucket() -> dict[str, int]:
    return {"new": 0, "duplicate": 0, "verified": 0, "companies_created": 0}


@dataclass
class CrawlStats:
    """Aggregated statistics for a crawl run.

    Identities: raw_jobs = normalized_jobs + duplicate_jobs, and
    normalized_jobs = inserted_jobs + updated_jobs.

    These fields are the pipeline's *internal* breakdown — kept for debugging
    and for the `[finalize] crawl finalized: ...` log line. They do NOT map
    1:1 to `crawl_runs` columns; see `as_persisted_columns` for what actually
    gets written to the database, and why.
    """

    raw_jobs: int = 0
    normalized_jobs: int = 0
    inserted_jobs: int = 0
    updated_jobs: int = 0
    duplicate_jobs: int = 0
    companies_created: int = 0
    companies_updated: int = 0
    source_errors: dict[str, str] = field(default_factory=dict)
    # Companies this crawl created or updated. Carried so the post-crawl
    # sponsorship hook knows what to look at without re-querying; not a
    # statistic, so it is excluded from `as_columns()`.
    affected_company_ids: list[str] = field(default_factory=list)
    # Companies touched this crawl that don't have an ai_summary yet (either
    # brand new, or pre-existing but never summarised) — the post-crawl
    # summary sweep's worklist. Deliberately separate from
    # affected_company_ids rather than reusing it.
    companies_needing_summary: list[str] = field(default_factory=list)
    # Per-source breakdown, for the `[crawl-source] <name>: ...` log lines
    # only — never persisted (crawl_runs has one row per run, not per
    # source). Keyed by source name ("adzuna", "reed"); see
    # `record_source_outcome`.
    per_source: dict[str, dict[str, int]] = field(default_factory=dict)
    # The (query, city) pair currently being crawled — reset by `begin_pair`,
    # never persisted. They decide whether this pair's fetches may be recorded
    # in `crawl_fetches`, the evidence the stale-job sweep relies on:
    #   pair_fetches   source -> results it returned; None = it failed or
    #                  was requested but not configured.
    #   pair_complete  False once anything means not every returned job was
    #                  stored and sighted (a dropped job, a failed sightings
    #                  write, migration 046 not applied).
    pair_fetches: dict[str, Optional[int]] = field(default_factory=dict)
    pair_complete: bool = True

    def begin_pair(self) -> None:
        self.pair_fetches = {}
        self.pair_complete = True

    def record_source_outcome(
        self,
        source: str,
        *,
        new: int = 0,
        duplicate: int = 0,
        verified: int = 0,
        companies_created: int = 0,
    ) -> None:
        bucket = self.per_source.setdefault(source, _empty_source_bucket())
        bucket["new"] += new
        bucket["duplicate"] += duplicate
        bucket["verified"] += verified
        bucket["companies_created"] += companies_created

    def as_columns(self) -> dict[str, int]:
        """The internal breakdown — used for logging, not persistence."""
        return {
            "raw_jobs": self.raw_jobs,
            "normalized_jobs": self.normalized_jobs,
            "inserted_jobs": self.inserted_jobs,
            "updated_jobs": self.updated_jobs,
            "duplicate_jobs": self.duplicate_jobs,
            "companies_created": self.companies_created,
            "companies_updated": self.companies_updated,
        }

    def as_display_columns(self) -> dict[str, int]:
        """The four coach-facing metrics — see `compute_display_stats`."""
        return compute_display_stats(
            normalized_jobs=self.normalized_jobs,
            inserted_jobs=self.inserted_jobs,
            updated_jobs=self.updated_jobs,
            duplicate_jobs=self.duplicate_jobs,
        )

    def as_persisted_columns(self) -> dict[str, int]:
        """Exactly the `crawl_runs` columns this run's statistics are written
        to — confirmed by inspecting a real completed run's live row, NOT
        assumed from the migration files.

        `new_jobs`, `duplicate_jobs`, `companies_discovered`, and
        `companies_updated` are migration 0001's original columns and are
        confirmed present on the live table. `raw_jobs`/`normalized_jobs`/
        `inserted_jobs`/`companies_created`/`updated_jobs` (migrations
        0002/0005) are NOT written here — writing them in the same UPDATE as
        the confirmed columns is exactly what caused every statistic to be
        silently discarded (see `_finalize`'s tiered write): PostgREST/
        Postgres UPDATE is all-or-nothing, so bundling one nonexistent column
        with several real ones fails the whole statement, not just the
        unknown field.

        `jobs_verified` is written to `jobs_found` — an existing column, not
        one this codebase's own migrations ever defined (0001 has
        `jobs_fetched`, not `jobs_found`), but confirmed live twice over: a
        real completed run's row has it, and `_cached_jobs_available` in
        app/routers/discover.py already selected it (before this fix, into a
        variable it then never actually read — a second, independent bug in
        the same family, fixed alongside this one) for the "N jobs
        available" cache banner. Reused rather than adding a new column, per
        the explicit preference to not grow the schema when an existing
        column already carries the right meaning.
        """
        display = self.as_display_columns()
        return {
            "new_jobs": display["new_jobs"],
            "duplicate_jobs": display["duplicate_jobs_total"],
            "companies_discovered": self.companies_created,
            "companies_updated": self.companies_updated,
            "jobs_found": display["jobs_verified"],
        }
