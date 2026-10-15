"""Pydantic request/response models for the API."""

from __future__ import annotations

import re
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

# Deliberately a plain regex rather than pydantic's EmailStr/email-validator:
# that extra isn't in requirements.txt, and this project already validates
# email format this same loose way client-side (see the "Send to" field in
# components/coach/outreach-composer.tsx) — kept identical so the two never
# disagree about what counts as a valid address.
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


# Bounds the job-title list in the prompt — a hiring signal, not a full
# listing; keeps the request (and the resulting prompt) from growing
# unbounded for a company with many open roles.
MAX_OUTREACH_JOB_TITLES = 10


class OutreachRequest(BaseModel):
    """Structured context used to generate a personalised outreach email.

    Company fields are required context; contact/sponsorship/notes fields are
    all optional so this still works for a company with no contact chosen yet
    or no sponsorship check on record — the prompt builder (see
    app/routers/ai.py `_build_user_prompt`) only mentions what is actually
    provided, never fabricating a fact this request left blank.
    """

    company_name: str = Field(..., min_length=1, description="Company name.")
    location: Optional[str] = Field(None, description="Company location, if known.")
    sector: Optional[str] = Field(None, description="Company sector, if known.")
    open_jobs: int = Field(0, ge=0, description="Number of open jobs.")
    lead_score: int = Field(0, description="Outreach lead score (0–100).")
    open_job_titles: list[str] = Field(
        default_factory=list,
        max_length=MAX_OUTREACH_JOB_TITLES,
        description="Titles of currently open roles — concrete hiring "
        "signals, not just a count.",
    )

    contact_name: Optional[str] = Field(
        None, description="The recipient's name, for direct personalisation."
    )
    contact_role: Optional[str] = Field(
        None, description='The recipient\'s role, e.g. "Hiring Manager".'
    )

    # Only ever "licensed" in practice — see _build_user_prompt, which omits
    # sponsorship from the prompt entirely for every other status so the
    # model is never handed an unconfirmed or negative claim to reason about.
    sponsorship_status: Optional[str] = Field(
        None, description="This company's coach-facing sponsorship status."
    )
    sponsorship_organisation_name: Optional[str] = Field(
        None, description="The matched sponsor register legal entity name, if licensed."
    )

    company_notes: Optional[str] = Field(
        None, description="The coach's private notes about this company, if any."
    )
    contact_notes: Optional[str] = Field(
        None, description="The coach's private notes about this contact, if any."
    )


class OutreachResponse(BaseModel):
    """Generated outreach email."""

    subject: str
    body: str


class SendEmailRequest(BaseModel):
    """Request to send a saved outreach draft to a recipient."""

    draft_id: str = Field(..., min_length=1, description="outreach_emails row id.")
    to: str = Field(..., min_length=3, description="Recipient email address.")


class SendEmailResponse(BaseModel):
    """Result of sending an outreach email."""

    status: str
    sent_at: str
    recipient_email: str


class DiscoverStartRequest(BaseModel):
    """Request to start (or check the cache for) a crawl."""

    query: str = Field(..., min_length=1, description="Role / keyword.")
    city: str = Field(..., min_length=1, description="City.")
    sources: list[str] = Field(default_factory=lambda: ["adzuna", "reed"])
    force: bool = Field(False, description="Bypass the 24h cache and refresh now.")


class DiscoverStartResponse(BaseModel):
    """Either a cache hit (no crawl started) or a started run."""

    cached: bool
    run_id: Optional[str] = None
    status: Optional[str] = None
    last_refreshed_at: Optional[str] = None
    hours_ago: Optional[float] = None
    jobs_available: Optional[int] = None


class CrawlRunStatus(BaseModel):
    """A crawl run row + its statistics.

    `raw_jobs`/`normalized_jobs`/`inserted_jobs`/`updated_jobs`/
    `duplicate_jobs`/`companies_created`/`companies_updated` are the internal
    counters, unchanged — kept for the "Recent crawls" history table and for
    debugging. `new_jobs`/`duplicate_jobs_total`/`jobs_verified` are the
    coach-facing metrics shown on the "Crawl complete" cards, derived from
    the internal counters by `compute_display_stats`
    (see `app.crawler.models` for exactly how and why); `companies_created`
    is reused as-is for that card since its meaning already matches.
    """

    id: str
    status: str
    query: Optional[str] = None
    location: Optional[str] = None
    raw_jobs: int = 0
    normalized_jobs: int = 0
    inserted_jobs: int = 0
    updated_jobs: int = 0
    duplicate_jobs: int = 0
    companies_created: int = 0
    companies_updated: int = 0
    new_jobs: int = 0
    duplicate_jobs_total: int = 0
    jobs_verified: int = 0
    error: Optional[str] = None
    created_at: Optional[str] = None
    finished_at: Optional[str] = None


