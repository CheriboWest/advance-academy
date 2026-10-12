# Adding a New Feature — End-to-End Walkthrough

This guide takes you from an empty branch to a working new feature reachable at `http://localhost:3000/?view=job-tracker`, by mirroring the Dream Company and Outreach patterns.

## Example feature: Job Tracker

**What it does:** the user pastes a job description. The backend calls Claude once and returns a structured analysis: title, seniority, must-have skills, nice-to-haves, red flags.

**Why this example:** it exercises every layer (types → prompt → service → route → proxy → frontend client → hook → screen → nav) without exotic patterns. No polling, no file upload, no multi-step pipeline. Once you've done this, swapping in multipart or multi-step is straightforward.

## Prerequisites

- Dev environment running (`npm run dev:all`).
- You've read [ARCHITECTURE.md](./ARCHITECTURE.md), [BACKEND.md](./BACKEND.md), and [FRONTEND.md](./FRONTEND.md).
- Create a feature branch: `git checkout -b feat/job-tracker`.

---

## Part 1 — Backend

### Step 1: Define the types

**Create `backend/src/types/job-tracker.ts`:**

```ts
export interface JobTrackerInput {
  jobDescription: string
}

export interface JobTrackerResult {
  title: string
  seniority: 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'principal'
  mustHaveSkills: string[]
  niceToHaveSkills: string[]
  redFlags: string[]
  summary: string
}
```

### Step 2: Write the prompt

**Create `backend/src/lib/job-tracker/prompts.ts`:**

```ts
export const JOB_TRACKER_SYSTEM_PROMPT = `You are a career coach analyzing job descriptions.

Given a job description, return a strict JSON object with these fields:
- title: the role title
- seniority: one of "intern" | "junior" | "mid" | "senior" | "lead" | "principal"
- mustHaveSkills: array of strings (required skills/technologies)
- niceToHaveSkills: array of strings (preferred but not required)
- redFlags: array of strings (concerning aspects like vague requirements, unrealistic scope, unpaid overtime hints)
- summary: 2-3 sentence plain-English summary

Return ONLY the JSON object, no prose, no markdown, no code fences.`
```

### Step 3: Write the service

**Create `backend/src/services/job-tracker.service.ts`:**

```ts
import { assertLlmConfigured, createAnthropicClient, getFeatureModel } from '../lib/llm-anthropic.js'
import { JOB_TRACKER_SYSTEM_PROMPT } from '../lib/job-tracker/prompts.js'
import type { JobTrackerInput, JobTrackerResult } from '../types/job-tracker.js'

export async function analyzeJob(input: JobTrackerInput): Promise<JobTrackerResult> {
  if (!input?.jobDescription?.trim()) {
    const error = new Error('jobDescription is required') as Error & { statusCode: number }
    error.statusCode = 400
    throw error
  }

  assertLlmConfigured('jobTracker') // 503 when LLM_API_KEY is missing
  const response = await createAnthropicClient('jobTracker').messages.create({
    model: getFeatureModel('jobTracker'),
    max_tokens: 2048,
    system: JOB_TRACKER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: input.jobDescription }],
  })

  const block = response.content[0]
  if (block?.type !== 'text') {
    throw Object.assign(new Error('LLM returned no text'), { statusCode: 502 })
  }
  return JSON.parse(block.text) as JobTrackerResult
}
```

### Step 4: Add the feature to the LLM config

**Edit `backend/src/config/llm.ts`** to register the `jobTracker` feature key and read `LLM_MODEL_JOB_TRACKER` from env (fall back to `LLM_MODEL_DEFAULT`). Follow the exact shape of the existing `cvOptimizer`, `dreamCompany`, and `outreach` entries.

### Step 5: Write the route

**Create `backend/src/routes/job-tracker.ts`:**

