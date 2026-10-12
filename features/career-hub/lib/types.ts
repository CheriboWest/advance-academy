/**
 * Domain types for the public student portal, mapped to the Supabase schema.
 *
 * `CompanySummary` mirrors the `public_company_summary` SQL view (snake_case,
 * exactly as returned by PostgREST). `Job` mirrors the `jobs` table.
 */

/** A row from the `public_company_summary` view. */
export interface CompanySummary {
  id: string;
  slug: string;
  name: string;
  website: string | null;
  careers_url: string | null;
  sector: string | null;
  region: string | null;
  hq_location: string | null;
  lead_score: number | null;
  open_jobs: number | null;
  /** Short, factual summary generated from stored data — see
   *  backend-python/app/companies/summarizer.py. `null` until first generated
   *  (company creation / crawl enrichment / manual refresh); never
   *  generated client-side. */
  ai_summary: string | null;
  ai_summary_generated_at: string | null;
}

/**
 * A company returned by Job Role Search: a company summary plus the number of
 * that company's active jobs whose title matched the searched role. Kept
 * conceptually separate from `open_jobs` (total active jobs).
 */
export interface CompanyRoleResult extends CompanySummary {
  matching_jobs: number;
}

/** A row from the `jobs` table. */
export interface Job {
  id: string;
  company_id: string;
  title: string;
  location_raw: string | null;
  city: string | null;
  salary_min: number | null;
  salary_max: number | null;
  posted_at: string | null;
  is_active: boolean;
  /** Optional outbound link to the live posting, if the row provides one. */
  source_url?: string | null;
}

/** A company summary merged with the current coach's private metadata. */
export interface CoachCompanyRow {
  company_id: string;
  slug: string;
  name: string;
  location: string;
  open_jobs: number;
  lead_score: number;
  starred: boolean;
  notes: string;
}

/** A company shown in the Sponsored Companies list. */
export interface SponsoredCompanyRow {
  company_id: string;
  slug: string;
  name: string;
  location: string;
  sector: string | null;
  open_jobs: number;
  lead_score: number;
}

/** Company context shown on the Sponsored Company detail page's overview,
 *  and reused as the Outreach research panel's company summary. */
export interface SponsoredCompanyContext {
  company_id: string;
  slug: string;
  name: string;
  location: string;
  sector: string | null;
  open_jobs: number;
  lead_score: number;
  ai_summary: string | null;
  ai_summary_generated_at: string | null;
}

/**
 * The four statuses a coach ever sets or that a send ever writes.
 * `follow_up_due` is NOT one of them — it is a fifth, purely computed
 * display state (a "sent" row whose follow_up_at has passed), never stored.
 * See lib/outreach-activity.ts computeDisplayStatus.
 */
export type OutreachStoredStatus = "draft" | "sent" | "replied" | "closed";

/** `OutreachStoredStatus` plus the computed "follow_up_due" — what the
 *  activity dashboard's filter and status badge actually work with. */
export type OutreachDisplayStatus = OutreachStoredStatus | "follow_up_due";

/** A row from the `outreach_emails` table (per-coach, RLS-protected). */
export interface OutreachEmail {
  id: string;
  coach_user_id: string;
  company_id: string;
  /** Legacy column, pre-dates `contact_id` and is unused by current code —
   *  its exact semantics were never confirmed against the live schema, so
   *  new code writes/reads `contact_id` instead rather than assuming. */
  recruiter_id: string | null;
  contact_id: string | null;
  recipient_email: string | null;
  subject: string | null;
  body: string | null;
  status: string;
  sent_at: string | null;
  last_contacted_at: string | null;
  follow_up_at: string | null;
  notes: string | null;
  created_at: string | null;
}

/**
 * One outreach_emails row enriched with the company/contact names it
 * references — for the Outreach activity dashboard and a company's outreach
 * history. Built by lib/outreach-activity.ts by merging outreach_emails
 * (direct, RLS-scoped) with company names (public_company_summary) and
 * contact names (GET /contacts, batched) — never a stored denormalisation.
 */
export interface OutreachActivityRow {
  id: string;
  companyId: string;
  companyName: string;
  contactId: string | null;
  contactName: string | null;
  contactRole: string | null;
  recipientEmail: string | null;
  subject: string | null;
  storedStatus: OutreachStoredStatus;
  displayStatus: OutreachDisplayStatus;
  sentAt: string | null;
  lastContactedAt: string | null;
  followUpAt: string | null;
  notes: string | null;
}

/**
 * The coach-facing sponsorship status for one company, from
 * GET /sponsors/companies/{id}. One of five normalized states; see
 * backend-python/app/schemas.py CompanySponsorshipStatus for the full contract
 * (in particular why `licensed` needs no `stale` check while the others do).
 */
export type SponsorshipStatus =
  | "licensed"
  | "ambiguous"
  | "no_match"
  | "error"
  | "not_checked";

export interface SponsorshipMatch {
  organisation_name: string;
  town_city: string | null;
  county: string | null;
  type_rating: string | null;
  licence_type: string | null;
  rating: string | null;
  routes: string[];
  confidence: number;
}

export interface CompanySponsorshipStatus {
  company_id: string;
  status: SponsorshipStatus;
  checked_at: string | null;
  register_import_id: string | null;
  candidate_count: number | null;
  stale: boolean;
  match: SponsorshipMatch | null;
}

/**
 * The list-badge shape from POST /sponsors/companies/statuses — enough to
 * render a compact status chip. Deliberately not the full
 * CompanySponsorshipStatus: no organisation name, routes, confidence, or
 * error text on a page that shows many companies at once.
 */
export interface CompanySponsorshipStatusCompact {
  status: SponsorshipStatus;
  stale: boolean;
  checked_at: string | null;
}

/**
 * Sponsorship totals across every company, from GET /sponsors/stats — the
 * dashboard KPI's number. Not scoped to the coach's visible companies, unlike
 * `CoachDashboardData.totalCompanies`.
 */
export interface SponsorshipStats {
  licensed_companies: number;
}

/**
 * A company contact, from the FastAPI `/contacts` endpoints — never a direct
 * Supabase read. The `contacts` table is deny-by-default RLS,
 * service-role-only (same posture as sponsorship data): the backend is the
 * only thing allowed to query it, which is also what keeps contacts off any
 * public/student-facing page by construction.
 */
export interface Contact {
  id: string;
  company_id: string;
  full_name: string;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** One row of the coach Contact Directory — see DirectoryContact in schemas.py. */
export interface DirectoryContact extends Contact {
  company: { id: string; name: string; slug: string } | null;
}

/** Body for creating/editing a contact — see ContactWrite in schemas.py. */
export interface ContactInput {
  full_name: string;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  notes: string | null;
}

/** Aggregated data for the coach dashboard. */
export interface CoachDashboardData {
  totalCompanies: number;
  highScoreCompanies: number;
  totalActiveJobs: number;
  recentCompanies: CompanySummary[];
  topHiringCompanies: CompanySummary[];
}
