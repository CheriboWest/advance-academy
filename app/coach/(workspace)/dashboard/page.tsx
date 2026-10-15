import type { Metadata } from "next";
import Link from "next/link";
import {
  BadgeCheck,
  Briefcase,
  Building2,
  Flame,
  MapPin,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";

import { getDashboardData } from "@/features/career-hub/lib/coach";
import { getSponsorshipStats } from "@/features/career-hub/lib/sponsorship";
import { KPICard } from "@/features/career-hub/components/coach/kpi-card";
import { CompanyCard } from "@/features/career-hub/components/company-card";
import { SectionHeading } from "@/features/career-hub/components/section-heading";
import { LeadScoreBadge } from "@/features/career-hub/components/lead-score-badge";
import { EmptyState } from "@/features/career-hub/components/empty-state";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function CoachDashboardPage() {
  // Concurrent: the sponsorship count is a separate round trip to the FastAPI
  // backend (the sponsorship tables are service-role-only, so it cannot come
  // from the same Supabase reads), and awaiting it after the dashboard data
  // would put two independent waits in series on the first paint.
  //
  // This is where coach sign-in lands, so a failed read must not take the
  // page down: uncaught, it rendered Next's bare server-error screen and the
  // whole workspace looked inaccessible (when migration 048 made
  // public_company_summary unreadable to signed-in users).
  const [dashboard, sponsorshipStats] = await Promise.all([
    getDashboardData().then(
      (data) => ({ ok: true as const, data }),
      (error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : "An unexpected error occurred.",
      })
    ),
    getSponsorshipStats(),
  ]);

  if (!dashboard.ok) {
    console.error(`coach dashboard: ${dashboard.message}`);
    return (
      <EmptyState
        icon={TriangleAlert}
        title="We couldn't load the dashboard"
        description={`${dashboard.message} The rest of the coach workspace is still available from the menu.`}
      />
    );
  }
  const { data } = dashboard;

  return (
    <div className="space-y-12">
      {/* Statistics band */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KPICard
          label="Total companies"
          value={data.totalCompanies.toLocaleString("en-GB")}
          icon={Building2}
        />
        <KPICard
          label="Licensed sponsors"
          value={
            sponsorshipStats
              ? sponsorshipStats.licensed_companies.toLocaleString("en-GB")
              : "—"
          }
          icon={BadgeCheck}
          hint="Confirmed on the GOV.UK register"
        />
        <KPICard
          label="High score (80+)"
          value={data.highScoreCompanies.toLocaleString("en-GB")}
          icon={Flame}
          hint="Priority outreach targets"
        />
        <KPICard
          label="Active jobs"
          value={data.totalActiveJobs.toLocaleString("en-GB")}
          icon={Briefcase}
        />
        <KPICard
          label="Recent companies"
          value={data.recentCompanies.length.toLocaleString("en-GB")}
          icon={TrendingUp}
          hint="Latest additions"
        />
      </section>

      {/* Top hiring companies */}
      <section>
        <SectionHeading index={1}>Priority targets</SectionHeading>
        <h2 className="mt-2 text-2xl">Top hiring companies</h2>

        {data.topHiringCompanies.length > 0 ? (
          <ol className="mt-5 space-y-3">
            {data.topHiringCompanies.map((company, index) => (
              <li key={company.id}>
                <Link
                  href={`/coach/sponsored-companies/${company.id}`}
                  className="card-interactive group flex items-center gap-4 p-4"
                >
                  <span className="font-display text-xl tabular-nums text-highlight-ink">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-lg">{company.name}</p>
                    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <MapPin className="size-3.5" />
                      {company.hq_location ?? company.region ?? "—"}
                    </p>
                  </div>
                  <div className="hidden shrink-0 text-right leading-none sm:block">
                    <span className="label-caps">Open roles</span>
                    <span className="mt-1 block font-display text-2xl tabular-nums">
                      {company.open_jobs ?? 0}
                    </span>
                  </div>
                  <LeadScoreBadge
                    score={company.lead_score ?? 0}
                    className="shrink-0"
                  />
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState
            icon={Briefcase}
            title="No hiring data yet"
            description="Once companies publish open roles, your top hirers will appear here."
          />
        )}
      </section>

      {/* Recent companies */}
      <section>
        <SectionHeading index={2}>Latest additions</SectionHeading>
        <h2 className="mt-2 text-2xl">Recent companies</h2>

        {data.recentCompanies.length > 0 ? (
          <ul className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.recentCompanies.map((company) => (
              <li key={company.id}>
                <CompanyCard company={company} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={Building2}
            title="No companies yet"
            description="Companies added to Advance Academy will show up here."
          />
        )}
      </section>
    </div>
  );
}
