'use client'

import type { DreamCompanyInput, ProfileAnalysis, TargetRole, RoadmapResponse } from '@/types/dream-company'
import { fetchFormDataJson, fetchJson, HttpClientError } from '@/shared/api/http-client'
import { getAuthHeaders } from '@/shared/auth/get-auth-headers'

export async function getDreamCompanyConfig(): Promise<{ maxRoles: number }> {
  return fetchJson<{ maxRoles: number }>('/api/dream-company/config', {
    method: 'GET',
    headers: await getAuthHeaders(),
    timeoutMs: 10000,
  })
}

// ---- Streaming (SSE) variants (M2.1) --------------------------------------------------
// Consume the backend's SSE stream for each step:
// `onDelta` fires with each text chunk (drive a progress bar), and the promise resolves with
// the final parsed result from the `done` event. See test/dream-company/M2.1-streaming-contract.md.

export interface SSEOptions {
  /** Aborts the in-flight stream when a newer run supersedes this one (see the hook). */
  signal?: AbortSignal
  /**
   * Inactivity watchdog (ms). The backend sends a `: keepalive` heartbeat every 15s, so a
   * healthy stream never trips this; only a genuinely dead connection (no bytes at all for
   * this long) aborts. Bounds "UI stuck on loading forever" without capping a legitimately
   * long roadmap by total duration.
   */
  inactivityMs?: number
}

async function postSSE<T>(
  path: string,
  body: unknown,
  onDelta: (text: string) => void,
  opts?: SSEOptions,
): Promise<T> {
  const inactivityMs = opts?.inactivityMs ?? 60000
  const ac = new AbortController()
  const onExternalAbort = () => ac.abort()
  if (opts?.signal) {
    if (opts.signal.aborted) ac.abort()
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => ac.abort(), inactivityMs)
  }

  try {
    armWatchdog()
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) },
      body: JSON.stringify(body),
      signal: ac.signal,
    })

    // Bad input / auth errors come back as normal JSON (not an event stream) — surface them.
    // HttpClientError rather than a bare Error: its constructor is what routes a 403
    // ACCOUNT_PENDING / ACCOUNT_REJECTED to /pending, and SSE never touches fetchJson.
    // It extends Error, so callers reading `.message` are unaffected.
    if (!res.headers.get('content-type')?.includes('text/event-stream') || !res.body) {
      let message = `Request failed (${res.status})`
      let code = 'HTTP_ERROR'
      try {
        const j = (await res.json()) as { message?: string; error?: string; code?: string }
        message = j.message || j.error || message
        if (j.code) code = j.code
      } catch {
        /* keep default */
      }
      throw new HttpClientError(res.status, { code, message })
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let result: T | undefined
    let streamError: string | undefined

    for (;;) {
      const { value, done } = await reader.read()
      armWatchdog()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const event = frame.match(/^event: (.*)$/m)?.[1]
        const data = frame.match(/^data: (.*)$/m)?.[1]
        if (!event || data == null) continue // skips ": keepalive" comment lines
        if (event === 'delta') {
          try {
            onDelta((JSON.parse(data) as { text?: string }).text ?? '')
          } catch {
            /* ignore malformed delta */
          }
        } else if (event === 'done') {
          result = JSON.parse(data) as T
        } else if (event === 'error') {
          try {
            streamError = (JSON.parse(data) as { message?: string }).message
          } catch {
            streamError = 'The analysis service failed. Please try again.'
          }
        }
      }
    }

    if (streamError) throw new Error(streamError)
    if (result === undefined) throw new Error('The connection ended before the result arrived. Please try again.')
    return result
  } catch (err) {
    // AbortError = superseded by a newer run (caller ignores it via run-id) or the watchdog
    // tripped on a dead stream. Give the latter a readable message.
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('The request timed out or was cancelled. Please try again.')
    }
    throw err
  } finally {
    if (watchdog) clearTimeout(watchdog)
    opts?.signal?.removeEventListener('abort', onExternalAbort)
  }
}

export function analyzeProfileStream(
  profile: DreamCompanyInput,
  onDelta: (text: string) => void,
  opts?: SSEOptions,
): Promise<ProfileAnalysis> {
  return postSSE<ProfileAnalysis>('/api/dream-company/analyze/stream', { profile }, onDelta, opts)
}

export function generateRolesStream(
  profile: DreamCompanyInput,
  analysis: ProfileAnalysis,
  onDelta: (text: string) => void,
  opts?: SSEOptions,
): Promise<TargetRole[]> {
  return postSSE<TargetRole[]>('/api/dream-company/roles/stream', { profile, analysis }, onDelta, opts)
}

export function generateRoadmapStream(
  profile: DreamCompanyInput,
  analysis: ProfileAnalysis,
  selectedRoles: TargetRole[],
  onDelta: (text: string) => void,
  opts?: SSEOptions,
): Promise<RoadmapResponse> {
  return postSSE<RoadmapResponse>(
    '/api/dream-company/roadmap/stream',
    { profile, analysis, selectedRoles },
    onDelta,
    opts,
  )
}

export interface CVParseResponse {
  degree: string
  workExperience: string
  skills: string
  interests: string
  targetSalary: string
  location: string
  currentLevel: 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'manager' | 'director' | 'executive'
  confidence: {
    degree: 'high' | 'medium' | 'low'
    workExperience: 'high' | 'medium' | 'low'
    skills: 'high' | 'medium' | 'low'
    location: 'high' | 'medium' | 'low'
  }
}

export async function parseCV(file: File): Promise<CVParseResponse> {
  const formData = new FormData()
  formData.append('cv', file)

  return fetchFormDataJson<CVParseResponse>('/api/dream-company/parse-cv', formData, {
    timeoutMs: 120000,
    headers: await getAuthHeaders(),
  })
}
