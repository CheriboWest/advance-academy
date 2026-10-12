import { NextResponse } from 'next/server'
import { getServerEnv } from '@/shared/env/server'
import { getProxyAuthToken } from '@/shared/api/proxy-auth'

// Shared pass-through for /api/gamification/*. The backend scopes everything
// to the signed-in user and answers 404 for all but the summary while
// GAMIFICATION_V2_ENABLED is off.

export async function forwardGamification(
  request: Request,
  path: string,
  method: 'GET' | 'PATCH' | 'POST',
  body?: unknown,
) {
  const { backendUrl } = getServerEnv()
  const token = getProxyAuthToken(request)
  try {
    const res = await fetch(`${backendUrl}/api/gamification${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
    if (res.status === 204) return new NextResponse(null, { status: 204 })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ code: 'GAMIFICATION_FAILED', message: 'Could not reach the server.' }, { status: 502 })
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function invalid(message: string) {
  return NextResponse.json({ code: 'INVALID_REQUEST', message }, { status: 400 })
}
