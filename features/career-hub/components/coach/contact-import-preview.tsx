"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import {
  commitImport,
  getImport,
  listImportRows,
  resolveImportRows,
  searchCompaniesForImport,
  type Classification,
  type CompanyDecision,
  type CompanySearchResult,
  type ContactDecision,
  type ImportRow,
  type ImportSummary,
  type PreviewCounts,
  type ResultStatus,
  type RowResolution,
} from "@/features/career-hub/lib/contact-import-api";
import {
  CLASSIFICATION_HELP,
  CLASSIFICATION_LABELS,
  RESULT_LABELS,
  companyLabel,
  companyOptions,
  contactLabel,
  contactOptions,
  needsCompanyDecision,
  needsContactDecision,
  toResolutionPayload,
} from "@/features/career-hub/lib/contact-import";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/shared/utils/cn";

const PAGE = 100;
const CLASSIFICATION_ORDER: Classification[] = ["needs_review", "new", "matched", "invalid", "skipped"];
const RESULT_ORDER: ResultStatus[] = ["failed", "created", "updated", "matched", "skipped", "rolled_back"];

const BADGE_TONE: Record<string, string> = {
  matched: "bg-slate-100 text-slate-800",
  new: "bg-emerald-100 text-emerald-900",
  needs_review: "bg-amber-100 text-amber-900",
  invalid: "bg-red-100 text-red-900",
  skipped: "bg-slate-100 text-slate-500",
  created: "bg-emerald-100 text-emerald-900",
  updated: "bg-sky-100 text-sky-900",
  failed: "bg-red-100 text-red-900",
  rolled_back: "bg-orange-100 text-orange-900",
};

function StatusBadge({ value, label }: { value: string; label: string }) {
  return <Badge className={cn("font-medium", BADGE_TONE[value])}>{label}</Badge>;
}

