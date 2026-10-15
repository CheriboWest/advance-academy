import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const coach = vi.hoisted(() => ({ getDashboardData: vi.fn() }));
const sponsorship = vi.hoisted(() => ({ getSponsorshipStats: vi.fn() }));
vi.mock("@/features/career-hub/lib/coach", () => coach);
vi.mock("@/features/career-hub/lib/sponsorship", () => sponsorship);
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import CoachDashboardPage from "./page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("/coach/dashboard (where coach sign-in lands)", () => {
  it("renders an error state instead of crashing when the company data can't be read", async () => {
    // What migration 048 caused: public_company_summary unreadable to coaches.
    coach.getDashboardData.mockRejectedValue(new Error("permission denied for table companies"));
    sponsorship.getSponsorshipStats.mockResolvedValue({ licensed_companies: 221 });
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(await CoachDashboardPage());

    expect(screen.getByText("We couldn't load the dashboard")).toBeTruthy();
    expect(screen.getByText(/permission denied for table companies/)).toBeTruthy();
    expect(screen.getByText(/still available from the menu/)).toBeTruthy();
  });

  it("still renders the dashboard when the data loads", async () => {
    coach.getDashboardData.mockResolvedValue({
      totalCompanies: 2000,
      highScoreCompanies: 12,
      totalActiveJobs: 20948,
      recentCompanies: [],
      topHiringCompanies: [],
    });
    sponsorship.getSponsorshipStats.mockResolvedValue({ licensed_companies: 221 });

    render(await CoachDashboardPage());

    expect(screen.getByText("2,000")).toBeTruthy();
    expect(screen.getByText("221")).toBeTruthy();
    expect(screen.queryByText("We couldn't load the dashboard")).toBeNull();
  });
});
