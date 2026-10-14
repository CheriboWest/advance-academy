'use client'

import { fetchJson } from '@/shared/api/http-client'
import { getAuthHeaders } from '@/shared/auth/get-auth-headers'
import type {
  BookRestDayResponse,
  GamificationGoals,
  GamificationSummary,
  UpdateGamificationGoalsRequest,
} from '@advance-academy/contracts/gamification'

export async function getGamification(): Promise<GamificationSummary> {
  return fetchJson<GamificationSummary>('/api/gamification', {
    method: 'GET',
    headers: await getAuthHeaders(),
    timeoutMs: 15000,
  })
}

export async function updateGamificationGoals(body: UpdateGamificationGoalsRequest): Promise<{ goals: GamificationGoals }> {
  return fetchJson<{ goals: GamificationGoals }>('/api/gamification/goals', {
    method: 'PATCH',
    headers: await getAuthHeaders(),
    body: JSON.stringify(body),
    timeoutMs: 15000,
  })
}

export async function bookRestDay(day: string): Promise<BookRestDayResponse> {
  return fetchJson<BookRestDayResponse>('/api/gamification/rest-days', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({ day }),
    timeoutMs: 15000,
  })
}

export async function markAchievementsSeen(keys: string[]): Promise<void> {
  await fetchJson<null>('/api/gamification/achievements/seen', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({ keys }),
    timeoutMs: 15000,
  })
}
