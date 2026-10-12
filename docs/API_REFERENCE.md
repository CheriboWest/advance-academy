# API Reference

Every HTTP endpoint exposed by the backend. The frontend hits the **same paths** via the Next.js proxy routes under `app/api/*`, minus the `http://localhost:4000` prefix.

- **Base URL (dev):** `http://localhost:4000`
- **Content-Type:** `application/json` unless noted (multipart for file uploads).
- **Error shape:** all errors return `{ code: string, message: string }` per `@advance-academy/contracts`.
- **Auth:** every endpoint needs `Authorization: Bearer <supabase-token>` and an **approved** account, except the public ones listed under Auth & Accounts. See the Authentication section of `CLAUDE.md`.

---

## Auth & Accounts

### `POST /api/auth/passwordless`

**Public** (no bearer token). Sign-up and sign-in are the same call: mints a trial account if the email is new, then emails a Supabase magic link. Rate limited **5 / minute by IP**.

**Request** — `{ "email": "a@b.com", "name": "Ada", "ref": "<referral code>" }` (`name` and `ref` optional).

**Response 200** — always `{ "ok": true }` for a valid email, whether or not the account existed. Never reveals whether an address is registered.

- `422 INVALID_EMAIL` — malformed address.
- `500 PASSWORDLESS_FAILED` — could not send the link.

The new account lands `status = 'pending'` (migration 018 column default) and cannot reach any other endpoint until an admin approves it.

### `GET /api/account/me`

The signed-in user's own state. **The one authenticated route exempt from the approval gate** (exact path match), so the `/pending` screen can read why it's blocked.

**Response 200**

```json
{ "status": "pending", "tier": "trial", "credits": 2, "isAdmin": false }
```

`status` is `pending | approved | rejected`; `tier` is `trial | membership`; admins read `credits` as unlimited.

### `GET /api/admin/users`

Admin only — `isAdminUser()` is checked inline, `403 FORBIDDEN` otherwise. Not rate limited.

**Query** — `search` (email substring), `tier`, `status`, `limit` (clamped 1–500, newest first). The pending-approval queue is `?status=pending`.

### `PATCH /api/admin/users/:userId`

Admin only. Approve, reject, change tier, adjust credits, or toggle admin — any combination in one call.

**Request** — `{ "status": "approved" | "rejected", "tier": "trial" | "membership", "creditDelta": 5, "isAdmin": true }`, at least one field.

`status` cannot be set back to `'pending'` — a review is a decision. Approving stamps `reviewed_at` / `reviewed_by`, invalidates the 60s status cache so it takes effect immediately, and writes a `set_status` row to `admin_actions`. Upgrading to `membership` tops the wallet up to the grant rather than adding to it.

- `400` — empty patch, or a self-lockout attempt (removing your own admin flag, rejecting your own account).
- `403 FORBIDDEN` — caller is not an admin.

---

## System

### `GET /api/health`

Liveness check. Used by `curl` smoke tests and the `docs/GETTING_STARTED.md` verification step.

**Response 200**

```json
{
  "status": "ok",
  "timestamp": "2026-04-06T12:00:00.000Z",
  "adapter": "..."
}
```

---

## CV Optimizer

### `GET /api/cv-optimizer/template`

Returns the schema and configuration for the CV Optimizer endpoint. Useful for clients that want to render the input form dynamically.

**Response 200** — template object (schema for the analyze request).

### `POST /api/cv-optimizer/analyze`

Submits a CV for async analysis. Returns immediately with a `jobId`. The client polls `/jobs/:jobId` until the result is ready.

**Request body**

```ts
{
  candidateName: string
  targetRole: string
  currentCvText: string
  jobDescription?: string
}
```

**Response 202**

```ts
{
  jobId: string
}
```

### `GET /api/cv-optimizer/jobs/:jobId`

Returns the current status of an analysis job. The frontend polls this every `1500ms` (see `shared/env/client.ts`).

**Response 200** (pending)

```ts
{
  status: 'pending'
}
```

**Response 200** (completed)

```ts
{
  status: 'completed',
  result: {
    overallScore: number          // 0-100
    sections: Array<{
      title: string
      score: number               // 0-100
      feedback: string
    }>
    expertReview: string
  }
}
```

**Response 200** (failed)

```ts
{
  status: 'failed',
  error: { code: string, message: string }
}
```

**Response 404** — jobId unknown (e.g. wrong process after horizontal scale).

> **Gotcha:** Jobs are stored in-memory per process. If your backend is deployed with multiple instances, you must use sticky sessions or the poll may 404.

---

## Dream Company

### `POST /api/dream-company/{analyze,roles,roadmap}/stream`

The three steps of the run, each streamed as Server-Sent Events. This is what the frontend calls.

| Step | Body | `done` payload |
|---|---|---|
| `analyze/stream` | `{ profile: DreamCompanyInput }` | `ProfileAnalysis` |
| `roles/stream` | `{ profile, analysis }` | `TargetRole[]` |
| `roadmap/stream` | `{ profile, analysis, selectedRoles }` | `RoadmapResponse` |

Events are `open`, `delta` (raw model text, progress only), `done` (the parsed result) and `error` (`{ status, code, message }`). Full contract: [`test/dream-company/M2.1-streaming-contract.md`](../test/dream-company/M2.1-streaming-contract.md). Types live in `types/dream-company.ts`.

