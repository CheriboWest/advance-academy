import {
  DIAGNOSTIC_CONTACT_ID,
  type ContactDirectoryDiagnostics,
  type ContactDirectoryFilterDiagnostics,
} from "@/features/career-hub/lib/contact-directory-diagnostics";

/**
 * TEMPORARY read-only panel for the 37-vs-148 investigation; shown only when
 * CONTACTS_DEBUG_PANEL=1 (see app/coach/(workspace)/contacts/page.tsx).
 * Renders counts, statuses and yes/no answers only — never a contact field or
 * the response body. No hooks, so a server or a client parent can render it.
 */
export function ContactDirectoryDiagnosticsPanel({
  server,
  filter,
}: {
  server: ContactDirectoryDiagnostics;
  /** Absent when the directory didn't render (request failed). */
  filter?: ContactDirectoryFilterDiagnostics;
}) {
  const rows: Array<[string, string]> = [
    ["API request", server.request === "ok" ? "OK" : "Failed"],
    ["HTTP status", show(server.httpStatus)],
    ["Failure reason", show(server.failureReason)],
    ["Error", show(server.error)],
    ["Response is a list", yesNo(server.responseIsArray)],
    ["Contacts returned by backend", show(server.returnedCount)],
    ["Unique contact ids", show(server.uniqueIdCount)],
    ["Contacts without a company", show(server.withoutCompanyCount)],
    [`Contact ${shortId(DIAGNOSTIC_CONTACT_ID)} in response`, yesNo(server.targetContactPresent)],
    ["Before frontend filtering", show(filter?.beforeFilter)],
    ["After frontend filtering", show(filter?.afterFilter)],
    ["Role filter", show(filter?.category)],
    ["Search length (characters)", show(filter?.queryLength)],
    [`Contact ${shortId(DIAGNOSTIC_CONTACT_ID)} in filtered view`, yesNo(filter?.targetContactInView)],
    ["Request time", `${server.durationMs} ms`],
    ["Fetched at (server)", server.fetchedAt],
  ];

  return (
    <section
      aria-label="Contact directory diagnostics"
      className="rounded-lg border border-dashed border-amber-500/60 bg-amber-50/40 p-4 text-xs dark:bg-amber-950/20"
    >
      <h2 className="mb-2 font-semibold">Diagnostics (temporary, CONTACTS_DEBUG_PANEL)</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono tabular-nums" data-diagnostic={label}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function show(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function yesNo(value: boolean | null | undefined): string {
  return value === null || value === undefined ? "—" : value ? "yes" : "no";
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}