# Bulk deletion is one transaction on the database; the cap keeps a single
# request (and the URL-free JSON body it produces) to a sane size.
MAX_COMPANIES_PER_DELETE = 200


class DeleteCompaniesRequest(BaseModel):
    """Companies to permanently delete. Ids are validated as UUIDs by Pydantic."""

    company_ids: list[UUID] = Field(
        ...,
        min_length=1,
        max_length=MAX_COMPANIES_PER_DELETE,
        description="Company ids to delete permanently, for everyone.",
    )


class DeleteCompaniesResponse(BaseModel):
    """Outcome of a permanent deletion, reported per company id.

    `requested` counts the ids after de-duplication, so
    `deleted_companies + len(missing_company_ids) == requested` always holds —
    a partial result is visible rather than implied.
    """

    requested: int
    deleted_companies: int
    deleted_company_ids: list[str] = Field(default_factory=list)
    missing_company_ids: list[str] = Field(default_factory=list)
    deleted_jobs: int = 0
    deleted_coach_meta: int = 0
    unlinked_outreach_emails: int = 0
    deleted_contacts: int = 0


class CompanySummaryResponse(BaseModel):
    """Outcome of a manual company-summary refresh."""

    company_id: str
    ai_summary: str
    ai_summary_generated_at: str


class SponsorImportResponse(BaseModel):
    """Outcome of one sponsor-register ingestion run."""

    import_id: Optional[str] = None
    status: str
    source_url: Optional[str] = None
    register_published_at: Optional[str] = None
    rows_downloaded: int = 0
    rows_parsed: int = 0
    rows_rejected: int = 0
    rows_processed: int = 0
    rows_current_after: int = 0
    rows_withdrawn: int = 0

    # Deprecated since migration 0009 and always null. Kept so existing clients
    # keep parsing the response; see ImportStats for why they are not computed.
    rows_inserted: Optional[int] = None
    rows_updated: Optional[int] = None
    rows_unchanged: Optional[int] = None


class SponsorCandidate(BaseModel):
    """A register row offered to the resolver."""

    id: str
    organisation_name: str
    town_city: Optional[str] = None
    county: Optional[str] = None
    route: Optional[str] = None
    licence_type: Optional[str] = None
    rating: Optional[str] = None


class SponsorResolutionResponse(BaseModel):
    """The resolution for one company, after the code-side guardrails."""

    company_id: str
    selected_candidate_id: Optional[str] = None
    confidence: float = 0.0
    decision: str
    matched_on: list[str] = Field(default_factory=list)
    reasoning: str = ""
    candidates_considered: int = 0
    search_strategies: list[str] = Field(default_factory=list)
    persisted: bool = False


class SponsorshipMatch(BaseModel):
    """The confirmed sponsor, with sibling licence routes grouped in.

    One legal sponsor is several rows in `sponsor_licences` — one per route.
    `organisation_name`/`town_city`/`county`/`type_rating`/`licence_type`/
    `rating` describe the SPECIFIC row the resolver matched; `routes` lists
    every route currently live for that same organisation at that same
    registered location (grouped by `normalized_name`/`normalized_town`, since
    the register carries no organisation-level id). A sibling route with a
    different `type_rating` is not reflected here — see the endpoint's
    docstring.
    """

    organisation_name: str
    town_city: Optional[str] = None
    county: Optional[str] = None
    type_rating: Optional[str] = None
    licence_type: Optional[str] = None
    rating: Optional[str] = None
    routes: list[str] = Field(default_factory=list)
    confidence: float


