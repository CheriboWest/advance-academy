"use client";

import * as React from "react";
import Link from "next/link";
import { Linkedin, Mail, Phone, Search, Send } from "lucide-react";

import {
  CONTACT_CATEGORY_LABELS,
  CONTACT_CATEGORY_ORDER,
  contactCategory,
  type ContactCategory,
} from "@advance-academy/contracts/contacts";
import type { DirectoryContact } from "@/features/career-hub/lib/types";
import { cn } from "@/shared/utils/cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/features/career-hub/components/empty-state";
import { ContactDirectoryDiagnosticsPanel } from "@/features/career-hub/components/coach/contact-directory-diagnostics-panel";
import {
  DIAGNOSTIC_CONTACT_ID,
  type ContactDirectoryDiagnostics,
} from "@/features/career-hub/lib/contact-directory-diagnostics";

type Filter = ContactCategory | "all";

/**
 * Every company contact in one searchable list. Filtering is in the browser:
 * contacts are hand-entered, so the whole set comes down in one request
 * (see GET /contacts/directory). Editing stays on each company's profile.
 */
export function ContactDirectory({
  contacts,
  diagnostics,
}: {
  contacts: DirectoryContact[];
  /** TEMPORARY: passed only when CONTACTS_DEBUG_PANEL=1. */
  diagnostics?: ContactDirectoryDiagnostics;
}) {
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<Filter>("all");

  const rows = React.useMemo(
    () => contacts.map((c) => ({ ...c, category: contactCategory(c.job_title) })),
    [contacts]
  );

  const counts = React.useMemo(() => {
    const out: Partial<Record<ContactCategory, number>> = {};
    for (const row of rows) out[row.category] = (out[row.category] ?? 0) + 1;
    return out;
  }, [rows]);

  const needle = query.trim().toLowerCase();
  const filtered = rows.filter(
    (row) =>
      (category === "all" || row.category === category) &&
      (!needle ||
        [row.full_name, row.job_title, row.company?.name, row.email]
          .some((field) => field?.toLowerCase().includes(needle)))
  );

  const chips: Array<{ key: Filter; label: string; count: number }> = [
    { key: "all", label: "All", count: rows.length },
    ...CONTACT_CATEGORY_ORDER.filter((key) => counts[key]).map((key) => ({
      key,
      label: CONTACT_CATEGORY_LABELS[key],
      count: counts[key] ?? 0,
    })),
  ];

  const diagnosticsPanel = diagnostics && (
    <ContactDirectoryDiagnosticsPanel
      server={diagnostics}
      filter={{
        beforeFilter: rows.length,
        afterFilter: filtered.length,
        category,
        queryLength: needle.length,
        targetContactInView: filtered.some((row) => row.id === DIAGNOSTIC_CONTACT_ID),
      }}
    />
  );

  if (contacts.length === 0) {
    return (
      <>
        {diagnosticsPanel}
        <EmptyState
          title="No contacts yet"
          description="Add contacts from a company's profile under Sponsored Companies, or import the contacts spreadsheet."
        />
      </>
    );
  }

  return (
    <div className="space-y-4">
      {diagnosticsPanel}
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, role, company or email"
          aria-label="Search contacts"
          className="h-11 pl-9"
        />
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by role">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            aria-pressed={category === chip.key}
            onClick={() => setCategory(chip.key)}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
              category === chip.key
                ? "border-primary/30 bg-secondary text-primary"
                : "border-transparent text-muted-foreground hover:bg-accent hover:text-primary"
            )}
          >
            {chip.label} <span className="tabular-nums">({chip.count})</span>
          </button>
        ))}
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {filtered.length} {filtered.length === 1 ? "contact" : "contacts"}
      </p>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Company</th>
              <th className="px-4 py-3 font-medium">Reach</th>
              <th className="px-4 py-3 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                <td className="px-4 py-3 font-medium">{row.full_name}</td>
                <td className="px-4 py-3">
                  <span className="block">{row.job_title ?? "—"}</span>
                  <span className="text-xs text-muted-foreground">
                    {CONTACT_CATEGORY_LABELS[row.category]}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {row.company ? (
                    <Link
                      href={`/coach/sponsored-companies/${row.company.id}`}
                      className="underline-offset-4 hover:text-primary hover:underline"
                    >
                      {row.company.name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className="flex gap-3 text-muted-foreground">
                    {row.email && (
                      <a href={`mailto:${row.email}`} title={row.email} aria-label={`Email ${row.full_name}`}>
                        <Mail className="size-4 hover:text-primary" />
                      </a>
                    )}
                    {row.phone && (
                      <a href={`tel:${row.phone}`} title={row.phone} aria-label={`Call ${row.full_name}`}>
                        <Phone className="size-4 hover:text-primary" />
                      </a>
                    )}
                    {row.linkedin_url && (
                      <a
                        href={row.linkedin_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${row.full_name} on LinkedIn`}
                      >
                        <Linkedin className="size-4 hover:text-primary" />
                      </a>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  {row.company && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/coach/outreach/${row.company.id}?contact=${row.id}`}>
                        <Send className="size-4" />
                        Outreach
                      </Link>
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
