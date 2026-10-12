import * as React from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Search, TriangleAlert } from "lucide-react";

import { fetchCompanies, SEARCH_PAGE_SIZE } from "@/features/career-hub/lib/queries";
import { fetchCompaniesByRole } from "@/features/career-hub/lib/role-search";
import { ALL, DEFAULT_SORT, type SearchFiltersState } from "@/features/career-hub/lib/filters";
import type { CompanyRoleResult, CompanySummary } from "@/features/career-hub/lib/types";
import { CompanyCard } from "@/features/career-hub/components/company-card";
import { EmptyState } from "@/features/career-hub/components/empty-state";
import { Button } from "@/components/ui/button";

interface SearchResultsProps {
  filters: SearchFiltersState;
}

function ErrorState({ message }: { message: string }) {
  return (
    <EmptyState
      icon={TriangleAlert}
      title="We couldn't load companies"
      description={message}
      action={
        <Button asChild variant="outline">
          <Link href="/search">Try again</Link>
        </Button>
      }
    />
  );
}

function ResultsList({
  count,
  children,
  footer,
}: {
  count: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div>
      <p
        className="label-caps border-b border-border pb-3"
        aria-live="polite"
      >
        {count.toLocaleString("en-GB")} {count === 1 ? "company" : "companies"} found
      </p>
      <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{children}</ul>
      {footer}
    </div>
  );
}

/** Company-mode URL for another page, keeping the active filters. */
function pageHref(filters: SearchFiltersState, page: number): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.location !== ALL) params.set("location", filters.location);
  if (filters.sector !== ALL) params.set("sector", filters.sector);
  if (filters.sort !== DEFAULT_SORT) params.set("sort", filters.sort);
  if (!filters.hiringOnly) params.set("all", "1");
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/search?${qs}` : "/search";
}

function Pagination({ filters, total }: { filters: SearchFiltersState; total: number }) {
  const pages = Math.ceil(total / SEARCH_PAGE_SIZE);
  if (pages <= 1) return null;
  const { page } = filters;
  return (
    <nav aria-label="Pagination" className="mt-8 flex items-center justify-between gap-3">
      {page > 1 ? (
        <Button asChild variant="outline">
          <Link href={pageHref(filters, page - 1)}>
            <ChevronLeft className="size-4" />
            Previous
          </Link>
        </Button>
      ) : (
        <span />
      )}
      <span className="label-caps tabular-nums">
        Page {page} of {pages.toLocaleString("en-GB")}
      </span>
      {page < pages ? (
        <Button asChild variant="outline">
          <Link href={pageHref(filters, page + 1)}>
            Next
            <ChevronRight className="size-4" />
          </Link>
        </Button>
      ) : (
        <span />
      )}
    </nav>
  );
}

/** Job Role Search: companies with active jobs matching the searched title. */
async function RoleResults({ filters }: SearchResultsProps) {
  // No role typed yet — prompt rather than implying an empty database.
  if (!filters.q.trim()) {
    return (
      <EmptyState
        icon={Search}
        title="Search for a job role"
        description="Enter a job title like “Marketing Executive” to find companies hiring for it."
      />
    );
  }

  let companies: CompanyRoleResult[];
  try {
    companies = await fetchCompaniesByRole(filters);
  } catch (error) {
    return (
      <ErrorState
        message={
          error instanceof Error ? error.message : "An unexpected error occurred."
        }
      />
    );
  }

  if (companies.length === 0) {
    return (
      <EmptyState
        title="No companies are hiring for this role"
        description="No active jobs match that title with the current filters. Try a broader title, or reset the sector and location filters."
        action={
          <Button asChild variant="outline">
            <Link href="/search?mode=role">Reset filters</Link>
          </Button>
        }
      />
    );
  }

  return (
    <ResultsList count={companies.length}>
      {companies.map((company) => (
        <li key={company.id}>
          <CompanyCard company={company} matchingJobs={company.matching_jobs} />
        </li>
      ))}
    </ResultsList>
  );
}

/** Company-name search — unchanged existing behaviour. */
async function CompanyResults({ filters }: SearchResultsProps) {
  let companies: CompanySummary[];
  let total: number;
  try {
    ({ companies, total } = await fetchCompanies(filters));
  } catch (error) {
    return (
      <ErrorState
        message={
          error instanceof Error ? error.message : "An unexpected error occurred."
        }
      />
    );
  }

  if (companies.length === 0) {
    return (
      <EmptyState
        title="No companies match your filters"
        description="Try a different search term, or reset the location and sector filters to see every employer."
        action={
          <Button asChild variant="outline">
            <Link href="/search">Reset filters</Link>
          </Button>
        }
      />
    );
  }

  return (
    <ResultsList count={total} footer={<Pagination filters={filters} total={total} />}>
      {companies.map((company) => (
        <li key={company.id}>
          <CompanyCard company={company} />
        </li>
      ))}
    </ResultsList>
  );
}

/**
 * Async server component that runs the Supabase query for the current filters
 * and renders the result list, plus empty and error states. Wrapped in a
 * Suspense boundary by the page so a skeleton shows while it loads.
 */
export async function SearchResults({ filters }: SearchResultsProps) {
  return filters.mode === "role" ? (
    <RoleResults filters={filters} />
  ) : (
    <CompanyResults filters={filters} />
  );
}
