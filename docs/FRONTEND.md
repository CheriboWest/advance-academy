# Frontend

The frontend is the Next.js application at the repo root. It is a single-page App Router app with a feature-based module structure.

## Tech stack

| Area | Choice |
|---|---|
| Framework | Next.js 16 (App Router) |
| React | 19 |
| Language | TypeScript 5.7 |
| Styling | Tailwind CSS 4 + CSS variables |
| UI library | shadcn/ui (Radix primitives) |
| Data fetching | TanStack Query (React Query) 5 |
| Forms | React Hook Form + Zod |
| Charts | Recharts |
| Icons | Lucide React |
| Fonts | Playfair Display (headings) + Inter (body), via `next/font` |
| Toasts | Sonner |

## Directory layout

```
/
├── app/                              Next.js App Router
│   ├── layout.tsx                    Root layout, fonts, <AppProviders>
│   ├── page.tsx                      Suspense boundary → HomePageContent
│   ├── home-page-content.tsx         ?view= router (client component)
│   ├── providers.tsx                 QueryClientProvider
│   ├── globals.css                   Tailwind + design tokens
│   ├── cv-library/                   CV Library page (real route, not ?view=)
│   └── api/                          Proxy routes (server-only)
│       ├── cv-optimizer/analyze/route.ts
│       ├── cv-optimizer/jobs/[jobId]/route.ts
│       ├── dream-company/{analyze,roles,roadmap}/stream/route.ts  (SSE, via proxyStream)
│       ├── dream-company/parse-cv/route.ts
│       ├── outreach/generate/route.ts
│       ├── outreach/extract/route.ts
│       ├── interview/route.ts                          (proxy: start/message)
│       ├── interview/coach-answer/route.ts             (proxy: enhanced answer)
│       ├── interview/sessions/route.ts                 (proxy: list)
│       ├── interview/sessions/[id]/route.ts            (proxy: detail)
│       ├── interview-prep/extract-job-from-url/route.ts (proxy: Jina + LLM)
│       ├── evaluate/route.ts                           (proxy: final report)
│       ├── cv-library/                                  (proxies: versions — two-phase upload, bullets/:id/similar, bullets/merge, gaps, jit-clarification)
│       └── coach-understanding/                         (proxies: generate, reports, reports/:id)
├── features/                         Feature modules
│   ├── home/                         Landing page
│   ├── cv-optimizer/
│   ├── dream-company/
│   ├── outreach/
│   ├── interview-prep/
│   └── cv-library/
├── shared/
│   ├── api/
│   │   ├── http-client.ts            fetchJson, fetchFormDataJson, HttpClientError
│   │   └── backend-client.ts         Server-only backend wrappers
│   ├── env/
│   │   ├── server.ts                 getServerEnv() → { backendUrl }
│   │   └── client.ts                 getClientEnv() → { cvAnalysisPollIntervalMs }
│   ├── config/                       Navigation config
│   └── utils/
│       └── cn.ts                     Tailwind class merger
├── components/
│   ├── navigation.tsx                Sticky header
│   ├── ornamental-divider.tsx
│   └── ui/                           shadcn/ui primitives (only the ones in use; add more with the shadcn CLI)
├── types/                            Cross-feature TS types
│   ├── dream-company.ts
│   └── outreach.ts
└── packages/contracts/               Shared contracts with backend
```

## Routing model

The frontend is a single-page app. Navigation happens via a `?view=` query parameter, not real routes:

- `/` or `/?view=home` — home
- `/?view=companies` — Dream Company
- `/?view=outreach` — Outreach
- `/?view=cv` — CV Optimizer
- `/?view=interview` — Interview Prep
- `/cv-library` — CV Library (real Next.js route, **not** a `?view=` switch)

Most features still use the `?view=` switch in `app/home-page-content.tsx`. The CV Library is the exception: it lives at the real path `/cv-library` (`app/cv-library/page.tsx`) and is linked from the top nav via `NAV_ITEMS[].href`. **When you add a new `?view=` feature, you must add its case to `home-page-content.tsx`** or the screen will never render. When you add a real-path feature, register it in `shared/config/navigation.ts` with an `href`.

## Feature module anatomy

Every feature lives under `features/{feature}/` and follows the same four-folder shape. The Dream Company feature is the canonical example:

```
features/dream-company/
├── components/
│   └── dream-company-screen.tsx      The full screen (form + result)
├── hooks/
│   └── use-dream-company.ts          State, loading, error, async actions
├── api/
│   └── frontend-client.ts            Calls /api/dream-company/* (relative URLs)
└── types.ts / schemas/               Feature-local types and Zod schemas
```

**Rule:** if something is specific to one feature, it lives inside that feature's folder. If two features need it, move it to `shared/` or `types/`.

### Screen (`components/*-screen.tsx`)

- `'use client'` component.
- Uses the feature hook for all state and async logic.
- Builds forms with React Hook Form + Zod.
- Uses shadcn/ui primitives from `components/ui/`.
- Renders states: idle → loading → error → result.

### Hook (`hooks/use-*.ts`)

