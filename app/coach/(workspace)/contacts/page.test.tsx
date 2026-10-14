import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const directory = vi.hoisted(() => ({ getContactDirectory: vi.fn() }));
vi.mock("@/features/career-hub/lib/contacts", () => directory);
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import ContactsPage from "./page";

afterEach(cleanup);

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
