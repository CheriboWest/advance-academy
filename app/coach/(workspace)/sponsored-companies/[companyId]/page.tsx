import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { BackLink } from "@/components/back-link";
import { getSponsoredCompanyContext } from "@/features/career-hub/lib/coach";
import { getContacts } from "@/features/career-hub/lib/contacts";
import { fetchActiveJobs } from "@/features/career-hub/lib/queries";
import { getSponsorshipStatus } from "@/features/career-hub/lib/sponsorship";
import { getOutreachActivitiesForCompany } from "@/features/career-hub/lib/outreach-activity";
import type {
  CompanySponsorshipStatus,
  Job,
  Contact,
  OutreachActivityRow,
} from "@/features/career-hub/lib/types";
import { CompanyContextCard } from "@/features/career-hub/components/coach/company-context-card";
import { SponsorshipCard } from "@/features/career-hub/components/coach/sponsorship-card";
import { ContactsSection } from "@/features/career-hub/components/coach/contacts-section";
import { OpenJobsSection } from "@/features/career-hub/components/coach/open-jobs-section";
import { OutreachActivityList } from "@/features/career-hub/components/coach/outreach-activity-list";
import { EmptyState } from "@/features/career-hub/components/empty-state";

interface SponsoredCompanyPageProps {
  params: Promise<{ companyId: string }>;
}

export async function generateMetadata({
  params,
}: SponsoredCompanyPageProps): Promise<Metadata> {
  const { companyId } = await params;
  try {
    const company = await getSponsoredCompanyContext(companyId);
    return { title: company ? company.name : "Sponsored Companies" };
  } catch {
    return { title: "Sponsored Companies" };
  }
}

/**
 * A sponsored company's profile: overview, visa sponsorship, open jobs,
 * contacts, and outreach history. Coach-only (the workspace layout enforces
 * the session) — never reachable from a public/student-facing route, which
 * is also why this page can show contacts at all (see migration 0011 /
 * app/routers/contacts.py).
 *
 * No email generation or sending here by design — see the separate Outreach
 * flow (app/coach/(workspace)/outreach) for composing and sending; this page
 * only shows what's already been sent, read-only-ish (reply/follow-up/close/
 * notes actions, same OutreachActivityList component the Outreach dashboard
 * uses — not a second copy of that list logic).
 */
export default async function SponsoredCompanyPage({
  params,
}: SponsoredCompanyPageProps) {
  const { companyId } = await params;

  const company = await getSponsoredCompanyContext(companyId);
  if (!company) {
    notFound();
  }

  const backLink = (
    <>
      <BackLink href="/coach/sponsored-companies">Back to sponsored companies</BackLink>
      {company.hidden && (
        <p className="text-sm text-muted-foreground">
          You removed this company from your lists. Restore it from Companies → Removed.
        </p>
      )}
    </>
  );

  // Sponsorship status, jobs, contacts and outreach history are each a
  // separate live read (three direct Supabase reads plus one FastAPI call)
  // that can fail independently of the company fetch above having already
  // succeeded — e.g. a schema migration this coach's database hasn't had
  // applied yet (see 0012_outreach_tracking.sql/0015_repair_outreach_tracking
  // .sql: an un-migrated outreach_emails is exactly the kind of failure this
  // catches). Handled the same way every sibling coach page already handles
  // its own data fetch (Companies, Sponsored Companies list, Outreach
  // dashboard) — a friendly EmptyState instead of an unhandled exception
  // reaching Next.js as an opaque "Application error". The company overview
  // above already succeeded, so it still renders.
  let sponsorshipStatus: CompanySponsorshipStatus | null;
  let jobs: Job[];
  let contacts: Contact[];
  let outreachActivities: OutreachActivityRow[];

  try {
    [sponsorshipStatus, jobs, contacts, outreachActivities] = await Promise.all([
      getSponsorshipStatus(company.company_id),
      fetchActiveJobs(company.company_id),
      getContacts(company.company_id),
      getOutreachActivitiesForCompany(company.company_id),
    ]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    return (
      <div className="space-y-6">
        {backLink}
        <CompanyContextCard company={company} />
        <EmptyState
          icon={TriangleAlert}
          title="We couldn't load this company's full profile"
          description={message}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {backLink}

      {/* Company overview */}
      <CompanyContextCard company={company} />

      {/* Visa sponsorship */}
      <SponsorshipCard
        companyId={company.company_id}
        initialStatus={sponsorshipStatus}
      />

      {/* Open jobs */}
      <OpenJobsSection jobs={jobs} />

      {/* Contacts */}
      <ContactsSection companyId={company.company_id} initialContacts={contacts} />

      {/* Outreach history */}
      <section className="space-y-4 rounded-lg border border-border bg-card p-6">
        <h3 className="text-lg">Outreach history</h3>
        <OutreachActivityList activities={outreachActivities} hideCompany />
      </section>
    </div>
  );
}
