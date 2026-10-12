"""Regression test for a reported "Not Found" on submitting the Add Contact
modal: `python test_contacts_routes.py` (no pytest, no network).

The error text matters here. FastAPI/Starlette's own response for a request
that matches *no route at all* is the literal JSON body `{"detail": "Not
Found"}`. This router's own 404s say something else — "Company not found."
(create) or "Contact not found." (update/delete) — so a plain "Not Found"
means the request never reached this router's code; something upstream of
the handler (path, method, or route registration) didn't match.

Traced end to end on this branch:
  - features/career-hub/lib/contacts-api.ts calls `POST {baseUrl}/contacts` (create),
    `PUT {baseUrl}/contacts/{id}` (update), `DELETE {baseUrl}/contacts/{id}`.
  - features/career-hub/lib/contacts.ts calls `GET {baseUrl}/contacts?company_id=...`.
  - app/routers/contacts.py registers exactly those four routes under
    `APIRouter(prefix="/contacts")`.
  - app/main.py calls `app.include_router(contacts.router)`.
  - An in-process TestClient POST to /contacts reaches the handler (a
    throwaway body returns a 422 from Pydantic, not a 404 from routing).

No mismatch was found in this branch's code — see test_contacts.py, whose
existing checks already exercise every one of these routes successfully.
This file adds two things that test_contacts.py didn't: (1) a check tying
the *actual* registered OpenAPI paths to the *literal* path strings the
frontend source files construct, so a future rename on either side fails a
test instead of shipping silently; (2) confirmation that a 404 from this
router is always the router's own message, never the bare routing-layer
"Not Found" — so if that generic text is ever seen again in production, it
is diagnostic on its own: the deployed backend does not yet have this
route, i.e. it is running a commit older than the one that added it (the
same class of stale-deployment gap already hit twice before in this
project — the crawl-stats columns, and the sponsorship status routes).
"""

from __future__ import annotations

import os
import re
from repo_paths import CAREERHUB_DIR

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")

from fastapi.testclient import TestClient  # noqa: E402

from app.auth import get_current_user  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.main import app  # noqa: E402
from app.routers import contacts  # noqa: E402

get_settings.cache_clear()


class _EmptyRest:
    """Stands in for SupabaseRest: every select/update finds nothing — just
    enough to exercise this router's own 404 paths without a network call."""

    async def select(self, client, table, params=None, timeout=None):
        return []

    async def update(self, client, table, match, values, prefer="return=minimal", timeout=None):
        return []


_empty_rest = _EmptyRest()
contacts.SupabaseRest = lambda *args, **kwargs: _empty_rest  # type: ignore[assignment]

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


CONTACTS_API_TS = CAREERHUB_DIR / "lib/contacts-api.ts"
CONTACTS_TS = CAREERHUB_DIR / "lib/contacts.ts"

http_client = TestClient(app)


# ---------------------------------------------------------------------------
# 1. The backend actually registers the four routes the frontend expects —
#    would fail if the router were renamed, un-registered from main.py, or
#    its prefix/method changed.
# ---------------------------------------------------------------------------
openapi_paths = http_client.get("/openapi.json").json()["paths"]

check("POST /contacts is registered",
      "post" in openapi_paths.get("/contacts", {}),
      f"got {sorted(openapi_paths)}")
check("GET /contacts is registered",
      "get" in openapi_paths.get("/contacts", {}))
check("PUT /contacts/{contact_id} is registered",
      "put" in openapi_paths.get("/contacts/{contact_id}", {}))
check("DELETE /contacts/{contact_id} is registered",
      "delete" in openapi_paths.get("/contacts/{contact_id}", {}))

# ---------------------------------------------------------------------------
# 2. The frontend's literal path strings match those routes — a static check
#    against the actual source, not a hand-copied assumption of what it
#    says. Regressions this catches: a frontend typo ("/contact" singular),
#    a stray trailing slash, or a backend prefix rename that the frontend
#    wasn't updated for.
# ---------------------------------------------------------------------------
if CONTACTS_API_TS.exists():
    source = CONTACTS_API_TS.read_text()
    create_call = re.search(r'authFetch<Contact>\(\s*"([^"]+)"\s*,\s*\{\s*method:\s*"POST"', source)
    update_call = re.search(r'authFetch<Contact>\(\s*`([^`]+)`\s*,\s*\{\s*method:\s*"PUT"', source)
    delete_call = re.search(r'authFetch<void>\(\s*`([^`]+)`\s*,\s*\{\s*method:\s*"DELETE"', source)

    check("contacts-api.ts POST path is exactly /contacts",
          bool(create_call) and create_call.group(1) == "/contacts",
          f"got {create_call.group(1) if create_call else None!r}")
    check("contacts-api.ts PUT path is /contacts/${contactId}",
          bool(update_call) and update_call.group(1) == "/contacts/${contactId}",
          f"got {update_call.group(1) if update_call else None!r}")
    check("contacts-api.ts DELETE path is /contacts/${contactId}",
          bool(delete_call) and delete_call.group(1) == "/contacts/${contactId}",
          f"got {delete_call.group(1) if delete_call else None!r}")