/** Match a company the candidates don't include, found by name. */
function CompanyPicker({ onPick }: { onPick: (company: CompanySearchResult) => void }) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<CompanySearchResult[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  async function search() {
    setError(null);
    try {
      setResults(q.trim().length >= 2 ? await searchCompaniesForImport(q.trim()) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    }
  }

  return (
    <div className="mt-2 space-y-1">
      <div className="flex gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), search())}
          placeholder="Find another company by name"
          aria-label="Find another company by name"
          className="h-8"
        />
        <Button type="button" size="sm" variant="outline" onClick={search}>
          Search
        </Button>
      </div>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
      {results.length > 0 ? (
        <ul className="max-h-40 overflow-auto rounded border text-sm">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full px-2 py-1 text-left hover:bg-muted"
                onClick={() => {
                  onPick(c);
                  setResults([]);
                }}
              >
                {c.name}
                {c.website || c.website_url ? (
                  <span className="ml-1 text-xs text-muted-foreground">{c.website ?? c.website_url}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function RowDecision({
  row,
  decision,
  onChange,
}: {
  row: ImportRow;
  decision: RowResolution | undefined;
  onChange: (next: RowResolution | undefined) => void;
}) {
  const [extraCompanies, setExtraCompanies] = React.useState<CompanySearchResult[]>([]);
  const company = companyOptions(row);
  for (const c of extraCompanies) {
    if (!company.some((o) => o.key === `match:${c.id}`)) {
      company.unshift({ key: `match:${c.id}`, label: `Match ${c.name} (chosen by you)`, decision: { action: "match", company_id: c.id } });
    }
  }
  const contact = contactOptions(row);
  const companyKey = decision?.company
    ? decision.company.action === "match" ? `match:${decision.company.company_id}` : decision.company.action
    : "";
  const contactKey = decision?.contact
    ? decision.contact.action === "match" ? `match:${decision.contact.contact_id}` : decision.contact.action
    : "";

  function setCompany(key: string) {
    const option = company.find((o) => o.key === key);
    const next: RowResolution = { ...decision, company: option ? ({ ...option.decision } as CompanyDecision) : undefined };
    onChange(next.company || next.contact ? next : undefined);
  }
  function setContact(key: string) {
    const option = contact.find((o) => o.key === key);
    const next: RowResolution = { ...decision, contact: option ? ({ ...option.decision } as ContactDecision) : undefined };
    onChange(next.company || next.contact ? next : undefined);
  }

  const name = row.extracted?.company?.name;
  return (
    <div className="space-y-2 text-sm">
      {needsCompanyDecision(row) ? (
        <div>
          <label className="block text-xs font-medium text-muted-foreground" htmlFor={`company-${row.id}`}>
            Company
          </label>
          <select
            id={`company-${row.id}`}
            className="mt-1 w-full rounded border bg-background px-2 py-1"
            value={companyKey}
            onChange={(e) => setCompany(e.target.value)}
          >
            <option value="">Decide later (row is skipped)</option>
            {company.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          {decision?.company?.action === "match" && name ? (
            <label className="mt-1 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={Boolean(decision.company.save_alias)}
                onChange={(e) => onChange({ ...decision, company: { ...decision.company!, save_alias: e.target.checked } })}
              />
              Remember &quot;{name}&quot; as a verified alias of this company
            </label>
          ) : null}
          <CompanyPicker
            onPick={(c) => {
              setExtraCompanies((prev) => [...prev, c]);
              onChange({ ...decision, company: { action: "match", company_id: c.id } });
            }}
          />
        </div>
      ) : null}
      {needsContactDecision(row) ? (
        <div>
          <label className="block text-xs font-medium text-muted-foreground" htmlFor={`contact-${row.id}`}>
            Contact
          </label>
          <select
            id={`contact-${row.id}`}
            className="mt-1 w-full rounded border bg-background px-2 py-1"
            value={contactKey}
            onChange={(e) => setContact(e.target.value)}
          >
            <option value="">Decide later (row is skipped)</option>
            {contact.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

function RowDetails({ row, showResult }: { row: ImportRow; showResult: boolean }) {
  const contact = row.extracted?.contact;
  const source = row.extracted?.source;
  const conflicts = row.result?.conflicts ?? [];
  return (
    <div className="space-y-1">
      <p className="font-medium">
        {companyLabel(row)}
        {row.extracted?.company?.group_row ? (
          <span className="ml-1 text-xs font-normal text-muted-foreground">(from row {row.extracted.company.group_row})</span>
        ) : null}
      </p>
      {row.extracted?.company?.website ? <p className="text-xs text-muted-foreground">{row.extracted.company.website}</p> : null}
      {contact || row.extracted?.contact_error ? (
        <p>
          {contactLabel(row)}
          {contact ? (
            <span className="ml-1 text-xs text-muted-foreground">
              {[contact.email, contact.phone, contact.linkedin_url].filter(Boolean).join(" · ")}
            </span>
          ) : null}
        </p>
      ) : null}
      {source ? (
        <p className="text-xs text-muted-foreground">
          Source: {source.text ?? ""}
          {source.url ? (
            <>
              {" "}
              <a className="underline" href={source.url} target="_blank" rel="noreferrer noopener">
                link
              </a>
            </>
          ) : null}
          {row.source_job_id ? " · matches a job already on file" : null}
        </p>
      ) : null}
      {[...row.parse_errors, ...row.reasons.filter((r) => !row.parse_errors.includes(r))].map((reason) => (
        <p key={reason} className="text-xs text-amber-900">
          {reason}
        </p>
      ))}
      {showResult && row.error ? <p className="text-xs text-red-700">{row.error}</p> : null}
      {showResult && row.result?.reason ? <p className="text-xs text-muted-foreground">Skipped: {row.result.reason}</p> : null}
      {showResult && conflicts.length > 0 ? (
        <ul className="text-xs text-sky-900">
          {conflicts.map((c) => (
            <li key={`${c.record}-${c.field}`}>
              Kept existing {c.record} {c.field} &quot;{c.existing}&quot; (file had &quot;{c.incoming}&quot;)
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ContactImportPreview({
  batchId,
  editable,
  onCommitted,
}: {
  batchId: string;
  editable: boolean;
  onCommitted?: (summary: ImportSummary) => void;
}) {
  const [counts, setCounts] = React.useState<PreviewCounts | null>(null);
  const [filter, setFilter] = React.useState<Classification | ResultStatus | "all">(editable ? "needs_review" : "all");
  const [rows, setRows] = React.useState<ImportRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [offset, setOffset] = React.useState(0);
  const [decisions, setDecisions] = React.useState<Record<number, RowResolution>>({});
  const [busy, setBusy] = React.useState<null | "load" | "apply" | "commit">("load");
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setBusy("load");
    setError(null);
    try {
      const [{ counts: c }, page] = await Promise.all([
        getImport(batchId),
        listImportRows(batchId, {
          ...(filter === "all"
            ? {}
            : editable
              ? { classification: filter as Classification }
              : { resultStatus: filter as ResultStatus }),
          limit: PAGE,
          offset,
        }),
      ]);
      setCounts(c);
      setRows(page.rows);
      setTotal(page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the preview.");
    } finally {
      setBusy(null);
    }
  }, [batchId, filter, offset, editable]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const pending = toResolutionPayload(decisions);

  const unsent = Object.keys(decisions).length;

  async function applyDecisions() {
    // An empty {} entry is an "undo": send it as a clear.
    const clears = Object.entries(decisions)
      .filter(([, d]) => !d.company && !d.contact)
      .map(([id]) => ({ row_id: Number(id), clear: true }));
    setBusy("apply");
    setError(null);
    try {
      await resolveImportRows(batchId, [...pending, ...clears]);
      setDecisions({});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your decisions.");
      setBusy(null);
    }
  }

  async function commit() {
    setBusy("commit");
    setError(null);
    try {
      const { summary } = await commitImport(batchId);
      setConfirming(false);
      setBusy(null);
      onCommitted?.(summary);
      if (summary.status === "failed") {
        // Rolled back as a whole: reload (which clears errors), then say which
        // rows failed so they can be skipped or fixed.
        await load();
        setError(`${summary.failed_rows ?? 0} row(s) failed, so nothing was imported. ${summary.errors?.map((e) => `${e.sheet} row ${e.row_number}: ${e.error}`).join(" · ") ?? ""}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import failed. Nothing was imported.");
      setBusy(null);
    }
  }

  const tabs: Array<{ key: Classification | ResultStatus | "all"; label: string; count?: number }> = editable
    ? [
        { key: "all", label: "All", count: counts?.total },
        ...CLASSIFICATION_ORDER.map((k) => ({ key: k, label: CLASSIFICATION_LABELS[k], count: counts?.[k] })),
      ]
    : [{ key: "all", label: "All", count: counts?.total }, ...RESULT_ORDER.map((k) => ({ key: k, label: RESULT_LABELS[k] }))];

  const importable = (counts?.matched ?? 0) + (counts?.new ?? 0);

  return (
    <section className="space-y-4" aria-label="Import preview">
      <div className="flex flex-wrap gap-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={filter === t.key}
            onClick={() => {
              setFilter(t.key);
              setOffset(0);
            }}
            className={cn(
              "rounded-full border px-3 py-1 text-sm",
              filter === t.key ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"
            )}
          >
            {t.label}
            {t.count !== undefined ? <span className="ml-1 tabular-nums">{t.count}</span> : null}
          </button>
        ))}
      </div>
      {editable && filter !== "all" && filter in CLASSIFICATION_HELP ? (
        <p className="text-sm text-muted-foreground">{CLASSIFICATION_HELP[filter as Classification]}</p>
      ) : null}

      {error ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Row</th>
              <th className="px-3 py-2">From the file</th>
              <th className="px-3 py-2">{editable ? "Status" : "Result"}</th>
              {editable ? <th className="px-3 py-2">Your decision</th> : null}
            </tr>
          </thead>
          <tbody>
            {busy === "load" && rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" aria-hidden /> Loading rows…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                  No rows here.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-t align-top" data-testid={`import-row-${row.row_number}`}>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {row.sheet}
                    <br />
                    row {row.row_number}
                  </td>
                  <td className="px-3 py-2">
                    <RowDetails row={row} showResult={!editable} />
                  </td>
                  <td className="px-3 py-2">
                    {editable
                      ? row.classification && (
                          <StatusBadge value={row.classification} label={CLASSIFICATION_LABELS[row.classification]} />
                        )
                      : row.result_status
                        ? <StatusBadge value={row.result_status} label={RESULT_LABELS[row.result_status]} />
                        : row.classification && (
                            <StatusBadge value={row.classification} label={CLASSIFICATION_LABELS[row.classification]} />
                          )}
                    {editable && row.resolution ? <p className="mt-1 text-xs text-muted-foreground">Decided</p> : null}
                  </td>
                  {editable ? (
                    <td className="min-w-64 px-3 py-2">
                      {needsCompanyDecision(row) || needsContactDecision(row) ? (
                        <RowDecision
                          row={row}
                          decision={decisions[row.id]}
                          onChange={(next) =>
                            setDecisions((prev) => {
                              const copy = { ...prev };
                              if (next) copy[row.id] = next;
                              else delete copy[row.id];
                              return copy;
                            })
                          }
                        />
                      ) : row.resolution ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setDecisions((prev) => ({ ...prev, [row.id]: {} }))}
                        >
                          Undo decision
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>
          {total === 0 ? "0 rows" : `Rows ${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`}
        </span>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>
            Previous
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            Next
          </Button>
        </div>
      </div>

      {editable ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-4">
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null || unsent === 0}
            onClick={applyDecisions}
          >
            {busy === "apply" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Apply {unsent} decision{unsent === 1 ? "" : "s"}
          </Button>
          <span className="text-sm text-muted-foreground">
            {importable} row{importable === 1 ? "" : "s"} will import. {counts?.needs_review ?? 0} needing review and{" "}
            {counts?.invalid ?? 0} invalid will be skipped.
          </span>
          <div className="ml-auto flex items-center gap-2">
            {confirming ? (
              <>
                <span className="text-sm">Import now? Everything is written in one go, or nothing is.</span>
                <Button type="button" disabled={busy !== null} onClick={commit}>
                  {busy === "commit" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Confirm import
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                disabled={busy !== null || importable === 0 || unsent > 0}
                title={unsent > 0 ? "Apply your decisions first" : undefined}
                onClick={() => setConfirming(true)}
              >
                Import {importable} row{importable === 1 ? "" : "s"}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
