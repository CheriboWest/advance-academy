import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContactDirectoryDiagnostics } from "@/features/career-hub/lib/contact-directory-diagnostics";

const directory = vi.hoisted(() => ({ getContactDirectory: vi.fn() }));
const coach = vi.hoisted(() => ({ isCoach: vi.fn() }));
vi.mock("@/features/career-hub/lib/contacts", () => directory);
vi.mock("@/features/career-hub/lib/coach", () => coach);
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import ContactsPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const okDiagnostics: ContactDirectoryDiagnostics = {
  fetchedAt: "2026-10-15T12:00:00.000Z",
  durationMs: 12,
  request: "ok",
  httpStatus: 200,
  failureReason: null,
  error: null,
  responseIsArray: true,
  returnedCount: 0,
  uniqueIdCount: 0,
  withoutCompanyCount: 0,
  targetContactPresent: false,
};

function panelValue(label: string): string | null | undefined {
  return document.querySelector(`[data-diagnostic="${label}"]`)?.textContent;
}

describe("/coach/contacts", () => {
  it("shows the API's failure as an error, not as an empty directory", async () => {
    directory.getContactDirectory.mockResolvedValue({
      ok: false,
      error: "The contact directory couldn't be loaded (HTTP 500).",
    });
    render(await ContactsPage());
    expect(screen.getByRole("alert").textContent).toContain("couldn't be loaded (HTTP 500)");
    expect(screen.queryByText("No contacts yet")).toBeNull();
    // The import button stays usable.
    expect(screen.getByRole("link", { name: /Import from Excel/ }).getAttribute("href")).toBe("/coach/contacts/import");
  });

  it("an empty but healthy directory still says there are no contacts", async () => {
    directory.getContactDirectory.mockResolvedValue({ ok: true, contacts: [] });
    render(await ContactsPage());
    expect(screen.getByText("No contacts yet")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("/coach/contacts diagnostics panel (temporary)", () => {
  it("is hidden unless CONTACTS_DEBUG_PANEL=1", async () => {
    coach.isCoach.mockResolvedValue(true);
    directory.getContactDirectory.mockResolvedValue({ ok: true, contacts: [], diagnostics: okDiagnostics });
    for (const value of [undefined, "", "0", "true"]) {
      vi.stubEnv("CONTACTS_DEBUG_PANEL", value as string);
      render(await ContactsPage());
      expect(screen.queryByRole("region", { name: "Contact directory diagnostics" })).toBeNull();
      cleanup();
    }
  });

  it("is hidden for a non-coach even with the flag on", async () => {
    vi.stubEnv("CONTACTS_DEBUG_PANEL", "1");
    coach.isCoach.mockResolvedValue(false);
    directory.getContactDirectory.mockResolvedValue({ ok: true, contacts: [], diagnostics: okDiagnostics });
    render(await ContactsPage());
    expect(screen.queryByRole("region", { name: "Contact directory diagnostics" })).toBeNull();
  });

  it("shows request status and counts for a coach with the flag on", async () => {
    vi.stubEnv("CONTACTS_DEBUG_PANEL", "1");
    coach.isCoach.mockResolvedValue(true);
    directory.getContactDirectory.mockResolvedValue({ ok: true, contacts: [], diagnostics: okDiagnostics });
    render(await ContactsPage());
    expect(screen.getByRole("region", { name: "Contact directory diagnostics" })).toBeTruthy();
    expect(panelValue("API request")).toBe("OK");
    expect(panelValue("HTTP status")).toBe("200");
    expect(panelValue("Contacts returned by backend")).toBe("0");
    // The directory itself is unchanged.
    expect(screen.getByText("No contacts yet")).toBeTruthy();
  });

  it("still shows the panel next to the error when the request fails", async () => {
    vi.stubEnv("CONTACTS_DEBUG_PANEL", "1");
    coach.isCoach.mockResolvedValue(true);
    directory.getContactDirectory.mockResolvedValue({
      ok: false,
      error: "No access (HTTP 403).",
      diagnostics: {
        ...okDiagnostics,
        request: "failed",
        httpStatus: 403,
        failureReason: "http",
        error: "No access (HTTP 403).",
        responseIsArray: null,
        returnedCount: null,
        uniqueIdCount: null,
        withoutCompanyCount: null,
        targetContactPresent: null,
      },
    });
    render(await ContactsPage());
    expect(screen.getByRole("alert").textContent).toContain("HTTP 403");
    expect(panelValue("API request")).toBe("Failed");
    expect(panelValue("HTTP status")).toBe("403");
    expect(panelValue("Failure reason")).toBe("http");
    expect(panelValue("Before frontend filtering")).toBe("—");
  });
});
