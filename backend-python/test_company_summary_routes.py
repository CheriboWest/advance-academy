"""Self-check for the manual summary-refresh endpoint:
`python test_company_summary_routes.py`.

No pytest, no network: `generate_and_store_summary` is stubbed directly on
the summarizer module (imported lazily inside the route handler, so this
patch takes effect regardless of import order), and the coach JWT dependency
is overridden. Exercises the endpoint's own behaviour — auth, 404 mapping,
error surfacing, response shape — not the summarizer's own logic (see
test_company_summary.py for that).
"""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")

from fastapi.testclient import TestClient  # noqa: E402

from app.auth import get_current_user  # noqa: E402
from app.companies import summarizer  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.main import app  # noqa: E402

get_settings.cache_clear()

COACH_ID = "aaaaaaaa-0000-0000-0000-00000000000a"
COMPANY_A = "11111111-1111-1111-1111-111111111111"

_failures: list[str] = []


def check(cond: bool, label: str) -> None:
    status = "ok  " if cond else "FAIL"
    if not cond:
        _failures.append(label)
    print(f"[{status}] {label}")


client = TestClient(app)


def _authenticated():
    app.dependency_overrides[get_current_user] = lambda: COACH_ID


def _anonymous():
    app.dependency_overrides.pop(get_current_user, None)


class _StubGenerateAndStore:
    """Replaces summarizer.generate_and_store_summary for the duration of one
    test — returns a fixed summary, or raises, without touching the network."""

    def __init__(self, *, summary=None, error: Exception | None = None):
        self._summary = summary
        self._error = error
        self.calls: list[dict] = []

    async def __call__(self, client, rest, company_id, **kwargs):
        self.calls.append({"company_id": company_id, **kwargs})
        if self._error is not None:
            raise self._error
        return self._summary


class _StubSelectRest:
    """Replaces SupabaseRest for the follow-up select of
    ai_summary_generated_at after a successful generate-and-store."""

    def __init__(self, *args, **kwargs):
        pass

    async def select(self, client, table, params=None, timeout=None):
        assert table == "companies"
        return [{"ai_summary_generated_at": "2026-08-26T12:00:00+00:00"}]


def _patch_rest():
    import app.routers.companies as companies_router

    companies_router.SupabaseRest = _StubSelectRest  # type: ignore[assignment]


_patch_rest()


def test_requires_authentication() -> None:
    _anonymous()
    response = client.post(f"/companies/{COMPANY_A}/summary/refresh")
    check(response.status_code == 401, "unauthenticated refresh is rejected (401)")


def test_successful_refresh() -> None:
    _authenticated()
    stub = _StubGenerateAndStore(summary="Acme Ltd is based in Leeds.")
    summarizer.generate_and_store_summary = stub  # type: ignore[assignment]

    response = client.post(f"/companies/{COMPANY_A}/summary/refresh")
    check(response.status_code == 200, "successful refresh returns 200")

    body = response.json()
    check(body["company_id"] == COMPANY_A, "response echoes the company id")
    check(
        body["ai_summary"] == "Acme Ltd is based in Leeds.",
        "response carries the freshly generated summary",
    )
    check(
        body["ai_summary_generated_at"] == "2026-08-26T12:00:00+00:00",
        "response carries the stored generation timestamp",
    )

    check(len(stub.calls) == 1, "generate_and_store_summary is called exactly once")
    check(
        stub.calls[0]["fallback_on_error"] is False,
        "manual refresh never silently falls back — failures must surface to the coach",
    )


def test_unknown_company_is_404() -> None:
    _authenticated()
    summarizer.generate_and_store_summary = _StubGenerateAndStore(summary=None)  # type: ignore[assignment]

    response = client.post(f"/companies/{COMPANY_A}/summary/refresh")
    check(response.status_code == 404, "an unknown company is a 404")
    check(
        response.json().get("detail") == "Company not found.",
        "the 404 names the reason",
    )


def test_ai_failure_surfaces_as_502() -> None:
    _authenticated()
    summarizer.generate_and_store_summary = _StubGenerateAndStore(  # type: ignore[assignment]
        error=RuntimeError("simulated Anthropic failure")
    )

    response = client.post(f"/companies/{COMPANY_A}/summary/refresh")
    check(response.status_code == 502, "a generation failure surfaces as 502, not silently 200")
    check(
        "could not generate a summary" in response.json().get("detail", "").lower(),
        "the error message says generation failed",
    )


def main() -> None:
    for test in (
        test_requires_authentication,
        test_successful_refresh,
        test_unknown_company_is_404,
        test_ai_failure_surfaces_as_502,
    ):
        test()
    _anonymous()
    print("\nAll company summary route checks passed.")


if __name__ == "__main__":
    main()
    print()
    if _failures:
        print(f"{len(_failures)} FAILED:")
        for failure in _failures:
            print(f"  - {failure}")
        raise SystemExit(1)
    print("ALL COMPANY SUMMARY ROUTE TESTS PASSED")