```ts
import type { FastifyInstance } from 'fastify'
import { analyzeJob } from '../services/job-tracker.service.js'
import type { JobTrackerInput } from '../types/job-tracker.js'

function anthropicHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const s = Number((error as { status?: number }).status)
    return Number.isFinite(s) ? s : undefined
  }
  return undefined
}

export async function registerJobTrackerRoutes(app: FastifyInstance) {
  app.post<{ Body: JobTrackerInput }>(
    '/api/job-tracker/analyze',
    async (request, reply) => {
      try {
        return await analyzeJob(request.body)
      } catch (error) {
        const statusCode =
          error && typeof error === 'object' && 'statusCode' in error
            ? Number((error as { statusCode?: number }).statusCode)
            : undefined

        if (statusCode === 400) {
          return reply.code(400).send({
            error: error instanceof Error ? error.message : 'Bad request',
          })
        }
        if (statusCode === 503) {
          return reply.code(503).send({
            error:
              error instanceof Error
                ? error.message
                : 'LLM is not configured (set LLM_API_KEY in backend/.env).',
          })
        }

        const http = anthropicHttpStatus(error)
        if (http === 401) {
          return reply.code(401).send({
            error: 'Anthropic API rejected the key (401). Check LLM_API_KEY in backend/.env.',
          })
        }
        if (http === 404) {
          return reply.code(502).send({
            error:
              'Anthropic returned 404 for the configured model. Set LLM_MODEL_JOB_TRACKER to a model your account can use.',
          })
        }

        request.log.error(error)
        return reply.code(500).send({ error: 'Internal server error' })
      }
    },
  )
}
```

Notice how the error-mapping block is copied verbatim from `backend/src/routes/dream-company.ts`. **Always copy, do not reinvent.**

### Step 6: Register the route

**Edit `backend/src/main.ts`** to import and call your new registration function:

```ts
import { registerJobTrackerRoutes } from './routes/job-tracker.js'

// inside bootstrap(), after the other route registrations:
await registerJobTrackerRoutes(app)
```

### Step 7: Update the env example

**Edit `backend/.env.example`** to add:

```
LLM_MODEL_JOB_TRACKER=claude-sonnet-4-20250514
```

### Step 8: Smoke-test the backend in isolation

Restart `npm run dev:backend` and hit the endpoint with curl:

```bash
curl -X POST http://localhost:4000/api/job-tracker/analyze \
  -H "Content-Type: application/json" \
  -d '{"jobDescription":"Senior React engineer with 5+ years experience. Must know TypeScript, Next.js, and Tailwind. Nice to have: GraphQL, testing. Competitive salary."}'
```

Expected: a JSON object matching `JobTrackerResult`. If you get a `503`, check `backend/.env`. If you get a parse error, log the raw LLM response and tighten the prompt.

---

## Part 2 — Frontend

### Step 9: Mirror the types (or import from contracts)

**Create `types/job-tracker.ts`** at the repo root:

```ts
export interface JobTrackerInput {
  jobDescription: string
}

export interface JobTrackerResult {
  title: string
  seniority: 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'principal'
  mustHaveSkills: string[]
  niceToHaveSkills: string[]
  redFlags: string[]
  summary: string
}
```

*(If you want these types to live in `packages/contracts` so backend and frontend stay in sync automatically, add them there and import from `@advance-academy/contracts` in both places.)*

### Step 10: Write the backend-client wrapper

**Edit `shared/api/backend-client.ts`** and add:

```ts
import type { JobTrackerInput, JobTrackerResult } from '@/types/job-tracker'

export function analyzeJobWithBackend(payload: JobTrackerInput) {
  const { backendUrl } = getServerEnv()
  return fetchJson<JobTrackerResult>(`${backendUrl}/api/job-tracker/analyze`, {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  })
}
```

### Step 11: Write the Next.js proxy route

**Create `app/api/job-tracker/analyze/route.ts`:**

```ts
import { NextResponse } from 'next/server'
import type { JobTrackerInput } from '@/types/job-tracker'
import { analyzeJobWithBackend } from '@/shared/api/backend-client'
import { HttpClientError } from '@/shared/api/http-client'

function isJobTrackerInput(body: unknown): body is JobTrackerInput {
  return (
    typeof body === 'object' &&
    body !== null &&
    'jobDescription' in body &&
    typeof (body as { jobDescription: unknown }).jobDescription === 'string'
  )
}

export async function POST(request: Request) {
  try {
    const json: unknown = await request.json()
    if (!isJobTrackerInput(json)) {
      return NextResponse.json(
        { code: 'INVALID_REQUEST', message: 'Request body must include a jobDescription string.' },
        { status: 400 },
      )
    }

    const response = await analyzeJobWithBackend(json)
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
```

Again, copied from `app/api/outreach/generate/route.ts`. Same shape, different names.

### Step 12: Write the frontend client

