"""Bulk company/contact import wizard (CareerHub CRM, /coach/contacts/import).

  POST /contacts/imports?filename=…          upload an .xlsx/.csv (raw request body)
  GET  /contacts/imports                     history
  GET  /contacts/imports/company-search?q=   companies, for matching a row by hand
  GET  /contacts/imports/{id}                one batch: status, sheets, counts, summary
  GET  /contacts/imports/{id}/rows           its rows (filter by classification)
  POST /contacts/imports/{id}/mapping        apply a column mapping → preview
  POST /contacts/imports/{id}/resolutions    decide needs_review rows → preview
  POST /contacts/imports/{id}/commit         import, in one database transaction

Admin-only: every route depends on `get_current_user`, which is this API's
coach/admin gate (403 for anyone without users.is_admin or the ADMIN_USER_IDS
allowlist). History is shared by all admins, like the contacts themselves;
changing or committing a batch is limited to the admin who uploaded it
(checked here and again inside contact_import_commit).

Matching, duplicate detection and the import itself run in the database
(migration 048) so the preview an admin approves and the commit that writes
can never disagree.
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from typing import Any, Literal, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.auth import get_current_user
from app.config import Settings, get_settings
from app.contacts_import.mapping import apply_mapping, validate_mapping
from app.contacts_import.upload import MAX_FILE_BYTES, ROLES, UploadError, parse_upload
from app.crawler.supabase_rest import SupabaseRest

router = APIRouter(prefix="/contacts/imports", tags=["contact-imports"])
logger = logging.getLogger(__name__)

_CHUNK = 500
_PAGE = 1000
_RPC_TIMEOUT = 300.0
CLASSIFICATIONS = ("matched", "new", "needs_review", "invalid", "skipped")
BATCH_COLUMNS = (
    "id,created_by,file_name,file_kind,file_sha256,file_size,status,sheets,mapping,summary,error,"
    "created_at,updated_at,previewed_at,committed_at,committed_by"
)
ROW_COLUMNS = (
    "id,sheet,sheet_index,row_number,raw,extracted,parse_errors,classification,company_status,contact_status,"
    "company_match,contact_match,company_candidates,contact_candidates,reasons,source_job_id,resolution,"
    "result_status,result,error"
)


def _require_supabase(settings: Settings) -> SupabaseRest:
    if not (settings.supabase_url and settings.supabase_service_role_key):
        raise HTTPException(status_code=500, detail="Server is not configured for Supabase access.")
    return SupabaseRest(settings.supabase_url, settings.supabase_service_role_key)


def _valid_uuid(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=404, detail="Import not found.") from exc


async def _load_batch(client: httpx.AsyncClient, rest: SupabaseRest, batch_id: str) -> dict[str, Any]:
    rows = await rest.select(client, "contact_import_batches",
                             {"id": f"eq.{_valid_uuid(batch_id)}", "select": BATCH_COLUMNS, "limit": "1"})
    if not rows:
        raise HTTPException(status_code=404, detail="Import not found.")
    return rows[0]


def _require_owner(batch: dict[str, Any], user_id: str) -> None:
    if batch["created_by"] != user_id:
        raise HTTPException(status_code=403, detail="Only the admin who uploaded this file can change or import it.")


def _require_editable(batch: dict[str, Any]) -> None:
    if batch["status"] == "committed":
        raise HTTPException(status_code=409, detail="This import has already been committed.")
    if batch["status"] == "uploading":
        raise HTTPException(status_code=409, detail="This upload did not finish. Upload the file again.")


def _db_error(exc: httpx.HTTPStatusError) -> Optional[dict[str, Any]]:
    try:
        body = exc.response.json()
        return body if isinstance(body, dict) else None
    except ValueError:
        return None


# ── Upload ────────────────────────────────────────────────────────────────────

async def _read_body(request: Request) -> bytes:
    """The upload, refused as soon as it passes the size limit rather than
    after buffering however much a client chooses to send."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail=f"The file is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB.")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail=f"The file is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB.")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("", status_code=201)
