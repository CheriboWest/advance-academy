// <CompaniesTable> (the coach Companies tab). It used to render every company
// hiring at once — ~2,000 rows measured 13.6 MB of HTML and ~4.2 s before the
// first row appeared — so it now renders ROWS_PER_STEP rows at a time, while
// search and the count still cover the whole list.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CoachCompanyRow } from "@/features/career-hub/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean; children: React.ReactNode }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/app/coach/(workspace)/companies/actions", () => ({
  hideCompanyAction: vi.fn(),
  restoreCompanyAction: vi.fn(),
  toggleStarAction: vi.fn(),
  saveNotesAction: vi.fn(),
}));
vi.mock("@/app/coach/(workspace)/sponsored-companies/actions", () => ({}));

import { CompaniesTable, ROWS_PER_STEP } from "@/features/career-hub/components/coach/companies-table";

afterEach(cleanup);

function companies(n: number): CoachCompanyRow[] {
  return Array.from({ length: n }, (_, i) => ({
    company_id: `co-${String(i).padStart(4, "0")}`,
    slug: `company-${i}`,
    name: `Company ${String(i).padStart(4, "0")}`,
    location: i === 120 ? "Edinburgh" : "London",
    open_jobs: 1,
    lead_score: 50,
    starred: false,
    notes: "",
  }));
}

const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1); // minus the header

describe("CompaniesTable", () => {
  it("renders the first ROWS_PER_STEP companies, not all of them, and still counts all", () => {
    render(<CompaniesTable rows={companies(250)} />);
    expect(ROWS_PER_STEP).toBe(100);
    expect(bodyRows()).toHaveLength(100);
    expect(screen.getByText("250 companies")).toBeTruthy();
    expect(screen.getByText("Showing 100 of 250")).toBeTruthy();
  });

  it("shows more on request, until every company is on screen", () => {
    render(<CompaniesTable rows={companies(130)} />);
    fireEvent.click(screen.getByRole("button", { name: "Show 30 more" }));
    expect(bodyRows()).toHaveLength(130);
    expect(screen.queryByText(/^Showing /)).toBeNull();
  });

  it("searches every company, including ones not yet rendered", () => {
    render(<CompaniesTable rows={companies(130)} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search companies" }), { target: { value: "edinburgh" } });
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText("Company 0120")).toBeTruthy();
    expect(screen.getByText("1 company")).toBeTruthy();
  });

  it("starts a new search from the top of its results", () => {
    render(<CompaniesTable rows={companies(130)} />);
    fireEvent.click(screen.getByRole("button", { name: "Show 30 more" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search companies" }), { target: { value: "company" } });
    expect(bodyRows()).toHaveLength(100);
  });

  it("'select all' selects only the companies on screen — a bulk permanent delete never reaches unseen rows", () => {
    render(<CompaniesTable rows={companies(130)} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all shown companies" }));
    expect(screen.getByText("100 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete selected (100)" })).toBeTruthy();
  });

  it("does not prefetch every company row's link", () => {
    render(<CompaniesTable rows={companies(3)} />);
    const link = screen.getByRole("link", { name: "Company 0001" });
    expect(link.getAttribute("href")).toBe("/coach/sponsored-companies/co-0001");
    expect(link.getAttribute("data-prefetch")).toBe("false");
  });

  it("a short list has no 'show more'", () => {
    render(<CompaniesTable rows={companies(12)} />);
    expect(bodyRows()).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /more$/ })).toBeNull();
  });
});
