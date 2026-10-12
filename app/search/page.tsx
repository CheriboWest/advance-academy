import * as React from "react";
import type { Metadata } from "next";

import { BackLink } from "@/components/back-link";
import { parseSearchFilters } from "@/features/career-hub/lib/filters";
import { PageContainer } from "@/features/career-hub/components/page-container";
import { SearchFilters } from "@/features/career-hub/components/search-filters";
import { SearchResults } from "@/features/career-hub/components/search-results";
import { SearchResultsSkeleton } from "@/features/career-hub/components/search-results-skeleton";

export const metadata: Metadata = {
  title: "Search",
  description: "Search UK companies and jobs on Advance Academy.",
};

// Data is fetched per request from Supabase, driven by URL search params.
export const dynamic = "force-dynamic";

interface SearchPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const filters = parseSearchFilters(await searchParams);

  // Re-key the Suspense boundary on the active filters so the skeleton shows
  // on every filter change, not just the first load.
  const suspenseKey = JSON.stringify(filters);

  return (
    <>
      <PageContainer as="header" className="py-10">
        <BackLink href="/" className="mb-6">
          Back to home
        </BackLink>
        <p className="label-caps">Employer directory</p>
        <h1 className="mt-3 text-4xl sm:text-5xl">Search UK employers</h1>
        <p className="mt-3 max-w-xl text-muted-foreground">
          Explore companies hiring across the UK and find your next role.
        </p>
      </PageContainer>

      <SearchFilters
        q={filters.q}
        location={filters.location}
        sector={filters.sector}
        sort={filters.sort}
        mode={filters.mode}
        hiringOnly={filters.hiringOnly}
      />

      <PageContainer className="pt-6">
        <React.Suspense key={suspenseKey} fallback={<SearchResultsSkeleton />}>
          <SearchResults filters={filters} />
        </React.Suspense>
      </PageContainer>
    </>
  );
}