class CompanySponsorshipStatus(BaseModel):
    """The coach-facing sponsorship status for one company.

    `status` is one of: licensed | ambiguous | no_match | error | not_checked.

    `licensed` is read from `company_sponsorship_current`, which is always
    current by construction (it joins `sponsor_licences.is_current`, kept live
    by register finalization) — so it needs no separate staleness check.

    The other four states come from `company_sponsorship_checks`, which DOES
    need one: `stale=true` means a check exists but was run against an older
    register edition than `register_import_id` (the current one), so its
    negative/inconclusive conclusion is not trusted as still current. The
    check's own `checked_at`/`candidate_count` are still returned when stale,
    so the UI can show "last checked <date>, against a previous edition"
    rather than nothing at all.

    `error` never carries the underlying exception text — only that a check
    failed.
    """

    company_id: str
    status: str
    checked_at: Optional[str] = None
    register_import_id: Optional[str] = None
    candidate_count: Optional[int] = None
    stale: bool = False
    match: Optional[SponsorshipMatch] = None


class CompanySponsorshipStatusCompact(BaseModel):
    """The list-badge shape: enough to render a status chip, nothing more.

    Deliberately excludes organisation name, routes, confidence and error
    text — a coach scanning a list of company names has no use for them, and
    they stay one click away via GET /sponsors/companies/{id}.
    """

    status: str
    stale: bool = False
    checked_at: Optional[str] = None


# One POST body, one JSON response — the cap keeps both to a sane size and
# bounds the chunked internal queries batch_company_sponsorship_status makes.
MAX_COMPANIES_PER_STATUS_BATCH = 500


class SponsorshipStatusBatchRequest(BaseModel):
    """Body for POST /sponsors/companies/statuses."""

    company_ids: list[str] = Field(
        default_factory=list, max_length=MAX_COMPANIES_PER_STATUS_BATCH
    )


class SponsorshipStatsResponse(BaseModel):
    """Body for GET /sponsors/stats — one headline number, not per-company.

    `licensed_companies` counts companies with a confirmed, currently-live
    sponsor licence: the same set that makes a company's status `licensed`.
    """

    licensed_companies: int


def _blank_to_none(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


class ContactWrite(BaseModel):
    """Shared body shape for creating and editing a contact.

    A contact must be reachable some way: at least one of email/phone/
    linkedin_url. Mirrors the `contacts_has_contact_method` database
    constraint (migration 0011) — checked here too so the coach gets a clear
    422 instead of a raw database error, and so a direct write that somehow
    bypassed the API would still be caught at the database.

    An edit form resubmits every field (not a sparse PATCH), so this same
    model is reused for both create and update — there is no partial-update
    "clear this field but leave that one" case to support.
    """

    full_name: str = Field(..., min_length=1, description="Contact's full name.")
    job_title: Optional[str] = Field(None, description='Role, e.g. "Hiring Manager".')
    email: Optional[str] = None
    phone: Optional[str] = None
    linkedin_url: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("email")
    @classmethod
    def _validate_email(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not _EMAIL_RE.match(value):
            raise ValueError("Enter a valid email address.")
        return value

    @model_validator(mode="before")
    @classmethod
    def _normalize_blanks(cls, data: object) -> object:
        # An edit form's untouched optional fields arrive as "", not absent —
        # treat blank the same as not provided, rather than persisting empty
        # strings that would (wrongly) count as a contact method.
        if isinstance(data, dict):
            for key in ("job_title", "email", "phone", "linkedin_url", "notes"):
                if key in data:
                    data[key] = _blank_to_none(data.get(key))
        return data

    @model_validator(mode="after")
    def _require_a_contact_method(self) -> "ContactWrite":
        if not (self.email or self.phone or self.linkedin_url):
            raise ValueError(
                "A contact needs at least one contact method: email, phone, "
                "or LinkedIn."
            )
        return self


class ContactCreate(ContactWrite):
    """Body for POST /contacts."""

    company_id: UUID


class Contact(BaseModel):
    """A company contact, as returned by the API."""

    id: str
    company_id: str
    full_name: str
    job_title: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    linkedin_url: Optional[str] = None
    notes: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ContactCompany(BaseModel):
    id: str
    name: str
    # Nullable: companies.slug has no NOT NULL (migration 024 added it without a
    # backfill), so older companies have none. Requiring it here turned one such
    # contact into a 500 for the whole Contact Directory. Link by id, not slug.
    slug: Optional[str] = None


class DirectoryContact(Contact):
    """A contact plus its company — one row of the coach Contact Directory."""

    company: Optional[ContactCompany] = None
