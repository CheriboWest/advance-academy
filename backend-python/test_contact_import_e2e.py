"""End to end: the import wizard's routes against a real database with
migration 049, through PostgREST. `python test_contact_import_e2e.py`.

LOCAL SCRATCH DATABASES ONLY. Skipped (exit 0) unless both are set:
  CONTACT_IMPORT_E2E_SUPABASE_URL   a local Supabase-style URL serving /rest/v1
                                    (`supabase start`, or PostgREST behind a proxy);
                                    anything not on localhost is refused
  CONTACT_IMPORT_E2E_SERVICE_KEY    a service_role JWT for it

Build the database with supabase/tests/run_local.sh. The auth gate is replaced
by two fixed admins here (it is tested for real in test_contact_imports_routes.py).
Everything this test creates is deleted at the end.
"""

from __future__ import annotations

import io
import os
import re
import sys
import uuid

URL = os.environ.get("CONTACT_IMPORT_E2E_SUPABASE_URL", "").strip()
KEY = os.environ.get("CONTACT_IMPORT_E2E_SERVICE_KEY", "").strip()
if not (URL and KEY):
    print("SKIPPED: set CONTACT_IMPORT_E2E_SUPABASE_URL and CONTACT_IMPORT_E2E_SERVICE_KEY to run")
    sys.exit(0)
if not re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?/?$", URL):
    sys.exit(f"refusing to run against {URL}: local scratch databases only")

os.environ["SUPABASE_URL"] = URL
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = KEY

import httpx  # noqa: E402
import openpyxl  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.auth import get_current_user  # noqa: E402
from app.config import get_settings  # noqa: E402

get_settings.cache_clear()
from app.main import app  # noqa: E402

ADMIN_A, ADMIN_B = str(uuid.uuid4()), str(uuid.uuid4())
_current = {"user": ADMIN_A}
app.dependency_overrides[get_current_user] = lambda: _current["user"]
client = TestClient(app)
REST = f"{URL.rstrip('/')}/rest/v1"
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
TAG = uuid.uuid4().hex[:8]          # keeps this run's companies apart from anything else

_failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(f"[{'ok  ' if cond else 'FAIL'}] {name}{('  ' + repr(detail)) if detail != '' and not cond else ''}")
    if not cond:
        _failures.append(name)


def db(method: str, path: str, **kw):
    r = httpx.request(method, f"{REST}/{path}", headers=H, timeout=30, **kw)
    r.raise_for_status()
    return r.json() if r.content else None


def workbook() -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "JOB AGENCIES UK"
    ws.append(["Company", "Link Job/Company", "LinkedIn", "Phone", "Email"])
    ws.append([f"Acme {TAG} Recruitment", "Recruiter", "Jane Doe - Lead Recruiter | LinkedIn", 1753621902, f"jane@acme-{TAG}.example"])
    ws["A2"].hyperlink = f"https://www.acme-{TAG}.example"
    ws["B2"].hyperlink = "https://www.linkedin.com/jobs/view/123/"
    ws["C2"].hyperlink = f"https://www.linkedin.com/in/jane-{TAG}/"
    ws.append([None, "worth a chat", "Tom Bell", "07700 900123 (general)", None])
    ws.append([None, None, "Ann One\nBob Two", "0200000000", None])            # two people: needs review
    ws.append([None, None, None, None, None])                                  # ends the Acme group
    ws.append([None, None, "Orphan Person", "0123456789", None])                # invalid: group ended
    ws.append([f"Beta {TAG} Staffing", None, "Kim Lo", None, f"kim@beta-{TAG}.example"])
    ws.append([None, None, "Kim Lo", None, f"KIM@beta-{TAG}.example"])          # same person again
    uk = wb.create_sheet("UK COMPANIES")
    uk.append(["COMPANY", "JOB TITLE/LINK"])
    uk.append([f"Gamma {TAG} Ltd", "Software Engineer"])
    uk["B2"].hyperlink = "https://uk.indeed.com/viewjob?jk=abc"
    uk.append([f"ACME {TAG} RECRUITMENT", None])                                # same company as sheet 1
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def run_import(data: bytes) -> tuple[str, dict]:
    up = client.post("/contacts/imports", params={"filename": f"e2e-{TAG}.xlsx"}, content=data)
    assert up.status_code == 201, up.text
    batch = up.json()["batch"]
    stored = db("GET", f"contact_import_batches?id=eq.{batch['id']}&select=status")
    check("the upload finished: the database has the batch as 'uploaded', not 'uploading'", stored == [{"status": "uploaded"}], stored)
    mapping = {"sheets": {s["name"]: s["suggested_mapping"] for s in batch["sheets"]}}
    preview = client.post(f"/contacts/imports/{batch['id']}/mapping", json=mapping)
    assert preview.status_code == 200, preview.text
    return batch["id"], preview.json()["preview"]


def rows(bid: str) -> dict[tuple[str, int], dict]:
    out = client.get(f"/contacts/imports/{bid}/rows", params={"limit": 500}).json()["rows"]
    return {(r["sheet"], r["row_number"]): r for r in out}


