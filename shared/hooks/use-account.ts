'use client'

import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/shared/api/http-client'
import { getAuthHeaders } from '@/shared/auth/get-auth-headers'
import { useAuth } from '@/features/auth/context/AuthContext'
import type { Tier, UserStatus } from '@advance-academy/contracts/admin'

export interface AccountSummary {
  /** Approval gate. Anything other than 'approved' means every tool route 403s. */
  status: UserStatus
  tier: Tier
  credits: number
  isAdmin: boolean
  /**
   * Coaching sessions left — a quota of its own, not part of the wallet
   * (migration 019). Null for admins, who are never metered, and on any
   * response predating the field.
   */
  coachingCredits?: number | null
}

/**
 * The signed-in user's approval status, tier, wallet balance and admin flag.
 *
 * Used by the header to show the credit pill and to decide whether the Admin
 * link exists. Disabled while signed out so a logged-out visitor never fires a
 * doomed 401. Credits change whenever a tool runs, so the cache is deliberately
 * short-lived rather than held for the session.
 */
export function useAccount() {
  const { session } = useAuth()

  return useQuery({
    queryKey: ['account-me'],
    queryFn: async () =>
      fetchJson<AccountSummary>('/api/account/me', {
        method: 'GET',
        headers: await getAuthHeaders(),
        timeoutMs: 15000,
      }),
    enabled: Boolean(session),
    staleTime: 30_000,
    retry: false,
  })
}
