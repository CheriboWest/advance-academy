import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/shared/auth/supabase-server";
import { getServerEnv } from "@/shared/env/server";
import type {
  CoachCompanyRow,
  CoachDashboardData,
  CompanySummary,
  OutreachEmail,
  SponsoredCompanyContext,
  SponsoredCompanyRow,
} from "@/features/career-hub/lib/types";

const COMPANY_COLUMNS =
  "id, slug, name, website, careers_url, sector, region, hq_location, lead_score, open_jobs";

const HIGH_SCORE_THRESHOLD = 80;

/**
 * Company ids the current coach has removed from their workspace
 * (`coach_company_meta.hidden = true`). RLS restricts these rows to the
 * signed-in coach, so this is inherently per-coach and never affects students,
 * other coaches, or the shared `companies` / `public_company_summary` data.
 */
export async function getHiddenCompanyIds(
  supabase: SupabaseClient
): Promise<string[]> {
  const { data, error } = await supabase
    .from("coach_company_meta")
    .select("company_id")
    .eq("hidden", true);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.company_id as string);
}

/** PostgREST `in` list literal, e.g. `(id1,id2)`. */
function inList(ids: string[]): string {
  return `(${ids.join(",")})`;
}

/**
 * The authenticated coach's verified token claims (`sub`, `email`, ...), or
 * `null`. Server-side session check.
 *
 * `getClaims()` rather than `getUser()`: getUser() is a network round trip to
 * the Supabase Auth server on EVERY call, and middleware.ts has already made
 * that call — and already redirected anyone unauthenticated — milliseconds
 * earlier, so a second one bought nothing but latency on every coach page
 * load. This project signs access tokens with asymmetric ES256 keys (see
 * backend-python/app/auth.py, which verifies the same tokens against the same
 * published JWKS), and for asymmetric keys getClaims() verifies the signature
 * locally via WebCrypto with no request at all. This is still a real
 * cryptographic check, so the defence-in-depth the layout wants is intact —
 * only the round trip is gone. auth-js caches the JWKS in a module-level
 * global for 10 minutes, so the fresh client object createSupabaseServerClient
 * returns per call does not refetch it.
 *
 * `cache()` so several callers within one request share a single verification.
 */
export const getCoachUser = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims ?? null;
});

/**
 * Whether the signed-in user may use the coach workspace.
 *
 * Asks Fastify rather than reading the column here, because `is_admin` is not
 * the whole answer: lib/admin.ts also honours the ADMIN_USER_IDS allowlist,
 * which is the bootstrap path and the way back in if the flag is ever mis-set.
 * Re-reading the column directly would silently skip it.
 *
 * GET /api/account/me is also the approval gate's one exemption, so it answers
 * even for an account still marked `pending` — which is what a newly-created
 * coach is. That is deliberate: the person who approves accounts must be able
 * to reach the workspace before someone approves theirs.
 *
 * Called from a Server Component, so it talks to Fastify directly. The proxy
 * routes under app/api exist to keep BACKEND_URL out of the *browser* bundle;
 * there is no browser here.
 *
 * Fails closed: any error is "not a coach".
 */
