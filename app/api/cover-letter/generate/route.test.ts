// The proxy must hand the backend's status and message to the screen as-is —
// the student needs "the writing service turned the request down…", not a
// generic "Could not write the cover letter".
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/shared/env/server', () => ({ getServerEnv: () => ({ backendUrl: 'http://backend.test' }) }))
vi.mock('@/shared/api/proxy-auth', () => ({ getProxyAuthToken: () => 'token-123' }))

import { POST } from './route'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const CV_ID = '11111111-1111-1111-1111-111111111111'
const pastedJdRequest = () =>
  new Request('http://app.test/api/cover-letter/generate', {
    method: 'POST',
    body: JSON.stringify({ cvVersionId: CV_ID, jobTitle: 'Data Analyst', jobDescription: 'Responsibilities: … '.repeat(30) }),
  })

describe('POST /api/cover-letter/generate (proxy)', () => {
  it('forwards the pasted JD and passes a specific backend error through unchanged', async () => {
    const backendBody = {
      code: 'LLM_REJECTED',
      message: 'The writing service turned the request down. This is a problem on our side, not with your CV or job description — no credit was used. Please try again later.',
    }
    const fetchMock = vi.fn(async () => Response.json(backendBody, { status: 502 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await POST(pastedJdRequest())
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual(backendBody)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://backend.test/api/cover-letter/generate')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123')
    expect(JSON.parse(String(init.body)).jobDescription).toMatch(/^Responsibilities/)
  })

  it('passes a save failure through too', async () => {
    const backendBody = { code: 'COVER_LETTER_SAVE_FAILED', message: "Your letter was written but couldn't be saved, so no credit was used." }
    globalThis.fetch = vi.fn(async () => Response.json(backendBody, { status: 500 })) as unknown as typeof fetch
    const res = await POST(pastedJdRequest())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual(backendBody)
  })
})
