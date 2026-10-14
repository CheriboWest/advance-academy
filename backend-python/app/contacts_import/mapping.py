"""Applies an admin's column mapping to raw rows (upload.py) and produces what
the database classifies: one `extracted` record per row, plus row-level
errors.

Reuses the cleaning rules written for this workbook (clean.py / rows.py):
Excel-float phones, "(general)" markers, styled-unicode text, "Name - Title"
splits, " | LinkedIn" wrappers, multi-person cells. What this module adds is
the wizard's rules:

* Grouping: with `group_fill`, a blank company cell continues the company
  above it — but only until a COMPLETELY blank row. After that, a row with no
  company is an error, never a guess.
* Nothing is guessed: a company cell holding only a URL gives a website, not
  a name; display text is a URL only if it is a valid one; a LinkedIn URL is
  only a profile if it is one (linkedin.com/in/...).
* Job titles / links / free text are source information: kept with the row,
  never turned into a job or a contact field.

Matching and normalization for duplicates live in the database (migration
048, ci_norm_*) so preview and commit can never disagree.
"""

from __future__ import annotations

import re
from typing import Any, Optional
from urllib.parse import urlparse

from app.contacts_import.clean import collapse_ws, nfkc
from app.contacts_import.rows import _extract_contact
from app.crawler.normalize import canonical_company_name, company_slug

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s.]+$")
_LINKEDIN_PROFILE_RE = re.compile(
    r"^https?://(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com/in/[^/?#\s]+/?(?:[?#]\S*)?$", re.I
)
_LINKISH_RE = re.compile(r"(https?://|www\.|linkedin\.com|\.(com|co\.uk|org|net|io)\b)", re.I)
_BARE_DOMAIN_RE = re.compile(r"^(?:www\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(/\S*)?$", re.I)

CONTACT_ROLES = {"contact", "contact_name", "contact_linkedin_url", "contact_job_title", "phone", "email"}


def valid_url(text: Optional[str]) -> Optional[str]:
    """`text` if it is a usable http(s) URL with a real host, else None."""
    if not text:
        return None
    candidate = text.strip()
    if not candidate or any(ch.isspace() for ch in candidate):
        return None
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return None
    if parsed.scheme.lower() not in ("http", "https") or "." not in (parsed.hostname or ""):
        return None
    return candidate


def valid_website(text: Optional[str]) -> Optional[str]:
    """A company website from a website column: a full URL, or a bare domain
    such as "acme.co.uk" (written that way in sheets all the time), which is
    given an https:// prefix — the domain itself is never invented."""
    url = valid_url(text)
    if url:
        return url
    if text and _BARE_DOMAIN_RE.match(text.strip()):
        return "https://" + text.strip()
    return None


def is_linkedin_profile(url: Optional[str]) -> bool:
    return bool(url and _LINKEDIN_PROFILE_RE.match(url.strip()))


def _text(cell: Optional[dict[str, Any]]) -> Optional[str]:
    if not cell:
        return None
    value = cell.get("text")
    if value is None:
        return None
    cleaned = collapse_ws(nfkc(str(value)) or "")
    return cleaned or None


def _raw_value(cell: Optional[dict[str, Any]]) -> Any:
    """The cell value as the cleaners expect it: a float stays a float, so an
    Excel-mangled phone (1753621902.0) gets its leading 0 back."""
    if not cell:
        return None
    if cell.get("type") == "float":
        return float(cell["value"])
    if cell.get("type") == "int":
        return float(cell["value"])
    return cell.get("text")


def _cells_for(row_cells: dict[str, dict[str, Any]], columns: dict[str, str], role: str) -> list[dict[str, Any]]:
    return [row_cells[c] for c, r in columns.items() if r == role and c in row_cells]


def _first(row_cells: dict[str, dict[str, Any]], columns: dict[str, str], role: str) -> Optional[dict[str, Any]]:
    cells = _cells_for(row_cells, columns, role)
    return cells[0] if cells else None


def _company_from_cell(cell: Optional[dict[str, Any]], link_is_website: bool) -> tuple[Optional[str], Optional[str]]:
    """(name, website) from a company-name cell. A cell whose display text is
    a URL has no name — only, possibly, a website."""
    text = _text(cell)
    if not text:
        return None, None
    hyperlink = valid_url((cell or {}).get("hyperlink"))
    if valid_url(text) or (text.lower().startswith(("http://", "https://", "www."))):
        return None, hyperlink or valid_website(text)
    return canonical_company_name(text), (hyperlink if link_is_website else None)