export const isCoach = cache(async (): Promise<boolean> => {
  const supabase = await createSupabaseServerClient();
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return false;

  try {
    const res = await fetch(`${getServerEnv().backendUrl}/api/account/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return false;
    const me = (await res.json()) as { isAdmin?: boolean };
    return me.isAdmin === true;
  } catch {
    return false;
  }
});

const PAGE_ROWS = 1000;

/**
 * Every row of a query. PostgREST caps one response at 1,000 rows, so an
 * unranged select silently drops the rest; `page` must build a fresh, stably
 * ordered query for each range.
 *
 * ponytail: sequential pages, fine for ~10k rows of an internal tool; move to
 * server-side paging in the UI if the company set grows well past that.
 */
async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_ROWS) return rows;
  }
}

/** Aggregate all data shown on the coach dashboard. */
export async function getDashboardData(): Promise<CoachDashboardData> {
  const supabase = await createSupabaseServerClient();

  // Exclude the coach's hidden companies from every aggregate and list. The
  // filter is applied in-query, before any `limit`, so counts and top-N lists
  // reflect only the coach's visible companies.
  const hiddenIds = await getHiddenCompanyIds(supabase);

  let totalQuery = supabase
    .from("public_company_summary")
    .select("*", { count: "exact", head: true });
  let highScoreQuery = supabase
    .from("public_company_summary")
    .select("*", { count: "exact", head: true })
    .gte("lead_score", HIGH_SCORE_THRESHOLD);
  // The view exposes no timestamp column, so we approximate "recent" by id.
  let recentQuery = supabase
    .from("public_company_summary")
    .select(COMPANY_COLUMNS)
    .order("id", { ascending: false })
    .limit(10);
  let topHiringQuery = supabase
    .from("public_company_summary")
    .select(COMPANY_COLUMNS)
    .order("open_jobs", { ascending: false, nullsFirst: false })
    .limit(5);

  if (hiddenIds.length) {
    const notIn = inList(hiddenIds);
    totalQuery = totalQuery.not("id", "in", notIn);
    highScoreQuery = highScoreQuery.not("id", "in", notIn);
    recentQuery = recentQuery.not("id", "in", notIn);
    topHiringQuery = topHiringQuery.not("id", "in", notIn);
  }

  const jobsPage = (from: number, to: number) => {
    let query = supabase
      .from("public_company_summary")
      .select("id, open_jobs")
      .order("id")
      .range(from, to);
    if (hiddenIds.length) query = query.not("id", "in", inList(hiddenIds));
    return query;
  };

  const [
    totalResult,
    highScoreResult,
    jobRows,
    recentResult,
    topHiringResult,
  ] = await Promise.all([
    totalQuery,
    highScoreQuery,
    selectAll(jobsPage),
    recentQuery,
    topHiringQuery,
  ]);

  const firstError =
    totalResult.error ||
    highScoreResult.error ||
    recentResult.error ||
    topHiringResult.error;
  if (firstError) {
    throw new Error(firstError.message);
  }

  const totalActiveJobs = jobRows.reduce(
    (sum, row) => sum + ((row.open_jobs as number | null) ?? 0),
    0
  );

  return {
    totalCompanies: totalResult.count ?? 0,
    highScoreCompanies: highScoreResult.count ?? 0,
    totalActiveJobs,
    recentCompanies: (recentResult.data ?? []) as CompanySummary[],
    topHiringCompanies: (topHiringResult.data ?? []) as CompanySummary[],
  };
}

/**
 * Companies for the coach's list, merged with their private metadata (starred +
 * notes). The metadata query is limited to the coach's own rows by RLS.
 *
 * `options.hidden` selects the view:
 *   - `false` (default) → the coach's visible companies (`hidden = false`)
 *   - `true`            → the coach's removed companies (`hidden = true`)
 *
 * Filtering is done server-side against the coach's own meta rows: the meta is
 * read first (cheap, RLS-scoped), then the `public_company_summary` query is
 * narrowed with `id in`/`id not in` so we never pull the full company set to
 * filter in JS.
 */
export async function getCoachCompanies(
  options: { hidden?: boolean } = {}
): Promise<CoachCompanyRow[]> {
  const hidden = options.hidden ?? false;
  const supabase = await createSupabaseServerClient();

  const { data: metaData, error: metaError } = await supabase
    .from("coach_company_meta")
    .select("company_id, starred, notes, hidden");
  if (metaError) throw new Error(metaError.message);

  const metaByCompany = new Map(
    (metaData ?? []).map((meta) => [meta.company_id as string, meta])
  );
  const hiddenIds = (metaData ?? [])
    .filter((meta) => meta.hidden)
    .map((meta) => meta.company_id as string);

  // The "Removed" view is exactly the hidden set — empty if nothing is hidden,
  // so skip the companies query entirely.
  if (hidden && hiddenIds.length === 0) return [];

  const companiesData = await selectAll((from, to) => {
    let companiesQuery = supabase
      .from("public_company_summary")
      .select("id, slug, name, region, hq_location, open_jobs, lead_score")
      .order("name", { ascending: true })
      .order("id")
      .range(from, to);

    if (hidden) {
      companiesQuery = companiesQuery.in("id", hiddenIds);
    } else if (hiddenIds.length) {
      companiesQuery = companiesQuery.not("id", "in", inList(hiddenIds));
    }
    return companiesQuery;
  });

  return companiesData.map((company) => {
    const meta = metaByCompany.get(company.id as string);
    return {
      company_id: company.id as string,
      slug: company.slug as string,
      name: company.name as string,
      location:
        (company.hq_location as string | null) ??
        (company.region as string | null) ??
        "—",
      open_jobs: (company.open_jobs as number | null) ?? 0,
      lead_score: (company.lead_score as number | null) ?? 0,
      starred: Boolean(meta?.starred),
      notes: (meta?.notes as string | null) ?? "",
    } satisfies CoachCompanyRow;
  });
}

/** What a Sponsored Companies *card* renders. Deliberately without
 *  `ai_summary`: SponsoredCompanyRow has no field for it, so selecting it here
 *  pulled a text blob per company over the wire for the list to throw away. */
const SPONSORED_COMPANY_LIST_COLUMNS =
  "id, slug, name, sector, region, hq_location, open_jobs, lead_score";

/** The card columns plus the AI summary, which only the detail page shows. */
const SPONSORED_COMPANY_COLUMNS =
  `${SPONSORED_COMPANY_LIST_COLUMNS}, ai_summary, ai_summary_generated_at`;

/**
 * All companies for the Sponsored Companies list. Also the company set the
 * Outreach placeholder's "choose a company" step reuses — see
 * app/coach/(workspace)/outreach/page.tsx — so this stays free of anything
 * Sponsored-Companies-specific (sponsorship status and contact counts are
 * fetched separately and merged in by each page, not baked in here).
 */
export async function getSponsoredCompanies(): Promise<SponsoredCompanyRow[]> {
  const supabase = await createSupabaseServerClient();

  // Concurrent, not sequential. The hidden set used to be awaited first purely
  // so the companies query could be narrowed with `not.in`, which put two
  // round trips to Supabase in series at the very front of a page that shows
  // nothing until both have landed. Excluding the hidden ids in JS instead
  // lets the two overlap.
  //
  // ponytail: this fetches the coach's hidden companies only to drop them,
  // so the row count crossing the wire is the *unfiltered* company set,
  // paged past PostgREST's 1000-row cap by selectAll.
  const [hiddenIds, data] = await Promise.all([
    getHiddenCompanyIds(supabase),
    selectAll((from, to) =>
      supabase
        .from("public_company_summary")
        .select(SPONSORED_COMPANY_LIST_COLUMNS)
        .order("name", { ascending: true })
        .order("id")
        .range(from, to)
    ),
  ]);

  const hidden = new Set(hiddenIds);

  return data
    .filter((company) => !hidden.has(company.id as string))
    .map((company) => ({
      company_id: company.id as string,
      slug: company.slug as string,
      name: company.name as string,
      location:
        (company.hq_location as string | null) ??
        (company.region as string | null) ??
        "—",
      sector: (company.sector as string | null) ?? null,
      open_jobs: (company.open_jobs as number | null) ?? 0,
      lead_score: (company.lead_score as number | null) ?? 0,
    }));
}

/** Company context for the Sponsored Company detail page's overview, by id. */
export async function getSponsoredCompanyContext(
  companyId: string
): Promise<SponsoredCompanyContext | null> {
  const supabase = await createSupabaseServerClient();

  // A company the coach has removed is treated as not found in their workspace.
  const hiddenIds = await getHiddenCompanyIds(supabase);
  if (hiddenIds.includes(companyId)) return null;

  const { data, error } = await supabase
    .from("public_company_summary")
    .select(SPONSORED_COMPANY_COLUMNS)
    .eq("id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  return {
    company_id: data.id as string,
    slug: data.slug as string,
    name: data.name as string,
    location:
      (data.hq_location as string | null) ??
      (data.region as string | null) ??
      "—",
    sector: (data.sector as string | null) ?? null,
    open_jobs: (data.open_jobs as number | null) ?? 0,
    lead_score: (data.lead_score as number | null) ?? 0,
    ai_summary: (data.ai_summary as string | null) ?? null,
    ai_summary_generated_at:
      (data.ai_summary_generated_at as string | null) ?? null,
  };
}

/**
 * Company names by id, for the Outreach activity dashboard — one row per
 * outreach attempt needs the company name next to it, without pulling the
 * full company summary shape.
 */
export async function getCompanyNames(
  companyIds: string[]
): Promise<Record<string, string>> {
  if (companyIds.length === 0) return {};
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("public_company_summary")
    .select("id, name")
    .in("id", companyIds);
  if (error) throw new Error(error.message);

  const names: Record<string, string> = {};
  for (const row of data ?? []) {
    names[row.id as string] = row.name as string;
  }
  return names;
}

/**
 * The current coach's own private notes about a company (from
 * `coach_company_meta`, RLS-scoped), for the Outreach research panel —
 * reuses the exact same notes shown/edited via NotesDialog on
 * /coach/companies, not a separate copy. `null` if the coach never wrote any.
 */
export async function getCompanyNotes(companyId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("coach_company_meta")
    .select("notes")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  const notes = (data?.notes as string | null | undefined)?.trim();
  return notes || null;
}

/** The current coach's existing draft for a company, or `null`. */
export async function getExistingDraft(
  companyId: string
): Promise<OutreachEmail | null> {
  const claims = await getCoachUser();
  if (!claims) return null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("outreach_emails")
    .select("*")
    .eq("coach_user_id", claims.sub)
    .eq("company_id", companyId)
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as OutreachEmail | null) ?? null;
}
