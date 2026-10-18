"""Self-check for the coach-facing sponsorship status endpoint.

`python test_sponsor_status_endpoint.py` — offline.

Two layers, matching how the rest of the sponsors test suite is split:

  1. `service.company_sponsorship_status()` exercised directly against a fake
     database — the state-machine logic (licensed / ambiguous / no_match /
     error / not_checked, staleness, route aggregation) lives here and is
     independent of FastAPI.
  2. A thin `TestClient` layer proving the router actually enforces
     authentication and wires the service function up correctly — this
     project has no coach/student role anywhere (no JWT claim, no profiles
     table: confirmed by grepping app/ — every existing coach-only route,
     /sponsors/import through /companies/delete, is gated by nothing but
     `get_current_user`), so "non-coach" in this codebase means "no valid
     Supabase session", and the rejection is 401 (from `get_current_user`
     itself), not 403. That is the existing, project-wide convention — a
     literal 403 anywhere here would be new behaviour invented for this
     endpoint alone, which is exactly what this milestone was told not to do.
"""

from __future__ import annotations

import asyncio
import os

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")

from app.sponsors.service import company_sponsorship_status  # noqa: E402

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


# ---------------------------------------------------------------------------
# A fake database covering exactly the tables company_sponsorship_status()
# touches: companies, sponsor_licences, company_sponsorship,
# company_sponsorship_checks, sponsor_register_imports.
# ---------------------------------------------------------------------------
class FakeRest:
    def __init__(self) -> None:
        self.companies: list[dict] = []
        self.licences: list[dict] = []
        self.links: list[dict] = []
        self.checks: list[dict] = []
        self.imports: list[dict] = []
        self.queries: list[tuple[str, dict]] = []

    async def select(self, client, table, params=None, timeout=None):
        params = params or {}
        self.queries.append((table, dict(params)))
        rows = {
            "companies": self.companies,
            "sponsor_licences": self.licences,
            "company_sponsorship": self.links,
            "company_sponsorship_checks": self.checks,
            "sponsor_register_imports": self.imports,
        }.get(table, [])
        return [dict(r) for r in rows if self._matches(r, params)][
            : int(params.get("limit", "1000"))
        ]

    @staticmethod
    def _matches(row: dict, params: dict) -> bool:
        for key, value in params.items():
            if key in ("select", "order", "limit") or not isinstance(value, str):
                continue
            actual = row.get(key)
            if value == "is.null":
                if actual is not None:
                    return False
            elif value.startswith("eq."):
                target = value[3:]
                if target in ("true", "false"):
                    if bool(actual) != (target == "true"):
                        return False
                elif str(actual) != target:
                    return False
            elif value.startswith("in.("):
                wanted = {v for v in value[4:-1].split(",") if v}
                if str(actual) not in wanted:
                    return False
        return True

    async def upsert(self, client, table, rows, on_conflict="", prefer="", timeout=None):
        return []

    async def insert(self, client, table, rows, prefer="return=representation", timeout=None):
        return rows

    async def update(self, client, table, match, values, prefer="", timeout=None):
        return None


def status_of(rest: FakeRest, company_id: str) -> dict:
    return asyncio.run(company_sponsorship_status(object(), rest, company_id))


COMPANY_ID = "co-1"

LICENCE_SKILLED = {
    "id": "lic-1", "organisation_name": "DGP Intelsius Ltd", "town_city": "York",
    "county": None, "type_rating": "Worker (A rating)", "licence_type": "Worker",
    "rating": "A rating", "route": "Skilled Worker",
    "normalized_name": "dgp intelsius", "normalized_town": "york",
    "is_current": True,
}
LICENCE_HEALTH = {
    **LICENCE_SKILLED,
    "id": "lic-2", "route": "Health and Care Worker",
}
LICENCE_WITHDRAWN_SIBLING = {
    **LICENCE_SKILLED,
    "id": "lic-3", "route": "Intra-Company Transfer", "is_current": False,
}

