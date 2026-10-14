import { createSupabaseServerClient } from "@/shared/auth/supabase-server";
import { careerHubApiUrl } from "@/features/career-hub/lib/api-url";
import type { Contact, DirectoryContact } from "@/features/career-hub/lib/types";

/**
 * A company's contacts, or a batch across several, from the FastAPI backend
 * (GET /contacts) — never a direct Supabase read. See the `Contact` type for
 * why: the `contacts` table is deny-by-default RLS, service-role-only,
 * reachable only through the backend.
 *
 * Server-only (imports next/headers via supabase-server) — for mutations
 * from a client component, see lib/contacts-api.ts, exactly as
 * lib/sponsorship.ts (server reads) and lib/sponsorship-api.ts (client
 * writes) are split.
 *
 * Never throws. requestContacts says what went wrong; fetchContacts turns
 * any failure into an empty list, so a page that only *decorates* itself with
 * contacts (a count, a picker) still renders. A page whose whole content is
 * contacts must not do that — an empty list there reads as "no contacts" — so
 * the Contact Directory reports the failure instead (getContactDirectory).
 */
type ContactsRequest<T> =
  | { ok: true; rows: T[] }
  | { ok: false; reason: "unconfigured" | "no_session" | "network" }
  | { ok: false; reason: "http"; status: number };

async function requestContacts<T = Contact>(pathAndQuery: string): Promise<ContactsRequest<T>> {
  const baseUrl = careerHubApiUrl();
  if (!baseUrl) return { ok: false, reason: "unconfigured" };

  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { ok: false, reason: "no_session" };

  try {
    const response = await fetch(
      `${baseUrl}/contacts${pathAndQuery}`,
      {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      }
    );
    if (!response.ok) return { ok: false, reason: "http", status: response.status };
    return { ok: true, rows: (await response.json()) as T[] };
  } catch {
    return { ok: false, reason: "network" };
  }
}

async function fetchContacts<T = Contact>(pathAndQuery: string): Promise<T[]> {
  const result = await requestContacts<T>(pathAndQuery);
  return result.ok ? result.rows : [];
}

export async function getContacts(companyId: string): Promise<Contact[]> {
  return fetchContacts(`?company_id=${encodeURIComponent(companyId)}`);
}

export type ContactDirectoryResult =
  | { ok: true; contacts: DirectoryContact[] }
  | { ok: false; error: string };

/** Every contact with its company — the coach Contact Directory. Unlike the
 *  readers above, a failure comes back as an error message for the page to
 *  show: this list *is* the page, so an empty one would claim there are no
 *  contacts. */
export async function getContactDirectory(): Promise<ContactDirectoryResult> {
  const result = await requestContacts<DirectoryContact>("/directory");
  if (result.ok) return { ok: true, contacts: result.rows };
  return { ok: false, error: directoryErrorMessage(result) };
}

function directoryErrorMessage(result: Exclude<ContactsRequest<unknown>, { ok: true }>): string {
  switch (result.reason) {
    case "unconfigured":
      return "Contacts can't be loaded: the Career Hub API isn't configured for this site (BACKEND_PYTHON_URL is not set).";
    case "no_session":
      return "Your session has expired. Sign in again to see contacts.";
    case "network":
      return "Contacts couldn't be loaded: the Career Hub API didn't respond. Try again in a moment.";
    case "http":
      if (result.status === 401 || result.status === 403) {
        return `You don't have access to the contact directory (HTTP ${result.status}). Sign in again with a coach account.`;
      }
      return `The contact directory couldn't be loaded (HTTP ${result.status}). Your contacts are not affected; try again, and if this keeps happening check the Career Hub API (backend-python) logs.`;
  }
}

// Well under MAX_COMPANY_IDS_PER_LIST (500) in app/routers/contacts.py: the ids
// travel in a GET query string that backend-python forwards to PostgREST as an
// `in.(...)` filter, and 500 UUIDs make a ~20 KB URL. 100 matches
// app/sponsors/service.py's cap for the same reason.
const CHUNK_SIZE = 100;

/**
 * Every contact across several companies — for the Outreach activity
 * dashboard, which needs to show a contact's name/role next to each outreach
 * row without an N+1 (one request per distinct company). Chunked so a large
 * company set is several short requests rather than one oversized URL.
 */
export async function getContactsForCompanies(
  companyIds: string[]
): Promise<Contact[]> {
  if (companyIds.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < companyIds.length; i += CHUNK_SIZE) {
    chunks.push(companyIds.slice(i, i + CHUNK_SIZE));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      fetchContacts(`?company_ids=${encodeURIComponent(chunk.join(","))}`)
    )
  );
  return results.flat();
}
