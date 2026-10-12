'use client'

import { fetchJson } from '@/shared/api/http-client'
import { getAuthHeaders } from '@/shared/auth/get-auth-headers'
import type {
  CoachingPack,
  CoachingSession,
  CoachingSessionSummary,
  ContextReport,
  CreateCoachingSessionRequest,
  SaveSessionNotesRequest,
  StudentContextInventory,
  UpdateCoachingPackRequest,
  UpdateCoachingSessionRequest,
} from '@advance-academy/contracts/coaching'

// Coaching booking (ticket T2). Calls the Next.js proxy, which forwards the
// Supabase bearer token; the backend scopes everything to the signed-in user.

export interface CoachingContextResponse {
  inventory: StudentContextInventory
  readiness: ContextReport
}

export async function getCoachingContext(studentId?: string): Promise<CoachingContextResponse> {
  const suffix = studentId ? `?studentId=${encodeURIComponent(studentId)}` : ''
  return fetchJson<CoachingContextResponse>(`/api/coaching/context${suffix}`, {
    method: 'GET',
    headers: await getAuthHeaders(),
    timeoutMs: 15000,
  })
}

export async function createCoachingSession(
  body: CreateCoachingSessionRequest,
): Promise<{ session: CoachingSession }> {
  return fetchJson<{ session: CoachingSession }>('/api/coaching/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) },
    body: JSON.stringify(body),
    timeoutMs: 20000,
  })
}

export async function listCoachingSessions(scope?: 'all'): Promise<{
  sessions: CoachingSessionSummary[]
  count: number
}> {
  const suffix = scope === 'all' ? '?scope=all' : ''
  return fetchJson<{ sessions: CoachingSessionSummary[]; count: number }>(
    `/api/coaching/sessions${suffix}`,
    { method: 'GET', headers: await getAuthHeaders(), timeoutMs: 15000 },
  )
}

// ── Coach workspace (ticket T5) ─────────────────────────────────────────────

export async function getCoachingSessionDetail(id: string): Promise<{ session: CoachingSession }> {
  return fetchJson<{ session: CoachingSession }>(
    `/api/coaching/sessions/${encodeURIComponent(id)}`,
    { method: 'GET', headers: await getAuthHeaders(), timeoutMs: 15000 },
  )
}

export async function updateCoachingSession(
  id: string,
  body: UpdateCoachingSessionRequest,
): Promise<{ session: CoachingSession }> {
  return fetchJson<{ session: CoachingSession }>(
    `/api/coaching/sessions/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) },
      body: JSON.stringify(body),
      timeoutMs: 20000,
    },
  )
}

export async function updateCoachingPack(
  id: string,
  body: UpdateCoachingPackRequest,
): Promise<{ pack: CoachingPack }> {
  return fetchJson<{ pack: CoachingPack }>(
    `/api/coaching/sessions/${encodeURIComponent(id)}/pack`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) },
      body: JSON.stringify(body),
      timeoutMs: 20000,
    },
  )
}

export async function saveSessionNotes(
  id: string,
  body: SaveSessionNotesRequest,
): Promise<{ session: CoachingSession }> {
  return fetchJson<{ session: CoachingSession }>(
    `/api/coaching/sessions/${encodeURIComponent(id)}/notes`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) },
      body: JSON.stringify(body),
      timeoutMs: 20000,
    },
  )
}

export interface PracticeRun {
  id: string
  label: string | null
  createdAt: string
  report: unknown
}

export async function listSessionPractice(
  sessionId: string,
): Promise<{ runs: PracticeRun[]; count: number }> {
  return fetchJson<{ runs: PracticeRun[]; count: number }>(
    `/api/coaching/sessions/${encodeURIComponent(sessionId)}/practice`,
    { method: 'GET', headers: await getAuthHeaders(), timeoutMs: 15000 },
  )
}

export type CoachingAction = 'generate' | 'approve' | 'reopen' | 'regenerate-question'

/** One entry point for the coach's verbs — see app/api/coaching/.../actions. */
export async function runCoachingAction<T>(
  id: string,
  action: CoachingAction,
  payload: Record<string, unknown> = {},
): Promise<T> {
  return fetchJson<T>(`/api/coaching/sessions/${encodeURIComponent(id)}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) },
    body: JSON.stringify({ action, ...payload }),
    // Rewriting a question runs an LLM call; the others return immediately.
    timeoutMs: action === 'regenerate-question' ? 90000 : 20000,
  })
}
