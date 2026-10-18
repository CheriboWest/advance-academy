import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  Briefcase,
  Building2,
  ExternalLink,
  Globe,
  MapPin,
} from "lucide-react";

import { BackLink } from "@/components/back-link";
import { fetchActiveJobs, fetchCompanyBySlug } from "@/features/career-hub/lib/queries";
import { PageContainer } from "@/features/career-hub/components/page-container";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { JobItem } from "@/features/career-hub/components/job-item";
import { EmptyState } from "@/features/career-hub/components/empty-state";
import { CompanySummary } from "@/features/career-hub/components/company-summary";
import { CompanyContacts } from "@/features/career-hub/components/company-contacts";
import { fetchContactSummary } from "@/features/career-hub/lib/company-contacts";
import { getPublicSponsorship } from "@/features/career-hub/lib/sponsorship";
import { Licensed } from "@/features/career-hub/components/coach/sponsorship-card";

// Company and job data are fetched per request from Supabase.
export const dynamic = "force-dynamic";

interface CompanyPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: CompanyPageProps): Promise<Metadata> {
  const { slug } = await params;

  try {
    const company = await fetchCompanyBySlug(slug);
    if (!company) {
      return { title: "Company not found" };
    }
    return { title: company.name };
  } catch {
    return { title: "Company" };
  }
}

export default async function CompanyPage({ params }: CompanyPageProps) {
  const { slug } = await params;

  const company = await fetchCompanyBySlug(slug);
  if (!company) {
    notFound();
  }

  const [jobs, contactSummary, sponsorship] = await Promise.all([
    fetchActiveJobs(company.id),
    fetchContactSummary(company.id),
    getPublicSponsorship(company.id),
  ]);
  const location = company.hq_location ?? company.region ?? "—";

  return (
    <>
      <PageContainer width="prose" className="py-10">
        <BackLink href="/search">Back to search</BackLink>

        {/* Company masthead */}
        <header className="card-surface mt-6 p-6 sm:p-8">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <span className="icon-tile">
                  <Building2 className="size-5" />
                </span>
                {company.sector && (
                  <Badge variant="outline">{company.sector}</Badge>
                )}
              </div>
              <h1 className="mt-3 text-balance text-4xl leading-[1.02] sm:text-6xl">
                {company.name}
              </h1>
              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <MapPin className="size-4" />
                  {location}
                </span>
                <span className="flex items-center gap-1.5 tabular-nums">
                  <Briefcase className="size-4" />
                  {jobs.length} open {jobs.length === 1 ? "job" : "jobs"}
                </span>
              </div>
              <CompanySummary summary={company.ai_summary} className="mt-4" />
            </div>
          </div>

          {(company.website || company.careers_url) && (
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              {company.careers_url && (
                <Button
                  asChild
                  size="xl"
                  variant="highlight"
                  className="hidden sm:inline-flex"
                >
                  <a
                    href={company.careers_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="size-4" />
                    Careers page
                  </a>
                </Button>
              )}
              {company.website && (
                <Button
                  asChild
                  size="xl"
                  variant={company.careers_url ? "outline" : "default"}
                >
                  <a
                    href={company.website}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Globe className="size-4" />
                    Visit website
                  </a>
                </Button>
              )}
            </div>
          )}
        </header>

        {sponsorship && (
          <section className="card-surface mt-6 space-y-1 p-6 sm:p-8">
            <p className="label-caps text-muted-foreground">Visa sponsorship</p>
            <Licensed status={sponsorship} showConfidence={false} />
          </section>
        )}

        {/* Open jobs */}
        <section className="mt-10">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-2xl">Open jobs</h2>
            <span className="label-caps tabular-nums">{jobs.length} live</span>
          </div>

          {jobs.length > 0 ? (
            <ul className="mt-5 space-y-3">
              {jobs.map((job) => (
                <li key={job.id}>
                  <JobItem job={job} companyName={company.name} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={Briefcase}
              title="No open jobs right now"
              description="This company doesn't have any live roles at the moment. Check back soon or visit their careers page."
            />
          )}
        </section>

        {contactSummary && (
          <CompanyContacts
            companyId={company.id}
            companyName={company.name}
            slug={company.slug}
            summary={contactSummary}
          />
        )}
      </PageContainer>

      {/* The money action, pinned within thumb reach on mobile. */}
      {company.careers_url && (
        <div className="sticky bottom-0 z-30 border-t border-border bg-card p-3 sm:hidden">
          <Button asChild size="xl" variant="highlight" className="w-full">
            <a
              href={company.careers_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-4" />
              Careers page
            </a>
          </Button>
        </div>
      )}
    </>
  );
}
