"""Regression test for Add Contact showing "[object Object]" after a failed
submit: `python test_contact_form_error_display.py` (no pytest; the backend
half uses FastAPI's TestClient, no network; the frontend half is a static
source check, no Node/TS runner available in this repo).

Root cause: FastAPI's error body isn't one shape. A route that raises
`HTTPException(detail="...")` (e.g. "Company not found.") sends
`{"detail": "..."}` — a plain string. A 422 from Pydantic validation (e.g.
ContactWrite's email-format and "needs a contact method" checks in
schemas.py, both raised as `ValueError` from a validator) sends
`{"detail": [{"msg": "...", "loc": [...], ...}, ...]}` — an ARRAY of error
objects. features/career-hub/lib/contacts-api.ts's authFetch did `String(data.detail)`
unconditionally; `String(anArrayOfPlainObjects)` is exactly where
"[object Object]" came from.

Part 1 pins down the actual response shape for both cases (an assumption
the frontend fix depends on, verified against the real Pydantic behaviour
rather than an assumption of it) — this is the "inspect the actual POST
/contacts response" the report asked for, made permanent. Part 2 is a
static check that the fix (extractErrorDetail, handling both shapes) is
actually in place and the old broken pattern hasn't crept back.
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

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


COACH_ID = "aaaaaaaa-0000-0000-0000-00000000000a"
COMPANY_A = "11111111-1111-1111-1111-111111111111"


class _CompanyExistsRest:
    async def select(self, client, table, params=None, timeout=None):
        return [{"id": COMPANY_A}]

    async def insert(self, client, table, rows, prefer="return=representation", timeout=None):
        return [{**rows[0], "id": "contact-1"}]


contacts.SupabaseRest = lambda *args, **kwargs: _CompanyExistsRest()  # type: ignore[assignment]

http_client = TestClient(app)
app.dependency_overrides[get_current_user] = lambda: COACH_ID


# ---------------------------------------------------------------------------
# 1. The actual response shapes — the contract the frontend fix relies on.
# ---------------------------------------------------------------------------

invalid_email = http_client.post(
    "/contacts",
    json={"company_id": COMPANY_A, "full_name": "Jamie Lee", "email": "not-an-email"},
)
check(
    "an invalid email is a 422",
    invalid_email.status_code == 422,
    f"got {invalid_email.status_code}",
)
invalid_email_detail = invalid_email.json().get("detail")
check(
    "a 422's detail is an ARRAY (not a string) — this is the shape "
    "String(detail) mishandled",
    isinstance(invalid_email_detail, list) and len(invalid_email_detail) >= 1,
    f"got {invalid_email_detail!r}",
)
if isinstance(invalid_email_detail, list) and invalid_email_detail:
    check(
        "each array entry carries a human-readable msg field",
        isinstance(invalid_email_detail[0].get("msg"), str)
        and "valid email" in invalid_email_detail[0]["msg"].lower(),
        f"got {invalid_email_detail[0]!r}",
    )
    check(
        "Pydantic v2 prefixes a validator's ValueError with 'Value error, ' "
        "(what the frontend fix strips before displaying it)",
        invalid_email_detail[0]["msg"].startswith("Value error,"),
        f"got {invalid_email_detail[0]['msg']!r}",
    )

no_contact_method = http_client.post(
    "/contacts", json={"company_id": COMPANY_A, "full_name": "Jamie Lee"}
)
check("no contact method is also a 422", no_contact_method.status_code == 422)
no_method_detail = no_contact_method.json().get("detail")
check(
    "its detail is also an array with a msg field, not a string",
    isinstance(no_method_detail, list)
    and isinstance(no_method_detail[0].get("msg"), str)
    and "contact method" in no_method_detail[0]["msg"].lower(),
    f"got {no_method_detail!r}",
)

missing_company_rest = _CompanyExistsRest()


class _NoCompanyRest:
    async def select(self, client, table, params=None, timeout=None):
        return []


contacts.SupabaseRest = lambda *args, **kwargs: _NoCompanyRest()  # type: ignore[assignment]
company_not_found = http_client.post(
    "/contacts",
    json={"company_id": COMPANY_A, "full_name": "Jamie Lee", "email": "jamie@example.com"},
)
check("an unknown company is a 404", company_not_found.status_code == 404)
check(
    "a 404's detail (from an explicit HTTPException) IS a plain string, "
    "unlike a 422's — confirming the frontend must handle both shapes, "
    "not just one",
    company_not_found.json().get("detail") == "Company not found.",
    f"got {company_not_found.json()!r}",
)

app.dependency_overrides.pop(get_current_user, None)


# ---------------------------------------------------------------------------
# 2. The frontend fix is actually in place — a static source check, since
#    this repo has no Node/TS test runner to execute contacts-api.ts
#    directly.
# ---------------------------------------------------------------------------

CONTACTS_API_TS = CAREERHUB_DIR / "lib/contacts-api.ts"

check(f"{CONTACTS_API_TS.name} exists", CONTACTS_API_TS.exists())
if CONTACTS_API_TS.exists():
    source = CONTACTS_API_TS.read_text()

    check(
        "the old broken pattern (String(data.detail) unconditionally) is gone",
        not re.search(r"String\(\s*data(\??\.|\[)detail", source),
        "found a bare String(data.detail) — this stringifies an array of "
        "error objects as '[object Object]'",
    )
    check(
        "the fix explicitly branches on the array shape (a 422's detail)",
        "Array.isArray(detail)" in source,
    )
    check(
        "the fix explicitly handles the string shape (an HTTPException's detail)",
        'typeof detail === "string"' in source,
    )
    check(
        "the fix extracts each array entry's msg field",
        re.search(r"\.msg\b", source) is not None,
    )
    check(
        "the fix still guards a genuinely unparseable/empty error body with "
        "a fallback message rather than throwing from inside error handling",
        "Request failed" in source,
    )


print()
if _failures:
    print(f"{len(_failures)} FAILED:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL CONTACT FORM ERROR DISPLAY CHECKS PASSED")
