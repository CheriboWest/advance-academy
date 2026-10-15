"""Row-level extraction: turn one raw worksheet row into structured
candidates (company name, job, contact) plus a list of reasons a row (or
part of it) couldn't be safely turned into data — never a guess passed
through silently.

Pure functions only — no I/O. The import wizard's mapping.py supplies the
raw cell values; matching against the database happens in SQL
(contact_import_classify, migration 049), never here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlparse

from app.contacts_import.clean import (
    collapse_ws,
    extract_linkedin_job_id,
    looks_like_title_continuation,
    looks_like_url,
    nfkc,
    normalize_phone_email,
    split_name_and_title,
    strip_linkedin_wrapper,
)


@dataclass
class RawCell:
    value: object = None
    hyperlink: Optional[str] = None


@dataclass
class CompanyNameResult:
    """The outcome of reading a company-name cell (column A)."""

    name: Optional[str]
    website: Optional[str] = None
    inferred_from_domain: bool = False
    ambiguous_reason: Optional[str] = None


@dataclass
class JobCandidate:
    title: str
    source_url: Optional[str]
    source_job_id: Optional[str] = None


@dataclass
class ContactCandidate:
    full_name: str
    job_title: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    linkedin_url: Optional[str] = None
    notes: Optional[str] = None


@dataclass
class AgencyRowOutcome:
    row_number: int
    company: CompanyNameResult
    job: Optional[JobCandidate] = None
    contact: Optional[ContactCandidate] = None
    ambiguous: list[str] = field(default_factory=list)


@dataclass
class CompanyRowOutcome:
    row_number: int
    company: CompanyNameResult
    job: Optional[JobCandidate] = None
    ambiguous: list[str] = field(default_factory=list)


def _domain_label(url: str) -> Optional[str]:
    """"https://www.get-recruited.co.uk/" -> "Get Recruited" — a best-effort,
    mechanically-derived display name for the rare case where a company's
    name cell holds nothing but a URL. Not a guess at *content*: every part
    of the label comes from the domain the sheet itself gave us."""
    try:
        host = urlparse(url).netloc or urlparse(f"//{url}").netloc
    except ValueError:
        return None
    host = host.removeprefix("www.")
    label = host.split(".")[0] if host else ""
    words = [w for w in label.replace("-", " ").replace("_", " ").split() if w]
    if not words:
        return None
    return " ".join(w.capitalize() for w in words)


def extract_company_name(
    raw_value: object,
    hyperlink: Optional[str],
    *,
    allow_domain_fallback: bool,
) -> CompanyNameResult:
    """Reads a company-name cell. `allow_domain_fallback` should only be
    true for JOB AGENCIES UK, where a bare-URL name cell's hyperlink is
    reliably the agency's own site; UK COMPANIES' equivalent cells link to
    a job board or LinkedIn posting, not the employer's own domain, so
    guessing a name from that URL would likely be wrong rather than merely
    imperfect — those are reported ambiguous instead.
    """
    if raw_value is None:
        return CompanyNameResult(name=None, ambiguous_reason="No company name in this row.")

    text = collapse_ws(nfkc(str(raw_value)) or "")
    if not text:
        return CompanyNameResult(name=None, ambiguous_reason="Blank company name.")

    if looks_like_url(text):
        website = hyperlink or text
        if allow_domain_fallback:
            label = _domain_label(website)
            if label:
                return CompanyNameResult(
                    name=label, website=website, inferred_from_domain=True
                )
        return CompanyNameResult(
            name=None,
            ambiguous_reason=(
                f"Company name cell contains only a URL, no readable company "
                f"name: {text!r}"
            ),
        )

    # A genuine display name. For JOB AGENCIES UK the cell's own hyperlink
    # (when present) is the agency's homepage — captured as a candidate
    # `website` for a newly-created company only (never overwrites an
    # existing one).
    website = hyperlink if allow_domain_fallback and hyperlink else None
    return CompanyNameResult(name=text, website=website)


def _extract_job(text_value: object, hyperlink: Optional[str]) -> tuple[Optional[JobCandidate], Optional[str], Optional[str]]:
    """Returns (job_candidate, ambiguous_reason, note_text).

    `note_text` covers the JOB AGENCIES UK pattern of a "Link Job/Company"
    cell that holds a recruiter's status note ("no suitable roles
    available", "worth a chat") instead of an actual job link — real in
    that sheet, distinguishable only by the absence of a hyperlink, and
    worth keeping as context rather than silently discarding.
    """
    if text_value is None:
        return None, None, None

    text = collapse_ws(nfkc(str(text_value)) or "")
    if not text:
        return None, None, None

    if hyperlink is None:
        # Text with no link: in the observed data this is always a note,
        # never a job title — a real job title in this column always came
        # with a link to it.
        return None, None, text

    if looks_like_url(text):
        return (
            None,
            f"Job link has no distinct title text (the display text is the "
            f"URL itself): {text!r}",
            None,
        )

    if text.rstrip().lower().endswith("linkedin") and "|" in text:
        title = text.split("|", 1)[0].strip()
    else:
        title = text

    if not title:
        return None, f"Job link had no usable title text: {text!r}", None

    return (
        JobCandidate(
            title=title,
            source_url=hyperlink,
            source_job_id=extract_linkedin_job_id(hyperlink),
        ),
        None,
        None,
    )


def _extract_contact(
    linkedin_value: object,
    linkedin_hyperlink: Optional[str],
    phone_raw: object,
    email_raw: object,
    extra_note: Optional[str],
) -> tuple[Optional[ContactCandidate], Optional[str]]:
    """Returns (contact_candidate, ambiguous_reason)."""
    phone, email, cell_linkedin_url, contact_notes = normalize_phone_email(phone_raw, email_raw)

    if extra_note:
        contact_notes.append(f"Recruiter note: {extra_note}")

    def _lost_data_reason() -> Optional[str]:
        # No name to attach to. Only worth flagging if there's actually
        # something here to lose — including an unrecognized phone/email
        # cell value (e.g. a name typed into the phone column) that
        # normalize_phone_email couldn't classify into any field but kept
        # as a note rather than silently dropping.
        if phone or email or cell_linkedin_url or contact_notes:
            return (
                f"Phone/email/LinkedIn present with no contact name in this "
                f"row (phone={phone!r}, email={email!r}, "
                f"linkedin={cell_linkedin_url!r}, notes={contact_notes!r})."
            )
        return None

    if linkedin_value is None:
        return None, _lost_data_reason()

    text = nfkc(str(linkedin_value)) or ""
    lines = [collapse_ws(l) for l in text.split("\n") if collapse_ws(l)]
    if not lines:
        return None, _lost_data_reason()

    url_lines = [l for l in lines if looks_like_url(l)]
    text_lines = [l for l in lines if not looks_like_url(l)]

    if not text_lines:
        return None, (
            f"Contact cell has a link but no readable name: {text!r}"
        )

    link_notes = [f"Link: {u}" for u in url_lines]

    if len(text_lines) == 1:
        primary = text_lines[0]
    else:
        rest = text_lines[1:]
        if all(looks_like_title_continuation(l) for l in rest):
            primary = text_lines[0] + " - " + " ".join(rest)
        else:
            return None, (
                f"Multiple distinct contacts listed in one cell — cannot "
                f"safely attribute the row's shared phone/email to any one "
                f"of them: {text!r}"
            )

    stripped = strip_linkedin_wrapper(primary)
    name, job_title = split_name_and_title(stripped)
    name = name.strip()
    if not name:
        return None, f"Could not extract a usable contact name from: {text!r}"

    linkedin_url = None
    profile_note = None
    if linkedin_hyperlink:
        if "linkedin.com/in/" in linkedin_hyperlink.lower():
            linkedin_url = linkedin_hyperlink
        else:
            profile_note = f"Profile: {linkedin_hyperlink}"
    if linkedin_url is None and cell_linkedin_url:
        # A profile URL recovered from the phone/email columns (see
        # normalize_phone_email) is just as usable as one from the
        # LinkedIn column's own hyperlink — only used as a fallback so it
        # never overrides a genuine one already found there.
        linkedin_url = cell_linkedin_url

    all_notes = contact_notes + link_notes + ([profile_note] if profile_note else [])

    if not (phone or email or linkedin_url):
        return None, (
            f"No reachable contact method (email/phone/LinkedIn) for "
            f"{name!r}."
        )

    return (
        ContactCandidate(
            full_name=name,
            job_title=job_title,
            phone=phone,
            email=email,
            linkedin_url=linkedin_url,
            notes="; ".join(all_notes) or None,
        ),
        None,
    )


def extract_agency_row(
    row_number: int,
    company: CompanyNameResult,
    link_cell: RawCell,
    linkedin_cell: RawCell,
    phone_raw: object,
    email_raw: object,
) -> AgencyRowOutcome:
    """JOB AGENCIES UK: Company (forward-filled, pre-resolved as `company`),
    Link Job/Company, LinkedIn, Phone, Email."""
    ambiguous: list[str] = []

    if company.ambiguous_reason:
        ambiguous.append(company.ambiguous_reason)

    job, job_ambiguous, note_text = _extract_job(link_cell.value, link_cell.hyperlink)
    if job_ambiguous:
        ambiguous.append(job_ambiguous)

    contact, contact_ambiguous = _extract_contact(
        linkedin_cell.value, linkedin_cell.hyperlink, phone_raw, email_raw, note_text
    )
    if contact_ambiguous:
        ambiguous.append(contact_ambiguous)
    elif note_text and contact is None:
        # A recruiter note with no contact on this row to attach it to —
        # not lost silently, just not attributable to anyone.
        ambiguous.append(f"Recruiter note with no contact on this row to attach it to: {note_text!r}")

    return AgencyRowOutcome(
        row_number=row_number,
        company=company,
        job=job if company.name else None,
        contact=contact if company.name else None,
        ambiguous=ambiguous,
    )


def extract_company_row(
    row_number: int,
    company: CompanyNameResult,
    job_cell: RawCell,
) -> CompanyRowOutcome:
    """UK COMPANIES: COMPANY, JOB TITLE/LINK. No forward-fill and no
    contact columns at all."""
    ambiguous: list[str] = []
    if company.ambiguous_reason:
        ambiguous.append(company.ambiguous_reason)

    job, job_ambiguous, _note_text = _extract_job(job_cell.value, job_cell.hyperlink)
    if job_ambiguous:
        ambiguous.append(job_ambiguous)

    return CompanyRowOutcome(
        row_number=row_number,
        company=company,
        job=job if company.name else None,
        ambiguous=ambiguous,
    )