def _source(row_cells: dict[str, dict[str, Any]], columns: dict[str, str]) -> Optional[dict[str, Any]]:
    cells = _cells_for(row_cells, columns, "source")
    if not cells:
        return None
    texts, url = [], None
    for cell in cells:
        text = _text(cell)
        link = valid_url(cell.get("hyperlink"))
        if text and valid_url(text) and not link:
            link, text = text, None
        if url is None and link:
            url = link
        if text and text != link:
            texts.append(text)
    if not texts and not url:
        return None
    return {"text": "; ".join(texts) or None, "url": url}


def _contact(row_cells: dict[str, dict[str, Any]], columns: dict[str, str]) -> tuple[Optional[dict], Optional[str], list[str]]:
    """Returns (contact, contact_error, warnings). `contact_error` means there
    was contact data on this row that could not be used safely."""
    if not _cells_for_any(row_cells, columns, CONTACT_ROLES):
        return None, None, []

    warnings: list[str] = []
    name_cell = _first(row_cells, columns, "contact") or _first(row_cells, columns, "contact_name")
    hyperlink = None
    if name_cell and name_cell in _cells_for(row_cells, columns, "contact"):
        hyperlink = valid_url(name_cell.get("hyperlink"))

    candidate, reason = _extract_contact(
        _text_preserving_lines(name_cell),
        hyperlink,
        _raw_value(_first(row_cells, columns, "phone")),
        _raw_value(_first(row_cells, columns, "email")),
        None,
    )

    url_cell = _first(row_cells, columns, "contact_linkedin_url")
    column_url = valid_url((url_cell or {}).get("hyperlink")) or valid_url(_text(url_cell))
    if url_cell and not is_linkedin_profile(column_url):
        warnings.append(f"LinkedIn column value is not a LinkedIn profile URL, ignored: {_text(url_cell)!r}")
        column_url = None

    if candidate is None and column_url and name_cell and reason and reason.startswith("No reachable contact method"):
        # The only contact method is in a dedicated LinkedIn URL column.
        candidate, reason = _extract_contact(_text_preserving_lines(name_cell), column_url, None, None, None)

    if candidate is None:
        return None, reason or "Contact columns are filled but no contact could be read.", warnings

    if _LINKISH_RE.search(candidate.full_name) or _BARE_DOMAIN_RE.match(candidate.full_name):
        # e.g. display text "linkedin.com/in/jane": not a valid URL, so not used
        # as one — and not a person's name either.
        return None, f"The contact cell holds link-like text, not a name: {candidate.full_name!r}.", warnings

    contact = {
        "full_name": candidate.full_name,
        "job_title": candidate.job_title,
        "email": candidate.email,
        "phone": candidate.phone,
        "linkedin_url": candidate.linkedin_url,
        "notes": candidate.notes,
    }
    title_cell = _text(_first(row_cells, columns, "contact_job_title"))
    if title_cell and not contact["job_title"]:
        contact["job_title"] = title_cell
    if column_url and not contact["linkedin_url"]:
        contact["linkedin_url"] = column_url

    # Only real values reach a contact field. Anything else is kept as a note.
    extra_notes = []
    if contact["email"] and not _EMAIL_RE.match(contact["email"]):
        extra_notes.append(f"Unrecognized email kept as a note: {contact['email']!r}")
        contact["email"] = None
    if contact["linkedin_url"] and not is_linkedin_profile(contact["linkedin_url"]):
        extra_notes.append(f"Link kept as a note (not a LinkedIn profile URL): {contact['linkedin_url']}")
        contact["linkedin_url"] = None
    if extra_notes:
        contact["notes"] = "; ".join([n for n in [contact["notes"], *extra_notes] if n])
    if not (contact["email"] or contact["phone"] or contact["linkedin_url"]):
        return None, f"No usable email, phone or LinkedIn profile for {contact['full_name']!r}.", warnings
    return contact, None, warnings


def _cells_for_any(row_cells: dict[str, dict[str, Any]], columns: dict[str, str], roles: set[str]) -> bool:
    return any(r in roles and c in row_cells for c, r in columns.items())


