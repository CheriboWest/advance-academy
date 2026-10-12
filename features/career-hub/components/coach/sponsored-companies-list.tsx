"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Search,
  Users,
} from "lucide-react";

import type {
  CompanySponsorshipStatusCompact,
  SponsoredCompanyPage,
} from "@/features/career-hub/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LeadScoreBadge } from "@/features/career-hub/components/lead-score-badge";
import { SponsorshipBadge } from "@/features/career-hub/components/coach/sponsorship-badge";
import { EmptyState } from "@/features/career-hub/components/empty-state";

interface SponsoredCompaniesListProps {
  data: SponsoredCompanyPage;
  scope: "licensed" | "all";
  q: string;
  page: number;
  /** Keyed by company_id, for this page only. A promise: the server hands it
   *  over unawaited so the cards paint first (see page.tsx). */
  sponsorshipStatuses?: Promise<Record<string, CompanySponsorshipStatusCompact>>;
}

/**
 * A promise prop's value once it lands, or `undefined` while it is still in
 * flight. `useEffect` rather than `React.use()` so the cards don't suspend.
 */
function useResolved<T>(promise: Promise<T> | undefined): T | undefined {
  const [value, setValue] = React.useState<T>();

  React.useEffect(() => {
    if (!promise) return;
    let alive = true;
    promise.then((next) => {
      if (alive) setValue(next);
    });
    return () => {
      alive = false;
    };
  }, [promise]);

  return value;
}

function pageHref(scope: string, q: string, page: number): string {
  const params = new URLSearchParams();
  if (scope === "all") params.set("scope", "all");
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/coach/sponsored-companies?${qs}` : "/coach/sponsored-companies";
}

/** One server-side page of companies — confirmed sponsors by default — with
 * a GET form for search/scope (no client state to lose) and prev/next links.
 * Each card opens the full company profile. */
export function SponsoredCompaniesList({
  data,
  scope,
  q,
  page,
  sponsorshipStatuses: sponsorshipStatusesPromise,
}: SponsoredCompaniesListProps) {
  const sponsorshipStatuses = useResolved(sponsorshipStatusesPromise);
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));

  return (
    <div className="space-y-4">
      <form
        method="get"
        action="/coach/sponsored-companies"
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search companies by name..."
            aria-label="Search companies"
            className="pl-9"
          />
        </div>
        <select
          name="scope"
          defaultValue={scope}
          aria-label="Which companies"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm sm:w-56"
        >
          <option value="licensed">Licensed sponsors</option>
          <option value="all">All companies</option>
        </select>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      <p className="text-sm text-muted-foreground">
        {data.total.toLocaleString("en-GB")}{" "}
        {scope === "licensed"
          ? data.total === 1
            ? "licensed sponsor"
            : "licensed sponsors"
          : data.total === 1
            ? "company"
            : "companies"}
        {q ? ` matching “${q}”` : ""}
      </p>

      {data.companies.length === 0 ? (
        <EmptyState
          icon={q ? Search : Briefcase}
          title="No companies match these filters."
          description="Try a different search term, or switch to All companies."
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {data.companies.map((company) => (
            <article
              key={company.company_id}
              className="flex h-full flex-col justify-between gap-6 rounded-lg border border-border bg-card p-6 transition-shadow hover:shadow-md"
            >
              <div className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h3 className="text-lg leading-tight">{company.name}</h3>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {sponsorshipStatuses ? (
                        <SponsorshipBadge
                          status={sponsorshipStatuses[company.company_id]}
                        />
                      ) : (
                        <span
                          aria-hidden
                          className="h-5 w-24 animate-pulse rounded-full bg-muted"
                        />
                      )}
                      {company.sector && (
                        <span className="text-sm text-muted-foreground">
                          {company.sector}
                        </span>
                      )}
                    </div>
                  </div>
                  <LeadScoreBadge score={company.lead_score} />
                </div>

                <dl className="grid gap-2 text-sm">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin className="size-4 shrink-0" />
                    <span>{company.location}</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Users className="size-4 shrink-0" />
                    <span>
                      {company.contacts}{" "}
                      {company.contacts === 1 ? "contact" : "contacts"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Briefcase className="size-4 shrink-0" />
                    <span>
                      {company.open_jobs} open{" "}
                      {company.open_jobs === 1 ? "job" : "jobs"}
                    </span>
                  </div>
                </dl>
              </div>

              <Button asChild variant="outline" className="w-full">
                <Link href={`/coach/sponsored-companies/${company.company_id}`}>
                  View company
                  <ArrowUpRight className="size-4" />
                </Link>
              </Button>
            </article>
          ))}
        </div>
      )}

      {pages > 1 && (
        <nav
          aria-label="Pagination"
          className="flex items-center justify-between gap-3 pt-2"
        >
          {page > 1 ? (
            <Button asChild variant="outline">
              <Link href={pageHref(scope, q, page - 1)}>
                <ChevronLeft className="size-4" />
                Previous
              </Link>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-sm tabular-nums text-muted-foreground">
            Page {page} of {pages.toLocaleString("en-GB")}
          </span>
          {page < pages ? (
            <Button asChild variant="outline">
              <Link href={pageHref(scope, q, page + 1)}>
                Next
                <ChevronRight className="size-4" />
              </Link>
            </Button>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
