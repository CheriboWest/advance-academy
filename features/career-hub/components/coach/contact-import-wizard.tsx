"use client";

import * as React from "react";
import Link from "next/link";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";

import {
  applyImportMapping,
  uploadImportFile,
  type ImportBatch,
  type ImportRole,
  type ImportSummary,
  type SheetMapping,
} from "@/features/career-hub/lib/contact-import-api";
import { ROLE_LABELS, ROLE_ORDER, summaryLines } from "@/features/career-hub/lib/contact-import";
import { Button } from "@/components/ui/button";
import { ContactImportPreview } from "@/features/career-hub/components/coach/contact-import-preview";

type Step = "upload" | "map" | "preview" | "done";

function stepFor(batch: ImportBatch | null): Step {
  if (!batch || batch.status === "uploading") return "upload";   // an unfinished upload starts over
  if (batch.status === "committed") return "done";
  return batch.status === "uploaded" ? "map" : "preview";
}

function UploadStep({ onUploaded }: { onUploaded: (batch: ImportBatch, previous: string | null) => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { batch, previous_imports_of_this_file: previous } = await uploadImportFile(file);
      const last = previous[0];
      onUploaded(
        batch,
        last ? `This exact file was uploaded before (${new Date(last.created_at).toLocaleString()}, ${last.status}). Rows already imported will match rather than duplicate.` : null
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-5">
      <p className="text-sm text-muted-foreground">
        Upload an Excel workbook (.xlsx) or a CSV, up to 10 MB. Nothing is imported until you have reviewed the preview.
      </p>
      <input
        type="file"
        accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        aria-label="Workbook or CSV file"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block text-sm"
      />
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <Button type="button" disabled={!file || busy} onClick={upload}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
        Upload and read the file
      </Button>
    </div>
  );
}

export function MappingStep({ batch, onPreviewed }: { batch: ImportBatch; onPreviewed: () => void }) {
  const [mapping, setMapping] = React.useState<Record<string, SheetMapping>>(() =>
    Object.fromEntries(batch.sheets.map((s) => [s.name, batch.mapping?.[s.name] ?? s.suggested_mapping]))
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function update(sheet: string, patch: Partial<SheetMapping>) {
    setMapping((prev) => ({ ...prev, [sheet]: { ...prev[sheet], ...patch } }));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await applyImportMapping(batch.id, mapping);
      onPreviewed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The mapping could not be applied.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {batch.sheets.map((sheet) => {
        const m = mapping[sheet.name];
        return (
          <section key={sheet.name} className="space-y-3 rounded-lg border p-4" aria-label={`Sheet ${sheet.name}`}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <h3 className="flex items-center gap-2 font-semibold">
                <FileSpreadsheet className="h-4 w-4" aria-hidden /> {sheet.name}
              </h3>
              <span className="text-xs text-muted-foreground">
                {sheet.row_count} rows · {sheet.blank_rows} blank
              </span>
              <label className="ml-auto flex items-center gap-2 text-sm">
                <input type="checkbox" checked={m.include} onChange={(e) => update(sheet.name, { include: e.target.checked })} />
                Import this sheet
              </label>
            </div>
            {m.include ? (
              <>
                <div className="flex flex-col gap-1 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={m.group_fill}
                      onChange={(e) => update(sheet.name, { group_fill: e.target.checked })}
                    />
                    A blank company cell belongs to the company above it, until a completely blank row
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={m.company_link_is_website}
                      onChange={(e) => update(sheet.name, { company_link_is_website: e.target.checked })}
                    />
                    A link on the company name is the company&apos;s own website (not a job posting)
                  </label>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-3">Column</th>
                        <th className="py-1 pr-3">Header</th>
                        <th className="py-1 pr-3">Sample values</th>
                        <th className="py-1">Use as</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(sheet.headers).map(([letter, header]) => (
                        <tr key={letter} className="border-t align-top">
                          <td className="py-2 pr-3 font-mono text-xs">{letter}</td>
                          <td className="py-2 pr-3">{header}</td>
                          <td className="max-w-xs py-2 pr-3 text-xs text-muted-foreground">
                            {sheet.sample
                              .map((r) => r.cells[letter])
                              .filter(Boolean)
                              .slice(0, 3)
                              .map((cell, i) => (
                                <div key={i} className="truncate" title={cell!.hyperlink ?? cell!.text}>
                                  {cell!.text || "(link only)"}
                                  {cell!.hyperlink ? " 🔗" : ""}
                                </div>
                              ))}
                          </td>
                          <td className="py-2">
                            <select
                              aria-label={`Use column ${letter} (${header}) as`}
                              className="rounded border bg-background px-2 py-1"
                              value={m.columns[letter] ?? "ignore"}
                              onChange={(e) =>
                                update(sheet.name, { columns: { ...m.columns, [letter]: e.target.value as ImportRole } })
                              }
                            >
                              {ROLE_ORDER.map((role) => (
                                <option key={role} value={role}>
                                  {ROLE_LABELS[role]}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </section>
        );
      })}
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <Button type="button" disabled={busy} onClick={submit}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        Preview the import
      </Button>
    </div>
  );
}

export function ImportSummaryView({ summary, batchId }: { summary: ImportSummary; batchId: string }) {
  return (
    <div className="space-y-3 rounded-lg border p-5" role="status">
      <h3 className="font-semibold">{summary.status === "committed" ? "Import complete" : "Import failed: nothing was imported"}</h3>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        {summaryLines(summary).map((line) => (
          <div key={line.label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{line.label}</dt>
            <dd className="tabular-nums">{line.value}</dd>
          </div>
        ))}
      </dl>
      {summary.errors?.length ? (
        <ul className="text-sm text-red-800">
          {summary.errors.map((e) => (
            <li key={e.row_id}>
              {e.sheet} row {e.row_number}: {e.error}
            </li>
          ))}
        </ul>
      ) : null}
      <Link className="text-sm underline" href={`/coach/contacts/import/${batchId}`}>
        See every row&apos;s result
      </Link>
    </div>
  );
}

/** Upload → map columns → review → import. Resumes from `initialBatch`. */
export function ContactImportWizard({ initialBatch = null }: { initialBatch?: ImportBatch | null }) {
  const [batch, setBatch] = React.useState<ImportBatch | null>(initialBatch);
  const [step, setStep] = React.useState<Step>(stepFor(initialBatch));
  const [notice, setNotice] = React.useState<string | null>(null);
  const [summary, setSummary] = React.useState<ImportSummary | null>(initialBatch?.summary ?? null);
  const steps: Array<[Step, string]> = [
    ["upload", "Upload"],
    ["map", "Map columns"],
    ["preview", "Review"],
    ["done", "Done"],
  ];

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Import steps">
        {steps.map(([key, label], i) => (
          <li
            key={key}
            aria-current={step === key ? "step" : undefined}
            className={step === key ? "font-semibold text-primary" : "text-muted-foreground"}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>
      {notice ? <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</p> : null}
      {summary?.status === "failed" && step === "preview" ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          The last attempt failed and was rolled back. Fix or skip the failing rows, then import again.
        </p>
      ) : null}

      {step === "upload" ? (
        <UploadStep
          onUploaded={(b, previous) => {
            setBatch(b);
            setNotice(previous);
            setStep("map");
          }}
        />
      ) : null}
      {step === "map" && batch ? (
        <>
          <MappingStep batch={batch} onPreviewed={() => setStep("preview")} />
        </>
      ) : null}
      {step === "preview" && batch ? (
        <>
          <Button type="button" variant="ghost" size="sm" onClick={() => setStep("map")}>
            ← Change the column mapping
          </Button>
          <ContactImportPreview
            batchId={batch.id}
            editable
            onCommitted={(s) => {
              setSummary(s);
              setStep(s.status === "committed" ? "done" : "preview");
            }}
          />
        </>
      ) : null}
      {step === "done" && batch && summary ? <ImportSummaryView summary={summary} batchId={batch.id} /> : null}
    </div>
  );
}
