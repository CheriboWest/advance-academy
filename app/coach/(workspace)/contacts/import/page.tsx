import type { Metadata } from "next";

import { BackLink } from "@/components/back-link";
import { ContactImportWizard } from "@/features/career-hub/components/coach/contact-import-wizard";
import { ContactImportHistory } from "@/features/career-hub/components/coach/contact-import-history";

export const metadata: Metadata = {
  title: "Import contacts",
};

// Admin-only like every /coach page (app/coach/(workspace)/layout.tsx); the
// API behind it enforces the same rule on every request.
export default function ContactImportPage() {
  return (
    <div className="space-y-8">
      <BackLink href="/coach/contacts">Contacts</BackLink>
      <section className="space-y-3">
        <header className="space-y-1">
          <h2 className="text-lg font-semibold">Import companies and contacts</h2>
          <p className="text-sm text-muted-foreground">
            Matches existing companies by website domain, exact name or a verified alias, and contacts by email,
            LinkedIn profile, or company + name + phone. Uncertain matches are never merged: you decide them in the
            preview. Existing details are only filled in where empty, never overwritten.
          </p>
        </header>
        <ContactImportWizard />
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Import history</h2>
        <ContactImportHistory />
      </section>
    </div>
  );
}
