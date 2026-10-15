"""Pure text-cleaning and classification helpers for the contact import
wizard (mapping.py). Written for the AI TEAM contacts workbook, whose messy
cells they were tested against. No I/O, no Supabase, no openpyxl — every
function here takes plain strings/values and returns plain values.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Optional

_WS_RE = re.compile(r"\s+")
_URL_RE = re.compile(r"^https?://", re.IGNORECASE)
_GENERAL_RE = re.compile(r"\(\s*general\s*\)", re.IGNORECASE)

# Words that mark a line as a job title / role descriptor rather than a
# second person's name — used both to decide whether a "Name - Title" split
# is safe, and whether a second line in a multi-line contact cell is a title
# continuation of the first line rather than a distinct second contact.
_TITLE_KEYWORDS = (
    "director",
    "manager",
    "recruit",
    "consult",
    "executive",
    "specialist",
    "coordinator",
    "officer",
    "partner",
    "associate",
    "founder",
    "owner",
    "lead",
    "head",
    "president",
    "principal",
    "resourcer",
    "talent",
)


def nfkc(value: Optional[str]) -> Optional[str]:
    """Unicode-normalize, collapsing e.g. mathematical-bold "𝟎𝟕𝟒𝟖𝟖" to "0748"
    and "𝐑𝐞𝐞𝐜𝐞@..." to "Reece@..." — a styled-text copy/paste artifact seen in
    the source sheet. A no-op for ordinary text."""
    if value is None:
        return None
    return unicodedata.normalize("NFKC", value)


def collapse_ws(value: str) -> str:
    return _WS_RE.sub(" ", value).strip()


def looks_like_url(text: str) -> bool:
    return bool(_URL_RE.match(text.strip()))


def looks_like_email(text: str) -> bool:
    return "@" in text


def looks_like_phone(text: str) -> bool:
    """Mostly digits, with UK-phone punctuation (space, +, (), -) allowed,
    and at least 7 digits — enough to separate a real phone number from
    stray text without trying to fully validate it."""
    digits = re.sub(r"\D", "", text)
    if len(digits) < 7:
        return False
    allowed = set("0123456789 ()+-\n\t")
    return all(ch in allowed for ch in text)


def strip_general_suffix(text: str) -> tuple[str, bool]:
    """Removes a "(general)" marker (any casing/spacing), returning the
    cleaned text and whether one was found — so the caller can preserve
    that as a note instead of silently discarding it (requirement: "clean
    (general) etc. from email/phone and preserve as notes if useful")."""
    cleaned, count = _GENERAL_RE.subn("", text)
    return collapse_ws(cleaned), count > 0


_TRAILING_PAREN_RE = re.compile(r"\(([^()]*)\)\s*$")


def strip_trailing_annotation(text: str) -> tuple[str, Optional[str]]:
    """Strips one trailing "(...)" annotation — "(Coventry)", "(London
    Office)", "(BIrmingham Office)" — the same "etc." this workbook's
    "(general)" markers belong to (see `strip_general_suffix`, which
    handles that one specific, most-common case with its own wording).
    Returns (remaining_text, annotation_or_None); the caller only acts on
    the annotation when the remaining text still looks like a phone number
    — a trailing "(...)" is not always this kind of noise (e.g. a company
    name that itself ends in a parenthetical), so this never fires blind."""
    match = _TRAILING_PAREN_RE.search(text)
    if not match:
        return text, None
    remainder = text[: match.start()].strip()
    annotation = match.group(1).strip()
    return remainder, (annotation or None)


def fix_excel_float_phone(value: float) -> str:
    """Excel silently reinterprets a "phone number" like "01753 621902" as
    the integer 1753621902 when it isn't entered as text, dropping the
    leading 0 every UK number starts with. Every float phone value observed
    in the source sheet is exactly 10 digits once that 0 is gone, which is
    the tell this fix relies on: restore it rather than passing the bare
    digit string through unchanged and silently wrong."""
    digits = str(int(value))
    if len(digits) == 10:
        return "0" + digits
    return digits


def _clean_cell_text(raw: object, *, label: str, notes: list[str]) -> Optional[str]:
    """Excel-float fix + NFKC + "(general)" stripping for one D/E cell,
    stopping short of deciding what *kind* of value it holds — that's
    `_classify` below, applied to both cells together so a value can be
    reassigned to the field it actually belongs in, not the column it
    happened to be typed into."""
    if raw is None:
        return None
    if isinstance(raw, float):
        text = fix_excel_float_phone(raw)
    else:
        text = nfkc(str(raw)) or ""

    text, had_general = strip_general_suffix(text)
    if had_general:
        notes.append(f"{label} listed as a general/shared line, not a named direct one.")
    return text.strip() or None


def normalize_phone_email(
    phone_raw: object, email_raw: object
) -> tuple[Optional[str], Optional[str], Optional[str], list[str]]:
    """Cleans the D (phone) and E (email) cells of one JOB AGENCIES UK row
    into (phone, email, linkedin_url, notes).

    Classifies each cell's cleaned text by content rather than trusting
    column position: the source sheet has real rows where a person's name
    or a LinkedIn profile URL was typed into the phone column instead of
    a phone number (a fat-fingered column, not a phone number that merely
    looks odd) — treating those as phone numbers would silently create a
    contact with a nonsense phone field. A LinkedIn URL found this way is
    recovered as `linkedin_url` (real, useful data in the wrong cell);
    anything else unrecognized is kept only as a note, never guessed into
    a field it doesn't belong in.
    """
    notes: list[str] = []
    d_text = _clean_cell_text(phone_raw, label="Phone", notes=notes)
    e_text = _clean_cell_text(email_raw, label="Email", notes=notes)

    phone: Optional[str] = None
    email: Optional[str] = None
    linkedin_url: Optional[str] = None

    for text, column in ((d_text, "phone"), (e_text, "email")):
        if text is None:
            continue

        candidate = text
        annotation_note = None
        if not looks_like_phone(candidate):
            remainder, annotation = strip_trailing_annotation(candidate)
            if annotation and looks_like_phone(remainder):
                candidate = remainder
                annotation_note = f"{column.capitalize()} annotated: {annotation}"

        if looks_like_url(candidate) and "linkedin.com/in/" in candidate.lower():
            if linkedin_url is None:
                linkedin_url = candidate
                notes.append(f"LinkedIn profile URL found in the {column} column; used as linkedin_url.")
            else:
                notes.append(f"Unrecognized value in the {column} column, kept as a note: {text!r}")
        elif looks_like_email(candidate):
            if email is None:
                email = candidate
            else:
                notes.append(f"Unrecognized value in the {column} column, kept as a note: {text!r}")
        elif looks_like_phone(candidate):
            if phone is None:
                phone = candidate
                if annotation_note:
                    notes.append(annotation_note)
            else:
                notes.append(f"Unrecognized value in the {column} column, kept as a note: {text!r}")
        else:
            notes.append(f"Unrecognized value in the {column} column, kept as a note: {text!r}")

    return phone, email, linkedin_url, notes


def strip_linkedin_wrapper(text: str) -> str:
    """Strips the sheet's own decorations around a name: a leading rank-like
    "(20) " counter and a trailing " | LinkedIn" suffix. Neither carries any
    information about the person — the number resets per some internal
    ordering visible in the sheet, not a contact attribute."""
    stripped = text.strip()
    stripped = re.sub(r"^\(\d+\)\s*", "", stripped)
    stripped = re.sub(r"\s*\|\s*LinkedIn\s*$", "", stripped, flags=re.IGNORECASE)
    return stripped.strip()


def looks_like_person_name(text: str) -> bool:
    """True for short, title-free text that's plausibly just "First Last" —
    used to decide whether a " - " in a contact cell is safe to read as
    "Name - Job title" (and not, e.g., "Job title - Name - Extra")."""
    words = text.split()
    if not (1 <= len(words) <= 4):
        return False
    lowered = text.lower()
    return not any(keyword in lowered for keyword in _TITLE_KEYWORDS)


def split_name_and_title(text: str) -> tuple[str, Optional[str]]:
    """Splits "Ryan Kaye - Managing Director" into ("Ryan Kaye", "Managing
    Director"). Only splits when the part before " - " reads as a plausible
    name on its own — otherwise (e.g. "Executive Recruiter - Kelly Howe -
    Career Consultants", where the first segment is itself a title) the
    split would silently mislabel a job title as a person's name, so the
    whole string is kept as the name instead: an unparsed name is honest,
    a wrongly-parsed one is not."""
    if " - " not in text:
        return text, None
    name, _, rest = text.partition(" - ")
    name = name.strip()
    rest = rest.strip()
    if name and looks_like_person_name(name):
        return name, rest or None
    return text, None


def looks_like_title_continuation(line: str) -> bool:
    """True for a second line in a multi-line contact cell that reads as a
    continuation of the first line's job title (e.g. "Managing Director Of
    Specialist Staffing") rather than a second, distinct person."""
    lowered = line.lower()
    return any(keyword in lowered for keyword in _TITLE_KEYWORDS)


def normalize_person_name(name: str) -> str:
    """Case/whitespace-insensitive key for "company + normalized name"
    contact dedup — the second tier, used only when no email match applies."""
    return collapse_ws(nfkc(name) or "").casefold()


def extract_linkedin_job_id(url: str) -> Optional[str]:
    """Best-effort `source_job_id` from a LinkedIn job-view URL
    (".../jobs/view/4418807838/..."), for traceability — never required."""
    match = re.search(r"/jobs/view/(\d+)", url)
    return match.group(1) if match else None
