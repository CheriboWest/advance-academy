import Link from "next/link";
import { Briefcase, ChevronRight, MapPin } from "lucide-react";

import { cn } from "@/shared/utils/cn";
import type { CompanySummary } from "@/features/career-hub/lib/types";
import { Badge } from "@/components/ui/badge";

interface CompanyCardProps {
  company: CompanySummary;
  /**
   * When set (Job Role Search), the number of this company's active jobs that
   * matched the searched role. Rendered alongside — never in place of — the
   * total open-jobs count.
   */
  matchingJobs?: number;
  className?: string;
}

/** One company as a card. The whole card is the link. */
export function CompanyCard({
  company,
  matchingJobs,
  className,
}: CompanyCardProps) {
  const location = company.hq_location ?? company.region ?? "—";
  const openJobs = company.open_jobs ?? 0;

  return (
    <Link
      href={`/companies/${company.slug}`}
      className={cn(
        "card-interactive group flex h-full flex-col p-6 focus-visible:border-primary/30 focus-visible:outline-none",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="icon-tile">
          <Briefcase className="size-5" />
        </span>
        {matchingJobs !== undefined && (
          <Badge variant="highlight">{matchingJobs} matching</Badge>
        )}
      </div>

      <h3 className="mt-4 text-2xl leading-tight">{company.name}</h3>

      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
        <MapPin className="size-3.5 shrink-0" />
        <span className="truncate">
          {company.sector ? `${company.sector} · ` : ""}
          {location}
        </span>
      </p>

      <div className="mt-5 flex items-end justify-between gap-4 border-t border-border pt-4">
        <span className="flex gap-6">
          <span className="block leading-none">
            <span className="label-caps">Open roles</span>
            <span className="mt-1 block font-display text-2xl tabular-nums text-foreground">
              {openJobs}
            </span>
          </span>
          {/* No lead score here: it's a coach prioritisation number that read as
              a rating to students. Coach pages still show it. */}
        </span>

        <span className="flex items-center gap-1 text-sm font-medium text-highlight-ink">
          Open
          <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}
