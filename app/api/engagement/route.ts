import { NextResponse } from 'next/server'
import { getServerEnv } from '@/shared/env/server'
import { getProxyAuthToken } from '@/shared/api/proxy-auth'

// The email-reminder switch (GET reads it, PATCH sets it). Plain
// pass-through: the backend scopes everything to the signed-in user.

async function forward(request: Request, method: 'GET' | 'PATCH', body?: string) {
  const { backendUrl } = getServerEnv()
  const token = getProxyAuthToken(request)
  try {
    const res = await fetch(`${backendUrl}/api/engagement`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ code: 'ENGAGEMENT_FAILED', message: 'Could not reach the server.' }, { status: 502 })
  }
}

export async function GET(request: Request) {
  return forward(request, 'GET')
}

export async function PATCH(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ code: 'INVALID_REQUEST', message: 'Invalid request body.' }, { status: 400 })
  }
  return forward(request, 'PATCH', JSON.stringify(body))
}
