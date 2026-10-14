import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportBatch, ImportRow } from "@/features/career-hub/lib/contact-import-api";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const api = vi.hoisted(() => ({
  getImport: vi.fn(),
  listImportRows: vi.fn(),
  resolveImportRows: vi.fn(),
  commitImport: vi.fn(),
  searchCompaniesForImport: vi.fn(),
  applyImportMapping: vi.fn(),
  uploadImportFile: vi.fn(),
}));
vi.mock("@/features/career-hub/lib/contact-import-api", () => api);

import { ContactImportPreview } from "@/features/career-hub/components/coach/contact-import-preview";
import { MappingStep } from "@/features/career-hub/components/coach/contact-import-wizard";

const reviewRow: ImportRow = {
  id: 11,
  sheet: "JOB AGENCIES UK",
  sheet_index: 0,
  row_number: 3,
  raw: {},
  extracted: { company: { name: "Delta Holdings", slug: "delta", website: "https://delta.co.uk", group_row: null }, contact: null },
  parse_errors: [],
  classification: "needs_review",
  company_status: "needs_review",
  contact_status: null,
  company_match: null,
  contact_match: null,
  company_candidates: [
    { id: "d1", name: "Delta One", slug: "delta-one", website: "https://delta.co.uk", reasons: ["domain"] },
    { id: "d2", name: "Delta Two", slug: "delta-two", website: null, reasons: ["domain"] },
  ],
  contact_candidates: [],
  reasons: ["Matches 2 existing companies by domain, name or alias. Choose one, or skip."],
  source_job_id: null,
  resolution: null,
  result_status: null,
  result: null,
  error: null,
};

const counts = { total: 3, matched: 1, new: 1, needs_review: 1, invalid: 0, skipped: 0 };

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getImport.mockResolvedValue({ batch: {}, counts });
  api.listImportRows.mockResolvedValue({ rows: [reviewRow], total: 1, limit: 100, offset: 0 });
  api.resolveImportRows.mockResolvedValue({ preview: counts });
});
afterEach(cleanup);

describe("ContactImportPreview", () => {
  it("opens on the rows needing review, with the reason and every candidate", async () => {
    render(<ContactImportPreview batchId="b1" editable />);
    expect(await screen.findByText("Delta Holdings")).toBeTruthy();
    expect(api.listImportRows).toHaveBeenCalledWith("b1", { classification: "needs_review", limit: 100, offset: 0 });
    expect(screen.getByText(/Matches 2 existing companies/)).toBeTruthy();
    const select = screen.getByLabelText("Company") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Decide later (row is skipped)",
      "Match Delta One (same website domain)",
      "Match Delta Two (same website domain)",
      'Create "Delta Holdings" as a new company',
      "Skip this row",
    ]);
  });

  it("sends a decision in the backend's shape, and blocks importing until it is applied", async () => {
    render(<ContactImportPreview batchId="b1" editable />);
    const select = (await screen.findByLabelText("Company")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "match:d1" } });
    fireEvent.click(screen.getByLabelText(/Remember "Delta Holdings" as a verified alias/));

    const importButton = screen.getByRole("button", { name: /Import 2 rows/ }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Apply 1 decision/ }));
    await waitFor(() =>
      expect(api.resolveImportRows).toHaveBeenCalledWith("b1", [
        { row_id: 11, company: { action: "match", company_id: "d1", save_alias: true } },
      ])
    );
  });

  it("imports only after an explicit confirmation", async () => {
    api.commitImport.mockResolvedValue({ summary: { status: "committed", rows: {}, companies: { created: 1, updated: 0, matched: 1 }, contacts: { created: 0, updated: 0, matched: 1 } } });
    const onCommitted = vi.fn();
    render(<ContactImportPreview batchId="b1" editable onCommitted={onCommitted} />);
    fireEvent.click(await screen.findByRole("button", { name: /Import 2 rows/ }));
    expect(api.commitImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalled());
    expect(api.commitImport).toHaveBeenCalledWith("b1");
  });

  it("a rolled-back import shows which rows failed, and that nothing was imported", async () => {
    api.commitImport.mockResolvedValue({
      summary: {
        status: "failed",
        failed_rows: 1,
        errors: [{ row_id: 11, sheet: "JOB AGENCIES UK", row_number: 3, sqlstate: "23514", error: "violates check constraint" }],
      },
    });
    render(<ContactImportPreview batchId="b1" editable onCommitted={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Import 2 rows/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1 row(s) failed, so nothing was imported");
    expect(alert.textContent).toContain("JOB AGENCIES UK row 3: violates check constraint");
    // Buttons are usable again.
    expect((screen.getByRole("button", { name: /Import 2 rows/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("read-only mode filters by result and shows kept conflicts and errors", async () => {
    api.listImportRows.mockResolvedValue({
      rows: [{
        ...reviewRow, classification: "matched", company_status: "matched", result_status: "matched",
        result: { conflicts: [{ record: "contact", field: "phone", existing: "020 1", incoming: "020 2" }] },
      }],
      total: 1, limit: 100, offset: 0,
    });
    render(<ContactImportPreview batchId="b1" editable={false} />);
    expect(await screen.findByText(/Kept existing contact phone "020 1" \(file had "020 2"\)/)).toBeTruthy();
    expect(screen.queryByLabelText("Company")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Failed/ }));
    await waitFor(() => expect(api.listImportRows).toHaveBeenLastCalledWith("b1", { resultStatus: "failed", limit: 100, offset: 0 }));
  });
});

describe("MappingStep", () => {
  const batch = {
    id: "b1",
    sheets: [{
      name: "JOB AGENCIES UK", index: 0, header_row: 1, row_count: 8, blank_rows: 1,
      headers: { A: "Company", B: "Link Job/Company", C: "LinkedIn" },
      sample: [{ row_number: 2, cells: { C: { header: "LinkedIn", value: "Jane Doe", text: "Jane Doe", type: "str", hyperlink: "https://www.linkedin.com/in/jane" } } }],
      suggested_mapping: { include: true, group_fill: true, company_link_is_website: true, columns: { A: "company_name", B: "source", C: "contact" } },
    }],
    mapping: null,
  } as unknown as ImportBatch;

  it("starts from the suggestion and submits the admin's changes", async () => {
    api.applyImportMapping.mockResolvedValue({ preview: counts });
    const onPreviewed = vi.fn();
    render(<MappingStep batch={batch} onPreviewed={onPreviewed} />);
    expect((screen.getByLabelText("Use column C (LinkedIn) as") as HTMLSelectElement).value).toBe("contact");
    expect(screen.getByText("Jane Doe 🔗")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Use column B (Link Job/Company) as"), { target: { value: "ignore" } });
    fireEvent.click(screen.getByLabelText(/A blank company cell belongs to the company above it/));
    fireEvent.click(screen.getByRole("button", { name: /Preview the import/ }));

    await waitFor(() => expect(onPreviewed).toHaveBeenCalled());
    expect(api.applyImportMapping).toHaveBeenCalledWith("b1", {
      "JOB AGENCIES UK": { include: true, group_fill: false, company_link_is_website: true, columns: { A: "company_name", B: "ignore", C: "contact" } },
    });
  });
});
