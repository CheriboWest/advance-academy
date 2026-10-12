'use client'

import { useQuery } from '@tanstack/react-query'
import { listLeads } from '../api/frontend-client'
import type { LeadsFilters } from '@advance-academy/contracts/leads'

// Filters are part of the query key so switching source/status refetches and caches
// each combination independently.
export function useLeads(filters: LeadsFilters) {
  return useQuery({
    queryKey: ['admin-leads', filters],
    queryFn: () => listLeads(filters),
    retry: false, // a 403 (not admin) should surface immediately, not retry
  })
}
