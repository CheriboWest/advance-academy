"""Self-check for the coach-facing contacts CRUD API.

`python test_contacts.py` — offline, no network/Supabase project. Same shape
as test_sponsor_status_endpoint.py: a FakeRest stands in for Supabase, and a
TestClient layer proves auth + routing + validation actually reach the
endpoints. This project has no coach/student role anywhere — every existing
coach-only route is gated by nothing but `get_current_user` — so an
unauthenticated request is 401, not 403, matching that project-wide
convention rather than inventing a new one for this endpoint.
"""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")

import httpx  # noqa: E402
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


def _in_list(raw: str) -> set[str]:
    if not raw.startswith("in.("):
        return {raw}
    return {v for v in raw[4:-1].split(",") if v}


def _pg_error(constraint: str) -> httpx.HTTPStatusError:
    request = httpx.Request("PATCH", "https://example.test/contacts")
    response = httpx.Response(
        400,
        json={
            "code": "23514",
            "message": f'new row for relation "contacts" violates check '
            f'constraint "{constraint}"',
        },
        request=request,
    )
    return httpx.HTTPStatusError("bad request", request=request, response=response)


class FakeRest:
    """In-memory stand-in for SupabaseRest covering `companies` + `contacts`."""

    def __init__(self, companies=None, contacts=None) -> None:
        self.companies: list[dict] = companies or []
        self.contacts: list[dict] = contacts or []
        self._next_id = 1
        # When set, the next insert/update raises this instead of writing —
        # simulates the database-level check constraint as a defense-in-depth
        # backstop, independent of Pydantic's own validation.
        self.raise_on_write: Exception | None = None

    async def select(self, client, table, params=None, timeout=None):
        params = params or {}
        rows = {"companies": self.companies, "contacts": self.contacts}.get(table, [])
        out = []
        for row in rows:
            ok = True
            for key, value in params.items():
                if key in ("select", "order", "limit"):
                    continue
                if value.startswith("eq."):
                    if str(row.get(key)) != value[3:]:
                        ok = False
                elif value.startswith("in.("):
                    if str(row.get(key)) not in _in_list(value):
                        ok = False
            if ok:
                out.append(dict(row))
        return out

    async def insert(self, client, table, rows, prefer="return=representation", timeout=None):
        if self.raise_on_write is not None:
            raise self.raise_on_write
        created = []
        for row in rows:
            new_row = {
                "id": f"contact-{self._next_id}",
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
                **row,
            }
            self._next_id += 1
            self.contacts.append(new_row)
            created.append(dict(new_row))
        return created

    async def update(self, client, table, match, values, prefer="return=minimal", timeout=None):
        if self.raise_on_write is not None:
            raise self.raise_on_write
        target_id = match.get("id", "").removeprefix("eq.")
        updated = []
        for row in self.contacts:
            if row.get("id") == target_id:
                row.update(values)
                row["updated_at"] = "2026-01-02T00:00:00Z"
                updated.append(dict(row))
        return updated if prefer.startswith("return=representation") else []

    async def delete(self, client, table, match, prefer="return=representation", timeout=None):
        target_id = match.get("id", "").removeprefix("eq.")
        remaining = []
        deleted = []
        for row in self.contacts:
            (deleted if row.get("id") == target_id else remaining).append(row)
        self.contacts = remaining
        return deleted


class _ConstantRest:
    """Stands in for SupabaseRest: returns a fixed fake regardless of ctor args."""

    def __new__(cls, *args, **kwargs):
        return _fixture["rest"]


_fixture: dict = {"rest": None}
contacts.SupabaseRest = _ConstantRest  # type: ignore[assignment]

http_client = TestClient(app)
COACH_ID = "aaaaaaaa-0000-0000-0000-00000000000a"
COMPANY_ID = "cccccccc-0000-0000-0000-00000000000c"


def _authenticated() -> None:
    app.dependency_overrides[get_current_user] = lambda: COACH_ID


def _anonymous() -> None:
    app.dependency_overrides.pop(get_current_user, None)


def fresh_rest(companies=None) -> FakeRest:
    rest = FakeRest(companies=companies or [{"id": COMPANY_ID, "slug": "acme"}])
    _fixture["rest"] = rest
    return rest


# ---------------------------------------------------------------------------
# Auth: every route is gated by get_current_user, same as the rest of the app.
# ---------------------------------------------------------------------------
_anonymous()
fresh_rest()
check("unauthenticated GET /contacts is rejected",
      http_client.get(f"/contacts?company_id={COMPANY_ID}").status_code == 401)
check("unauthenticated POST /contacts is rejected",
      http_client.post("/contacts", json={
          "company_id": COMPANY_ID, "full_name": "A", "email": "a@b.com",
      }).status_code == 401)
check("unauthenticated PUT /contacts/{id} is rejected",
      http_client.put("/contacts/x", json={
          "full_name": "A", "email": "a@b.com",
      }).status_code == 401)
check("unauthenticated DELETE /contacts/{id} is rejected",
      http_client.delete("/contacts/x").status_code == 401)

