import type { Metadata } from "next";
import Link from "next/link";
import { Upload } from "lucide-react";

import { getContactDirectory } from "@/features/career-hub/lib/contacts";
import { ContactDirectory } from "@/features/career-hub/components/coach/contact-directory";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Contacts",
};

export default async function ContactsPage() {
  const contacts = await getContactDirectory();

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
      <ContactDirectory contacts={contacts} />
    </div>
  );
}
