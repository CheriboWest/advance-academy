import { getSupabaseBrowser } from "@/shared/auth/supabase-browser";
import { CAREERHUB_PROXY } from "@/features/career-hub/lib/api-url";

export interface GeneratedOutreach {
  subject: string;
  body: string;
}

/**
 * Structured context for one outreach email, mirroring OutreachRequest in
 * backend-python/app/schemas.py field-for-field. Only `companyName` is required —
 * everything else is optional context that, when present, the backend
 * prompt actually uses (see `_build_user_prompt` in app/routers/ai.py):
 * sponsorship is only ever mentioned in the generated email when
 * `sponsorshipStatus === "licensed"`, and coach notes are treated as
 * background, never quoted.
 */
export interface OutreachContext {
  companyName: string;
  location: string | null;
  sector: string | null;
  openJobs: number;
  leadScore: number;
  openJobTitles?: string[];
  contactName?: string | null;
  contactRole?: string | null;
  sponsorshipStatus?: string | null;
  sponsorshipOrganisationName?: string | null;
  companyNotes?: string | null;
  contactNotes?: string | null;
}

/**
 * Call the FastAPI backend to generate an outreach email with Claude.
 *
 * The backend holds the Anthropic API key; the browser only ever talks to this
 * backend (via the /api/careerhub rewrite). The key is never exposed to the frontend.
 * The endpoint is protected — we send the signed-in coach's Supabase access
 * token as a Bearer token.
 */
export async function generateOutreachViaApi(
  context: OutreachContext,
  signal?: AbortSignal
): Promise<GeneratedOutreach> {
  const supabase = getSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error("You must be signed in to generate outreach.");
  }

  const response = await fetch(`${CAREERHUB_PROXY}/ai/outreach`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      company_name: context.companyName,
      location: context.location,
      sector: context.sector,
      open_jobs: context.openJobs,
      lead_score: context.leadScore,
      open_job_titles: context.openJobTitles ?? [],
      contact_name: context.contactName ?? null,
      contact_role: context.contactRole ?? null,
      sponsorship_status: context.sponsorshipStatus ?? null,
      sponsorship_organisation_name: context.sponsorshipOrganisationName ?? null,
      company_notes: context.companyNotes ?? null,
      contact_notes: context.contactNotes ?? null,
    }),
    signal,
  });

  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const data = (await response.json()) as { detail?: unknown };
      if (data?.detail) detail = String(data.detail);
    } catch {
      // Non-JSON error body — keep the default message.
    }
    throw new Error(detail);
  }

  const data = (await response.json()) as {
    subject?: string;
    body?: string;
  };

  if (!data.subject || !data.body) {
    throw new Error("The AI service returned an unexpected response.");
  }

  return { subject: data.subject, body: data.body };
}