def _text_preserving_lines(cell: Optional[dict[str, Any]]) -> Optional[str]:
    """The contact cleaner splits on newlines (two people in one cell, or a
    name with its title on the next line), so newlines must survive."""
    if not cell or cell.get("text") is None:
        return None
    text = nfkc(str(cell["text"])) or ""
    return text if text.strip() else None


def apply_mapping(sheet_rows: list[dict[str, Any]], sheet_mapping: dict[str, Any]) -> list[dict[str, Any]]:
    """`sheet_rows`: [{row_number, cells}] in sheet order, blank rows included
    (cells == {}). Returns [{row_number, extracted, parse_errors}] for every
    non-blank row."""
    if not sheet_mapping.get("include", True):
        return [{"row_number": r["row_number"], "extracted": {"excluded": True}, "parse_errors": []}
                for r in sheet_rows if r["cells"]]

    columns: dict[str, str] = sheet_mapping.get("columns", {})
    group_fill = bool(sheet_mapping.get("group_fill"))
    link_is_website = bool(sheet_mapping.get("company_link_is_website"))

    out: list[dict[str, Any]] = []
    group: Optional[dict[str, Any]] = None   # {name, website, row}
    blank_since_group = False

    for row in sheet_rows:
        cells = row["cells"]
        if not cells:
            # A completely blank row ends the current company group.
            if group is not None:
                blank_since_group = True
            group = None
            continue

        errors: list[str] = []
        warnings: list[str] = []
        name, website = _company_from_cell(_first(cells, columns, "company_name"), link_is_website)
        site_cell = _first(cells, columns, "company_website")
        if site_cell:
            column_site = valid_website(_text(site_cell)) or valid_url(site_cell.get("hyperlink"))
            if column_site:
                website = column_site
            else:
                warnings.append(f"Website column value is not a URL, ignored: {_text(site_cell)!r}")

        company_cell_present = _first(cells, columns, "company_name") is not None
        group_row = None
        if name or website or company_cell_present:
            if group_fill:
                group = {"name": name, "website": website, "row": row["row_number"]}
                blank_since_group = False
            if company_cell_present and not name and not website:
                errors.append(f"The company cell has no readable name: {_text(_first(cells, columns, 'company_name'))!r}.")
        elif group_fill and group is not None:
            name, website, group_row = group["name"], group["website"], group["row"]
        elif group_fill:
            errors.append(
                "No company for this row: the company group ended at a blank row above it."
                if blank_since_group else "No company for this row and none above it to continue."
            )
        else:
            errors.append("No company name in this row.")

        contact, contact_error, contact_warnings = _contact(cells, columns)
        warnings.extend(contact_warnings)
        source = _source(cells, columns)

        if not errors and not (name or website):
            errors.append("No company name in this row.")

        extracted: dict[str, Any] = {
            "company": {
                "name": name,
                "slug": company_slug(name) if name else None,
                "website": website,
                "group_row": group_row,
            },
            "contact": contact,
            "source": source,
            "warnings": warnings,
        }
        if contact_error:
            extracted["contact_error"] = contact_error
        out.append({"row_number": row["row_number"], "extracted": extracted, "parse_errors": errors})
    return out


def validate_mapping(mapping: dict[str, Any], sheets: list[dict[str, Any]], roles: tuple[str, ...]) -> Optional[str]:
    """An error message, or None if the mapping can be applied."""
    known = {s["name"]: s for s in sheets}
    if not isinstance(mapping, dict) or not mapping:
        return "Provide a mapping for at least one sheet."
    included = 0
    for sheet_name, spec in mapping.items():
        if sheet_name not in known:
            return f"Unknown sheet {sheet_name!r}."
        if not isinstance(spec, dict):
            return f"The mapping for {sheet_name!r} must be an object."
        columns = spec.get("columns", {})
        if not isinstance(columns, dict):
            return f"Columns for {sheet_name!r} must be an object."
        for letter, role in columns.items():
            if letter not in known[sheet_name]["headers"]:
                return f"Sheet {sheet_name!r} has no column {letter!r}."
            if role not in roles:
                return f"Unknown role {role!r} for column {letter} of {sheet_name!r}."
        if spec.get("include", True):
            included += 1
            if "company_name" not in columns.values() and "company_website" not in columns.values():
                return f"Sheet {sheet_name!r} needs a company name or website column."
            if sum(1 for r in columns.values() if r == "company_name") > 1:
                return f"Sheet {sheet_name!r} maps more than one column to the company name."
    if included == 0:
        return "Include at least one sheet."
    return None