_authenticated()

# ---------------------------------------------------------------------------
# Create: requires at least one contact method — enforced by Pydantic before
# any database write is attempted.
# ---------------------------------------------------------------------------
rest = fresh_rest()
response = http_client.post("/contacts", json={
    "company_id": COMPANY_ID, "full_name": "Jamie Lee",
    "job_title": None, "email": None, "phone": None, "linkedin_url": None,
})
check("create with no contact method is rejected (422)",
      response.status_code == 422, f"got {response.status_code} {response.text}")
check("...and nothing was written", len(rest.contacts) == 0)

# Blank strings count as "not provided", not as a contact method.
response = http_client.post("/contacts", json={
    "company_id": COMPANY_ID, "full_name": "Jamie Lee",
    "email": "  ", "phone": "", "linkedin_url": None,
})
check("create with only blank/whitespace fields is rejected (422)",
      response.status_code == 422, f"got {response.status_code}")

# Email only.
response = http_client.post("/contacts", json={
    "company_id": COMPANY_ID, "full_name": "Jamie Lee", "job_title": "Talent Lead",
    "email": "jamie@acme.example",
})
check("create with email only succeeds (201)",
      response.status_code == 201, f"got {response.status_code} {response.text}")
body = response.json()
check("response has the expected shape",
      body["full_name"] == "Jamie Lee" and body["email"] == "jamie@acme.example"
      and body["phone"] is None and body["linkedin_url"] is None
      and body["company_id"] == COMPANY_ID and body["id"],
      f"got {body}")

# Phone only.
response = http_client.post("/contacts", json={
    "company_id": COMPANY_ID, "full_name": "Priya Shah", "phone": "020 7946 0958",
})
check("create with phone only succeeds (201)", response.status_code == 201,
      f"got {response.status_code} {response.text}")

# LinkedIn only.
response = http_client.post("/contacts", json={
    "company_id": COMPANY_ID, "full_name": "Tom Reid",
    "linkedin_url": "https://linkedin.com/in/tomreid",
})
check("create with LinkedIn only succeeds (201)", response.status_code == 201,
      f"got {response.status_code} {response.text}")

# Invalid email format.
response = http_client.post("/contacts", json={
    "company_id": COMPANY_ID, "full_name": "Bad Email", "email": "not-an-email",
})
check("create with a malformed email is rejected (422)",
      response.status_code == 422, f"got {response.status_code}")

check("three valid contacts were actually persisted", len(rest.contacts) == 3,
      f"got {len(rest.contacts)}")

# Unknown company.
response = http_client.post("/contacts", json={
    "company_id": "00000000-0000-0000-0000-000000000000",
    "full_name": "Nobody", "email": "nobody@example.com",
})
check("create against an unknown company is a 404",
      response.status_code == 404, f"got {response.status_code}")

# ---------------------------------------------------------------------------
# List: scoped to one company, most recent first.
# ---------------------------------------------------------------------------
response = http_client.get(f"/contacts?company_id={COMPANY_ID}")
check("list returns 200", response.status_code == 200)
listed = response.json()
check("list returns exactly this company's contacts", len(listed) == 3,
      f"got {len(listed)}")
check("list scopes by company_id — a different company sees none",
      http_client.get("/contacts?company_id=other-co").json() == [])

# ---------------------------------------------------------------------------
# List (batch): several companies at once — for the Sponsored Companies list
# (contact counts) and the Outreach picker, without an N+1.
# ---------------------------------------------------------------------------
OTHER_COMPANY_ID = "dddddddd-0000-0000-0000-00000000000d"
rest.companies.append({"id": OTHER_COMPANY_ID, "slug": "globex"})
response = http_client.post("/contacts", json={
    "company_id": OTHER_COMPANY_ID, "full_name": "Alex Kim", "email": "alex@globex.example",
})
check("seed contact for the second company succeeds (201)",
      response.status_code == 201, f"got {response.status_code}")

response = http_client.get(f"/contacts?company_ids={COMPANY_ID},{OTHER_COMPANY_ID}")
check("batch list returns 200", response.status_code == 200)
batch = response.json()
check("batch list returns contacts from both companies",
      {c["company_id"] for c in batch} == {COMPANY_ID, OTHER_COMPANY_ID},
      f"got {sorted(c['company_id'] for c in batch)}")
check("batch list returns exactly the union (3 + 1 = 4)", len(batch) == 4,
      f"got {len(batch)}")

response = http_client.get(f"/contacts?company_ids={OTHER_COMPANY_ID}")
check("batch list with a single id behaves like a scoped list",
      len(response.json()) == 1 and response.json()[0]["company_id"] == OTHER_COMPANY_ID)

response = http_client.get("/contacts")
check("list with neither company_id nor company_ids is a 422",
      response.status_code == 422, f"got {response.status_code}")

response = http_client.get("/contacts?company_ids=")
check("an empty company_ids is treated the same as omitted (422, not a crash)",
      response.status_code == 422, f"got {response.status_code} {response.text}")