LATEST_IMPORT = "import-latest"
OLD_IMPORT = "import-old"


def base_rest() -> FakeRest:
    rest = FakeRest()
    rest.companies = [{"id": COMPANY_ID, "name": "DGP Intelsius"}]
    rest.imports = [{"id": LATEST_IMPORT, "status": "success"}]
    return rest


# ---------------------------------------------------------------------------
# A — a confirmed current match -> licensed.
# ---------------------------------------------------------------------------
rest = base_rest()
rest.licences = [LICENCE_SKILLED]
rest.links = [{
    "company_id": COMPANY_ID, "sponsor_licence_id": "lic-1", "decision": "match",
    "confidence": 0.96, "resolved_at": "2026-01-01T00:00:00Z",
}]
rest.checks = [{
    "company_id": COMPANY_ID, "last_decision": "match",
    "register_import_id": LATEST_IMPORT, "candidate_count": 1,
    "checked_at": "2026-01-02T00:00:00Z",
}]

result = status_of(rest, COMPANY_ID)
check("A: a confirmed current match is licensed", result["status"] == "licensed",
      f"got {result['status']}")
check("A: stale is false for a licensed result", result["stale"] is False)
check("A: the match block carries the organisation name",
      result["match"]["organisation_name"] == "DGP Intelsius Ltd")
check("A: confidence is passed through exactly", result["match"]["confidence"] == 0.96,
      f"got {result['match']['confidence']}")  # J
check("A: candidate_count comes from the check row", result["candidate_count"] == 1)
check("A: checked_at comes from the check row",
      result["checked_at"] == "2026-01-02T00:00:00Z")
check("A: register_import_id is the latest successful import",
      result["register_import_id"] == LATEST_IMPORT)

# ---------------------------------------------------------------------------
# B — multiple sponsor rows/routes -> aggregated, not duplicated.
# ---------------------------------------------------------------------------
rest = base_rest()
rest.licences = [LICENCE_SKILLED, LICENCE_HEALTH, LICENCE_WITHDRAWN_SIBLING]
rest.links = [{
    "company_id": COMPANY_ID, "sponsor_licence_id": "lic-1", "decision": "match",
    "confidence": 0.9, "resolved_at": "2026-01-01T00:00:00Z",
}]
rest.checks = [{
    "company_id": COMPANY_ID, "last_decision": "match",
    "register_import_id": LATEST_IMPORT, "candidate_count": 1,
    "checked_at": "2026-01-02T00:00:00Z",
}]

result = status_of(rest, COMPANY_ID)
check("B: still exactly one licensed result, not one per route",
      result["status"] == "licensed")
check("B: both CURRENT routes are aggregated into the same match",
      set(result["match"]["routes"]) == {"Skilled Worker", "Health and Care Worker"},
      f"got {result['match']['routes']}")
check("B: a withdrawn sibling route is excluded from the aggregate",
      "Intra-Company Transfer" not in result["match"]["routes"])
check("B: the matched row's own display fields are used (not blended)",
      result["match"]["type_rating"] == "Worker (A rating)")

# ---------------------------------------------------------------------------
# C — an ambiguous check -> ambiguous.
# ---------------------------------------------------------------------------
rest = base_rest()
rest.checks = [{
    "company_id": COMPANY_ID, "last_decision": "ambiguous",
    "register_import_id": LATEST_IMPORT, "candidate_count": 3,
    "checked_at": "2026-01-02T00:00:00Z",
}]
result = status_of(rest, COMPANY_ID)
check("C: an ambiguous check reports ambiguous", result["status"] == "ambiguous")
check("C: candidate_count is passed through", result["candidate_count"] == 3)
check("C: no match block is present", result["match"] is None)
check("C: not flagged stale", result["stale"] is False)

