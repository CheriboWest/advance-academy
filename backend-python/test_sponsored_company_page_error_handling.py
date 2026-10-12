"""Regression test for "Application error: a server-side exception has
occurred" on the coach Sponsored Company detail page ("View company"):
`python test_sponsored_company_page_error_handling.py` (no pytest, no
network).

Root cause: sponsorship status, active jobs, contacts, and outreach history
are each a separate live read (getSponsorshipStatus, fetchActiveJobs,
getContacts, getOutreachActivitiesForCompany) — three of the four `throw`
on any failure (an un-migrated table, a transient network error, ...), and
none of the page's four sibling pages (Companies, Sponsored Companies list,
Outreach dashboard) leave their equivalent fetch unguarded — each wraps it
in try/catch and renders a friendly EmptyState instead. This one page did
not, so any of those four failing reached Next.js as an unhandled
exception (an opaque digest page, no message) instead of the same friendly
message its siblings would show for the identical underlying failure.

This is a static source check, not a live reproduction (no test in this
repo can start the real Next.js server or hit a real Supabase project) —
it can't confirm any specific query succeeds or fails, only that a future
edit can't silently remove the try/catch this fix added without failing
here first.
"""

from __future__ import annotations

import re
from repo_paths import APP_DIR

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


PAGE_PATH = (
    APP_DIR
    / "coach/(workspace)/sponsored-companies/[companyId]/page.tsx"
)

source = PAGE_PATH.read_text()

check(f"{PAGE_PATH.name} exists", PAGE_PATH.exists())

# The four data-fetching calls that can each independently fail.
DATA_CALLS = [
    "getSponsorshipStatus",
    "fetchActiveJobs",
    "getContacts",
    "getOutreachActivitiesForCompany",
]

try_match = re.search(r"\btry\s*\{(.*?)\}\s*catch\s*\(([^)]*)\)\s*\{(.*?)\n  \}", source, re.DOTALL)
check("the page has a try/catch around its data fetching", try_match is not None)

if try_match:
    try_body, catch_param, catch_body = try_match.groups()

    for call in DATA_CALLS:
        check(
            f"{call}(...) is called inside the try block, not left unguarded",
            f"{call}(" in try_body,
            "not found inside the try block — a call left out here can crash "
            "the whole page again exactly as before this fix",
        )

    check(
        "the catch block renders EmptyState (the same pattern every sibling "
        "coach page uses), not a bare re-throw or a blank page",
        "EmptyState" in catch_body,
    )
    check(
        "the catch block extracts a message from the caught error rather "
        "than discarding it",
        "message" in catch_body and catch_param.strip() != "",
    )
    check(
        "the already-successfully-fetched company overview still renders "
        "on this error path (CompanyContextCard), not just an empty page",
        "CompanyContextCard" in catch_body,
    )

# The happy path must still render all five sections it always has — this
# fix must not have quietly dropped one while adding the try/catch.
for component in [
    "CompanyContextCard",
    "SponsorshipCard",
    "OpenJobsSection",
    "ContactsSection",
    "OutreachActivityList",
]:
    check(
        f"{component} is still rendered on the success path",
        source.count(component) >= 2,  # import + at least one usage
        "(expected at least an import and one JSX usage)",
    )

print()
if _failures:
    print(f"{len(_failures)} FAILED:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL SPONSORED COMPANY PAGE ERROR-HANDLING CHECKS PASSED")
