"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EyeOff, RotateCcw, Search, Star, TriangleAlert, Trash2, X } from "lucide-react";

import { cn } from "@/shared/utils/cn";
import type { CoachCompanyRow } from "@/features/career-hub/lib/types";
import {
  hideCompanyAction,
  restoreCompanyAction,
  toggleStarAction,
} from "@/app/coach/(workspace)/companies/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { LeadScoreBadge } from "@/features/career-hub/components/lead-score-badge";
import { EmptyState } from "@/features/career-hub/components/empty-state";
import { NotesDialog } from "@/features/career-hub/components/coach/notes-dialog";
import { DeleteCompaniesDialog } from "@/features/career-hub/components/coach/delete-companies-dialog";

interface CompaniesTableProps {
  rows: CoachCompanyRow[];
  /** "all" shows "Remove from my list"; "removed" shows Restore. */
  view?: "all" | "removed";
}

/**
 * Searchable table of companies with per-coach starring, private notes, and two
 * distinct destructive-looking actions that are NOT the same thing:
 *
 *   - "Remove from my list" (eye icon) hides the company from this coach only,
 *     reversibly, via `coach_company_meta.hidden`. It appears in "Removed".
 *   - The trash button permanently deletes the company from the database for
 *     every user. It does not appear anywhere afterwards, including "Removed".
 *
 * Deletion — single or bulk — always goes through the confirmation dialog and a
 * server action; the browser never writes to the database.
 */
/**
 * Rows rendered at a time. The tab used to render every company hiring —
 * ~2,000 rows, each with a checkbox, a notes dialog and four buttons — which
 * measured 13.6 MB of HTML, ~2.4 s of main-thread work and ~4.2 s before the
 * first row appeared, and every search keystroke re-rendered them all. Search
 * and the count still cover every row; only the rendering is incremental.
 */
export const ROWS_PER_STEP = 100;

