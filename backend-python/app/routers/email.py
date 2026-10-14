"""Outreach email sending via Resend's HTTPS API.

Gmail SMTP was the original transport, but Railway blocks outbound SMTP ports
on every plan below Pro, so mail now leaves over port 443 like any other HTTP
request and Resend speaks SMTP to the recipient on our behalf.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.auth import get_current_user
from app.config import get_settings
from app.schemas import SendEmailRequest, SendEmailResponse

router = APIRouter(prefix="/email", tags=["email"])

# The `detail` sent to the browser stays deliberately vague; the cause goes to
# the server log instead, where it is the only way to tell a rejected API key
# from an unverified sender domain.
logger = logging.getLogger(__name__)


def _rest_base(supabase_url: str) -> str:
    return f"{supabase_url.rstrip('/')}/rest/v1/outreach_emails"


def _is_missing_column_error(response: httpx.Response) -> bool:
    """True when PostgREST rejected a write because a column does not exist."""
    body = response.text or ""
    return "PGRST204" in body or "does not exist" in body


@router.post("/send", response_model=SendEmailResponse)
async def send_email(
    req: SendEmailRequest,
    user_id: str = Depends(get_current_user),
) -> SendEmailResponse:
    settings = get_settings()

    if not (settings.supabase_url and settings.supabase_service_role_key):
        raise HTTPException(
            status_code=500,
            detail="Server is not configured for Supabase access.",
        )
    if not (settings.resend_api_key and settings.email_from):
        raise HTTPException(
            status_code=500, detail="Server is not configured for email sending."
        )

    rest_base = _rest_base(settings.supabase_url)
    service_headers = {
        "apikey": settings.supabase_service_role_key,
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        # 1. Load the draft with the service key (bypasses RLS server-side).
        try:
            load = await client.get(
                rest_base,
                params={"id": f"eq.{req.draft_id}", "select": "*"},
                headers=service_headers,
            )
            load.raise_for_status()
        except httpx.HTTPError as exc:
            logger.exception("Loading draft %s from Supabase failed", req.draft_id)
            raise HTTPException(
                status_code=502, detail="Could not load the draft."
            ) from exc

        rows = load.json()
        if not rows:
            raise HTTPException(status_code=404, detail="Draft not found.")

        draft = rows[0]

        # 2. Ensure the draft belongs to the authenticated coach.
        if str(draft.get("coach_user_id")) != user_id:
            raise HTTPException(
                status_code=403, detail="This draft does not belong to you."
            )

        subject = draft.get("subject") or ""
        body = draft.get("body") or ""

        # 3. Hand the email to Resend over HTTPS, reusing the client above.
        try:
            sent = await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                json={
                    "from": settings.email_from,
                    "to": [req.to],
                    "subject": subject,
                    "text": body,
                },
            )
            sent.raise_for_status()
        except httpx.HTTPError as exc:
            # raise_for_status() carries only the status code, but Resend names
            # the actual problem — which domain is unverified, which field is
            # malformed — in the response body. Transport errors have no
            # response at all, hence the isinstance check.
            reason = (
                exc.response.text if isinstance(exc, httpx.HTTPStatusError) else ""
            )
            logger.exception(
                "Resend rejected the email for draft %s: %s", req.draft_id, reason
            )
            raise HTTPException(
                status_code=502, detail="Failed to send the email."
            ) from exc

        # 4. Mark the draft as sent, and record it as outreach activity: this
        # is the one place a send becomes something the Outreach activity
        # dashboard can show and a coach can track follow-ups against.
        # `last_contacted_at`/`recipient_email` were added in migration 0012;
        # if that hasn't reached this database yet, fall back to the
        # original two-field write rather than losing the send confirmation
        # over bookkeeping columns that don't exist yet (same tiered-write
        # reasoning as the crawl-stats persistence fix).
        sent_at = datetime.now(timezone.utc).isoformat()
        full_payload = {
            "status": "sent",
            "sent_at": sent_at,
            "last_contacted_at": sent_at,
            "recipient_email": req.to,
        }
        try:
            update = await client.patch(
                rest_base,
                params={"id": f"eq.{req.draft_id}"},
                headers={**service_headers, "Prefer": "return=minimal"},
                json=full_payload,
            )
            if update.status_code >= 400 and _is_missing_column_error(update):
                logger.warning(
                    "outreach_emails is missing tracking columns — apply "
                    "supabase/migrations/035_ch0012_outreach_tracking.sql "
                    "(or, if a migration tool already believes that one "
                    "applied, its idempotent repair: "
                    "0015_repair_outreach_tracking.sql). Falling back to a "
                    "status-only write. draft_id=%s",
                    req.draft_id,
                )
                update = await client.patch(
                    rest_base,
                    params={"id": f"eq.{req.draft_id}"},
                    headers={**service_headers, "Prefer": "return=minimal"},
                    json={"status": "sent", "sent_at": sent_at},
                )
            update.raise_for_status()
        except httpx.HTTPError as exc:
            # The email was sent; surface the bookkeeping failure clearly.
            logger.exception(
                "Draft %s was emailed but could not be marked sent", req.draft_id
            )
            raise HTTPException(
                status_code=502,
                detail="Email sent, but the draft status could not be updated.",
            ) from exc

    return SendEmailResponse(status="sent", sent_at=sent_at, recipient_email=req.to)
