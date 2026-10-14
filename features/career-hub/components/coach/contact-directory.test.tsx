import { cleanup, render, screen } from "@testing-library/react";
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