original_cap = contacts.MAX_COMPANY_IDS_PER_LIST
contacts.MAX_COMPANY_IDS_PER_LIST = 1
response = http_client.get(f"/contacts?company_ids={COMPANY_ID},{OTHER_COMPANY_ID}")
contacts.MAX_COMPANY_IDS_PER_LIST = original_cap
check("company_ids over the cap is rejected (422)",
      response.status_code == 422, f"got {response.status_code}")

# ---------------------------------------------------------------------------
# Update: full-form resubmit; same "at least one contact method" rule.
# ---------------------------------------------------------------------------
contact_id = listed[0]["id"]
response = http_client.put(f"/contacts/{contact_id}", json={
    "full_name": "Jamie Lee-Wilson", "job_title": "Head of Talent",
    "email": "jamie.lw@acme.example",
})
check("update succeeds (200)", response.status_code == 200,
      f"got {response.status_code} {response.text}")
check("update actually changed the row",
      response.json()["full_name"] == "Jamie Lee-Wilson"
      and response.json()["job_title"] == "Head of Talent")

response = http_client.put(f"/contacts/{contact_id}", json={
    "full_name": "Jamie Lee-Wilson", "email": None, "phone": None, "linkedin_url": None,
})
check("update clearing every contact method is rejected (422)",
      response.status_code == 422, f"got {response.status_code}")

response = http_client.put("/contacts/does-not-exist", json={
    "full_name": "Ghost", "email": "ghost@example.com",
})
check("update of an unknown contact is a 404", response.status_code == 404,
      f"got {response.status_code}")

# ---------------------------------------------------------------------------
# Delete.
# ---------------------------------------------------------------------------
response = http_client.delete(f"/contacts/{contact_id}")
check("delete succeeds (204)", response.status_code == 204,
      f"got {response.status_code}")
check("the contact is actually gone",
      all(c["id"] != contact_id for c in rest.contacts))

response = http_client.delete(f"/contacts/{contact_id}")
check("deleting again is a 404 (already gone)", response.status_code == 404,
      f"got {response.status_code}")

# ---------------------------------------------------------------------------
# Defense in depth: a database-level check-constraint violation (in case
# something ever bypasses Pydantic) still surfaces as a clean 422, not a 502.
# ---------------------------------------------------------------------------
rest_db_guard = fresh_rest()
rest_db_guard.raise_on_write = _pg_error("contacts_has_contact_method")
response = http_client.post("/contacts", json={
    "company_id": COMPANY_ID, "full_name": "Edge Case", "email": "edge@example.com",
})
check("a check-constraint violation from the database is surfaced as 422",
      response.status_code == 422, f"got {response.status_code}")

# ---------------------------------------------------------------------------
# Directory: every contact with its company, sorted by company then name.
# ---------------------------------------------------------------------------
_fixture["rest"] = FakeRest(contacts=[
    {"id": "c1", "company_id": "x", "full_name": "zoe", "email": "z@x.com",
     "company": {"id": "x", "name": "Beta", "slug": "beta"}},
    {"id": "c2", "company_id": "y", "full_name": "Amy", "email": "a@y.com",
     "company": {"id": "y", "name": "alpha", "slug": "alpha"}},
    {"id": "c3", "company_id": "x", "full_name": "Ben", "email": "b@x.com",
     "company": {"id": "x", "name": "Beta", "slug": "beta"}},
])
response = http_client.get("/contacts/directory")
rows = response.json() if response.status_code == 200 else []
check("directory sorts by company, then name",
      [r["full_name"] for r in rows] == ["Amy", "Ben", "zoe"], f"{response.status_code} {rows}")
check("directory rows carry their company",
      bool(rows) and rows[0]["company"]["slug"] == "alpha")

# A company with no slug (companies.slug is nullable; companies created before
# migration 024 have none). One such contact used to fail response validation
# and 500 the whole directory, which the page showed as "no contacts".
_fixture["rest"] = FakeRest(contacts=[
    {"id": "c1", "company_id": "x", "full_name": "Ann", "email": "a@x.com",
     "company": {"id": "x", "name": "Acme", "slug": "acme"}},
    {"id": "c2", "company_id": "y", "full_name": "Bob", "email": "b@y.com",
     "company": {"id": "y", "name": "Hays", "slug": None}},
])
lenient_client = TestClient(app, raise_server_exceptions=False)   # see the 500, don't raise it
response = lenient_client.get("/contacts/directory")
rows = response.json() if response.status_code == 200 else []
check("a contact at a company with no slug doesn't break the directory (was a 500)",
      response.status_code == 200, f"got {response.status_code}")
check("…every contact is listed, the slug-less company's contact included, with its company id and name",
      [(r["full_name"], r["company"]["id"], r["company"]["name"], r["company"]["slug"]) for r in rows]
      == [("Ann", "x", "Acme", "acme"), ("Bob", "y", "Hays", None)], f"{rows}")

_anonymous()
check("directory is coach-only",
      http_client.get("/contacts/directory").status_code == 401)

print()
if _failures:
    print(f"{len(_failures)} FAILED:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL CONTACTS TESTS PASSED")
