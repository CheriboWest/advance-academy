import type { ApiErrorResponse } from '@advance-academy/contracts'

export class HttpClientError extends Error {
  status: number
  payload: ApiErrorResponse

  constructor(status: number, payload: ApiErrorResponse) {
    super(payload.message)
    this.name = 'HttpClientError'
    this.status = status
    this.payload = payload

    // ponytail: handled in the constructor, not per-feature — every fetch path in the
    // app builds this error, so one guard covers all five tools and anything added later.
    // The backend's 403 is the signal that a session went stale (approved user
    // rejected mid-session, or a cold load that never resolved). Middleware only
    // checks that a session exists; approval lives in Fastify.
    // Codes are literals mirrored from backend/src/lib/user-access.ts — two strings don't
    // justify a @advance-academy/contracts export.
    if (status === 403 && (payload.code === 'ACCOUNT_PENDING' || payload.code === 'ACCOUNT_REJECTED')) {
      redirectToPending()
    }
  }
}

// No redirect loop: /api/account/me is the gate's one exemption (backend/src/main.ts) so it
// never returns these codes, and /pending is excluded below. Guarded on `window` because
// this class is also thrown server-side inside the app/api/* proxy routes.
function redirectToPending() {
  if (typeof window === 'undefined') return
  if (window.location.pathname.startsWith('/pending')) return

  window.location.assign('/pending')
}

interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number
}

function buildDefaultError(status: number, statusText: string): ApiErrorResponse {
  return {
    code: status > 0 ? 'HTTP_ERROR' : 'NETWORK_ERROR',
    message: statusText || 'Request failed.',
  }
}

// Backend routes send their friendly text under either `message` or `error` (e.g. dream-company
// sends `{ error: "Only PDF and DOCX files are supported" }`). Preserve whichever carries the
// text instead of falling back to the bare HTTP statusText ("Bad Request").
function toErrorPayload(parsed: unknown, status: number, statusText: string): ApiErrorResponse {
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>
    const message =
      typeof p.message === 'string' ? p.message : typeof p.error === 'string' ? p.error : undefined
    if (message) {
      return { code: typeof p.code === 'string' ? p.code : buildDefaultError(status, statusText).code, message }
    }
  }
  return buildDefaultError(status, statusText)
}

export async function fetchJson<T>(input: RequestInfo | URL, options: FetchJsonOptions = {}) {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 15000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(input, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
      signal: controller.signal,
    })

    const text = await response.text()
    const parsed = text ? JSON.parse(text) : null

    if (!response.ok) {
      throw new HttpClientError(
        response.status,
        toErrorPayload(parsed, response.status, response.statusText),
      )
    }

    return parsed as T
  } catch (error) {
    if (error instanceof HttpClientError) {
      throw error
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpClientError(504, {
        code: 'TIMEOUT',
        message: 'The request timed out.',
      })
    }

    throw new HttpClientError(0, buildDefaultError(0, error instanceof Error ? error.message : 'Unknown error'))
  } finally {
    clearTimeout(timeout)
  }
}

interface FetchFormDataJsonOptions {
  timeoutMs?: number
  method?: string
  headers?: Record<string, string>
}

export async function fetchFormDataJson<T>(
  input: RequestInfo | URL,
  formData: FormData,
  options: FetchFormDataJsonOptions = {},
) {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 120000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(input, {
      method: options.method ?? 'POST',
      body: formData,
      headers: options.headers,
      signal: controller.signal,
    })

    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      throw new HttpClientError(500, {
        code: 'INVALID_RESPONSE',
        message: 'Invalid JSON response.',
      })
    }

    if (!response.ok) {
      throw new HttpClientError(
        response.status,
        toErrorPayload(parsed, response.status, response.statusText),
      )
    }

    return parsed as T
  } catch (error) {
    if (error instanceof HttpClientError) {
      throw error
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpClientError(504, {
        code: 'TIMEOUT',
        message: 'The request timed out.',
      })
    }

    throw new HttpClientError(0, buildDefaultError(0, error instanceof Error ? error.message : 'Unknown error'))
  } finally {
    clearTimeout(timeout)
  }
}