export function CompaniesTable({ rows, view = "all" }: CompaniesTableProps) {
  const removed = view === "removed";
  const router = useRouter();
  const [data, setData] = React.useState(rows);
  const [query, setQuery] = React.useState("");
  const [shownCount, setShownCount] = React.useState(ROWS_PER_STEP);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [toDelete, setToDelete] = React.useState<CoachCompanyRow[] | null>(null);
  const [, startTransition] = React.useTransition();

  // Keep local state in sync if the server sends fresh data.
  React.useEffect(() => {
    setData(rows);
    // Drop selections for rows the server no longer returns, so a stale id can
    // never end up in a delete request.
    const live = new Set(rows.map((row) => row.company_id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter(
      (row) =>
        row.name.toLowerCase().includes(q) ||
        row.location.toLowerCase().includes(q)
    );
  }, [data, query]);

  const shown = React.useMemo(() => filtered.slice(0, shownCount), [filtered, shownCount]);

  // Selection is scoped to what is currently displayed: "select all" means the
  // rows on screen, and the bulk bar counts only rows the coach can see — a
  // bulk *permanent delete* must never reach rows that were never rendered.
  const selectedRows = React.useMemo(
    () => shown.filter((row) => selectedIds.has(row.company_id)),
    [shown, selectedIds]
  );
  const allVisibleSelected =
    shown.length > 0 && selectedRows.length === shown.length;
  const someVisibleSelected =
    selectedRows.length > 0 && !allVisibleSelected;

  function patchRow(companyId: string, patch: Partial<CoachCompanyRow>) {
    setData((prev) =>
      prev.map((row) =>
        row.company_id === companyId ? { ...row, ...patch } : row
      )
    );
  }

  function toggleSelection(companyId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(companyId)) next.delete(companyId);
      else next.add(companyId);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const row of shown) next.delete(row.company_id);
      } else {
        for (const row of shown) next.add(row.company_id);
      }
      return next;
    });
  }

  /**
   * Runs an optimistic action: undo the optimistic edit and SAY SO if it fails.
   *
   * All three handlers below used to revert in silence, so a write the server
   * refused looked exactly like one it accepted — the row stayed gone until a
   * reload. The `catch` matters as much as the `result.error` branch: a thrown
   * action (a stale Server Action id after an edit, a redirect on the POST)
   * skipped both the revert and any sign that anything had happened.
   */
  function runAction(
    action: () => Promise<{ error: string | null }>,
    revert: () => void,
    companyId: string
  ) {
    setActionError(null);
    setPendingId(companyId);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) {
          revert();
          setActionError(result.error);
        }
      } catch (cause) {
        revert();
        setActionError(cause instanceof Error ? cause.message : String(cause));
      }
      setPendingId(null);
    });
  }

  function toggleStar(row: CoachCompanyRow) {
    const next = !row.starred;
    patchRow(row.company_id, { starred: next }); // optimistic
    runAction(
      () => toggleStarAction(row.company_id, next),
      () => patchRow(row.company_id, { starred: !next }),
      row.company_id
    );
  }

  /** Per-coach, reversible hide — not a deletion. */
  function hideCompany(row: CoachCompanyRow) {
    const snapshot = data;
    setData((prev) => prev.filter((r) => r.company_id !== row.company_id)); // optimistic
    runAction(
      () => hideCompanyAction(row.company_id),
      () => setData(snapshot),
      row.company_id
    );
  }

  function restoreCompany(row: CoachCompanyRow) {
    const snapshot = data;
    setData((prev) => prev.filter((r) => r.company_id !== row.company_id)); // optimistic
    runAction(
      () => restoreCompanyAction(row.company_id),
      () => setData(snapshot),
      row.company_id
    );
  }

  /**
   * Rows are removed only once the server confirms which ids it deleted — a
   * permanent deletion is not worth an optimistic guess — then the route is
   * refreshed so every other list reflects the new company set.
   */
  function handleDeleted(deletedIds: string[]) {
    if (deletedIds.length === 0) return;
    const gone = new Set(deletedIds);
    setData((prev) => prev.filter((row) => !gone.has(row.company_id)));
    setSelectedIds((prev) => new Set([...prev].filter((id) => !gone.has(id))));
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {actionError && (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {actionError}
        </p>
      )}

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setShownCount(ROWS_PER_STEP);
          }}
          placeholder="Search by company or location"
          aria-label="Search companies"
          className="h-11 pl-9"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {filtered.length} {filtered.length === 1 ? "company" : "companies"}
        </p>

        {selectedRows.length > 0 && (
          <div
            role="group"
            aria-label="Bulk actions"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2"
          >
            <span className="text-sm font-medium" aria-live="polite">
              {selectedRows.length} selected
            </span>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setToDelete(selectedRows)}
            >
              <Trash2 className="size-4" />
              Delete selected ({selectedRows.length})
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
            >
              <X className="size-4" />
              Clear
            </Button>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        data.length === 0 ? (
          <EmptyState
            title={removed ? "No removed companies" : "No companies yet"}
            description={
              removed
                ? "Companies you remove from your list will appear here, ready to restore."
                : "Run the crawler to discover companies, then manage them here."
            }
          />
        ) : (
          <EmptyState
            title="No companies match your search"
            description="Try a different company name or location."
          />
        )
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="w-10 px-4 py-3">
                  <Checkbox
                    // Radix models the mixed state as a third `checked` value
                    // rather than a separate `indeterminate` prop, and still
                    // renders aria-checked="mixed" for it.
                    checked={someVisibleSelected ? 'indeterminate' : allVisibleSelected}
                    onCheckedChange={toggleSelectAllVisible}
                    aria-label={
                      allVisibleSelected
                        ? "Deselect all shown companies"
                        : "Select all shown companies"
                    }
                  />
                </th>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 text-right font-medium">Open jobs</th>
                <th className="px-4 py-3 font-medium">Lead score</th>
                <th className="px-4 py-3 text-center font-medium">Starred</th>
                <th className="px-4 py-3 text-right font-medium">Notes</th>
                <th className="px-4 py-3 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const selected = selectedIds.has(row.company_id);
                return (
                  <tr
                    key={row.company_id}
                    data-selected={selected || undefined}
                    className={cn(
                      "border-b border-border/60 last:border-0 hover:bg-muted/40",
                      selected && "bg-muted/60"
                    )}
                  >
                    <td className="px-4 py-3">
                      <Checkbox
                        checked={selected}
                        onCheckedChange={() => toggleSelection(row.company_id)}
                        aria-label={`Select ${row.name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/coach/sponsored-companies/${row.company_id}`}
                        // Not prefetched: each visible row's prefetch was its own
                        // server request (middleware's Supabase Auth call included).
                        prefetch={false}
                        className="font-medium underline-offset-4 hover:text-primary hover:underline"
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.location}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.open_jobs}
                    </td>
                    <td className="px-4 py-3">
                      <LeadScoreBadge score={row.lead_score} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-pressed={row.starred}
                        aria-label={
                          row.starred ? "Unstar company" : "Star company"
                        }
                        disabled={pendingId === row.company_id}
                        onClick={() => toggleStar(row)}
                      >
                        <Star
                          className={cn(
                            "size-4",
                            row.starred
                              ? "fill-highlight text-highlight"
                              : "text-muted-foreground"
                          )}
                        />
                      </Button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <NotesDialog
                        companyId={row.company_id}
                        companyName={row.name}
                        notes={row.notes}
                        onSaved={(notes) => patchRow(row.company_id, { notes })}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {removed ? (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Restore ${row.name} to your companies`}
                            disabled={pendingId === row.company_id}
                            onClick={() => restoreCompany(row)}
                          >
                            <RotateCcw className="size-4" />
                            Restore
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-foreground"
                            title="Remove from my list (only affects you)"
                            aria-label={`Remove ${row.name} from my list`}
                            disabled={pendingId === row.company_id}
                            onClick={() => hideCompany(row)}
                          >
                            <EyeOff className="size-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          title="Delete permanently (affects all users)"
                          aria-label={`Permanently delete ${row.name} for all users`}
                          disabled={pendingId === row.company_id}
                          onClick={() => setToDelete([row])}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {shown.length < filtered.length && (
        <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-muted-foreground">
          <span>
            Showing {shown.length.toLocaleString("en-GB")} of {filtered.length.toLocaleString("en-GB")}
          </span>
          <Button variant="outline" size="sm" onClick={() => setShownCount((count) => count + ROWS_PER_STEP)}>
            Show {Math.min(ROWS_PER_STEP, filtered.length - shown.length)} more
          </Button>
        </div>
      )}

      {toDelete && (
        <DeleteCompaniesDialog
          companies={toDelete}
          open={toDelete.length > 0}
          onOpenChange={(open) => !open && setToDelete(null)}
          onDeleted={(result) => handleDeleted(result.deletedIds)}
        />
      )}
    </div>
  );
}
