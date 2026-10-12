import Link from "next/link";
import { Briefcase, ExternalLink, MapPin } from "lucide-react";

import type { SponsoredCompanyContext } from "@/features/career-hub/lib/types";
import { Badge } from "@/components/ui/badge";
import { LeadScoreBadge } from "@/features/career-hub/components/lead-score-badge";
import { CompanySummaryPanel } from "@/features/career-hub/components/coach/company-summary-panel";

interface CompanyContextCardProps {
  company: SponsoredCompanyContext;
}

/** Read-only overview panel for a company on the Sponsored Company page. */
export function CompanyContextCard({ company }: CompanyContextCardProps) {
  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {company.sector && (
                <Badge variant="secondary">
                  {company.sector}
                </Badge>
              )}
            </div>
            <h2 className="text-2xl">
              {company.name}
            </h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <MapPin className="size-4" />
                {company.location}
              </span>
              <span className="flex items-center gap-1.5">
                <Briefcase className="size-4" />
                {company.open_jobs} open{" "}
                {company.open_jobs === 1 ? "job" : "jobs"}
              </span>
            </div>
          </div>
          <LeadScoreBadge score={company.lead_score} />
        </div>

        <CompanySummaryPanel
          companyId={company.company_id}
          initialSummary={company.ai_summary}
        />

        <Link
          href={`/companies/${company.slug}`}
          className="inline-flex w-fit items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
        >
          <ExternalLink className="size-4" />
          View public company profile
        </Link>
      </div>
    </section>
  );
}
