import { describe, expect, it } from "vitest";

import type { ImportRow } from "@/features/career-hub/lib/contact-import-api";
import {
  companyOptions,
  conflictText,
  contactMatchAllowed,
  contactOptions,
  otherCompanyContacts,
  summaryLines,
  toResolutionPayload,
} from "@/features/career-hub/lib/contact-import";

function row(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    id: 1,
    sheet: "JOB AGENCIES UK",
    sheet_index: 0,
    row_number: 2,
    raw: {},
    extracted: {
      company: { name: "Delta Holdings", slug: "delta", website: "https://delta.co.uk", group_row: null },
      contact: { full_name: "Pat Kim", job_title: null, email: "pat@beta.com", phone: null, linkedin_url: null, notes: null },
      source: null,
      warnings: [],
    },
    parse_errors: [],
    classification: "needs_review",
    company_status: "needs_review",
    contact_status: "needs_review",
    company_match: null,
    contact_match: null,
    company_candidates: [
      { id: "d1", name: "Delta One", slug: "delta-one", website: "https://delta.co.uk", reasons: ["domain"] },
      { id: "d2", name: "Delta Two", slug: "delta-two", website: "https://delta.co.uk/jobs", reasons: ["domain"] },
    ],
    contact_candidates: [
      {
        id: "k3", full_name: "Pat Kim", company_id: "e2", company_name: "Beta Talent",
        email: "pat@beta.com", phone: null, linkedin_url: null, job_title: null,
      },
    ],
    reasons: [],
    source_job_id: null,
    resolution: null,
    result_status: null,
    result: null,
    error: null,
    ...overrides,
  };
}

describe("companyOptions", () => {
  it("offers each candidate with why it matched, then create and skip", () => {
    expect(companyOptions(row()).map((o) => o.label)).toEqual([
      "Match Delta One (same website domain)",
      "Match Delta Two (same website domain)",
      'Create "Delta Holdings" as a new company',
      "Skip this row",
    ]);
  });

  it("never offers to create a company the file gives no name for", () => {
    const r = row({ extracted: { company: { name: null, slug: null, website: "https://x.example", group_row: null } } });
    expect(companyOptions(r).map((o) => o.key)).toEqual(["match:d1", "match:d2", "skip"]);
  });

  it("does not offer create when a similar-named company already holds the slug", () => {
    const r = row({
      company_candidates: [{ id: "g", name: "Gamma Group", slug: "gamma", website: null, reasons: ["similar_name"] }],
    });
    expect(companyOptions(r).map((o) => o.key)).toEqual(["match:g", "skip"]);
  });
});

describe("contactOptions", () => {
  it("offers the existing contact at the row's company, create, or leaving it out", () => {
    expect(contactOptions(row({ company_match: { id: "e2", method: "name" } })).map((o) => o.decision)).toEqual([
      { action: "match", contact_id: "k3" },
      { action: "create" },
      { action: "skip" },
    ]);
  });

  it("never offers a contact at another company (the database would mark the row invalid)", () => {
    const elsewhere = row({ company_match: { id: "e1", method: "name" } });
    expect(contactOptions(elsewhere).map((o) => o.key)).toEqual(["create", "skip"]);
    expect(otherCompanyContacts(elsewhere).map((c) => c.id)).toEqual(["k3"]);
  });

  it("offers no match while the row's company is not settled", () => {
    expect(contactOptions(row()).map((o) => o.key)).toEqual(["create", "skip"]);
  });

  it("an unreadable contact can only be left out (so the company can import)", () => {
    const r = row({ extracted: { company: row().extracted!.company, contact: null, contact_error: "Two people in one cell." } });
    expect(contactOptions(r).map((o) => o.key)).toEqual(["skip"]);
  });

  it("matching is only allowed to a contact at the row's own company", () => {
    expect(contactMatchAllowed(row({ company_match: { id: "e2", method: "name" } }), "k3")).toBe(true);
    expect(contactMatchAllowed(row({ company_match: { id: "e1", method: "name" } }), "k3")).toBe(false);
    expect(contactMatchAllowed(row(), "k3")).toBe(false);
  });
});

describe("conflictText", () => {
  it("a differing value was kept", () => {
    expect(conflictText({ record: "contact", field: "phone", existing: "020 1", incoming: "020 2" })).toBe(
      'Kept existing contact phone "020 1" (file had "020 2")'
    );
  });

  it("an empty field was not filled because another contact has the value", () => {
    expect(
      conflictText({ record: "contact", field: "email", existing: null, incoming: "nina@x.example", reason: "used_by_other_contact" })
    ).toBe('Did not add contact email "nina@x.example": another contact already has it');
  });
});

describe("toResolutionPayload", () => {
  it("sends one entry per decided row and drops empty ones", () => {
    expect(
      toResolutionPayload({
        3: { company: { action: "match", company_id: "d1", save_alias: true } },
        7: {},
        9: { contact: { action: "skip" } },
      })
    ).toEqual([
      { row_id: 3, company: { action: "match", company_id: "d1", save_alias: true } },
      { row_id: 9, contact: { action: "skip" } },
    ]);
  });
});

describe("summaryLines", () => {
  it("a failed import reports only that nothing was imported", () => {
    expect(summaryLines({ status: "failed", failed_rows: 2 })).toEqual([{ label: "Rows that failed", value: 2 }]);
  });

  it("a committed import reports created, matched, skipped and failed", () => {
    const lines = summaryLines({
      status: "committed",
      rows: { skipped: 3, failed: 0 },
      companies: { created: 1, updated: 0, matched: 4 },
      contacts: { created: 2, updated: 1, matched: 5 },
      conflicts: 2,
      aliases_created: 1,
    });
    expect(Object.fromEntries(lines.map((l) => [l.label, l.value]))).toMatchObject({
      "Companies created": 1,
      "Companies matched": 4,
      "Contacts created": 2,
      "Contacts filled in": 1,
      "Rows skipped": 3,
      "Rows failed": 0,
      "Conflicts kept as they were": 2,
    });
  });
});
