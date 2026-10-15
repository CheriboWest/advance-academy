import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DirectoryContact } from "@/features/career-hub/lib/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ContactDirectory } from "@/features/career-hub/components/coach/contact-directory";
import {
  DIAGNOSTIC_CONTACT_ID,
  type ContactDirectoryDiagnostics,
} from "@/features/career-hub/lib/contact-directory-diagnostics";

afterEach(cleanup);

function contact(id: string, fullName: string, company: DirectoryContact["company"]): DirectoryContact {
  return {
    id,
    company_id: company?.id ?? "none",
    full_name: fullName,
    job_title: null,
    email: `${id}@example.com`,
    phone: null,
    linkedin_url: null,
    notes: null,
    created_at: null,
    updated_at: null,
    company,
  } as DirectoryContact;
}

describe("ContactDirectory", () => {
  it("lists a contact at a company with no slug, linking the company by id", () => {
    render(
      <ContactDirectory
        contacts={[
          contact("c1", "Ann Acme", { id: "co-1", name: "Acme", slug: "acme" }),
          contact("c2", "Bob Hays", { id: "co-2", name: "Hays", slug: null }),
        ]}
      />
    );
    expect(screen.getByText("Bob Hays")).toBeTruthy();
    expect(screen.getByText("2 contacts")).toBeTruthy();
    const company = screen.getByRole("link", { name: "Hays" });
    expect(company.getAttribute("href")).toBe("/coach/sponsored-companies/co-2");
    expect(Array.from(document.querySelectorAll("a")).some((a) => /null|undefined/.test(a.getAttribute("href") ?? ""))).toBe(false);
  });
});

describe("ContactDirectory diagnostics panel (temporary)", () => {
  const diagnostics: ContactDirectoryDiagnostics = {
    fetchedAt: "2026-10-15T12:00:00.000Z",
    durationMs: 12,
    request: "ok",
    httpStatus: 200,
    failureReason: null,
    error: null,
    responseIsArray: true,
    returnedCount: 3,
    uniqueIdCount: 3,
    withoutCompanyCount: 0,
    targetContactPresent: true,
  };
  const contacts = [
    contact(DIAGNOSTIC_CONTACT_ID, "Hana Head", { id: "co-1", name: "Headstar", slug: "headstar" }),
    contact("c2", "Ann Acme", { id: "co-2", name: "Acme", slug: "acme" }),
    contact("c3", "Bob Hays", { id: "co-3", name: "Hays", slug: "hays" }),
  ];
  const value = (label: string) => document.querySelector(`[data-diagnostic="${label}"]`)?.textContent;

  it("is not rendered without diagnostics", () => {
    render(<ContactDirectory contacts={contacts} />);
    expect(screen.queryByRole("region", { name: "Contact directory diagnostics" })).toBeNull();
  });

  it("shows the counts before and after the search filter, and whether the tracked contact is in view", () => {
    render(<ContactDirectory contacts={contacts} diagnostics={diagnostics} />);
    expect(value("Contacts returned by backend")).toBe("3");
    expect(value("Before frontend filtering")).toBe("3");
    expect(value("After frontend filtering")).toBe("3");
    expect(value(`Contact ${DIAGNOSTIC_CONTACT_ID.slice(0, 8)}… in filtered view`)).toBe("yes");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search contacts" }), { target: { value: "acme" } });
    expect(value("Before frontend filtering")).toBe("3");
    expect(value("After frontend filtering")).toBe("1");
    expect(value("Search length (characters)")).toBe("4");
    expect(value(`Contact ${DIAGNOSTIC_CONTACT_ID.slice(0, 8)}… in filtered view`)).toBe("no");
  });

  it("shows no contact details or search text", () => {
    render(<ContactDirectory contacts={contacts} diagnostics={diagnostics} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search contacts" }), { target: { value: "headstar" } });
    const panel = screen.getByRole("region", { name: "Contact directory diagnostics" }).textContent ?? "";
    expect(panel).not.toMatch(/Hana|Ann|Bob|Headstar|headstar|Acme|Hays|example\.com|co-1/);
    expect(panel).not.toContain(DIAGNOSTIC_CONTACT_ID);
  });

  it("is still shown when the backend returned no contacts", () => {
    render(<ContactDirectory contacts={[]} diagnostics={{ ...diagnostics, returnedCount: 0, targetContactPresent: false }} />);
    expect(screen.getByText("No contacts yet")).toBeTruthy();
    expect(value("Before frontend filtering")).toBe("0");
  });
});
