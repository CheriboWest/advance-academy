'use client'

import { useQuery } from '@tanstack/react-query'
import { listToolResults, getToolResult } from '../api/frontend-client'
import type { ToolResultsFilters } from '@advance-academy/contracts/tool-results'

export function useToolResults(filters: ToolResultsFilters = {}) {
  return useQuery({
    queryKey: ['tool-results', filters],
    queryFn: () => listToolResults(filters),
    retry: false,
  })
}

/**
 * One stored run, fetched only once the user opens it — the list deliberately
 * omits the payload, which for a Dream Company roadmap is the bulk of the row.
 *
 * Stored results never change, so once loaded they stay fresh for the session.
 */
export function useToolResult(id: string | null) {
  return useQuery({
    queryKey: ['tool-result', id],
    queryFn: () => getToolResult(id!),
    enabled: Boolean(id),
    staleTime: Infinity,
    retry: false,
  })
}
