import { getProxyAuthToken } from '@/shared/api/proxy-auth'
import { NextResponse } from 'next/server'
import type { OutreachRequest } from '@advance-academy/contracts/outreach'
import { generateOutreachWithBackend } from '@/shared/api/backend-client'
import { HttpClientError } from '@/shared/api/http-client'

function isOutreachRequest(body: unknown): body is OutreachRequest {
  if (typeof body !== 'object' || body === null) return false
  const o = body as Record<string, unknown>
  if (
    typeof o.intent !== 'string' ||
    typeof o.cvText !== 'string' ||
    typeof o.targetCompany !== 'string' ||
    typeof o.targetRole !== 'string' ||
    typeof o.experienceLevel !== 'string'
  ) {
    return false
  }
  const outputs = o.outputs as { email?: unknown; linkedIn?: unknown } | undefined
  if (
    !outputs ||
    typeof outputs.email !== 'boolean' ||
    typeof outputs.linkedIn !== 'boolean'
  ) {
    return false
  }
  if (!outputs.email && !outputs.linkedIn) {
    return false
  }
  return true
}

export async function POST(request: Request) {
  try {
    const json: unknown = await request.json()
    if (!isOutreachRequest(json)) {
      return NextResponse.json(
        { code: 'INVALID_REQUEST', message: 'Request body must match outreach payload shape.' },
        { status: 400 },
      )
    }

    const authToken = getProxyAuthToken(request)
    const response = await generateOutreachWithBackend(json, authToken)
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