else:
    check("features/career-hub/lib/contacts-api.ts exists (path-agreement check)", False,
          f"not found at {CONTACTS_API_TS}")

if CONTACTS_TS.exists():
    source = CONTACTS_TS.read_text()
    # getContacts/getContactCounts/getContactDirectory all go through one shared
    # fetchContacts(pathAndQuery) helper — check that helper hits exactly
    # /contacts<pathAndQuery>, and that the
    # callers build a query starting with the param name the backend expects
    # (company_id= / company_ids=), rather than pinning one exact call shape that
    # a harmless internal refactor (e.g. extracting that helper) would break.
    base_call = re.search(
        r"fetch\(\s*`\$\{baseUrl[^}]*\}/contacts\$\{pathAndQuery\}`", source
    )
    check("contacts.ts's shared fetch helper hits exactly /contacts<pathAndQuery>",
          bool(base_call), f"searched {CONTACTS_TS.name} for the fetch(...) call")

    get_contacts_query = re.search(
        r"function getContacts\([^)]*\)[^{]*\{\s*return fetchContacts\(\s*`\?([^$]+)\$\{",
        source,
    )
    check("getContacts() queries by company_id=",
          bool(get_contacts_query) and get_contacts_query.group(1) == "company_id=",
          f"got {get_contacts_query.group(1) if get_contacts_query else None!r}")

    # getContactCounts() itself no longer calls fetchContacts directly — it
    # was refactored to go through getContactsForCompanies() (added for the
    # Outreach activity dashboard, which needs the same batch of full contact
    # objects, not just counts). Check the query construction where it now
    # actually lives, rather than re-pinning the old direct call shape.
    #
    # getContactsForCompanies() itself chunks by MAX_COMPANY_IDS_PER_LIST (see
    # test_sponsored_companies_contact_count_cache.py for why: a single
    # request over that cap 422s in full, silently zeroing every company's
    # count) — so this no longer matches one direct top-level `return
    # fetchContacts(...)`; it's a `.map()` over chunks instead. Match the
    # function's body up to the next top-level export (getContactCounts,
    # always the next function in this file) rather than one exact call shape.
    get_for_companies_fn = re.search(
        r"function getContactsForCompanies\([\s\S]*?"
        r"(?=\nexport async function getContactCounts)",
        source,
    )
    check("getContactsForCompanies() exists", bool(get_for_companies_fn))
    check("getContactsForCompanies() queries by company_ids=",
          bool(get_for_companies_fn)
          and bool(re.search(r"fetchContacts\(\s*`\?company_ids=\$\{", get_for_companies_fn.group(0))),
          f"searched the function body for a fetchContacts(`?company_ids=${{...`) call")

    check("getContactDirectory() hits /contacts/directory, which the router exposes",
          bool(re.search(r'fetchContacts<DirectoryContact>\(\s*"/directory"\s*\)', source))
          and any(getattr(r, "path", None) == "/contacts/directory" for r in contacts.router.routes))
    check("getContactsForCompanies() chunks rather than sending every id in "
          "one request (the actual fix for the batch-cap 422)",
          bool(get_for_companies_fn)
          and "CHUNK_SIZE" in get_for_companies_fn.group(0)
          and ".map(" in get_for_companies_fn.group(0))

    check("getContactCounts() is built on getContactsForCompanies(), not a "
          "second direct call — one place constructs the company_ids= query",
          bool(re.search(r"getContactCounts[\s\S]*?await getContactsForCompanies\(", source)))
else:
    check("features/career-hub/lib/contacts.ts exists (path-agreement check)", False,
          f"not found at {CONTACTS_TS}")

# ---------------------------------------------------------------------------
# 3. This router's own 404s are never the bare "Not Found" — so the two are
#    always distinguishable, in production logs as much as in this test.
# ---------------------------------------------------------------------------
app.dependency_overrides[get_current_user] = lambda: "coach-1"

response = http_client.post(
    "/contacts",
    json={
        "company_id": "00000000-0000-0000-0000-000000000000",
        "full_name": "Nobody",
        "email": "nobody@example.com",
    },
)
check("an unknown company is this router's own 404, not the bare routing 404",
      response.status_code == 404
      and response.json().get("detail") == "Company not found.",
      f"got {response.status_code} {response.text}")

response = http_client.put(
    "/contacts/does-not-exist",
    json={"full_name": "Ghost", "email": "ghost@example.com"},
)
check("an unknown contact on update is this router's own 404",
      response.status_code == 404
      and response.json().get("detail") == "Contact not found.",
      f"got {response.status_code} {response.text}")

# A path FastAPI genuinely has no route for — the actual routing-layer 404,
# for contrast with the two checks above.
response = http_client.post("/contacts/does-not-exist-as-a-route/extra")
check("a genuinely unmatched path returns the bare Starlette 404",
      response.status_code == 404 and response.json().get("detail") == "Not Found",
      f"got {response.status_code} {response.text}")

app.dependency_overrides.pop(get_current_user, None)

print()
if _failures:
    print(f"{len(_failures)} FAILED:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL CONTACTS ROUTE-AGREEMENT TESTS PASSED")
