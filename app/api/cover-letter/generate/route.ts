import { NextResponse } from 'next/server'
import { getServerEnv } from '@/shared/env/server'
import { getProxyAuthToken } from '@/shared/api/proxy-auth'

// Cover Letter Generator. Keeps BACKEND_URL server-side and forwards the bearer
// token; the backend validates the body and charges the credit. Status codes
// (400/404/429/503) pass through so the screen can show the backend's message.
// 120s: a thin JD means the backend fetches the posting before it writes.
export async function POST(request: Request) {
  const { backendUrl } = getServerEnv()
  const token = getProxyAuthToken(request)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ code: 'INVALID_REQUEST', message: 'Invalid request body.' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).cvVersionId !== 'string') {
    return NextResponse.json({ code: 'INVALID_REQUEST', message: 'Pick a CV first.' }, { status: 400 })
  }

  try {
    const res = await fetch(`${backendUrl}/api/cover-letter/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch (error) {
    // The backend keeps the whole request inside this deadline (see cover-letter.service.ts);
    // past it, the usual cause is a slow job site.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return NextResponse.json(
        {
          code: 'COVER_LETTER_TIMEOUT',
          message:
            'This took too long, usually because the job page was slow to load. Paste the job description into the Job description box and try again.',
        },
        { status: 504 },
      )
    }
    return NextResponse.json(
      { code: 'COVER_LETTER_FAILED', message: 'Could not reach the cover letter service. Please try again.' },
      { status: 502 },
    )
  }
}
