import { getSupabaseBrowser } from "@/shared/auth/supabase-browser";
import { CAREERHUB_PROXY } from "@/features/career-hub/lib/api-url";
import type { Contact, ContactInput } from "@/features/career-hub/lib/types";

/**
 * Client-side contact mutations against the FastAPI backend — for reading
 * a company's contacts from a Server Component, see lib/contacts.ts. Split
 * the same way lib/sponsorship-api.ts (client writes) is split from
 * lib/sponsorship.ts (server reads): this file imports the *browser*
 * Supabase client, which cannot be pulled into a Server Component.
 */

/**
 * FastAPI's error body isn't one shape: a route that raises
 * `HTTPException(detail="...")` (e.g. "Company not found.") sends
 * `{"detail": "..."}` — a plain string. A 422 from Pydantic validation
 * (e.g. ContactWrite's email format / "needs a contact method" checks in
 * schemas.py) sends `{"detail": [{"msg": "...", "loc": [...], ...}, ...]}`
 * — an ARRAY of error objects, one per failed field. `String(detail)` on
 * that array is where "[object Object]" came from: Array.prototype.toString
 * stringifies each element by calling its own toString, and a plain object
 * has none worth having. Handles both shapes explicitly instead.
 */
export function extractErrorDetail(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("detail" in data)) return null;
  const detail = (data as { detail?: unknown }).detail;

  if (typeof detail === "string") return detail;

  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        const msg =
          item && typeof item === "object"
            ? (item as { msg?: unknown }).msg
            : null;
        // Pydantic v2 prefixes a validator's own ValueError message with
        // "Value error, " — implementation noise, not something a coach
        // filling in a form should see.
        return typeof msg === "string"
          ? msg.replace(/^Value error,\s*/i, "")
          : null;
      })
      .filter((msg): msg is string => Boolean(msg));
    return messages.length > 0 ? messages.join(" ") : null;
  }

  return null;
}

async function authFetch<T>(path: string, init: RequestInit): Promise<T> {
  const supabase = getSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error("You must be signed in to manage contacts.");
  }

  const response = await fetch(`${CAREERHUB_PROXY}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const data: unknown = await response.json();
      const extracted = extractErrorDetail(data);
      if (extracted) detail = extracted;
    } catch {
      // Non-JSON error body — keep the default message.
    }
    throw new Error(detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** A company's contacts, fetched client-side — for an interactive picker
 *  (e.g. the Outreach placeholder's "choose a contact" step) that needs to
 *  load a different company's contacts on selection, without a page
 *  round-trip. For the initial list on page load, prefer the server-side
 *  lib/contacts.ts (no client-server waterfall). */
export function listContactsViaApi(companyId: string): Promise<Contact[]> {
  return authFetch<Contact[]>(
    `/contacts?company_id=${encodeURIComponent(companyId)}`,
    { method: "GET" }
  );
}

export function createContactViaApi(
  companyId: string,
  input: ContactInput
): Promise<Contact> {
  return authFetch<Contact>("/contacts", {
    method: "POST",
    body: JSON.stringify({ company_id: companyId, ...input }),
  });
}

export function updateContactViaApi(
  contactId: string,
  input: ContactInput
): Promise<Contact> {
  return authFetch<Contact>(`/contacts/${contactId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteContactViaApi(contactId: string): Promise<void> {
  return authFetch<void>(`/contacts/${contactId}`, { method: "DELETE" });
}