The backend also exposes the same three steps as plain JSON (`POST /api/dream-company/{analyze,roles,roadmap}`, same bodies, the `done` payload as the 200 response). The Next.js app does not proxy them; `test/dream-company/m1-ac-check.mjs` calls them directly.

**Errors** — `400` missing profile fields / analysis / roles; `429` daily limit or `CREDIT_EXHAUSTED` (step 1); `502` model 404 or truncated output; `503` `LLM_API_KEY` not set; `504` timeout.

### `GET /api/dream-company/config`

`{ maxRoles: number }` — the role-selection cap (`JOB_MAX_ROLE_QUERIES`).

### `POST /api/dream-company/parse-cv`

Parses an uploaded CV file and returns structured profile fields the user can then edit and submit to `/generate`.

**Request** — `multipart/form-data` with a single field `cv` containing a `.pdf` or `.docx` file (≤15 MB).

**Response 200**

```ts
{
  degree: string
  workExperience: string
  skills: string
  interests: string
  targetSalary: string
  location: string
  currentLevel: 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'manager' | 'director' | 'executive'
  confidence: {
    degree: 'high' | 'medium' | 'low'
    workExperience: 'high' | 'medium' | 'low'
    skills: 'high' | 'medium' | 'low'
    location: 'high' | 'medium' | 'low'
  }
}
```

**Errors**

- `400` — invalid multipart or missing `cv` field or unsupported file extension.
- `422` — file was valid but unreadable (corrupt PDF/DOCX).
- `401` / `502` / `503` — same LLM-related errors as `/generate`.

---

## Outreach

### `POST /api/outreach/generate`

Generates a LinkedIn message (<300 chars) and an email (subject + body) for a specific target.

**Request body**

```ts
{
  cvText: string
  linkedInText?: string
  targetCompany: string
  targetPersonName: string
  targetPersonRole?: string
  enrichedContexts: Array<{
    type: string        // e.g. "company_website", "job_description"
    content: string
  }>
  intent: 'direct_application' | 'referral_request' | 'informational_interview' | 'agency_recruiter'
}
```

**Response 200**

```ts
{
  intent: OutreachIntent
  linkedInMessage: string     // <300 chars
  email: {
    subject: string
    body: string
  }
}
```

**Errors** — same LLM error mapping as Dream Company.

### `POST /api/outreach/extract`

Extracts plain text from a file upload **or** a URL, to feed into the `enrichedContexts` field of `/generate`.

**Request (file mode)** — `multipart/form-data` with a file field (PDF/DOCX, ≤15 MB).

**Request (URL mode)** — `application/json`:

```ts
{ url: string }
```

URL mode uses the Jina Reader API (`https://r.jina.ai/{targetUrl}`). Set `JINA_API_KEY` for authenticated access if you're rate-limited.

**Response 200**

```ts
{ text: string }
```

**Errors**

- `400` — neither file nor URL provided.
- `422` — extraction failed (unreadable file or blocked URL).

---

## Error code cheat sheet

| Status | When | Typical message |
|---|---|---|
| 400 | Bad request body / missing fields / invalid file type | "Missing required fields" |
| 401 | Missing or invalid bearer token (`UNAUTHORIZED`) — re-login | "Authentication required." |
| 401 | Anthropic key rejected | "Anthropic API rejected the key (401). Check LLM_API_KEY in backend/.env." |
| 403 | Account not approved (`ACCOUNT_PENDING` / `ACCOUNT_REJECTED`) — token is valid, the account isn't cleared. The frontend redirects to `/pending`. | "Your account is awaiting approval." |
| 403 | Non-admin hitting `/api/admin/*` (`FORBIDDEN`) | "Admin access required." |
| 403 | Trial user hitting a membership feature (`MEMBERSHIP_REQUIRED`) | "… is part of Mentorship." |
| 429 | Credit wallet empty (`CREDIT_EXHAUSTED`) | "You need 1 credit to run … and have 0 left." |
| 404 | Unknown jobId (CV Optimizer) | — |
| 422 | Valid request but parsing/extraction failed | "Parse failed" |
| 500 | Unexpected or LLM response parse error | "Internal server error" or `{ error, step }` |
| 502 | Anthropic returned 404 for the model | "Anthropic returned 404 for the configured model. Set LLM_MODEL_{FEATURE}..." |
| 503 | LLM not configured | "LLM is not configured (set LLM_API_KEY in backend/.env)." |
| 504 | Client-side request timeout | "The request timed out." |

## Frontend proxy paths

The frontend hits these paths on **its own origin** (Next.js, port 3000 in dev). The proxy route forwards to the backend with the matching path:

| Frontend path | Backend path |
|---|---|
| `/api/cv-optimizer/analyze` | `/api/cv-optimizer/analyze` |
| `/api/cv-optimizer/jobs/:jobId` | `/api/cv-optimizer/jobs/:jobId` |
| `/api/dream-company/{analyze,roles,roadmap}/stream` | same path |
| `/api/dream-company/config` | `/api/dream-company/config` |
| `/api/dream-company/parse-cv` | `/api/dream-company/parse-cv` |
| `/api/outreach/generate` | `/api/outreach/generate` |
| `/api/outreach/extract` | `/api/outreach/extract` |
| `/api/auth/passwordless` | `/api/auth/passwordless` |
| `/api/account/me` | `/api/account/me` |
| `/api/admin/users` | `/api/admin/users` |
| `/api/admin/users/:userId` | `/api/admin/users/:userId` |

The proxy paths are identical to the backend paths by convention. **Keep it that way** when you add new endpoints.