# ---------------------------------------------------------------------------
# D — a no_match check -> no_match.
# ---------------------------------------------------------------------------
rest = base_rest()
rest.checks = [{
    "company_id": COMPANY_ID, "last_decision": "no_match",
    "register_import_id": LATEST_IMPORT, "candidate_count": 0,
    "checked_at": "2026-01-02T00:00:00Z",
}]
result = status_of(rest, COMPANY_ID)
check("D: a no_match check reports no_match", result["status"] == "no_match")
check("D: no match block is present", result["match"] is None)

# ---------------------------------------------------------------------------
# E — an error check -> error, without leaking the raw error text.
# ---------------------------------------------------------------------------
rest = base_rest()
rest.checks = [{
    "company_id": COMPANY_ID, "last_decision": "error",
    "register_import_id": LATEST_IMPORT, "candidate_count": 0,
    "checked_at": "2026-01-02T00:00:00Z",
    "error": "APIConnectionError: connection reset by peer at 10.0.4.12:443 key=sk-ant-***",
}]
result = status_of(rest, COMPANY_ID)
check("E: an error check reports error", result["status"] == "error")
check("E: the raw error/exception text is never in the response",
      "error" not in str(result.get("match"))
      and all("APIConnectionError" not in str(v) for v in result.values())
      and all("sk-ant" not in str(v) for v in result.values()))
check("E: the response has no field carrying the check's error column at all",
      "error" not in result)

# ---------------------------------------------------------------------------
# F — no check at all -> not_checked (and not stale — there is nothing to be
#     stale relative to).
# ---------------------------------------------------------------------------
rest = base_rest()
result = status_of(rest, COMPANY_ID)
check("F: no check on record is not_checked", result["status"] == "not_checked")
check("F: not flagged stale when nothing was ever checked", result["stale"] is False)
check("F: checked_at is null", result["checked_at"] is None)
check("F: candidate_count is null, not zero (never measured, not zero)",
      result["candidate_count"] is None)

# ---------------------------------------------------------------------------
# G — a check from a PREVIOUS register edition must not appear current.
# ---------------------------------------------------------------------------
rest = base_rest()
rest.checks = [{
    "company_id": COMPANY_ID, "last_decision": "no_match",
    "register_import_id": OLD_IMPORT, "candidate_count": 0,
    "checked_at": "2025-06-01T00:00:00Z",
}]
result = status_of(rest, COMPANY_ID)
check("G: a stale no_match check is reported as not_checked, not no_match",
      result["status"] == "not_checked", f"got {result['status']}")
check("G: ...explicitly flagged stale", result["stale"] is True)
check("G: the stale check's own checked_at is still surfaced",
      result["checked_at"] == "2025-06-01T00:00:00Z")
check("G: register_import_id reported is the CURRENT latest, not the stale one",
      result["register_import_id"] == LATEST_IMPORT)

# A stale MATCH-decision check (no live company_sponsorship row for it, e.g. the
# organisation dropped out of a newer edition) must also read as not_checked,
# not silently as licensed or as a bare "match".
rest = base_rest()
rest.checks = [{
    "company_id": COMPANY_ID, "last_decision": "match",
    "register_import_id": OLD_IMPORT, "candidate_count": 1,
    "checked_at": "2025-06-01T00:00:00Z",
}]
result = status_of(rest, COMPANY_ID)
check("G: a stale match-decision check (no live link) is not_checked, not licensed",
      result["status"] == "not_checked", f"got {result['status']}")
check("G: ...and flagged stale", result["stale"] is True)

# ---------------------------------------------------------------------------
# Company existence is not this function's job (the router 404s beforehand),
# but it must not crash on an unknown id either.
# ---------------------------------------------------------------------------
rest = base_rest()
result = status_of(rest, "no-such-company")
check("unknown company id does not crash — reports not_checked",
      result["status"] == "not_checked")


# ---------------------------------------------------------------------------
# H / I — the router actually enforces authentication, and a real coach
# session reaches the handler and gets the normalized shape back.
# ---------------------------------------------------------------------------
from fastapi.testclient import TestClient  # noqa: E402

