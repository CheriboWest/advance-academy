import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_CONTACT_ID, summarizeDirectoryRequest } from "@/features/career-hub/lib/contact-directory-diagnostics";

const NOW = new Date("2026-10-15T12:00:00.000Z");

function row(id: string, company: unknown = { id: "co", name: "Secret Co Ltd", slug: "secret-co" }) {
  return { id, full_name: "Jane Private", email: "jane.private@example.com", phone: "+44 7700 900000", company };
}

describe("summarizeDirectoryRequest", () => {
  it("counts the rows, unique ids and company-less rows, and finds the tracked contact", () => {
    const rows = [row("a"), row("a"), row("b", null), row(DIAGNOSTIC_CONTACT_ID)];
    const out = summarizeDirectoryRequest({ ok: true, status: 200, rows }, null, 42, NOW);
    expect(out).toEqual({
      fetchedAt: "2026-10-15T12:00:00.000Z",
      durationMs: 42,
      request: "ok",
      httpStatus: 200,
      failureReason: null,
      error: null,
      responseIsArray: true,
      returnedCount: 4,
      uniqueIdCount: 3,
      withoutCompanyCount: 1,
      targetContactPresent: true,
    });
  });

  it("says when the tracked contact is missing", () => {
    const out = summarizeDirectoryRequest({ ok: true, status: 200, rows: [row("a")] }, null, 1, NOW);
    expect(out.targetContactPresent).toBe(false);
  });

  it("never carries a contact field or any part of the body", () => {
    const out = summarizeDirectoryRequest({ ok: true, status: 200, rows: [row(DIAGNOSTIC_CONTACT_ID)] }, null, 1, NOW);
    expect(JSON.stringify(out)).not.toMatch(/Jane|Private|example\.com|7700|Secret Co|secret-co/);
  });

  it("flags a body that isn't a list instead of counting it", () => {
    const out = summarizeDirectoryRequest({ ok: true, status: 200, rows: { detail: "x" } }, null, 1, NOW);
    expect(out).toMatchObject({ responseIsArray: false, returnedCount: null, targetContactPresent: null });
  });

  it("reports an HTTP failure with its status and the page's message", () => {
    const out = summarizeDirectoryRequest({ ok: false, reason: "http", status: 403 }, "No access (HTTP 403).", 5, NOW);
    expect(out).toMatchObject({
      request: "failed",
      httpStatus: 403,
      failureReason: "http",
      error: "No access (HTTP 403).",
      returnedCount: null,
      targetContactPresent: null,
    });
  });

  it("reports a failure with no response (no HTTP status)", () => {
    const out = summarizeDirectoryRequest({ ok: false, reason: "network" }, "Didn't respond.", 5, NOW);
    expect(out).toMatchObject({ request: "failed", httpStatus: null, failureReason: "network" });
  });
});