batches: list[str] = []
try:
    data = workbook()

    # ── First import ──────────────────────────────────────────────────────
    bid, preview = run_import(data)
    batches.append(bid)
    check("preview counts (8 non-blank rows; the spacer row is not a row)",
          preview == {"total": 8, "matched": 2, "new": 4, "needs_review": 1, "invalid": 1, "skipped": 0}, preview)
    r = rows(bid)
    A = "JOB AGENCIES UK"
    check("row 2: new company + new contact", r[(A, 2)]["classification"] == "new")
    check("row 3: same group, new contact; company created once (pending on row 2)",
          r[(A, 3)]["company_status"] == "new_pending" and r[(A, 3)]["contact_status"] == "new")
    check("row 4: two people in one cell → needs review", r[(A, 4)]["classification"] == "needs_review")
    check("row 6: after the blank row → invalid, with the reason",
          r[(A, 6)]["classification"] == "invalid" and "blank row" in r[(A, 6)]["reasons"][0])
    check("row 8: the same email again in the file → matched to row 7's contact",
          r[(A, 8)]["contact_status"] == "duplicate_in_file")
    check("UK row 3: the other sheet's spelling of Acme is the same pending company",
          r[("UK COMPANIES", 3)]["company_status"] == "new_pending")
    check("raw cells come back untouched", r[(A, 2)]["raw"]["D"]["value"] == 1753621902
          and r[(A, 2)]["raw"]["C"]["hyperlink"] == f"https://www.linkedin.com/in/jane-{TAG}/")

    resp = client.post(f"/contacts/imports/{bid}/commit")
    check("unresolved review rows don't block the import; they're skipped", resp.status_code == 200, resp.text[:300])

    # Before that commit landed, admin B could not have done it:
    _current["user"] = ADMIN_B
    check("another admin can't commit it (and it's already committed)",
          client.post(f"/contacts/imports/{bid}/commit").status_code == 403)
    _current["user"] = ADMIN_A

    summary = resp.json()["summary"]
    check("summary: 3 companies and 3 contacts created", summary["companies"]["created"] == 3
          and summary["contacts"]["created"] == 3, summary)
    companies = db("GET", f"companies?name=ilike.*{TAG}*&select=id,name,slug,website,canonical_domain")
    check("Acme exists once despite three rows on two sheets",
          sum(1 for c in companies if c["slug"] == f"acme-{TAG}-recruitment") == 1, companies)
    acme = next(c for c in companies if c["slug"] == f"acme-{TAG}-recruitment")
    check("Acme took its website from the company cell's hyperlink", acme["canonical_domain"] == f"acme-{TAG}.example")
    check("Gamma did not take the job-board link as its website",
          next(c for c in companies if c["slug"].startswith("gamma"))["website"] is None)
    jane = db("GET", f"contacts?email=eq.jane@acme-{TAG}.example&select=*")[0]
    check("Jane: name/title split, phone with its 0 back, profile URL",
          (jane["full_name"], jane["job_title"], jane["phone"], jane["linkedin_url"])
          == ("Jane Doe", "Lead Recruiter", "01753621902", f"https://www.linkedin.com/in/jane-{TAG}/"), jane)
    check("no job was created from job titles/links", db("GET", "jobs?source=eq.manual_import_xlsx&select=id") == [])
    detail = client.get(f"/contacts/imports/{bid}").json()
    check("history: committed, with counts", detail["batch"]["status"] == "committed" and detail["counts"]["total"] == 8)

    # ── Same file again ──────────────────────────────────────────────────
    bid2, preview2 = run_import(data)
    batches.append(bid2)
    check("re-import preview: nothing new", preview2["new"] == 0, preview2)
    resp = client.post(f"/contacts/imports/{bid2}/commit")
    s2 = resp.json()["summary"]
    check("re-import commit creates nothing", resp.status_code == 200 and s2["companies"]["created"] == 0
          and s2["contacts"]["created"] == 0, s2)
    check("still exactly 3 companies and 3 contacts",
          len(db("GET", f"companies?name=ilike.*{TAG}*&select=id")) == 3
          and len(db("GET", f"contacts?or=(email.ilike.*{TAG}*,full_name.eq.Tom Bell)&select=id")) == 3)
    previous = client.post("/contacts/imports", params={"filename": "again.xlsx"}, content=data).json()
    batches.append(previous["batch"]["id"])
    check("a third upload is told this file was imported before",
          {p["id"] for p in previous["previous_imports_of_this_file"]} >= {bid, bid2})
finally:
    for b in batches:
        db("DELETE", f"contact_import_batches?id=eq.{b}")
    ids = [c["id"] for c in db("GET", f"companies?name=ilike.*{TAG}*&select=id")]
    if ids:
        db("POST", "rpc/delete_companies_permanently", json={"p_company_ids": ids})
    left = len(db("GET", f"companies?name=ilike.*{TAG}*&select=id"))
    print(f"cleanup: {len(ids)} companies and their contacts removed, {left} left")

print()
if _failures:
    print(f"{len(_failures)} FAILED")
    raise SystemExit(1)
print("ALL CONTACT IMPORT END-TO-END CHECKS PASSED")
