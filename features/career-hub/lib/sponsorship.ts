import { createSupabaseServerClient } from "@/shared/auth/supabase-server";
import { careerHubApiUrl } from "@/features/career-hub/lib/api-url";
import type {
  CompanySponsorshipStatus,
  CompanySponsorshipStatusCompact,
  SponsorshipStats,
} from "@/features/career-hub/lib/types";

/**
 * This company's sponsorship status, from the FastAPI backend
 * (GET /sponsors/companies/{id}) — never a direct Supabase read. The
 * sponsorship tables are deny-by-default RLS, service-role-only; the backend
 * is the only thing allowed to query them, and it returns one of five
 * normalized states, never the raw register/check rows.
 *
 * Never throws. A missing session, a network failure, or a non-2xx response
 * all resolve to `null` rather than breaking the page that embeds this — the
 * Sponsorship card renders its own "Check unavailable" state for `null`,
 * matching how a genuine backend `status: "error"` renders. The one
 * exception is a 404 (company not found), which is also `null`: from this
 * card's point of view there is nothing to show either way.
 */
export async function getSponsorshipStatus(
  companyId: string
): Promise<CompanySponsorshipStatus | null> {
  const baseUrl = careerHubApiUrl();
  if (!baseUrl) return null;

  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;

  try {
    const response = await fetch(
      `${baseUrl}/sponsors/companies/${companyId}`,
      {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      }
    );
    if (!response.ok) return null;
    return (await response.json()) as CompanySponsorshipStatus;
  } catch {
    return null;
  }
}

/**
 * How many companies hold a confirmed sponsor licence (GET /sponsors/stats),
 * for the coach dashboard's "Licensed sponsors" KPI. One count, not a row per
 * company — the dashboard has no use for the individual companies, and asking
 * for their statuses instead would be 11 batched requests for one number.
 *
 * Never throws, same contract as the two functions around it: a missing
 * session, an undeployed or unreachable backend, or a non-2xx response all
 * resolve to `null`, which the KPI renders as "—" rather than failing the
 * whole dashboard over one tile.
 */
export async function getSponsorshipStats(): Promise<SponsorshipStats | null> {
  const baseUrl = careerHubApiUrl();
  if (!baseUrl) return null;

  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;

  try {
    const response = await fetch(`${baseUrl}/sponsors/stats`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as SponsorshipStats;
  } catch {
    return null;
  }
}

/**
 * The list-badge status for many companies at once (POST
 * /sponsors/companies/statuses), keyed by company id. One request
 * regardless of how many companies are shown — the whole reason this exists
 * instead of calling `getSponsorshipStatus` once per company, which would be
 * an N+1 the browser pays for on every /coach/sponsored-companies page load.
 *
 * Never throws. A missing session, a network failure, or a non-2xx response
 * all resolve to an empty map — the list still renders, just without badges,
 * rather than the whole page failing over a status chip.
 */
export async function getSponsorshipStatuses(
  companyIds: string[]
): Promise<Record<string, CompanySponsorshipStatusCompact>> {
  if (companyIds.length === 0) return {};

  const baseUrl = careerHubApiUrl();
  if (!baseUrl) return {};

  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return {};

  // Matches MAX_COMPANIES_PER_STATUS_BATCH in backend-python/app/schemas.py — kept
  // in step so a large company list still renders badges rather than a
  // single oversized request being rejected outright.
  const CHUNK_SIZE = 500;
  const chunks: string[][] = [];
  for (let i = 0; i < companyIds.length; i += CHUNK_SIZE) {
    chunks.push(companyIds.slice(i, i + CHUNK_SIZE));
  }

  try {
    const results = await Promise.all(
      chunks.map((chunk) =>
        fetch(`${baseUrl}/sponsors/companies/statuses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ company_ids: chunk }),
          cache: "no-store",
        })
      )
    );

    const merged: Record<string, CompanySponsorshipStatusCompact> = {};
    for (const response of results) {
      if (!response.ok) continue;
      const data = (await response.json()) as Record<
        string,
        CompanySponsorshipStatusCompact
      >;
      Object.assign(merged, data);
    }
    return merged;
  } catch {
    return {};
  }
}
