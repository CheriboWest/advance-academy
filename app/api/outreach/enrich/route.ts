import { getProxyAuthToken } from '@/shared/api/proxy-auth'
import { NextResponse } from 'next/server'
import type { EnrichmentRequest, ExperienceLevel } from '@advance-academy/contracts/outreach'
import { enrichOutreachWithBackend } from '@/shared/api/backend-client'
import { HttpClientError } from '@/shared/api/http-client'

const VALID_LEVELS: ExperienceLevel[] = ['senior', 'mid', 'fresher', 'intern']

function isEnrichmentRequest(body: unknown): body is EnrichmentRequest {
  if (typeof body !== 'object' || body === null) return false
  const o = body as Record<string, unknown>
  return (
    typeof o.companyName === 'string' &&
    o.companyName.trim().length > 0 &&
    typeof o.targetRole === 'string' &&
    o.targetRole.trim().length > 0 &&
    typeof o.experienceLevel === 'string' &&
    VALID_LEVELS.includes(o.experienceLevel as ExperienceLevel)
  )
}

export async function POST(request: Request) {
  try {
    const json: unknown = await request.json()
    if (!isEnrichmentRequest(json)) {
      return NextResponse.json(
        { code: 'INVALID_REQUEST', message: 'Request body must include companyName, targetRole, and a valid experienceLevel.' },
        { status: 400 },
      )
    }

    const authToken = getProxyAuthToken(request)
    const response = await enrichOutreachWithBackend(json, authToken)
    return NextResponse.json(response)
  } catch (error) {
    if (error instanceof HttpClientError) {
      return NextResponse.json(error.payload, { status: error.status || 500 })
    }

    return NextResponse.json(
      {
        code: 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : 'Invalid request body.',
      },
      { status: 400 },
    )
  }
}
