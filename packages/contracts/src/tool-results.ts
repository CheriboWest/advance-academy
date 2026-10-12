// Tool run history (sprint F5).
// The shapes GET /api/tool-results sends; the backend imports these too.

export type ToolName = 'cv' | 'dream' | 'interview' | 'coaching' | 'cover_letter'

export interface ToolResultSummary {
  id: string
  tool: ToolName
  /** Short label, e.g. "Data Analyst · London". */
  input_summary: string | null
  created_at: string
}

export interface ToolResultDetail extends ToolResultSummary {
  /** The tool's stored output. Shape depends on `tool`. */
  result: unknown
  /** What was fed in. Null on rows written before migration 018. */
  input_json?: unknown
  /** `cv_versions` row this run was based on, when there was one. */
  cv_version_id?: string | null
}

export interface ToolResultsListResponse {
  results: ToolResultSummary[]
  count: number
}

export interface ToolResultDetailResponse {
  result: ToolResultDetail
}

export interface ToolResultsFilters {
  tool?: string
  limit?: number
}

export const TOOL_LABELS: Record<ToolName, string> = {
  cv: 'CV Optimiser',
  dream: 'Dream Company',
  interview: 'Interview Lab',
  coaching: 'Coaching',
  cover_letter: 'Cover Letter',
}