from app.auth import get_current_user  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.main import app  # noqa: E402
from app.routers import sponsors  # noqa: E402

get_settings.cache_clear()

COACH_ID = "aaaaaaaa-0000-0000-0000-00000000000a"


class _ConstantRest:
    """Stands in for SupabaseRest: returns a fixed fake regardless of ctor args."""

    def __new__(cls, *args, **kwargs):
        return _http_fixture["rest"]


_http_fixture: dict = {"rest": None}
sponsors.SupabaseRest = _ConstantRest  # type: ignore[assignment]

http_client = TestClient(app)


def _authenticated() -> None:
    app.dependency_overrides[get_current_user] = lambda: COACH_ID


def _anonymous() -> None:
    app.dependency_overrides.pop(get_current_user, None)


# H — no session at all.
_anonymous()
response = http_client.get("/sponsors/companies/co-1")
check("H: an unauthenticated request to the status endpoint is rejected",
      response.status_code == 401, f"got {response.status_code}")
check("H: ...same on the recheck endpoint",
      http_client.post("/sponsors/companies/co-1/recheck").status_code == 401,
      f"got {http_client.post('/sponsors/companies/co-1/recheck').status_code}")

# I — a real coach session reaches the handler and gets the normalized shape.
_authenticated()
fixture_rest = base_rest()
fixture_rest.licences = [LICENCE_SKILLED]
fixture_rest.links = [{
    "company_id": "co-http", "sponsor_licence_id": "lic-1", "decision": "match",
    "confidence": 0.96, "resolved_at": "2026-01-01T00:00:00Z",
}]
fixture_rest.checks = [{
    "company_id": "co-http", "last_decision": "match",
    "register_import_id": LATEST_IMPORT, "candidate_count": 1,
    "checked_at": "2026-01-02T00:00:00Z",
}]
fixture_rest.companies = [{"id": "co-http", "name": "DGP Intelsius"}]
_http_fixture["rest"] = fixture_rest

response = http_client.get("/sponsors/companies/co-http")
check("I: an authenticated coach reaches the handler (200)",
      response.status_code == 200, f"got {response.status_code}")
body = response.json()
check("I: the response is the normalized shape, not raw table rows",
      set(body) == {
          "company_id", "status", "checked_at", "register_import_id",
          "candidate_count", "stale", "match",
      },
      f"got {sorted(body)}")
check("I: status is licensed for this fixture", body["status"] == "licensed")
check("I: the match block is present with the expected fields",
      body["match"]["organisation_name"] == "DGP Intelsius Ltd"
      and body["match"]["confidence"] == 0.96)

# A company id that does not exist is a 404, not a fabricated not_checked.
response = http_client.get("/sponsors/companies/does-not-exist")
check("I: an unknown company id is a clean 404",
      response.status_code == 404, f"got {response.status_code}")

# J — the public route students see: no token, licensed facts only.
_anonymous()
fixture_rest.companies.append({"id": "co-none", "name": "Nobody Ltd"})
response = http_client.get("/sponsors/public/companies/co-http")
body = response.json()
check("J: the public route needs no session (200)",
      response.status_code == 200, f"got {response.status_code}")
check("J: a licensed company returns its match",
      body["status"] == "licensed"
      and body["match"]["organisation_name"] == "DGP Intelsius Ltd")
check("J: coach-only fields are blanked",
      body["candidate_count"] is None and body["register_import_id"] is None)
response = http_client.get("/sponsors/public/companies/co-none")
check("J: a company with no licence is null, not its triage state",
      response.status_code == 200 and response.json() is None,
      f"got {response.status_code} {response.text}")
response = http_client.get("/sponsors/public/companies/does-not-exist")
check("J: an unknown company is null",
      response.status_code == 200 and response.json() is None,
      f"got {response.status_code} {response.text}")


print()
if _failures:
    print(f"{len(_failures)} FAILED:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("ALL SPONSOR STATUS ENDPOINT TESTS PASSED")
