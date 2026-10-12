"""Self-check for GET /sponsors/companies — one page of coach Sponsored Companies.

`python test_sponsored_company_page.py` — offline (a `TestClient` over a fake
`SupabaseRest`). What must hold:

  A. It calls migration 048's `coach_company_page` with this coach's id,
     licensed-only by default, and turns `page` into an offset of 30s.
  B. `scope=all` and a search are passed through; the total comes off the
     first row and is not repeated on every company.
  C. An empty page reports total 0; a bad scope is a 422; no session is a 401.
"""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")

from typing import Any  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from app.auth import get_current_user  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.main import app  # noqa: E402
from app.routers import sponsors  # noqa: E402

get_settings.cache_clear()

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(f"{name} {detail}")
    print(f"[{status}] {name}{('  ' + detail) if detail and not cond else ''}")


class FakeRest:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def rpc(self, client, function, payload=None, timeout=None):
        self.calls.append((function, dict(payload or {})))
        return self.rows


_fixture: dict = {"rest": None}


class _ConstantRest:
    def __new__(cls, *args, **kwargs):
        return _fixture["rest"]


sponsors.SupabaseRest = _ConstantRest  # type: ignore[assignment]

http_client = TestClient(app)
COACH_ID = "aaaaaaaa-0000-0000-0000-00000000000a"
ROW = {"id": "c1", "slug": "acme", "name": "Acme", "sector": None, "region": "London",
       "hq_location": None, "lead_score": 3, "open_jobs": 0, "contacts": 2, "total": 41}

app.dependency_overrides[get_current_user] = lambda: COACH_ID

# --- A ----------------------------------------------------------------------
_fixture["rest"] = FakeRest([ROW])
response = http_client.get("/sponsors/companies?page=2")
check("A: 200", response.status_code == 200, f"got {response.status_code} {response.text}")
calls = _fixture["rest"].calls
check("A: one call to coach_company_page", [c[0] for c in calls] == ["coach_company_page"], f"got {calls}")
payload = calls[0][1] if calls else {}
check("A: scoped to this coach", payload.get("p_coach") == COACH_ID, f"got {payload}")
check("A: licensed only by default", payload.get("p_licensed") is True, f"got {payload}")
check("A: page 2 is offset 30, limit 30",
      payload.get("p_offset") == 30 and payload.get("p_limit") == 30, f"got {payload}")
check("A: no search means p_q null", payload.get("p_q") is None, f"got {payload}")

# --- B ----------------------------------------------------------------------
_fixture["rest"] = FakeRest([ROW])
body = http_client.get("/sponsors/companies?scope=all&q=%20acme%20").json()
payload = _fixture["rest"].calls[0][1]
check("B: scope=all lifts the licensed filter", payload.get("p_licensed") is False, f"got {payload}")
check("B: the search is trimmed and passed", payload.get("p_q") == "acme", f"got {payload}")
check("B: total read off the rows", body.get("total") == 41, f"got {body}")
check("B: rows carry contacts and no per-row total",
      body.get("companies") == [{k: v for k, v in ROW.items() if k != "total"}], f"got {body}")

# --- C ----------------------------------------------------------------------
_fixture["rest"] = FakeRest([])
body = http_client.get("/sponsors/companies?page=99").json()
check("C: an empty page is total 0", body.get("total") == 0 and body.get("companies") == [], f"got {body}")
check("C: an unknown scope is rejected",
      http_client.get("/sponsors/companies?scope=nope").status_code == 422)
app.dependency_overrides.pop(get_current_user, None)
check("C: an unauthenticated request is rejected",
      http_client.get("/sponsors/companies").status_code == 401)

print()
if _failures:
    print(f"{len(_failures)} check(s) failed:")
    for failure in _failures:
        print(f"  - {failure}")
    raise SystemExit(1)
print("All checks passed.")
