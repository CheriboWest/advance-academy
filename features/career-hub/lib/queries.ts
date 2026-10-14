import { getSupabaseClient } from "@/features/career-hub/lib/supabase";
import { ALL, type SearchFiltersState } from "@/features/career-hub/lib/filters";
import type { CompanySummary, Job } from "@/features/career-hub/lib/types";

/** Columns exposed by the `public_company_summary` view. */
const COMPANY_COLUMNS =
  "id, slug, name, website, careers_url, sector, region, hq_location, lead_score, open_jobs, ai_summary, ai_summary_generated_at";

export const SEARCH_PAGE_SIZE = 30;

/**
 * One page of companies from the `public_company_summary` view, applying the
 * public search filters (name search, location, sector) and sort order in the
 * query, plus the exact total. Paged rather than fetched whole: PostgREST caps
 * an unranged select at 1,000 rows, which silently hid most of the directory.
 */
export async function fetchCompanies(
  filters: SearchFiltersState
): Promise<{ companies: CompanySummary[]; total: number }> {
  const supabase = getSupabaseClient();

  let query = supabase
    .from("public_company_summary")
    .select(COMPANY_COLUMNS, { count: "exact" });

  const q = filters.q.trim();
  if (q) {
    query = query.ilike("name", `%${q}%`);
  }

  if (filters.location !== ALL) {
    // Match either the broad region or the specific HQ location.
    query = query.or(
      `region.ilike.%${filters.location}%,hq_location.ilike.%${filters.location}%`
    );
  }

  if (filters.sector !== ALL) {
    query = query.eq("sector", filters.sector);
  }

  if (filters.hiringOnly) {
    query = query.gt("open_jobs", 0);
  }

  switch (filters.sort) {
    case "jobs_desc":
      query = query.order("open_jobs", {
        ascending: false,
        nullsFirst: false,
      });
      break;
    case "name_asc":
      query = query.order("name", { ascending: true });
      break;
    case "score_desc":
    default:
      query = query.order("lead_score", {
        ascending: false,
        nullsFirst: false,
      });
      break;
  }

  // Tie-breaker so ties don't shuffle between pages.
  const from = (filters.page - 1) * SEARCH_PAGE_SIZE;
  query = query.order("id").range(from, from + SEARCH_PAGE_SIZE - 1);

  const { data, error, count } = await query;
  if (error) {
    // Asking past the last page is a 416 from PostgREST — treat it as empty.
    if (error.code === "PGRST103") return { companies: [], total: count ?? 0 };
    throw new Error(error.message);
  }

  return { companies: (data ?? []) as CompanySummary[], total: count ?? 0 };
}

/** Fetch a single company by its slug, or `null` if none matches. */
export async function fetchCompanyBySlug(
  slug: string
): Promise<CompanySummary | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("public_company_summary")
    .select(COMPANY_COLUMNS)
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as CompanySummary | null) ?? null;
}

/**
 * Fetch active jobs for a company.
 *
 * Filters on ONLY `company_id` and `is_active = true` — no `posted_at`,
 * `expires_at`, or other conditions — so the count here matches the active-job
 * count exposed by `public_company_summary`. Newest-first ordering for display
 * is applied in memory after the fetch, not as a query condition.
 */
export async function fetchActiveJobs(companyId: string): Promise<Job[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("company_id", companyId)
    .eq("is_active", true);

  if (error) {
    throw new Error(error.message);
  }

  const jobs = (data ?? []) as Job[];

  return jobs.sort((a, b) => {
    const aTime = a.posted_at ? new Date(a.posted_at).getTime() : 0;
    const bTime = b.posted_at ? new Date(b.posted_at).getTime() : 0;
    return bTime - aTime;
  });
}