async def upload_import(
    request: Request,
    filename: str = Query(..., min_length=1, max_length=255),
    user_id: str = Depends(get_current_user),
) -> dict[str, Any]:
    data = await _read_body(request)
    safe_name = re.sub(r"[^\w.\- ()]+", "_", filename).strip() or "upload"
    try:
        kind, sheets = parse_upload(safe_name, data)
    except UploadError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not any(s.rows for s in sheets):
        raise HTTPException(status_code=422, detail="The file has no data rows under its header.")

    rest = _require_supabase(get_settings())
    sha = hashlib.sha256(data).hexdigest()
    summaries = [s.summary() for s in sheets]
    async with httpx.AsyncClient() as client:
        previous = await rest.select(client, "contact_import_batches", {
            "file_sha256": f"eq.{sha}", "select": "id,file_name,status,created_at", "order": "created_at.desc"})
        # 'uploading' until the last row is stored. If this request dies part-way
        # (an error, a timeout, a cancelled request, a restart) the batch is
        # deleted, or failing that stays marked unfinished: the mapping, the
        # preview and the commit all refuse it, so a partial file can never
        # pass for the whole one (its missing rows would read as blank rows
        # and split company groups).
        created = await rest.insert(client, "contact_import_batches", [{
            "created_by": user_id, "file_name": safe_name, "file_kind": kind, "file_sha256": sha,
            "file_size": len(data), "sheets": summaries, "status": "uploading",
        }])
        batch = created[0]
        rows = [
            {"batch_id": batch["id"], "sheet": s.name, "sheet_index": s.index, "row_number": r.row_number, "raw": r.cells}
            for s in sheets for r in s.rows if not r.is_blank
        ]
        try:
            for i in range(0, len(rows), _CHUNK):
                await rest.insert(client, "contact_import_rows", rows[i:i + _CHUNK], prefer="return=minimal", timeout=60.0)
            await rest.update(client, "contact_import_batches", {"id": f"eq.{batch['id']}"}, {"status": "uploaded"})
        except BaseException as exc:  # noqa: BLE001 — cancellation too: never leave a partial batch looking complete
            logger.exception("Storing rows for import %s failed", batch["id"])
            try:
                await rest.delete(client, "contact_import_batches", {"id": f"eq.{batch['id']}"}, prefer="return=minimal")
            except BaseException:  # noqa: BLE001 — the batch stays 'uploading', which is refused everywhere
                logger.error("Could not remove unfinished import %s; it stays marked as uploading", batch["id"])
            if isinstance(exc, Exception):
                raise HTTPException(status_code=502, detail="The file could not be stored.") from exc
            raise
        batch["status"] = "uploaded"

    return {"batch": batch, "previous_imports_of_this_file": previous}


# ── Reads ─────────────────────────────────────────────────────────────────────

@router.get("")
async def list_imports(
    limit: int = Query(50, ge=1, le=200),
    user_id: str = Depends(get_current_user),
) -> list[dict[str, Any]]:
    rest = _require_supabase(get_settings())
    async with httpx.AsyncClient() as client:
        batches = await rest.select(client, "contact_import_batches", {
            "select": "id,created_by,file_name,file_kind,status,summary,error,created_at,previewed_at,committed_at",
            "order": "created_at.desc", "limit": str(limit)})
    return [{**b, "mine": b["created_by"] == user_id} for b in batches]


@router.get("/company-search")
async def company_search(
    q: str = Query(..., min_length=2, max_length=100),
    _user_id: str = Depends(get_current_user),
) -> list[dict[str, Any]]:
    # PostgREST's or=() syntax treats , ( ) * as structure: keep only safe text.
    term = re.sub(r"[^\w\s.&'-]+", " ", q).strip()
    if len(term) < 2:
        return []
    rest = _require_supabase(get_settings())
    async with httpx.AsyncClient() as client:
        return await rest.select(client, "companies", {
            "select": "id,name,slug,website,website_url",
            "or": f"(name.ilike.*{term}*,slug.ilike.*{term}*)",
            "order": "name", "limit": "20"})


