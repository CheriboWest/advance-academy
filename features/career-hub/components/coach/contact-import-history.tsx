"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import {
  getImport,
  listImports,
  type ImportBatch,
  type ImportBatchListItem,
  type PreviewCounts,
} from "@/features/career-hub/lib/contact-import-api";
import { summaryLines } from "@/features/career-hub/lib/contact-import";
import { ContactImportPreview } from "@/features/career-hub/components/coach/contact-import-preview";
import { ContactImportWizard, ImportSummaryView } from "@/features/career-hub/components/coach/contact-import-wizard";

const STATUS_LABEL: Record<ImportBatch["status"], string> = {
  uploading: "Upload incomplete",
  uploaded: "Uploaded (not mapped)",
  previewed: "In review",
  committed: "Imported",
  failed: "Failed, rolled back",
};

export function ContactImportHistory() {
  const [batches, setBatches] = React.useState<ImportBatchListItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    listImports().then(setBatches, (e) => setError(e instanceof Error ? e.message : "Could not load the history."));
  }, []);

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!batches) {
    return (
      <p className="text-sm text-muted-foreground">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" aria-hidden /> Loading import history…
      </p>
    );
  }
  if (batches.length === 0) return <p className="text-sm text-muted-foreground">No imports yet.</p>;

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2">File</th>
            <th className="px-3 py-2">Uploaded</th>
            <th className="px-3 py-2">By</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Result</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} className="border-t">
              <td className="px-3 py-2">
                <Link className="underline" href={`/coach/contacts/import/${b.id}`}>
                  {b.file_name}
                </Link>
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{new Date(b.created_at).toLocaleString()}</td>
              <td className="px-3 py-2 text-muted-foreground">{b.mine ? "You" : "Another admin"}</td>
              <td className="px-3 py-2">{STATUS_LABEL[b.status]}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {b.summary
                  ? summaryLines(b.summary)
                      .filter((l) => l.value > 0)
                      .slice(0, 4)
                      .map((l) => `${l.label}: ${l.value}`)
                      .join(" · ")
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One batch: resumable by its uploader until imported; read-only results otherwise. */
export function ContactImportBatchView({ batchId }: { batchId: string }) {
  const [data, setData] = React.useState<{ batch: ImportBatch; counts: PreviewCounts } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    getImport(batchId).then(setData, (e) => setError(e instanceof Error ? e.message : "Could not load this import."));
  }, [batchId]);

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!data) {
    return (
      <p className="text-sm text-muted-foreground">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" aria-hidden /> Loading…
      </p>
    );
  }

  const { batch } = data;
  const header = (
    <header className="space-y-1">
      <h2 className="text-lg font-semibold">{batch.file_name}</h2>
      <p className="text-sm text-muted-foreground">
        {STATUS_LABEL[batch.status]} · uploaded {new Date(batch.created_at).toLocaleString()} by{" "}
        {batch.mine ? "you" : "another admin"}
        {batch.committed_at ? ` · imported ${new Date(batch.committed_at).toLocaleString()}` : ""}
      </p>
      {batch.error ? <p className="text-sm text-red-700">{batch.error}</p> : null}
    </header>
  );

  if (batch.status === "uploading") {
    return (
      <div className="space-y-4">
        {header}
        <p className="text-sm text-muted-foreground">
          This upload did not finish, so it can&apos;t be mapped or imported. Upload the file again.
        </p>
      </div>
    );
  }
  if (batch.mine && batch.status !== "committed") {
    return (
      <div className="space-y-4">
        {header}
        <ContactImportWizard initialBatch={batch} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {header}
      {batch.summary ? <ImportSummaryView summary={batch.summary} batchId={batch.id} /> : null}
      {batch.status === "uploaded" ? (
        <p className="text-sm text-muted-foreground">This file has not been mapped yet.</p>
      ) : (
        <ContactImportPreview batchId={batch.id} editable={false} />
      )}
    </div>
  );
}
