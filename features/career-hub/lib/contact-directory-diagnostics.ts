/**
 * TEMPORARY — the 37-vs-148 Contact Directory investigation. Remove this file,
 * the panel component, CONTACTS_DEBUG_PANEL and the `diagnostics` field on
 * ContactDirectoryResult once it is resolved.
 *
 * Everything here is a count, a status or a yes/no. No contact field (name,
 * email, phone, company, notes) and no part of the response body may end up in
 * these objects: the panel renders them as-is. The flag that shows the panel
 * is contactsDebugPanelEnabled() in shared/env/server.ts.
 *
 * Pure (no server imports) so the client panel and the tests can use it too.
 */

/** The contact the investigation tracks (Headstar's one contact). An id, not
 *  personal data; the panel only says whether it is present. */
export const DIAGNOSTIC_CONTACT_ID = "048355b3-7954-4545-a5c3-cac69c39d093";

export type ContactDirectoryDiagnostics = {
  /** When the server made the request (catches a cached/stale render). */
  fetchedAt: string;
  durationMs: number;
  request: "ok" | "failed";
  /** HTTP status from backend-python, or null when no response came back. */
  httpStatus: number | null;
  /** Why it failed before/without an HTTP error: unconfigured | no_session | network | http. */
  failureReason: string | null;
  /** The same message the page already shows on failure. */
  error: string | null;
  /** False if the body was not a JSON array (the directory would misbehave). */
  responseIsArray: boolean | null;
  returnedCount: number | null;
  uniqueIdCount: number | null;
  withoutCompanyCount: number | null;
  targetContactPresent: boolean | null;
};

type DirectoryRequest =
  | { ok: true; status: number; rows: unknown }
  | { ok: false; reason: string; status?: number };

export function summarizeDirectoryRequest(
  result: DirectoryRequest,
  error: string | null,
  durationMs: number,
  now: Date = new Date()
): ContactDirectoryDiagnostics {
  const base = { fetchedAt: now.toISOString(), durationMs };
  if (!result.ok) {
    return {
      ...base,
      request: "failed",
      httpStatus: result.reason === "http" ? (result.status ?? null) : null,
      failureReason: result.reason,
      error,
      responseIsArray: null,
      returnedCount: null,
      uniqueIdCount: null,
      withoutCompanyCount: null,
      targetContactPresent: null,
    };
  }

  const rows = Array.isArray(result.rows) ? (result.rows as Array<{ id?: unknown; company?: unknown }>) : null;
  return {
    ...base,
    request: "ok",
    httpStatus: result.status,
    failureReason: null,
    error: null,
    responseIsArray: rows !== null,
    returnedCount: rows?.length ?? null,
    uniqueIdCount: rows ? new Set(rows.map((row) => row?.id)).size : null,
    withoutCompanyCount: rows ? rows.filter((row) => !row?.company).length : null,
    targetContactPresent: rows ? rows.some((row) => row?.id === DIAGNOSTIC_CONTACT_ID) : null,
  };
}

/** What the browser-side filter did, measured inside ContactDirectory. The
 *  search text itself is never included — only its length. */
export type ContactDirectoryFilterDiagnostics = {
  beforeFilter: number;
  afterFilter: number;
  category: string;
  queryLength: number;
  targetContactInView: boolean;
};
