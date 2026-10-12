'use client'

import { fetchJson } from '@/shared/api/http-client'
import { getAuthHeaders } from '@/shared/auth/get-auth-headers'
import type { AdminPersonProfile } from '@advance-academy/contracts/admin-person'
import type { LeadsFilters, LeadsListResponse } from '@advance-academy/contracts/leads'
import type {
  AdminUserPatch,
  AdminUserPatchResponse,
  AdminUsersFilters,
  AdminUsersListResponse,
} from '@advance-academy/contracts/admin'

// Admin lead list (CA-001, Bước 6). Calls the Next.js proxy, which forwards the
// Supabase bearer token to the backend. Backend enforces the ADMIN_USER_IDS gate.
export async function listLeads(filters: LeadsFilters = {}): Promise<LeadsListResponse> {
  const qs = new URLSearchParams()
  if (filters.status) qs.set('status', filters.status)
  if (filters.source) qs.set('source', filters.source)
  if (filters.utmSource) qs.set('utm_source', filters.utmSource)
  if (filters.limit) qs.set('limit', String(filters.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''

  return fetchJson<LeadsListResponse>(`/api/leads${suffix}`, {
    method: 'GET',
    headers: await getAuthHeaders(),
    timeoutMs: 15000,
  })
}

// Admin user management (sprint F4). Same proxy pattern as listLeads; the
// backend rejects non-admins with 403.
export async function listAdminUsers(
  filters: AdminUsersFilters = {},
): Promise<AdminUsersListResponse> {
  const qs = new URLSearchParams()
  if (filters.search) qs.set('search', filters.search)
  if (filters.tier) qs.set('tier', filters.tier)
  if (filters.status) qs.set('status', filters.status)
  if (filters.limit) qs.set('limit', String(filters.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''

  return fetchJson<AdminUsersListResponse>(`/api/admin/users${suffix}`, {
    method: 'GET',
    headers: await getAuthHeaders(),
    timeoutMs: 15000,
  })
}

// One person's full profile for the drawer. `id` is whichever id the row that
// was clicked holds — a user id from /admin/users, a lead id from /admin/leads.
export async function getAdminPerson(id: string): Promise<{ person: AdminPersonProfile }> {
  return fetchJson<{ person: AdminPersonProfile }>(
    `/api/admin/people/${encodeURIComponent(id)}`,
    { method: 'GET', headers: await getAuthHeaders(), timeoutMs: 15000 },
  )
}

export async function updateAdminUser(
  userId: string,
  patch: AdminUserPatch,
): Promise<AdminUserPatchResponse> {
  return fetchJson<AdminUserPatchResponse>(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    headers: await getAuthHeaders(),
    timeoutMs: 15000,
  })
}
