"""Coach-facing company contacts: CRUD, authenticated, service-role-mediated.

Contacts are shared crawler-adjacent data, like companies/jobs — not
per-coach data like outreach drafts — so any coach may view, add, edit or
delete any company's contacts. The table is RLS-denied (migration 034) and
never read from the browser. `get_current_user` admits coaches only
(`users.is_admin` or `ADMIN_USER_IDS`, app/auth.py). Students on Membership
see a reduced shape (no phone/notes) through Fastify
`routes/company-contacts.ts`, not through this router.
"""

from __future__ import annotations

import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import get_current_user
from app.config import Settings, get_settings
from app.crawler.supabase_rest import SupabaseRest
from app.schemas import Contact, ContactCreate, ContactWrite, DirectoryContact

router = APIRouter(prefix="/contacts", tags=["contacts"])

logger = logging.getLogger(__name__)

CONTACT_COLUMNS = (
    "id,company_id,full_name,job_title,email,phone,linkedin_url,notes,"
    "created_at,updated_at"
)

# Bounds the `company_ids` batch list — the Sponsored Companies list (contact
# counts per row) and the Outreach picker (a company's contacts) are the two
# callers; neither needs more than a coach's whole company set at once.
MAX_COMPANY_IDS_PER_LIST = 500


def _require_supabase(settings: Settings) -> SupabaseRest:
    if not (settings.supabase_url and settings.supabase_service_role_key):
        raise HTTPException(
            status_code=500, detail="Server is not configured for Supabase access."
        )
    return SupabaseRest(settings.supabase_url, settings.supabase_service_role_key)


async def _company_exists(
    client: httpx.AsyncClient, rest: SupabaseRest, company_id: str
) -> bool:
    rows = await rest.select(
        client, "companies", {"id": f"eq.{company_id}", "select": "id", "limit": "1"}
    )
    return bool(rows)


@router.get("", response_model=list[Contact])
async def list_contacts(
    company_id: Optional[str] = Query(
        None, description="A single company to list contacts for."
    ),
    company_ids: Optional[str] = Query(
        None,
        description="Comma-separated company ids, for a batch list across "
        "several companies at once.",
    ),
    _user_id: str = Depends(get_current_user),
) -> list[Contact]:
    """Contacts for one company, or a batch across several — most recently
    added first.

    Exactly one of `company_id`/`company_ids` is expected. The batch form
    exists so a list of companies can show a contact count (Sponsored
    Companies) or offer a contact picker once a company is chosen (Outreach)
    without an N+1 of one request per company — both reuse this same
    endpoint and the same `Contact` shape rather than a bespoke counts-only
    response.
    """
    if not company_id and not company_ids:
        raise HTTPException(
            status_code=422, detail="Provide company_id or company_ids."
        )

    settings = get_settings()
    rest = _require_supabase(settings)

    if company_ids:
        ids = [c.strip() for c in company_ids.split(",") if c.strip()]
        if not ids:
            return []
        if len(ids) > MAX_COMPANY_IDS_PER_LIST:
            raise HTTPException(
                status_code=422,
                detail=f"Provide at most {MAX_COMPANY_IDS_PER_LIST} company_ids.",
            )
        company_filter = f"in.({','.join(ids)})"
    else:
        company_filter = f"eq.{company_id}"

    async with httpx.AsyncClient() as client:
        rows = await rest.select(
            client,
            "contacts",
            {
                "company_id": company_filter,
                "select": CONTACT_COLUMNS,
                "order": "created_at.desc",
            },
        )

    return [Contact(**row) for row in rows]


# PostgREST's per-response row cap; the directory pages through it.
DIRECTORY_PAGE = 1000


@router.get("/directory", response_model=list[DirectoryContact])
async def contact_directory(
    _user_id: str = Depends(get_current_user),
) -> list[DirectoryContact]:
    """Every contact with its company, sorted by company then name — the
    coach Contact Directory. Search and category filtering happen in the
    page: contacts are hand-entered, so the whole set is small.

    ponytail: returns everything; add server-side search/paging when the
    set reaches the tens of thousands.
    """
    rest = _require_supabase(get_settings())
    rows: list[dict] = []
    async with httpx.AsyncClient() as client:
        while True:
            page = await rest.select(
                client,
                "contacts",
                {
                    "select": f"{CONTACT_COLUMNS},company:companies(id,name,slug)",
                    "order": "id",
                    "limit": str(DIRECTORY_PAGE),
                    "offset": str(len(rows)),
                },
            )
            rows.extend(page)
            if len(page) < DIRECTORY_PAGE:
                break

    rows.sort(key=lambda r: ((r.get("company") or {}).get("name", "").lower(), r["full_name"].lower()))
    return [DirectoryContact(**row) for row in rows]


@router.post("", response_model=Contact, status_code=201)
async def create_contact(
    body: ContactCreate,
    _user_id: str = Depends(get_current_user),
) -> Contact:
    settings = get_settings()
    rest = _require_supabase(settings)
    company_id = str(body.company_id)

    async with httpx.AsyncClient() as client:
        if not await _company_exists(client, rest, company_id):
            raise HTTPException(status_code=404, detail="Company not found.")

        row = {
            "company_id": company_id,
            "full_name": body.full_name,
            "job_title": body.job_title,
            "email": body.email,
            "phone": body.phone,
            "linkedin_url": body.linkedin_url,
            "notes": body.notes,
        }
        try:
            created = await rest.insert(client, "contacts", [row])
        except httpx.HTTPStatusError as exc:
            if "contacts_has_contact_method" in exc.response.text:
                raise HTTPException(
                    status_code=422,
                    detail="A contact needs at least one contact method: "
                    "email, phone, or LinkedIn.",
                ) from exc
            logger.exception("Creating contact for company %s failed", company_id)
            raise HTTPException(
                status_code=502, detail="The contact could not be created."
            ) from exc

    return Contact(**created[0])


@router.put("/{contact_id}", response_model=Contact)
async def update_contact(
    contact_id: str,
    body: ContactWrite,
    _user_id: str = Depends(get_current_user),
) -> Contact:
    """Replace a contact's editable fields. Full-form submit, not a sparse
    PATCH — see `ContactWrite`."""
    settings = get_settings()
    rest = _require_supabase(settings)

    values = {
        "full_name": body.full_name,
        "job_title": body.job_title,
        "email": body.email,
        "phone": body.phone,
        "linkedin_url": body.linkedin_url,
        "notes": body.notes,
    }

    async with httpx.AsyncClient() as client:
        try:
            updated = await rest.update(
                client,
                "contacts",
                {"id": f"eq.{contact_id}"},
                values,
                prefer="return=representation",
            )
        except httpx.HTTPStatusError as exc:
            if "contacts_has_contact_method" in exc.response.text:
                raise HTTPException(
                    status_code=422,
                    detail="A contact needs at least one contact method: "
                    "email, phone, or LinkedIn.",
                ) from exc
            logger.exception("Updating contact %s failed", contact_id)
            raise HTTPException(
                status_code=502, detail="The contact could not be updated."
            ) from exc

    if not updated:
        raise HTTPException(status_code=404, detail="Contact not found.")

    return Contact(**updated[0])


@router.delete("/{contact_id}", status_code=204)
async def delete_contact(
    contact_id: str,
    _user_id: str = Depends(get_current_user),
) -> None:
    settings = get_settings()
    rest = _require_supabase(settings)

    async with httpx.AsyncClient() as client:
        deleted = await rest.delete(client, "contacts", {"id": f"eq.{contact_id}"})

    if not deleted:
        raise HTTPException(status_code=404, detail="Contact not found.")
