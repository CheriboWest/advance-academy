# backend — Fastify API (port 4000)

`src/main.ts` boots everything: env, CORS (`FRONTEND_URL`, comma-split), rate-limit
plugin, the auth/approval preHandler, every `register*Routes`, and the in-process
timers (`startCvAnalysisReaper`, `startEngagementReminders`, `startRewardSweep`).
**A new route module does nothing until it is registered in `main.ts`.**

## Layout rules

- `routes/` — thin HTTP handlers: validate, call a service, map thrown
  `statusCode`/`step` to HTTP codes. Copy the catch block of `routes/dream-company.ts`
  (`handleServiceError`).
- `services/` — business logic and LLM/DB calls; never import `fastify`.
- `lib/` — helpers and integration clients (`llm-anthropic.ts` is the only place the
  Anthropic client is built; `voyage.ts`, `exa-client.ts`, `cost-tracker.ts`).
  `lib/<feature>/prompts.ts` holds prompt text; `lib/interview-prep/db.ts` is the
  Interview Prep data layer. CV agent prompts live in `services/cv-agents/prompts/`.
- Shared request/response types belong in `packages/contracts`, not `src/types/`.
- Two interview route files, don't merge them: `routes/interview.ts` = the live turn
  loop (`POST /api/interview` with `action: start|message`, `/api/evaluate`, session
  history); `routes/interview-prep.ts` = extract-job-from-url.

## Env

- `main.ts` loads `./.env`, then `./backend/.env`, relative to **cwd** — `npm run dev:backend`
  works from root or `backend/`; a raw `tsx src/main.ts` from elsewhere silently gets no env.
- Required: `LLM_API_KEY`, `FRONTEND_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Per-feature keys/models in `config/llm.ts`: `LLM_API_KEY_OUTREACH` covers Outreach
  **and** Dream Company; `LLM_API_KEY_INTERVIEW` covers Interview Prep **and** CV Library;
  `LLM_API_KEY_CV` for CV Optimizer. `LLM_MODEL_INTERVIEW_SCORING` falls back to the
  Interview Prep model. LLM HTTP timeout 30s unless `LLM_TIMEOUT_MS`.
- No LLM key: CV Optimizer falls back to heuristic scoring; every other AI route 503s.

## Auth and the approval gate (`main.ts` preHandler)

- Every route needs `Authorization: Bearer <supabase token>` (`getUserIdFromToken`),
  except the `skipPaths` list (health, system, lead capture/confirm/unsubscribe,
  `/api/auth/passwordless`, `/api/engagement/unsubscribe`, `/api/public/*`) — matched
  with `startsWith`, so keep entries specific.
- The same hook returns **403** `ACCOUNT_PENDING` / `ACCOUNT_REJECTED` unless
  `users.status = 'approved'` (403, not 401: the token is valid). `/api/account/me` is
  the only exemption, by **exact** path.
- `lib/user-access.ts` caches status for 60s and **fails closed** (missing row = pending).
  Any new write to `users.status` must call `invalidateUserStatus()`.
- `is_admin` (`lib/admin.ts`, plus the `ADMIN_USER_IDS` allowlist) does not bypass the
  gate. `/api/admin/*` handlers check `isAdminUser` inline and are not rate-limited.
- Sign-up is passwordless only (`services/passwordless.service.ts`). Lead-funnel
  accounts land `pending` too; referral payouts fire on first `spendCredits`, i.e. after approval.

## Rate limits

- `@fastify/rate-limit` is `global: false` (opt in per route) with `hook: 'preHandler'`
  so `keyGenerator` can read `request.userId`. 429 body is `{ code: 'RATE_LIMIT_EXCEEDED', message }`.
- LLM routes use `perUserDaily(envVar, default, label)` from `lib/rate-limit.ts`
  (per user per day, env-tunable). Only one `rateLimit` config fits a route, so it
  replaces any per-minute cap. Current daily caps: CV 5, Dream Company 3 (analyze and roadmap, each),
  Outreach 5, Interview start 2 (`message` turns exempt), Cover Letter 10.
- The frontend shows the 429 `message` as-is — write it for students.

## Money and points

- Credits (`lib/credits.ts`): `assertCredits` before the LLM call, `spendCredits` after
  success. Interview Lab and company contacts also need Membership (`requireMembership`).
- Gamification XP and Career Coins are a score, never credits — don't route them through `lib/credits.ts`.
- Job Tracking spends nothing and records no tool result on purpose.
- Follow-up reminder emails run hourly in-process, deduped by `reminder_sends`, and
  stay off unless `ENGAGEMENT_REMINDERS_ENABLED=true`.

## Uploads

`@fastify/multipart` is registered inside a scoped plugin per route group, never
globally; 15MB cap, `.pdf`/`.docx` only, parse failure → 422. No file is stored —
only extracted text (see `src/services/CLAUDE.md`).

## Dream Company job source

`config/job-source.ts` + `services/job-search.service.ts`: UK → Adzuna + Reed, other
covered countries → Adzuna, else Exa. `DREAM_JOB_SOURCE` is read per request, so a
rollback needs no deploy. Never throws (returns a notice instead); results cached
in-process. `test/dream-company/jobsource-harness.ts` makes **live, paid** API calls.
