import type { Metadata } from "next";
import Link from "next/link";
import { TriangleAlert, Upload } from "lucide-react";

import { getContactDirectory } from "@/features/career-hub/lib/contacts";
import { isCoach } from "@/features/career-hub/lib/coach";
import { ContactDirectory } from "@/features/career-hub/components/coach/contact-directory";
import { ContactDirectoryDiagnosticsPanel } from "@/features/career-hub/components/coach/contact-directory-diagnostics-panel";
import { contactsDebugPanelEnabled } from "@/shared/env/server";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Contacts",
};

export default async function ContactsPage() {
  const directory = await getContactDirectory();
  // TEMPORARY diagnostics (37-vs-148): the env flag, plus the coach check the
  // (workspace) layout already makes — isCoach() is cached per request, so
  // this reuses that answer rather than asking Fastify again.
  const diagnostics = contactsDebugPanelEnabled() && (await isCoach()) ? directory.diagnostics : undefined;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Every HR, recruiter, hiring-manager and decision-maker contact across
          your companies. Add or edit contacts on each company&apos;s profile.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/coach/contacts/import">
            <Upload className="h-4 w-4" aria-hidden />
            Import from Excel / CSV
          </Link>
        </Button>
      </header>
      {directory.ok ? (
        <ContactDirectory contacts={directory.contacts} diagnostics={diagnostics} />
      ) : (
        <>
          {diagnostics && <ContactDirectoryDiagnosticsPanel server={diagnostics} />}
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 p-4 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {directory.error}
          </p>
        </>
      )}
    </div>
  );
}