**Create `features/job-tracker/api/frontend-client.ts`:**

```ts
'use client'

import type { JobTrackerInput, JobTrackerResult } from '@/types/job-tracker'
import { fetchJson } from '@/shared/api/http-client'

export async function analyzeJob(input: JobTrackerInput): Promise<JobTrackerResult> {
  return fetchJson<JobTrackerResult>('/api/job-tracker/analyze', {
    method: 'POST',
    body: JSON.stringify(input),
    timeoutMs: 60000,
  })
}
```

### Step 13: Write the hook

**Create `features/job-tracker/hooks/use-job-tracker.ts`:**

```ts
'use client'

import { useCallback, useState } from 'react'
import type { JobTrackerInput, JobTrackerResult } from '@/types/job-tracker'
import { analyzeJob } from '@/features/job-tracker/api/frontend-client'

export function useJobTracker() {
  const [result, setResult] = useState<JobTrackerResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const analyze = useCallback(async (input: JobTrackerInput) => {
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const data = await analyzeJob(input)
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred')
    } finally {
      setLoading(false)
    }
  }, [])

  const reset = useCallback(() => {
    setResult(null)
    setLoading(false)
    setError(null)
  }, [])

  return { result, loading, error, analyze, reset }
}
```

### Step 14: Write the screen

**Create `features/job-tracker/components/job-tracker-screen.tsx`:**

```tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { useJobTracker } from '@/features/job-tracker/hooks/use-job-tracker'

const schema = z.object({
  jobDescription: z.string().min(50, 'Paste a full job description (at least 50 characters).'),
})

type FormValues = z.infer<typeof schema>

export function JobTrackerScreen() {
  const { result, loading, error, analyze, reset } = useJobTracker()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { jobDescription: '' },
  })

  const onSubmit = form.handleSubmit((values) => analyze(values))

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Job Tracker</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <Textarea
              placeholder="Paste the job description here..."
              rows={10}
              {...form.register('jobDescription')}
            />
            {form.formState.errors.jobDescription && (
              <p className="text-sm text-red-500">
                {form.formState.errors.jobDescription.message}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={loading}>
                {loading ? 'Analyzing…' : 'Analyze'}
              </Button>
              {result && (
                <Button type="button" variant="ghost" onClick={reset}>
                  Reset
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-red-500">
          <CardContent className="pt-6 text-red-600">{error}</CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>{result.title}</CardTitle>
            <p className="text-sm text-muted-foreground capitalize">{result.seniority}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <p>{result.summary}</p>
            <div>
              <h4 className="font-semibold">Must have</h4>
              <ul className="list-disc pl-5">
                {result.mustHaveSkills.map((s) => <li key={s}>{s}</li>)}
              </ul>
            </div>
            <div>
              <h4 className="font-semibold">Nice to have</h4>
              <ul className="list-disc pl-5">
                {result.niceToHaveSkills.map((s) => <li key={s}>{s}</li>)}
              </ul>
            </div>
            {result.redFlags.length > 0 && (
              <div>
                <h4 className="font-semibold text-red-600">Red flags</h4>
                <ul className="list-disc pl-5">
                  {result.redFlags.map((s) => <li key={s}>{s}</li>)}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
```

### Step 15: Register the view

**Edit `app/home-page-content.tsx`** to add `'job-tracker'` to the view type and render `<JobTrackerScreen />` in the switch:

```tsx
import { JobTrackerScreen } from '@/features/job-tracker/components/job-tracker-screen'

// inside the switch:
case 'job-tracker':
  return <JobTrackerScreen />
```

### Step 16: Add nav + home card

- **`shared/config/`** — add a navigation entry so the link shows up in the sticky header.
- **`features/home/`** — add a feature card on the landing page that links to `/?view=job-tracker`.

(Both files use existing patterns — look at how the four existing features are wired.)

---

## Part 3 — Verify

### Smoke test the full flow

1. Restart `npm run dev:all` (both frontend and backend need to reload because `main.ts` changed).
2. Open `http://localhost:3000/?view=job-tracker`.
3. Paste a real job description into the textarea and click **Analyze**.
4. Confirm the result card renders with title, seniority, skills, and red flags.

### Isolate backend vs frontend

If something breaks, hit the backend directly to rule out the frontend:

```bash
curl -X POST http://localhost:4000/api/job-tracker/analyze \
  -H "Content-Type: application/json" \
  -d '{"jobDescription":"..."}'
```

If the curl works but the browser flow fails, the bug is in the proxy route or the frontend client. If the curl also fails, the bug is in the backend route or service.

### Lint + build

```bash
npm run lint
npm run build:all
```

---

## PR checklist

Before opening a pull request, tick every box:

- [ ] `backend/src/types/job-tracker.ts` exists
- [ ] `backend/src/lib/job-tracker/prompts.ts` exists (prompt is **not** inlined in the service)
- [ ] `backend/src/services/job-tracker.service.ts` exists, throws `statusCode: 503` when `LLM_API_KEY` missing
- [ ] `backend/src/config/llm.ts` updated with the `jobTracker` feature key
- [ ] `backend/src/routes/job-tracker.ts` exists with the copied error-mapping block
- [ ] `backend/src/main.ts` registers the new route
- [ ] `backend/.env.example` includes `LLM_MODEL_JOB_TRACKER`
- [ ] `types/job-tracker.ts` mirrors the backend types
- [ ] `shared/api/backend-client.ts` has `analyzeJobWithBackend`
- [ ] `app/api/job-tracker/analyze/route.ts` exists and validates the body
- [ ] `features/job-tracker/` has `components/`, `hooks/`, `api/`
- [ ] No component or hook imports `backend-client.ts`
- [ ] `app/home-page-content.tsx` renders `JobTrackerScreen` when `?view=job-tracker`
- [ ] Navigation and home feature card updated
- [ ] Manual curl smoke test passes
- [ ] `npm run lint` and `npm run build:all` pass
- [ ] Commit style matches `git log` (`feat: add job tracker ...`)

---

## Variations

**Need a file upload?** Copy the scoped `@fastify/multipart` pattern from `backend/src/routes/dream-company.ts:68-128` and use `fetchFormDataJson` on the frontend instead of `fetchJson`.

**Need a multi-step LLM pipeline?** Use the Anthropic SDK directly (via `backend/src/lib/llm-anthropic.ts`) and copy the structure of `backend/src/services/dream-company.service.ts` — one private function per step, throw with `step: 'stepName'` on parse failures.

**Need async polling?** Copy `backend/src/services/cv-optimizer.service.ts`. Read the warning in [ARCHITECTURE.md](./ARCHITECTURE.md#state--persistence) first — the in-memory job map is single-process only.

**Need to persist data?** Don't reach for the in-memory `Map`. Use Supabase via `backend/src/lib/supabase.ts` (`getSupabase()`, `getMvpUserId()`) — that's how Interview Prep and the CV Library do it. Add a migration in `supabase/migrations/` (idempotent: `create table if not exists`, `add column if not exists`, `create index if not exists`). See [CV_KNOWLEDGE_BASE.md](./CV_KNOWLEDGE_BASE.md) for a full worked example, including how the schema, services, routes, and Next.js proxies all line up.

**Need data to be shared across multiple parent rows?** Don't attach it to the parent with a `NOT NULL` FK. The CV Library originally did this (`cv_bullets.cv_version_id NOT NULL`) and it meant users re-filled the same evidence for every CV version. The fix in migration `003_shared_bullet_pool.sql` was to introduce a user-scoped pool table + an M:N junction (`cv_version_bullets`) so a single bullet's gaps and artifacts are visible across every parent. If your feature has any "same thing appears in multiple places" smell, model it as a pool from day one — retrofitting is painful.

**Need text retrieval ("find most relevant X for Y")?** Use the `retrieval-researcher` subagent to pick an approach before writing code. The CV Library uses `pgvector` + Voyage `voyage-3.5-lite` (1024 dims) via `backend/src/lib/voyage.ts` — small cost, no new datastore, scales fine to thousands of records per user without an index. See `supabase/migrations/003_shared_bullet_pool.sql` for the extension setup and `backend/src/services/cv-knowledge.service.ts::findSimilarBullets` for the query pattern.

**Adding a feature that needs its own page (not a `?view=` switch)?** Look at how the CV Library is wired: real Next.js page at `app/cv-library/page.tsx`, screen at `features/cv-library/components/`, and a navigation entry in `shared/config/navigation.ts` with an `href` so the top nav links to it. Don't add it to `home-page-content.tsx` — that file is only for `?view=` features.
