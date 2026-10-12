'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listAdminUsers, updateAdminUser } from '../api/frontend-client'
import type { AdminUserPatch, AdminUsersFilters } from '@advance-academy/contracts/admin'

// Filters are part of the query key so switching tier/search caches each
// combination independently — mirrors use-leads.
export function useAdminUsers(filters: AdminUsersFilters) {
  return useQuery({
    queryKey: ['admin-users', filters],
    queryFn: () => listAdminUsers(filters),
    retry: false, // a 403 (not admin) should surface immediately, not retry
  })
}

/**
 * Tier change / credit top-up / admin toggle. Invalidates the whole
 * `admin-users` key on success so every cached filter combination refetches —
 * an upgrade also moves the row between tier filters, so patching one cached
 * list in place would leave the others stale.
 */
export function useUpdateAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, patch }: { userId: string; patch: AdminUserPatch }) =>
      updateAdminUser(userId, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    },
  })
}
