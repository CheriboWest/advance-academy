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
 * Never throws. A missing session, a network failure, or a non-2xx response
 * all resolve to an empty list — a page using this still renders, just
 * without contacts, rather than failing outright.
 */
async function fetchContacts<T = Contact>(pathAndQuery: string): Promise<T[]> {
  const baseUrl = careerHubApiUrl();
  if (!baseUrl) return [];

  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return [];

  try {
    const response = await fetch(
      `${baseUrl}/contacts${pathAndQuery}`,
      {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      }
    );
    if (!response.ok) return [];
    return (await response.json()) as T[];
  } catch {
    return [];
  }
}

export async function getContacts(companyId: string): Promise<Contact[]> {
  return fetchContacts(`?company_id=${encodeURIComponent(companyId)}`);
}

/** Every contact with its company — the coach Contact Directory. */
export async function getContactDirectory(): Promise<DirectoryContact[]> {
  return fetchContacts<DirectoryContact>("/directory");
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