async def _counts(client: httpx.AsyncClient, rest: SupabaseRest, batch_id: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for c in CLASSIFICATIONS:
        counts[c] = await rest.count(client, "contact_import_rows",
                                     {"batch_id": f"eq.{batch_id}", "classification": f"eq.{c}"}) or 0
    counts["total"] = await rest.count(client, "contact_import_rows", {"batch_id": f"eq.{batch_id}"}) or 0
    return counts


@router.get("/{batch_id}")
async def get_import(batch_id: str, user_id: str = Depends(get_current_user)) -> dict[str, Any]:
    rest = _require_supabase(get_settings())
    async with httpx.AsyncClient() as client:
        batch = await _load_batch(client, rest, batch_id)
        counts = await _counts(client, rest, batch["id"])
    return {"batch": {**batch, "mine": batch["created_by"] == user_id}, "counts": counts}


@router.get("/{batch_id}/rows")
async def list_rows(
    batch_id: str,
    classification: Optional[str] = Query(None),
    result_status: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _user_id: str = Depends(get_current_user),
) -> dict[str, Any]:
    if classification and classification not in CLASSIFICATIONS:
        raise HTTPException(status_code=422, detail="Unknown classification.")
    if result_status and result_status not in ("created", "updated", "matched", "skipped", "failed", "rolled_back"):
        raise HTTPException(status_code=422, detail="Unknown result status.")
    rest = _require_supabase(get_settings())
    params = {"batch_id": f"eq.{_valid_uuid(batch_id)}", "select": ROW_COLUMNS,
              "order": "sheet_index,row_number", "limit": str(limit), "offset": str(offset)}
    count_params = {"batch_id": params["batch_id"]}
    if classification:
        params["classification"] = count_params["classification"] = f"eq.{classification}"
    if result_status:
        params["result_status"] = count_params["result_status"] = f"eq.{result_status}"
    async with httpx.AsyncClient() as client:
        await _load_batch(client, rest, batch_id)
        rows = await rest.select(client, "contact_import_rows", params)
        total = await rest.count(client, "contact_import_rows", count_params)
    return {"rows": rows, "total": total, "limit": limit, "offset": offset}


# ── Mapping → preview ─────────────────────────────────────────────────────────

class SheetMapping(BaseModel):
    include: bool = True
    group_fill: bool = False
    company_link_is_website: bool = False
    columns: dict[str, str] = Field(default_factory=dict)


class MappingBody(BaseModel):
    sheets: dict[str, SheetMapping]


async def _classify(client: httpx.AsyncClient, rest: SupabaseRest, batch_id: str) -> dict[str, Any]:
    try:
        return await rest.rpc(client, "contact_import_classify", {"p_batch": batch_id}, timeout=_RPC_TIMEOUT)
    except httpx.HTTPStatusError as exc:
        logger.exception("Classifying import %s failed", batch_id)
        raise HTTPException(status_code=502, detail="The preview could not be built.") from exc


async def _all_rows(client: httpx.AsyncClient, rest: SupabaseRest, batch_id: str, select: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    while True:
        page = await rest.select(client, "contact_import_rows", {
            "batch_id": f"eq.{batch_id}", "select": select, "order": "sheet_index,row_number",
            "limit": str(_PAGE), "offset": str(len(rows))}, timeout=60.0)
        rows.extend(page)
        if len(page) < _PAGE:
            return rows


def with_blank_rows(stored: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Blank rows are not stored, but they end company groups. Every non-blank
    row is stored under its sheet row number, so a gap in the numbering is
    exactly a run of blank rows: put one marker back for it."""
    out: list[dict[str, Any]] = []
    previous: Optional[int] = None
    for row in stored:
        if previous is not None and row["row_number"] > previous + 1:
            out.append({"row_number": previous + 1, "cells": {}})
        out.append({"row_number": row["row_number"], "cells": row["raw"]})
        previous = row["row_number"]
    return out


@router.post("/{batch_id}/mapping")
async def apply_import_mapping(batch_id: str, body: MappingBody, user_id: str = Depends(get_current_user)) -> dict[str, Any]:
    rest = _require_supabase(get_settings())
    mapping = {name: spec.model_dump() for name, spec in body.sheets.items()}
    async with httpx.AsyncClient() as client:
        batch = await _load_batch(client, rest, batch_id)
        _require_owner(batch, user_id)
        _require_editable(batch)
        problem = validate_mapping(mapping, batch["sheets"], ROLES)
        if problem:
            raise HTTPException(status_code=422, detail=problem)

        stored = await _all_rows(client, rest, batch["id"], "sheet,sheet_index,row_number,raw")
        by_sheet: dict[str, list[dict[str, Any]]] = {}
        for row in stored:
            by_sheet.setdefault(row["sheet"], []).append(row)

        updates: list[dict[str, Any]] = []
        for sheet_name, rows in by_sheet.items():
            spec = mapping.get(sheet_name, {"include": False})
            sheet_index = rows[0]["sheet_index"]
            raw_by_number = {r["row_number"]: r["raw"] for r in rows}
            for item in apply_mapping(with_blank_rows(rows), spec):
                updates.append({
                    "batch_id": batch["id"], "sheet": sheet_name, "sheet_index": sheet_index,
                    "row_number": item["row_number"], "raw": raw_by_number[item["row_number"]],
                    "extracted": item["extracted"], "parse_errors": item["parse_errors"],
                    # A new mapping can change what a row means: earlier decisions no longer apply.
                    "resolution": None, "result_status": None, "result": None, "error": None,
                })
        for i in range(0, len(updates), _CHUNK):
            await rest.upsert(client, "contact_import_rows", updates[i:i + _CHUNK],
                              on_conflict="batch_id,sheet,row_number", prefer="resolution=merge-duplicates,return=minimal",
                              timeout=120.0)
        # The rows' earlier commit results were cleared above; a failed commit's
        # summary and error describe rows that no longer mean the same thing.
        reset: dict[str, Any] = {"mapping": mapping, "summary": None, "error": None}
        if batch["status"] == "failed":
            reset["status"] = "previewed"
        await rest.update(client, "contact_import_batches", {"id": f"eq.{batch['id']}"}, reset)
        preview = await _classify(client, rest, batch["id"])
    return {"preview": preview}


# ── Resolutions ───────────────────────────────────────────────────────────────

class CompanyDecision(BaseModel):
    action: Literal["match", "create", "skip"]
    company_id: Optional[uuid.UUID] = None
    save_alias: bool = False


class ContactDecision(BaseModel):
    action: Literal["match", "create", "skip"]
    contact_id: Optional[uuid.UUID] = None


class RowResolution(BaseModel):
    row_id: int
    company: Optional[CompanyDecision] = None
    contact: Optional[ContactDecision] = None
    clear: bool = False


class ResolutionsBody(BaseModel):
    resolutions: list[RowResolution] = Field(min_length=1, max_length=1000)


def _resolution_json(r: RowResolution) -> Optional[dict[str, Any]]:
    if r.clear:
        return None
    out: dict[str, Any] = {}
    if r.company:
        if r.company.action == "match" and not r.company.company_id:
            raise HTTPException(status_code=422, detail=f"Row {r.row_id}: choose the company to match.")
        out["company"] = {"action": r.company.action}
        if r.company.action == "match":
            out["company"].update(company_id=str(r.company.company_id), save_alias=r.company.save_alias)
    if r.contact:
        if r.contact.action == "match" and not r.contact.contact_id:
            raise HTTPException(status_code=422, detail=f"Row {r.row_id}: choose the contact to match.")
        out["contact"] = {"action": r.contact.action}
        if r.contact.action == "match":
            out["contact"]["contact_id"] = str(r.contact.contact_id)
    if not out:
        raise HTTPException(status_code=422, detail=f"Row {r.row_id}: no decision given.")
    return out


@router.post("/{batch_id}/resolutions")
async def resolve_rows(batch_id: str, body: ResolutionsBody, user_id: str = Depends(get_current_user)) -> dict[str, Any]:
    rest = _require_supabase(get_settings())
    decisions = {r.row_id: _resolution_json(r) for r in body.resolutions}
    async with httpx.AsyncClient() as client:
        batch = await _load_batch(client, rest, batch_id)
        _require_owner(batch, user_id)
        _require_editable(batch)
        if batch["status"] == "uploaded":
            raise HTTPException(status_code=409, detail="Apply a column mapping first.")
        ids = list(decisions)
        known = set()
        for i in range(0, len(ids), _CHUNK):
            found = await rest.select(client, "contact_import_rows", {
                "batch_id": f"eq.{batch['id']}", "id": f"in.({','.join(str(x) for x in ids[i:i + _CHUNK])})", "select": "id"})
            known.update(r["id"] for r in found)
        missing = sorted(set(ids) - known)
        if missing:
            raise HTTPException(status_code=404, detail=f"Rows not in this import: {missing[:10]}")
        for row_id, resolution in decisions.items():
            await rest.update(client, "contact_import_rows", {"id": f"eq.{row_id}", "batch_id": f"eq.{batch['id']}"},
                              {"resolution": resolution})
        preview = await _classify(client, rest, batch["id"])
    return {"preview": preview}


# ── Commit ────────────────────────────────────────────────────────────────────

_COMMIT_ERRORS = {
    "CI403": (403, "Only the admin who uploaded this file can import it."),
    "CI404": (404, "Import not found."),
    "CI409": (409, "This import has already been committed."),
    "CI400": (409, "Apply a column mapping and review the preview first."),
}


@router.post("/{batch_id}/commit")
async def commit_import(batch_id: str, user_id: str = Depends(get_current_user)) -> dict[str, Any]:
    rest = _require_supabase(get_settings())
    async with httpx.AsyncClient() as client:
        batch = await _load_batch(client, rest, batch_id)
        _require_owner(batch, user_id)
        _require_editable(batch)
        try:
            summary = await rest.rpc(client, "contact_import_commit",
                                     {"p_batch": batch["id"], "p_actor": user_id}, timeout=_RPC_TIMEOUT)
        except httpx.HTTPStatusError as exc:
            err = _db_error(exc) or {}
            mapped = _COMMIT_ERRORS.get(err.get("code", ""))
            if mapped:
                raise HTTPException(status_code=mapped[0], detail=mapped[1]) from exc
            logger.exception("Committing import %s failed", batch["id"])
            raise HTTPException(status_code=502, detail="The import could not be completed. Nothing was imported.") from exc
    return {"summary": summary}
