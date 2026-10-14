import { getSupabaseBrowser } from "@/shared/auth/supabase-browser";
import { CAREERHUB_PROXY } from "@/features/career-hub/lib/api-url";
import { extractErrorDetail } from "@/features/career-hub/lib/contacts-api";

/**
 * Client for the bulk import wizard (backend-python
 * app/routers/contact_imports.py, migration 048). Browser-only: it reads the
 * coach's session from the browser Supabase client, like contacts-api.ts.
 */

export type ImportRole =
  | "company_name"
  | "company_website"
  | "contact"
  | "contact_name"
  | "contact_linkedin_url"
  | "contact_job_title"
  | "phone"
  | "email"
  | "source"
  | "ignore";

export type Classification = "matched" | "new" | "needs_review" | "invalid" | "skipped";
export type ResultStatus = "created" | "updated" | "matched" | "skipped" | "failed" | "rolled_back";
export type BatchStatus = "uploaded" | "previewed" | "committed" | "failed";

export interface RawCell {
  header: string;
  value: unknown;
  text: string;
  type: string;
  hyperlink: string | null;
}

export interface SheetMapping {
  include: boolean;
  group_fill: boolean;
  company_link_is_website: boolean;
  columns: Record<string, ImportRole>;
}

export interface SheetSummary {
  name: string;
  index: number;
  header_row: number;
  headers: Record<string, string>;
  row_count: number;
  blank_rows: number;
  sample: Array<{ row_number: number; cells: Record<string, RawCell> }>;
  suggested_mapping: SheetMapping;
}

export interface ImportSummary {
  status: "committed" | "failed";
  rows?: Partial<Record<ResultStatus | "total", number>>;
  companies?: { created: number; updated: number; matched: number };
  contacts?: { created: number; updated: number; matched: number };
  aliases_created?: number;
  conflicts?: number;
  failed_rows?: number;
  errors?: Array<{ row_id: number; sheet: string; row_number: number; sqlstate: string; error: string }>;
}

export interface ImportBatch {
  id: string;
  created_by: string;
  file_name: string;
  file_kind: "xlsx" | "csv";
  status: BatchStatus;
  sheets: SheetSummary[];
  mapping: Record<string, SheetMapping> | null;
  summary: ImportSummary | null;
  error: string | null;
  created_at: string;
  previewed_at: string | null;
  committed_at: string | null;
  mine: boolean;
}

export type ImportBatchListItem = Pick<
  ImportBatch,
  "id" | "created_by" | "file_name" | "file_kind" | "status" | "summary" | "error" | "created_at" | "previewed_at" | "committed_at" | "mine"
>;

export interface PreviewCounts {
  total: number;
  matched: number;
  new: number;
  needs_review: number;
  invalid: number;
  skipped: number;
}

export interface CompanyCandidate {
  id: string;
  name: string;
  slug: string | null;
  website: string | null;
  reasons: Array<"domain" | "name" | "alias" | "similar_name">;
}

export interface ContactCandidate {
  id: string;
  full_name: string;
  company_id: string;
  company_name: string;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  job_title: string | null;
}

export interface ExtractedContact {
  full_name: string;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  notes: string | null;
}

export interface Extracted {
  excluded?: boolean;
  company?: { name: string | null; slug: string | null; website: string | null; group_row: number | null };
  contact?: ExtractedContact | null;
  contact_error?: string;
  source?: { text: string | null; url: string | null } | null;
  warnings?: string[];
}

export interface CompanyDecision {
  action: "match" | "create" | "skip";
  company_id?: string;
  save_alias?: boolean;
}

export interface ContactDecision {
  action: "match" | "create" | "skip";
  contact_id?: string;
}

export interface RowResolution {
  company?: CompanyDecision;
  contact?: ContactDecision;
}

export interface ImportRow {
  id: number;
  sheet: string;
  sheet_index: number;
  row_number: number;
  raw: Record<string, RawCell>;
  extracted: Extracted | null;
  parse_errors: string[];
  classification: Classification | null;
  company_status: string | null;
  contact_status: string | null;
  company_match: { id?: string; method?: string; pending_row?: number } | null;
  contact_match: { id?: string; method?: string; pending_row?: number } | null;
  company_candidates: CompanyCandidate[];
  contact_candidates: ContactCandidate[];
  reasons: string[];
  source_job_id: string | null;
  resolution: RowResolution | null;
  result_status: ResultStatus | null;
  result: {
    company_id?: string;
    company?: string;
    contact_id?: string | null;
    contact?: string | null;
    conflicts?: Array<{ record: string; field: string; existing: string; incoming: string }>;
    reason?: string;
  } | null;
  error: string | null;
}

export interface CompanySearchResult {
  id: string;
  name: string;
  slug: string | null;
  website: string | null;
  website_url: string | null;
}

async function authFetch<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const {
    data: { session },
  } = await getSupabaseBrowser().auth.getSession();
  if (!session) throw new Error("You must be signed in to import contacts.");

  const { json, ...rest } = init;
  const response = await fetch(`${CAREERHUB_PROXY}${path}`, {
    ...rest,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${session.access_token}`,
      ...(rest.headers ?? {}),
    },
  });
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      detail = extractErrorDetail(await response.json()) ?? detail;
    } catch {
      // Non-JSON error body: keep the default message.
    }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The file goes up as the raw request body (no multipart parser on the API). */
export function uploadImportFile(file: File) {
  return authFetch<{ batch: ImportBatch; previous_imports_of_this_file: Array<{ id: string; file_name: string; status: BatchStatus; created_at: string }> }>(
    `/contacts/imports?filename=${encodeURIComponent(file.name)}`,
    { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } }
  );
}

export function listImports() {
  return authFetch<ImportBatchListItem[]>("/contacts/imports", { method: "GET" });
}

export function getImport(batchId: string) {
  return authFetch<{ batch: ImportBatch; counts: PreviewCounts }>(`/contacts/imports/${batchId}`, { method: "GET" });
}

export function listImportRows(
  batchId: string,
  opts: { classification?: Classification; resultStatus?: ResultStatus; limit?: number; offset?: number } = {}
) {
  const params = new URLSearchParams();
  if (opts.classification) params.set("classification", opts.classification);
  if (opts.resultStatus) params.set("result_status", opts.resultStatus);
  params.set("limit", String(opts.limit ?? 100));
  params.set("offset", String(opts.offset ?? 0));
  return authFetch<{ rows: ImportRow[]; total: number; limit: number; offset: number }>(
    `/contacts/imports/${batchId}/rows?${params}`,
    { method: "GET" }
  );
}

export function applyImportMapping(batchId: string, sheets: Record<string, SheetMapping>) {
  return authFetch<{ preview: PreviewCounts }>(`/contacts/imports/${batchId}/mapping`, {
    method: "POST",
    json: { sheets },
  });
}

export function resolveImportRows(
  batchId: string,
  resolutions: Array<{ row_id: number; clear?: boolean } & RowResolution>
) {
  return authFetch<{ preview: PreviewCounts }>(`/contacts/imports/${batchId}/resolutions`, {
    method: "POST",
    json: { resolutions },
  });
}

export function commitImport(batchId: string) {
  return authFetch<{ summary: ImportSummary }>(`/contacts/imports/${batchId}/commit`, { method: "POST" });
}

export function searchCompaniesForImport(q: string) {
  return authFetch<CompanySearchResult[]>(`/contacts/imports/company-search?q=${encodeURIComponent(q)}`, { method: "GET" });
}
