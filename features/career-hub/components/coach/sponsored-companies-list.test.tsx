// <SponsoredCompaniesList> renders one server-side page (GET /sponsors/companies):
// contact counts arrive with the rows, badges stream in after, and the
// pagination links keep the search and scope.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SponsoredCompaniesList } from "@/features/career-hub/components/coach/sponsored-companies-list";
import type { SponsoredCompanyPage } from "@/features/career-hub/lib/types";

vi.mock("next/link", () => ({
  default: ({ href, prefetch, children }: { href: string; prefetch?: boolean; children: React.ReactNode }) => (
    <a href={href} data-prefetch={String(prefetch)}>{children}</a>
  ),
}));
// Stands in for next/form so the test can see the search uses it (a client-side
// navigation) rather than a plain <form> (a full document reload).
vi.mock("next/form", () => ({
  default: ({ action, children, ...rest }: { action: string; children: React.ReactNode }) => (
    <form action={action} data-next-form="" {...rest}>{children}</form>
  ),
}));

afterEach(cleanup);

const ABSOLUTE_RECRUIT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const ABSOLUTE_RECRUIT: SponsoredCompanyPage["companies"][number] = {
  company_id: ABSOLUTE_RECRUIT_ID,
  slug: "absolute-recruit",
  name: "Absolute Recruit",
  location: "London",
  sector: "Recruitment",
  open_jobs: 0,
  lead_score: 50,
  contacts: 2,
};

function pageOf(
  companies: SponsoredCompanyPage["companies"],
  total = companies.length
): SponsoredCompanyPage {
  return { companies, total, page_size: 30 };
}

function card(): HTMLElement {
  const article = screen.getByText("Absolute Recruit").closest("article");
  expect(article).not.toBeNull();
  return article as HTMLElement;
}

describe("SponsoredCompaniesList", () => {
  it("renders the contact count that came with the row, and 0 open jobs", () => {
    render(<SponsoredCompaniesList data={pageOf([ABSOLUTE_RECRUIT])} scope="licensed" q="" page={1} />);
    expect(card().textContent).toContain("2 contacts");
    expect(card().textContent).toContain("0 open jobs");
  });

  it("states the total as licensed sponsors by default and companies for scope=all", () => {
    const { unmount } = render(
      <SponsoredCompaniesList data={pageOf([ABSOLUTE_RECRUIT], 41)} scope="licensed" q="" page={1} />
    );
    expect(screen.getByText(/41 licensed sponsors/)).toBeTruthy();
    unmount();
    render(<SponsoredCompaniesList data={pageOf([ABSOLUTE_RECRUIT], 41)} scope="all" q="" page={1} />);
    expect(screen.getByText(/41 companies/)).toBeTruthy();
  });

  it("shows a badge placeholder while the statuses stream", () => {
    render(
      <SponsoredCompaniesList
        data={pageOf([ABSOLUTE_RECRUIT])}
        scope="licensed"
        q=""
        page={1}
        sponsorshipStatuses={new Promise(() => {})}
      />
    );
    expect(card().querySelector(".animate-pulse")).not.toBeNull();
  });

  it("pages with links that keep search and scope", () => {
    render(<SponsoredCompaniesList data={pageOf([ABSOLUTE_RECRUIT], 95)} scope="all" q="acme" page={2} />);
    expect(screen.getByText("Page 2 of 4")).toBeTruthy();
    expect(screen.getByText("Next").closest("a")?.getAttribute("href")).toBe(
      "/coach/sponsored-companies?scope=all&q=acme&page=3"
    );
    expect(screen.getByText("Previous").closest("a")?.getAttribute("href")).toBe(
      "/coach/sponsored-companies?scope=all&q=acme"
    );
  });

  it("searches with a client-side navigation, not a full page reload", () => {
    render(<SponsoredCompaniesList data={pageOf([ABSOLUTE_RECRUIT])} scope="all" q="acme" page={1} />);
    const form = screen.getByRole("searchbox", { name: "Search companies" }).closest("form");
    expect(form?.hasAttribute("data-next-form")).toBe(true);
    expect(form?.getAttribute("action")).toBe("/coach/sponsored-companies");
    // Same GET fields as before, so the URL a search produces is unchanged.
    expect((screen.getByRole("searchbox", { name: "Search companies" }) as HTMLInputElement).name).toBe("q");
    expect((screen.getByRole("combobox", { name: "Which companies" }) as HTMLSelectElement).name).toBe("scope");
  });

  it("does not prefetch every card's company link", () => {
    render(<SponsoredCompaniesList data={pageOf([ABSOLUTE_RECRUIT])} scope="licensed" q="" page={1} />);
    const link = within(card()).getByRole("link", { name: /View company/ });
    expect(link.getAttribute("data-prefetch")).toBe("false");
  });
});
