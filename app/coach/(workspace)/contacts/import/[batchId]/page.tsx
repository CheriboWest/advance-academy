import type { Metadata } from "next";

import { BackLink } from "@/components/back-link";
import { ContactImportBatchView } from "@/features/career-hub/components/coach/contact-import-history";

export const metadata: Metadata = {
  title: "Contact import",
};

interface ContactImportBatchPageProps {
  params: Promise<{ batchId: string }>;
}

export default async function ContactImportBatchPage({ params }: ContactImportBatchPageProps) {
  const { batchId } = await params;
  return (
    <div className="space-y-6">
      <BackLink href="/coach/contacts/import">All imports</BackLink>
      <ContactImportBatchView batchId={batchId} />
    </div>
  );
}
