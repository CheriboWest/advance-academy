import { getSupabaseBrowser } from "@/shared/auth/supabase-browser";
import { CAREERHUB_PROXY } from "@/features/career-hub/lib/api-url";

export interface StartCrawlResponse {
  cached: boolean;
  run_id?: string;
  status?: string;
  last_refreshed_at?: string;
  hours_ago?: number;
  jobs_available?: number;
}

export interface CrawlRunStatus {
  id: string;
  status: string;
  query?: string | null;
  location?: string | null;
  // Internal counters — used by the "Recent crawls" history table.
  raw_jobs: number;
  normalized_jobs: number;
  inserted_jobs: number;
  updated_jobs: number;
  duplicate_jobs: number;
  companies_created: number;
  companies_updated: number;
  // Coach-facing metrics — used by the "Crawl complete" cards. Derived
  // server-side from the internal counters (see compute_display_stats in
  // app/crawler/models.py); companies_created above is reused as-is.
  new_jobs: number;
  duplicate_jobs_total: number;
  jobs_verified: number;
  error?: string | null;
  created_at?: string | null;
  finished_at?: string | null;
}

export interface StartCrawlInput {
  query: string;
  city: string;
  sources: string[];
  force: boolean;
}

/**
 * Split a multi-value crawler input (newlines and/or commas) into unique terms.
 *
 * Mirrors `split_terms` in backend-python/app/crawler/normalize.py — the API re-splits
 * the same strings server-side, so this copy exists only to size the request
 * (how many crawls am I about to start?) before sending it. Both fields stay
 * plain strings on the wire; nothing about the request shape is per-term.
 */
export const splitTerms = (value: string): string[] => [
  ...new Set(
    value
      .split(/[\n,]/)
      .map((term) => term.trim())
      .filter(Boolean)
  ),
];

async function authFetch<T>(path: string, init: RequestInit): Promise<T> {
  const supabase = getSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error("You must be signed in to run the crawler.");
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
      const data = (await response.json()) as { detail?: unknown };
      if (data?.detail) detail = String(data.detail);
    } catch {
      // No JSON body: not backend-python's own error, so name the likely setup gap.
      if (response.status === 404) {
        detail = "Job crawler API not reachable — BACKEND_PYTHON_URL isn't set on the frontend (rebuild after setting it).";
      } else if (response.status >= 500) {
        detail = `Job crawler API error (${response.status}) — check backend-python's logs and that the crawl_runs / discovery_queries migrations are applied.`;
      }
    }
    throw new Error(detail);
  }

  return (await response.json()) as T;
}

export function startCrawl(input: StartCrawlInput): Promise<StartCrawlResponse> {
  return authFetch<StartCrawlResponse>("/discover/start", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getCrawlStatus(runId: string): Promise<CrawlRunStatus> {
  return authFetch<CrawlRunStatus>(`/discover/status/${runId}`, {
    method: "GET",
  });
}

export function getCrawlHistory(): Promise<CrawlRunStatus[]> {
  return authFetch<CrawlRunStatus[]>("/discover/history", { method: "GET" });
}