- `'use client'`.
- Owns `result`, `loading`, `error` state.
- Exposes async action functions (`generateFromProfile`, `uploadCV`, `reset`).
- Calls the feature's `frontend-client.ts`, never `backend-client.ts` directly.
- Canonical example: `features/dream-company/hooks/use-dream-company.ts`.

### Frontend client (`api/frontend-client.ts`)

- `'use client'`.
- One function per endpoint.
- Calls **relative** URLs (`/api/outreach/generate`), which hit the Next.js proxy routes.
- Uses `fetchJson` or `fetchFormDataJson` from `shared/api/http-client.ts`.
- Never imports `backend-client.ts`, never reads env vars directly.

Example from `features/outreach/api/frontend-client.ts`:

```ts
import { fetchJson } from '@/shared/api/http-client'
import { getAuthHeaders } from '@/shared/auth/get-auth-headers'

export async function submitOutreachGeneration(request: OutreachRequest): Promise<OutreachResult> {
  return fetchJson<OutreachResult>('/api/outreach/generate', {
    method: 'POST',
    body: JSON.stringify(request),
    headers: await getAuthHeaders(),
    timeoutMs: 100000,
  })
}
```

## HTTP client pattern

Two layers, **do not mix them**:

### `shared/api/http-client.ts` (isomorphic)

- `fetchJson<T>(url, options)` — 15s default timeout.
- `fetchFormDataJson<T>(url, formData, options)` — 120s default timeout.
- `HttpClientError` — typed error with `status` and `payload: ApiErrorResponse`.
- Used by **both** feature frontend clients and the server-side `backend-client.ts`.

### `shared/api/backend-client.ts` (server-only)

- Reads `BACKEND_URL` via `getServerEnv()`.
- One function per backend endpoint (`analyzeCvWithBackend`, `generateOutreachWithBackend`, etc.).
- **Only imported from `app/api/*/route.ts`.** Importing it from a `'use client'` file will bundle `BACKEND_URL` into the browser and defeat the whole point.

## Next.js proxy routes

Every feature has one or more proxy routes at `app/api/{feature}/*/route.ts`. They are thin: validate → call backend-client → map errors.

Canonical example: `app/api/outreach/generate/route.ts`:

```ts
import { getProxyAuthToken } from '@/shared/api/proxy-auth'
import { NextResponse } from 'next/server'
import { generateOutreachWithBackend } from '@/shared/api/backend-client'
import { HttpClientError } from '@/shared/api/http-client'

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
      { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Invalid request body.' },
      { status: 400 },
    )
  }
}
```

When you add a new feature, **copy this file and change the names.** Do not reinvent the validation or error-mapping logic.

## State management

- **TanStack Query** is wired up in `app/providers.tsx` with `staleTime: 1000` and `refetchOnWindowFocus: false`. Use it for **polling** (CV Optimizer) and any cached reads you introduce.
- **Plain `useState` + `useCallback` inside custom hooks** is the default. Most features don't need React Query. See `features/dream-company/hooks/use-dream-company.ts` for the pattern.
- **No Redux, no Zustand, no Context.** Don't add one without a strong reason.

## Styling

- **Tailwind CSS 4** with CSS variables defined in `app/globals.css`.
- **Design tokens** — primary `#0F1C2E` (dark blue), accent `#D4AF37` (gold), plus a neutral palette and a 5-color chart palette.
- **shadcn/ui** — New York style, configured via `components.json`. Primitives live in `components/ui/`.
- **Class merging** — use `cn()` from `shared/utils/cn.ts`, which wraps `clsx` + `tailwind-merge`.
- **Fonts** — `next/font/google` loads Playfair Display and Inter in `app/layout.tsx`.

## Import aliases

`tsconfig.json` defines `@/*` mapped to the repo root. **Always use `@/...` imports**, never `../../../` relative imports. Example:

```ts
import { fetchJson } from '@/shared/api/http-client'
import type { DreamCompanyInput } from '@/types/dream-company'
```

## Adding a new frontend feature — 6-step checklist

Assume you're adding a "Job Tracker" feature (full walkthrough in [ADD_A_FEATURE.md](./ADD_A_FEATURE.md)).

1. **Create feature folder** — `features/job-tracker/{components,hooks,api}`.
2. **Frontend client** — `features/job-tracker/api/frontend-client.ts` calling `/api/job-tracker/analyze` via `fetchJson`.
3. **Hook** — `features/job-tracker/hooks/use-job-tracker.ts` modeled on `use-dream-company.ts` but without the step simulation.
4. **Screen** — `features/job-tracker/components/job-tracker-screen.tsx` with React Hook Form + Zod.
5. **Proxy route** — `app/api/job-tracker/analyze/route.ts` copied from the dream-company route.
6. **Wire up** — add `'job-tracker'` to the view type in `app/home-page-content.tsx`, and add the feature card to `features/home/` and the nav entry in `shared/config/`.

## Environment config

- **`shared/env/server.ts`** — `getServerEnv()` returns `{ backendUrl }` from `BACKEND_URL` (defaults to `http://localhost:4000`). Only called from server code.
- **`shared/env/client.ts`** — `getClientEnv()` returns `{ cvAnalysisPollIntervalMs: 1500 }`. Safe to call from the browser. No secrets.

**Never read `process.env` directly outside these two files.**
