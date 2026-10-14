"""Regression test for "Sponsored Companies shows 0 contacts even though the
company detail page has contacts": `python test_sponsored_companies_contact_count_cache.py`
(no pytest, no network — static source checks, same style as
test_contacts_routes.py).

Root cause
----------
The Sponsored Companies list's contact count (features/career-hub/lib/contacts.ts's
getContactCounts, rendered by components/coach/sponsored-companies-list.tsx)
and the /contacts batch endpoint it calls (app/routers/contacts.py) were both
already correct — the FK-enforced `contacts.company_id` uuid column and the
same `company.id` used by both the list and the detail page rule out an id
mismatch, and test_contacts.py's existing batch-list checks already cover the
query itself.

The actual gap: every other coach mutation in this app revalidates the pages
whose rendered output it affects (see companies/actions.ts,
outreach/actions.ts), but contact create/edit/delete
(components/coach/contact-form-dialog.tsx, contacts-section.tsx) went
straight from the browser to the FastAPI backend with no corresponding
`revalidatePath` call. The Contacts section on the company detail page still
looked right immediately after an add, because it updates its own local
React state (`handleSaved`/`handleDelete` in contacts-section.tsx) — but the
separate Sponsored Companies list page kept serving whatever contact count
its own Next.js Router Cache entry held from the last time it was rendered,
which predates the new contact. Navigating back to the list (or reloading
it) showed the stale, pre-mutation count instead of the real one.

Fix: a new Server Action, `revalidateContactPaths` in
app/coach/(workspace)/sponsored-companies/actions.ts, revalidates both
`/coach/sponsored-companies` (the list, for the count) and
`/coach/sponsored-companies/{companyId}` (the detail page, for a reload) —
called from contacts-section.tsx after every successful save and delete,
matching the revalidation pattern already used everywhere else in this app.
"""

from __future__ import annotations

import re
from repo_paths import APP_DIR, CAREERHUB_DIR

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


ACTIONS_TS = (
    APP_DIR
    / "coach/(workspace)/sponsored-companies/actions.ts"
)
CONTACTS_SECTION_TSX = CAREERHUB_DIR / "components/coach/contacts-section.tsx"

# ---------------------------------------------------------------------------
# 1. The revalidation Server Action exists and revalidates both the list
#    (the contact count) and this company's own detail page.
# ---------------------------------------------------------------------------
check("sponsored-companies/actions.ts exists", ACTIONS_TS.exists(), f"looked at {ACTIONS_TS}")

if ACTIONS_TS.exists():
    actions_src = ACTIONS_TS.read_text()

    check('actions.ts is a Server Action module ("use server")',
          bool(re.search(r'^\s*"use server"', actions_src, re.MULTILINE)))

    check("actions.ts exports revalidateContactPaths",
          bool(re.search(r"export async function revalidateContactPaths\(", actions_src)))

    check('revalidateContactPaths revalidates "/coach/sponsored-companies" (the list)',
          bool(re.search(r'revalidatePath\(\s*"/coach/sponsored-companies"\s*\)', actions_src)))

    check("revalidateContactPaths revalidates this company's own detail page",
          bool(re.search(
              r"revalidatePath\(\s*`/coach/sponsored-companies/\$\{companyId\}`\s*\)",
              actions_src,
          )))
else:
    check("app/coach/(workspace)/sponsored-companies/actions.ts exists", False)

# ---------------------------------------------------------------------------
# 2. contacts-section.tsx actually calls it after a save and after a delete —
#    the two mutations that change the count. Without this, the action above
#    existing would be dead code and the bug would still reproduce.
# ---------------------------------------------------------------------------
check("contacts-section.tsx exists", CONTACTS_SECTION_TSX.exists())

if CONTACTS_SECTION_TSX.exists():
    section_src = CONTACTS_SECTION_TSX.read_text()

    check("contacts-section.tsx imports revalidateContactPaths from the "
          "sponsored-companies Server Action module",
          bool(re.search(
              r'import\s*\{\s*revalidateContactPaths\s*\}\s*from\s*'
              r'"@/app/coach/\(workspace\)/sponsored-companies/actions"',
              section_src,
          )))

    handle_saved = re.search(
        r"function handleSaved\([^)]*\)\s*\{(.*?)\n  \}", section_src, re.DOTALL
    )
    check("handleSaved() exists", bool(handle_saved))
    check("handleSaved() calls revalidateContactPaths(companyId) — an add or "
          "edit invalidates the stale list/detail cache",
          bool(handle_saved) and "revalidateContactPaths(companyId)" in handle_saved.group(1))

    handle_delete = re.search(
        r"function handleDelete\(\)\s*\{(.*?)\n  \}", section_src, re.DOTALL
    )
    check("handleDelete() exists", bool(handle_delete))
    check("handleDelete() calls revalidateContactPaths(companyId) on a "
          "successful delete — same cache invalidation as a save",
          bool(handle_delete) and "revalidateContactPaths(companyId)" in handle_delete.group(1))
else:
    check("features/career-hub/components/coach/contacts-section.tsx exists", False)

print()
if _failures:
    print(f"{len(_failures)} check(s) FAILED:")
    for f in _failures:
        print(f"  - {f}")
    raise SystemExit(1)
print("ALL SPONSORED COMPANIES CONTACT COUNT CACHE TESTS PASSED")
