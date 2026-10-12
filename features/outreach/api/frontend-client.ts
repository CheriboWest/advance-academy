import { fetchJson, HttpClientError } from '@/shared/api/http-client'
import { getAuthHeaders } from '@/shared/auth/get-auth-headers'
import type {
  EnrichmentRequest,
  EnrichmentResponse,
  JdValidationResult,
  OutreachRequest,
  OutreachResult,
} from '@advance-academy/contracts/outreach'

export async function submitOutreachGeneration(request: OutreachRequest): Promise<OutreachResult> {
  return fetchJson<OutreachResult>('/api/outreach/generate', {
    method: 'POST',
    body: JSON.stringify(request),
    headers: await getAuthHeaders(),
    timeoutMs: 100000,
  })
}

export async function submitOutreachEnrichment(request: EnrichmentRequest): Promise<EnrichmentResponse> {
  return fetchJson<EnrichmentResponse>('/api/outreach/enrich', {
    method: 'POST',
    body: JSON.stringify(request),
    headers: await getAuthHeaders(),
    timeoutMs: 90000,
  })
}

export async function validateJdUrl(url: string): Promise<JdValidationResult> {
  return fetchJson<JdValidationResult>('/api/outreach/validate-jd', {
    method: 'POST',
    body: JSON.stringify({ url }),
    headers: await getAuthHeaders(),
    // Jina alone can take ~48s (3 attempts × 15s + backoff) before the LLM check runs.
    timeoutMs: 70000,
  })
}

export async function extractOutreachSource(source: File | string): Promise<{ text: string }> {
  const authHeaders = await getAuthHeaders()

  if (source instanceof File) {
    const formData = new FormData()
    formData.append('file', source)

    const res = await fetch('/api/outreach/extract', {
      method: 'POST',
      body: formData,
      headers: authHeaders,
    })

    // HttpClientError, not Error: the constructor routes a 403 ACCOUNT_PENDING /
    // ACCOUNT_REJECTED to /pending. This branch is raw fetch (multipart), so it
    // never passes through fetchJson's own handling.
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}))
      throw new HttpClientError(res.status, {
        code: errorData.code ?? 'EXTRACT_FAILED',
        message: errorData.message || errorData.error || 'Failed to extract text from file',
      })
    }

    return res.json()
  } else {
    return fetchJson<{ text: string }>('/api/outreach/extract', {
      method: 'POST',
      body: JSON.stringify({ url: source }),
      headers: authHeaders,
      timeoutMs: 70000,
    })
  }
}
