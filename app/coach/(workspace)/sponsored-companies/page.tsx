import type { Metadata } from "next";
import { TriangleAlert } from "lucide-react";

import {
  getSponsoredCompanyPage,
  getSponsorshipStatuses,
} from "@/features/career-hub/lib/sponsorship";
import type {
  CompanySponsorshipStatusCompact,
  SponsoredCompanyPage,
} from "@/features/career-hub/lib/types";
import { SponsoredCompaniesList } from "@/features/career-hub/components/coach/sponsored-companies-list";
import { EmptyState } from "@/features/career-hub/components/empty-state";

export const metadata: Metadata = {
  title: "Sponsored Companies",
};

interface SponsoredCompaniesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function SponsoredCompaniesPage({
  searchParams,
}: SponsoredCompaniesPageProps) {
  const params = await searchParams;
  const scope = first(params.scope) === "all" ? "all" : "licensed";
  const q = first(params.q).trim().slice(0, 100);
  const page = Math.max(1, Math.floor(Number(first(params.page))) || 1);

  const header = (
    <header className="space-y-1">
      <p className="text-sm text-muted-foreground">
        Visa sponsorship status, licence details, open jobs and contacts.
      </p>
    </header>
  );

  // One page, filtered and counted in SQL (migration 048) — contact counts
  // come with the rows, so there is no second request carrying every id.
  let data: SponsoredCompanyPage;
  try {
    data = await getSponsoredCompanyPage({ scope, q, page });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    return (
      <div className="space-y-4">
        {header}
        <EmptyState
          icon={TriangleAlert}
          title="We couldn't load companies"
          description={message}
        />
      </div>
    );
  }

  // Badges for this page's 30 companies only. Not awaited: the cards paint
  // first and the badges stream in. `.catch` because the session lookup inside
  // sits outside the helper's own try.
  const sponsorshipStatuses: Promise<
    Record<string, CompanySponsorshipStatusCompact>
  > = getSponsorshipStatuses(data.companies.map((c) => c.company_id)).catch(
    () => ({})
  );

  return (
    <div className="space-y-4">
      {header}
      <SponsoredCompaniesList
        data={data}
        scope={scope}
        q={q}
        page={page}
        sponsorshipStatuses={sponsorshipStatuses}
      />
    </div>
  );
}
