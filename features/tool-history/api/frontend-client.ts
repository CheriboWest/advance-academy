'use client'

import { fetchJson } from '@/shared/api/http-client'
import { getAuthHeaders } from '@/shared/auth/get-auth-headers'
import type {
  ToolResultDetailResponse,
  ToolResultsFilters,
  ToolResultsListResponse,
} from '@advance-academy/contracts/tool-results'

// Tool run history (sprint F5). Calls the Next.js proxy, which forwards the
// Supabase bearer token; the backend scopes every row to the signed-in user.
export async function listToolResults(
  filters: ToolResultsFilters = {},
): Promise<ToolResultsListResponse> {
  const qs = new URLSearchParams()
  if (filters.tool) qs.set('tool', filters.tool)
  if (filters.limit) qs.set('limit', String(filters.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''

  return fetchJson<ToolResultsListResponse>(`/api/tool-results${suffix}`, {
    method: 'GET',
    headers: await getAuthHeaders(),
    timeoutMs: 15000,
  })
}

export async function getToolResult(id: string): Promise<ToolResultDetailResponse> {
  return fetchJson<ToolResultDetailResponse>(`/api/tool-results/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: await getAuthHeaders(),
    timeoutMs: 15000,
  })
}
