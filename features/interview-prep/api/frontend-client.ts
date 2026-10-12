// Interview Prep endpoints. Each returns the raw Response: the hook and screens
// read their own error bodies (429 messages, coaching-pack errors) as before.
// CV Library calls used by the coach panel live in features/cv-library/api.
import { authedFetch } from '@/shared/auth/authed-fetch'

const postJson = (path: string, body: unknown) =>
  authedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

/** `action: 'start' | 'message'` — one route serves both (rate limit applies to start only). */
export const postInterview = (body: unknown) => postJson('/api/interview', body)
export const evaluateInterview = (body: unknown) => postJson('/api/evaluate', body)
export const requestCoachAnswerPreview = (body: unknown) => postJson('/api/interview/coach-answer/preview', body)
export const requestCoachAnswerGenerate = (body: unknown) => postJson('/api/interview/coach-answer/generate', body)
export const transcribeInterviewAudio = (form: FormData) =>
  authedFetch('/api/interview/transcribe', { method: 'POST', body: form })

/** `query` is the already-built `?cursor=…` suffix, or ''. */
export const listInterviewSessions = (query: string) => authedFetch(`/api/interview/sessions${query}`)
export const getInterviewSession = (id: string) => authedFetch(`/api/interview/sessions/${id}`)

export const extractJobFromUrl = (body: { url: string }) => postJson('/api/interview-prep/extract-job-from-url', body)
export const getCoachingMockContext = (coachingSessionId: string) =>
  authedFetch(`/api/coaching/sessions/${encodeURIComponent(coachingSessionId)}/mock`)
