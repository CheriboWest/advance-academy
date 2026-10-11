# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This repo is a merge sandbox (not production)

This is `advance-academy`, a rehearsal for merging AdvanceAcademyTools (this
tree) with career-hub. **Both production repos are untouched and still deploy.**
Nothing here has been cut over.

- `tools-upstream` and `careerhub` remotes are **fetch-only** — their push URLs
  are deliberately set to `DISABLED-production-repo` so a stray `git push` fails
  loudly instead of writing to production. Don't "fix" them.
- Pull upstream fixes weekly, or the merge drifts:
  `git fetch tools-upstream && git merge tools-upstream/main`
  `git subtree pull --prefix=careerhub careerhub main`
- `backend-python/` is career-hub's FastAPI service. It stays Python — it is not
  being ported to the Fastify backend.
- `supabase/careerhub/schema.sql` is a **reference mirror, not a migration**.
  Never run it. career-hub's real migrations get renumbered into
  `supabase/migrations/` as `024_ch_*` onward.
- career-hub's web app has been folded in: its routes are `app/{search,companies,coach}`
  and its non-route code is `features/career-hub/`. The `careerhub/` directory
  is gone.
- **Contacts** live in one table, `contacts` (migration 034, service-role only). Coaches manage them through backend-python (`/contacts`, `/contacts/directory` → `/coach/contacts`); students on Membership read a reduced shape (no phone/notes) through Fastify `routes/company-contacts.ts` on `/companies/[slug]`. The category (HR / recruiter / …) is derived from `job_title` by `contactCategory` in `packages/contracts/src/contacts.ts` — not stored. `companies.sector` is written only by `backend-python/app/companies/sector.py` (backfill: `scripts/classify_sectors.py`); its list must match `SECTOR_OPTIONS` in `features/career-hub/lib/filters.ts` (`test_sector.py` checks).
- `middleware.ts`'s `PUBLIC_PATHS` is the one list of pages reachable signed-out:
  `/login`, `/register`, `/auth/callback`, `/search`, `/companies/*` (top of the
  funnel), `/coach/login`, `/unsubscribe`. Its matcher gates every other page
  route, so a new public page must be added there or it silently redirects to
  `/login`.
- The browser reaches `backend-python` only via the same-origin rewrite
  `/api/careerhub/*` → `BACKEND_PYTHON_URL` in `next.config.mjs`; server code
  calls it directly. Both go through `features/career-hub/lib/api-url.ts` —
  don't reintroduce a `NEXT_PUBLIC_` URL for it. The rewrite is fixed at **build
  time** and vanishes when the variable is unset (the build warns), so every
  Career Hub call 404s until it's set *and* the frontend is rebuilt. A 401
  "Unknown token signing key" / "Invalid token issuer" from it means
  `BACKEND_PYTHON_URL` points at a backend-python wired to the old career-hub
  Supabase project.
- **Job crawler** (`/coach/crawler` → backend-python `/discover/*`) is not a
  scraper: it calls the Adzuna and Reed APIs over `httpx` (`ADZUNA_APP_ID`,
  `ADZUNA_APP_KEY`, `REED_API_KEY`) as an in-process FastAPI background task,
  writing `crawl_runs` / `discovery_queries` / `companies` / `jobs`. A restart
  mid-run kills it ("The crawl was interrupted").
- **Job expiry** (migration 046, `docs/JOB_EXPIRY.md`): `jobs.is_active` is the
  only switch every student query, the view and RLS read, so closing a job means
  setting it false with a `closed_reason`. `expired` = Reed's stated
  `expires_at` has passed (`close_expired_jobs()`, run after every crawl);
  `stale` = successful crawls stopped returning it (`close_stale_jobs()`, a dry
  run by default and refused until coverage is complete). The crawler upserts
  jobs **one request per column set** — PostgREST rejects mixed keys, and a
  source without a date must never null Reed's. `crawl_fetches` rows are written
  only for fully successful pairs; never relax that.
- `/coach/*` additionally requires `users.is_admin` — checked in
  `app/coach/(workspace)/layout.tsx` and, for the Python API, in
  `backend-python/app/auth.py`. There is no separate `is_coach` column: coach
  and admin are the same set (see `backend/src/lib/admin.ts`).
- Frontend tests are vitest (`npm test`); `backend/` uses the node built-in
  runner (`npm run test --workspace backend`); `backend-python/` self-checks run
  as plain scripts (`for f in test_*.py; do .venv/bin/python $f; done`).
  `vitest.config.ts` is scoped away from `backend/` on purpose.

**`git log --follow` alone will not show career-hub's history** — it stops at the
subtree merge and looks like the history was lost. It wasn't; add `-m`:

```bash
git log -m --follow -- backend-python/app/main.py   # reaches career-hub's commits
```

## Git workflow

- **Commit automatically** to the current branch as soon as a task is done and
  both type checks plus the relevant tests pass — no need to ask. On `main`,
  branch first.
- **Never `git push`** — not to `origin` (`CheriboWest/advance-academy-merge`)
  or anywhere else. The user pushes. Don't open PRs either.
- Commit only the files you changed, with a pathspec:
  `git commit -m "…" -- <paths>`. Plain `git add <paths> && git commit` also
  sweeps in whatever the user already staged; never `git add -A`. Leave the
  user's own uncommitted or staged changes alone.
- Message style matches history: one imperative sentence naming the outcome
  ("Stop showing raw Anthropic errors from Coach Understanding"), then the
  attribution trailer.

## Commands

Run from the repo root (npm workspaces; `backend` is a workspace):

- `npm run dev:frontend` — Next.js dev server (port 3000)
- `npm run dev:backend` — Fastify dev server with `tsx watch` (port 4000)
- `npm run dev:all` — both concurrently
- `cd backend-python && .venv/bin/uvicorn app.main:app --reload --port 8000` — Career Hub API (matches `BACKEND_PYTHON_URL=http://localhost:8000` in `.env.local`)
- `npm run build:all` — `next build` then backend `tsc -p tsconfig.build.json`
- `npm run lint` — **currently broken**: `eslint` isn't installed and there is no `eslint.config.*`. Rely on the type checks and tests.
- `npm test` (vitest, frontend) · `npm run test --workspace backend` (node runner, `src/**/*.test.ts`)
- `npm run typecheck --workspace backend` — backend type check only (uses `tsconfig.json`, so it includes `scripts/` and other files the build excludes via `tsconfig.build.json`)
- `npx tsc --noEmit` (from repo root) — frontend type check
- `npm run usage --workspace backend` (also `usage:week`, `usage:month`) — LLM cost report from `cost-log.jsonl`, written by `backend/src/lib/cost-tracker.ts`

**Type checking is split.** There is no combined `typecheck:all` script — frontend (`npx tsc --noEmit` from repo root) and backend (`npm run typecheck --workspace backend`) must be run separately. CI/pre-commit hooks need both.

**Backend env loading is cwd-sensitive.** `npm run dev:backend` resolves to `tsx watch src/main.ts` inside the `backend/` workspace, so `main.ts` looks at `./.env` first (i.e. `backend/.env`) and falls back to `./backend/.env` (`main.ts:24-36`). This means `npm run dev:backend` works from either repo root or `backend/`, but raw `tsx src/main.ts` invocations outside `npm run` will silently miss the env file if launched from the wrong directory.

Env: copy `.env.local.example` → `.env.local` (frontend, mainly `BACKEND_URL`) and `backend/.env.example` → `backend/.env`. Required backend vars: `LLM_API_KEY`, `FRONTEND_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Feature-specific keys: `GROQ_API_KEY` (Interview Prep voice transcription via Groq Whisper), `JINA_API_KEY` (Outreach + CV Library URL fetching), `EXA_API_KEY` (Outreach search via `lib/exa-client.ts`), `VOYAGE_API_KEY` (embeddings via `lib/voyage.ts`). Optional overrides: `LLM_TIMEOUT_MS`, per-feature LLM keys (`LLM_API_KEY_OUTREACH` covers Dream Company + Outreach, `LLM_API_KEY_CV` for CV Optimizer, `LLM_API_KEY_INTERVIEW` for Interview Prep + CV Library), and per-feature model overrides `LLM_MODEL_DEFAULT` / `LLM_MODEL_CV_OPTIMIZER` / `LLM_MODEL_OUTREACH` / `LLM_MODEL_DREAM_COMPANY` / `LLM_MODEL_INTERVIEW_PREP` (see `backend/src/config/llm.ts`).

## Architecture

Career-tools web app. AI features (Anthropic Claude): CV Optimizer, Dream Company Finder, Outreach Generator, Interview Prep, CV Library, Cover Letter. Non-AI: Job Tracking (`/jobs`), engagement/weekly goals, and the folded-in Career Hub (`/search`, `/companies`, `/coach`, served by backend-python). Interview Prep, CV Optimizer, Outreach and Dream Company are views of the home page (`/?view=interview` etc., `app/home-page-content.tsx`), not their own routes. The Outreach Generator and CV Library extractors also use Jina Reader for URL fetching, Exa for web search, and Voyage for embeddings. **Persistence:** Supabase Postgres backs Interview Prep (sessions, assessments, coaching) and the CV Library (versions, bullets, gaps, artifacts, coach answers); the other features remain stateless request/response. **Auth:** Supabase bearer-token auth (see Authentication below). See `docs/ARCHITECTURE.md` for the canonical reference and diagrams; `docs/BACKEND.md`, `docs/FRONTEND.md`, `docs/ADD_A_FEATURE.md`, `docs/CV_KNOWLEDGE_BASE.md`, `docs/COACH_ANSWER_FLOW.md`, `docs/CV_LIBRARY_UPLOAD_FLOW.md`, `docs/PERF_BATCHED_QUERIES.md`, `docs/INTERVIEW_PREP_WORKFLOW.md`, and `docs/CONVENTIONS.md` are also authoritative.

**Stack:** Frontend is Next.js 16 (App Router) + React 19 + Tailwind v4 + shadcn/ui (`components.json`) + TanStack Query. Backend is Fastify 5 + Anthropic SDK + Supabase. Cross-layer types live in `packages/contracts` (`@advance-academy/contracts`).

### Request flow (frontend ↔ proxy ↔ backend ↔ LLM)

Every feature follows the same hop chain — replicate it when adding new ones. Conceptually three boundaries (browser → Next.js server → Fastify → LLM), but each boundary has paired client/handler files, so a request touches roughly seven modules end-to-end:

```
UI (features/*/components)
  → hook (features/*/hooks)
  → frontend client (features/*/api/frontend-client.ts)
  → Next.js proxy route (app/api/*/route.ts)
  → backend client (shared/api/backend-client.ts)
  → Fastify route (backend/src/routes)
  → service (backend/src/services)
  → Anthropic SDK
```

### Why the Next.js proxy layer exists

`app/api/*/route.ts` is not optional plumbing — it does three jobs:
1. Keeps `BACKEND_URL` server-only (read via `shared/env/server.ts`).
2. Validates request bodies with type guards before forwarding to Fastify.
3. Catches `HttpClientError` from `shared/api/http-client.ts` and normalizes it to `ApiErrorResponse` (`{ code, message }` from `@advance-academy/contracts`).

### Loading bars for unknowable-duration actions

User-triggered actions whose total time can't be predicted (LLM calls, multi-step pipelines) use the shared `useFakeProgress` hook + `<ProgressBar>` in `shared/hooks/`. The hook drives an asymptotic curve `ceiling * (1 - exp(-t / tauMs))` that plateaus near 92% until the real response lands, then snaps to 100%. Pick `tauMs` to match the typical "feels half done" point. Currently used in CV upload (`tau=12s`), CV finalise (adaptive: ~4s × new-bullet-count), Coach Understanding (`tau=15s`), and Interview Prep extract-from-URL (`tau=8s`). Don't roll new spinners for these flows — extend the existing hook instead.

### Backend layout

- `backend/src/main.ts` — entry, CORS reads `FRONTEND_URL` (comma-split for multiple origins); also kicks off `startCvAnalysisReaper()` (sweeps stuck CV-analysis jobs from `lib/cv-analysis-reaper.ts`). Env loading is path-flexible: tries `./.env` then `./backend/.env` (`main.ts:24-36`), so the backend boots from either repo root or the `backend/` workspace.
- `backend/src/routes/` — thin HTTP handlers; inspect thrown `Error.statusCode`/`step` and map to HTTP codes (`routes/dream-company.ts` is the canonical pattern). CV Library coach flow is split across `routes/coach-answer.ts` (answering gap questions) and `routes/coach-understanding.ts` (the understanding-report sibling) — see `docs/COACH_ANSWER_FLOW.md` for how they fit together.
- **Two interview routes**: `routes/interview.ts` owns the live interview turn loop (`/api/interview`, `/api/evaluate`); `routes/interview-prep.ts` owns the prep-session lifecycle (sessions, assessments, coaching). New endpoints go in whichever matches the surface — don't merge them.
- `backend/src/services/` — business logic + LLM calls. Outreach has the most fan-out: `outreach.service.ts` is the orchestrator and delegates to `outreach-extractor`, `outreach-enrichment`, `outreach-jd-validator`, and `outreach-rerank` — when touching outreach, find the right sub-service first.
- `backend/src/lib/` — prompts, Anthropic SDK helpers, plus integration clients: `voyage.ts` (embeddings), `exa-client.ts` (web search), `cost-tracker.ts` (LLM cost logging to `cost-log.jsonl`)
- `backend/src/config/llm.ts` — feature → model + API key mapping (per-feature env overrides)

### Shared contracts

Types and error shapes shared between frontend and backend live in `packages/contracts` (`@advance-academy/contracts`, a workspace package). Use it for any cross-layer type.

### Persistence

- **Interview Prep + CV Library** persist to Supabase via `backend/src/lib/supabase.ts` (`getSupabase()` for service-role access, `getUserIdFromToken()` for the auth hook). Migrations live in `supabase/migrations/` and are applied manually through the Supabase SQL editor (no migration CLI in this project); `supabase/migrations/schema_May_5_2026.sql` is the last full schema dump, but it **predates migrations 012–045** (leads, trial tier, referral, credit wallet, admin actions, tool results, user approval, coaching sessions, user–lead link, saved jobs, the career-hub `024_ch_*` tables, contacts, cover letter, engagement) — read the numbered files for anything newer. **After applying any migration by hand, verify RLS actually took on the live DB** — run `select tablename, rowsecurity from pg_tables where schemaname='public' and rowsecurity=false;` and expect zero rows. A table whose `enable row level security` lives only in the dump but was never run on live (as happened to `cv_analysis_jobs` — created by migration 005 with no RLS statement, so the dump's ALTER never applied), or one absent from the dump entirely (`company_additional_url`, migration 008), triggers Supabase's `rls_disabled_in_public` Critical alert and is publicly read/writable via the anon key. `011_rls_hardening_sweep.sql` is the idempotent re-enable-everywhere fix. See `docs/CV_KNOWLEDGE_BASE.md` for the coach-answer / JIT-clarification flow.
- **Job Tracking** (AI Job Tools 1.3, migration `023_saved_jobs.sql`): `saved_jobs` (one card per tracked role, `status` text+CHECK over `saved → preparing → applied → follow_up → interview → offer | rejected`) and the append-only `job_events` (one row per status change, `user_id` denormalised so gamification can count without a join). Duplicate detection is the partial unique index on `(user_id, url_key)` where `url_key` is the normalised host+path from `backend/src/lib/job-tracking.ts` — the same rule `dedupeJobs` uses in job search. Backend is `routes/job-tracking.ts` + `services/job-tracking.service.ts` at `/api/job-tracking`; it deliberately calls neither `spendCredits` nor `recordToolResult` (zero LLM, zero credits). Frontend lives at the real route `/jobs` (`features/job-tracking/`), not a `?view=`, so Career Hub can deep-link `/jobs?add=<url>&title=&company=` to pre-fill the add form. `SaveJobButton` is the reusable "Save" for any tool that shows a vacancy; Dream Company's "Currently Hiring" cards use it, which is why `ExaJobListing` now carries optional `company` / `location` / `salaryText`.
- **App 1 workflow (migrations 044–045).** Career Hub job rows (`features/career-hub/components/job-item.tsx`) link to `/jobs?add=…&source=career_hub` (Save) and `/cover-letter?url=…` — a signed-out visitor goes through `/login?next=…` and comes back (`shared/auth/next-path.ts`; the magic link carries `next` via localStorage). **Cover Letter** (`/cover-letter`, `routes/cover-letter.ts` → `services/cover-letter.service.ts`) takes a CV Library version + a saved job or pasted job; a thin JD with a link is fetched via `extractJobFromUrl` first; the letter and CV are written back onto the card (`cover_letter_text`, `cv_version_id`) and a `saved` card moves to `preparing`. **Assisted Apply** is the per-job page `/jobs/[id]/apply` — frontend only, it chains existing tools (`?savedJob=<id>` is read by CV Optimizer, Cover Letter and Interview Prep) and marks the card applied when the student confirms on returning from the employer's site. **Progress & Engagement**: weekly tasks are fixed in `packages/contracts/src/engagement.ts` and ticked off from `job_events`/`tool_results`/`saved_jobs`; `points_ledger` holds points (a score, never credits — don't route them through `lib/credits.ts`); reminder emails (`lib/engagement-reminder.ts`, hourly in-process like the CV reaper, deduped by `reminder_sends`) ship dark behind `ENGAGEMENT_REMINDERS_ENABLED=true`.
- **CV Optimizer** uses an async job pattern: `POST /api/cv-optimizer/analyze` returns `202 + jobId`; the client polls `GET /api/cv-optimizer/jobs/:jobId`. Jobs are persisted to the Supabase `cv_analysis_jobs` table via `createCvAnalysisJob` / `getCvAnalysisJob` in `backend/src/services/cv-optimizer.service.ts`, so polls are safe across multiple backend instances.
- **CV Optimizer V2** is the live path (`CV_OPTIMIZER_USE_V2=true`; orchestrator `backend/src/services/cv-agents/build-llm-analysis-v2.ts`, all branches Haiku via `cv-agents/models.ts`). Structure, keywords, ATS (two chained calls) and alignment fan out in parallel; **bullets** — the slowest branch, output grows per bullet — splits the CV into ≤4 parts evaluated in parallel (`splitCvIntoParts`), and `rewriteSuggestions` is derived from the weakest bullets' `autoRewrite` (`deriveRewriteSuggestions`) rather than generated. The action plan starts once the four fast branches land and runs **alongside** bullets, so it gets no bullet stats. Every CV call uses `CV_LLM_CLIENT_OPTIONS` (120s, 1 retry) so a stuck call fails to its branch fallback instead of hitting the 10-min stale-job reaper. Per-branch timings print as `⏱️ [v2] …` on stdout (CV calls aren't in `cost-log.jsonl`); on a 13-bullet sample CV + JD (2026-10-09) the total went 52.7s → 28.6s, with the action plan (~17s after an ~11s fan-out) now the critical path.
- **Interview Prep job picker**: the setup step offers the student's tracked jobs (`useSavedJobs` + the `TERMINAL_SAVED_JOB_STATUSES` filter, same as Cover Letter) and fills title/company/JD from the list; a thin JD pre-fills the extract-from-URL box. `?savedJob=<id>` goes through the same `applySavedJob`. Starting a prep session does **not** move the card's status (unlike Cover Letter / CV Optimizer).

### CV Library design notes

- **No blob storage anywhere.** Gap artifact intake is text-only — `POST /api/cv-library/gaps/:gapId/artifacts` accepts `{ text }` only, the file and URL options were intentionally removed. Historical rows with `source_type` of `'file'` or `'url'` are read-only; do not reintroduce write paths or a Supabase Storage bucket. CV upload still accepts PDF/DOCX but only stores extracted text + the original filename in `cv_versions.source_file_path` (it's metadata, not a blob path). The same stance is why `extractTextFromUrl` is no longer imported from `cv-knowledge.service` even though the helper still exists for outreach.
- **Artifact edits re-summarise.** `PATCH /api/cv-library/artifacts/:artifactId` updates `content_text` and re-runs the LLM summariser so `summary_json` stays consistent with the raw text. Both `addArtifactToGap` and `updateArtifactText` go through the shared `summarizeArtifactText(rawText, gapQuestion)` helper in `cv-knowledge.service.ts` — keep them aligned if you change one.

### Interview-prep refactor note

Earlier versions kept interview-prep LLM + DB calls inside Next.js route handlers (`app/api/interview/route.ts`, `app/api/evaluate/route.ts`, `app/api/interview/sessions/*`). These have been moved to Fastify (`backend/src/routes/interview.ts` + `backend/src/services/interview.service.ts`). The `app/api/interview/*` and `app/api/evaluate/*` files are now thin proxies. Any new interview-prep work goes in the backend.

### Interview-prep prompt caching

`startInterviewSession` and `sendInterviewMessage` in `backend/src/services/interview.service.ts` use Anthropic prompt caching (1-hour TTL) on two breakpoints: (1) the system block holding `persona.systemPrompt + buildContextPreamble(JD + CV)` (~3500–5700 tokens — the static prefix that's identical across all turns of one session); and (2) the last assistant message in the conversation (multi-turn caching, so the growing history caches turn-over-turn). The `[IMPORTANT: This is the final exchange]` addendum is intentionally placed in a **separate, uncached** system text block — keep it that way, otherwise concatenating it into the cached prefix invalidates the cache on the final turn. Both calls log `[interview-prep:start]` / `[interview-prep:turn]` lines with `cache_read` / `cache_write` token counts so you can verify hits in dev. `scoreAnswer` (irs-scoring.ts) and `generateFeedbackReport` (feedback-engine.service.ts) are intentionally **not** cached — see `docs/INTERVIEW_PREP_WORKFLOW.md` for the full rationale, the Sonnet 4.0 caching constraints (1024-token min prefix, 4-breakpoint cap, 20-block lookback), and the silent-invalidator audit checklist.

### Coach-answer two-phase flow

`/api/interview/coach-answer` is split into **preview** and **generate** (`backend/src/services/coach-answer.service.ts` + `routes/coach-answer.ts`). Preview runs **embedding-based retrieval** over the user's CV bullet pool — top-K=5, cosine-similarity threshold 0.50, via the `match_bullets` Supabase RPC defined in `supabase/migrations/007_match_bullets_rpc.sql` (HNSW index over `cv_bullets.bullet_embedding`). It returns the preselected bullets with their gaps + **raw artifact text** plus a lightweight pool of every user bullet for an "add bullet" picker — no LLM tokens spent. The user reviews/edits the selection in `CoachPanel` (`features/interview-prep/components/interview-prep-screen.tsx`), then generate runs the rewriter LLM with the user's edited `selectedBulletIds`, the recent conversation history (last 10 turns), the IRS score, and the per-dimension `rationale_json` pulled server-side from `answer_assessments`. Raw artifact `content_text` is intentionally **never** sent to the LLM — only `summary_json`. See `docs/COACH_ANSWER_FLOW.md` for the full sequence diagram, prompt-input table, latency budget, and failure modes (including the `match_bullets` silent-fallback that also affects the CV-Library merge feature when migration 007 isn't applied).

### Timeouts (know these before debugging hangs)

- Frontend `fetchJson`: 15s; `fetchFormDataJson`: 120s (`shared/api/http-client.ts`)
- Backend client per-feature: 10–120s (`shared/api/backend-client.ts`) — Dream Company is 120s because it runs 4 sequential LLM calls
- LLM HTTP call: 30s default, override with `LLM_TIMEOUT_MS`

### Authentication

Supabase-based bearer-token auth is enforced on the backend. A Fastify `preHandler` hook in `backend/src/main.ts` rejects any request without an `Authorization: Bearer <token>` header, validates the token via `getUserIdFromToken()` in `backend/src/lib/supabase.ts` (which calls `supabase.auth.getUser()`), and attaches `request.userId` for routes/services to use. Fully public (no token): `/api/health`, `/api/system`, `/api/leads/capture`, `/api/leads/confirm`, `/api/leads/unsubscribe`, `/api/auth/passwordless`, `/api/engagement/unsubscribe` (HMAC token in the link is the credential), anything under `/api/public/` (counts only, no personal data — e.g. the company-contacts summary) — matched with `startsWith`, so `GET /api/leads` (admin) stays gated.

**Sign-up is passwordless.** `POST /api/auth/passwordless` (`services/passwordless.service.ts`) mints a trial account server-side with a throwaway password and emails a Supabase magic link; `app/(auth)/register/page.tsx` and the login page's "email me a link" fallback both go through it. There is no password-signup path.

**The approval gate (migration 018).** The *same* preHandler then checks `users.status` and returns **403 `ACCOUNT_PENDING` / `ACCOUNT_REJECTED`** for anything not `'approved'` — 403 not 401, because the token is valid and the frontend must tell the two apart. This is the one choke point every route already passes through, so new features are gated with no per-route work. `GET /api/account/me` is the sole authenticated exemption (**exact** path match, so a future `/api/account/*` sibling isn't accidentally exempt) — it's how `/pending` reads its own state.

- `backend/src/lib/user-access.ts` owns it: `getUserStatus()` (60s in-memory `Map` cache, **fails closed** — a missing row reads as `pending`) and the pure `approvalError()`, unit-tested in `user-access.test.ts`.
- `invalidateUserStatus()` is called from `admin.service.ts` on review, so approvals take effect immediately rather than after the TTL. If you add another write path for `users.status`, call it there too.
- `is_admin` (migration 015, resolved by `lib/admin.ts` with the `ADMIN_USER_IDS` env allowlist) does **not** bypass the gate — a pending admin is 403'd off `/admin` too. Admin rights are deliberately not cached in `user-access.ts`; two caches of one fact drift.
- Orthogonal to the credit wallet: `status` answers "is this person allowed in at all", `tier`/`credit_balance` (`lib/credits.ts`) answer "how much can they spend once they are".
- Accepted consequence: the quiz lead funnel (`routes/leads.ts`) also mints accounts that land `pending`, so the funnel feeds an approval queue. Referral payouts fire from `spendCredits` on first tool use, so they are delayed until approval, not lost.

The Next.js proxy layer pulls the user's token with `getProxyAuthToken()` and forwards it through `shared/api/backend-client.ts`, which sets the `Authorization` header when a token is present. Frontend calls that need auth must thread the token through the proxy — see the recent fixes in commits `e72a65f`, `f776727`, `a4f46ca` for the canonical wiring.

A second auth layer lives at the Next.js edge: `middleware.ts` in the repo root reads the `aa-session` cookie on every non-`/api` route — absent → `/login`, `pending`/`rejected` → `/pending`, `approved` on `/pending` → `/`. The literal `'1'` means "status not loaded yet" and falls through. This gates page navigation only; it intentionally excludes `/api/*` so the proxy routes can run their own bearer-token forwarding. Public paths are the `PUBLIC_PATHS` list described at the top (`/auth/callback` is public because the magic-link token arrives in the URL hash and never reaches the server).

**The cookie is a forgeable UX hint, not a gate** — it is set with `document.cookie` in `AuthContext.syncSessionCookie`. The real enforcement is the backend 403. Never put server-rendered data behind the cookie check. A 403 that arrives mid-session is caught centrally in the `HttpClientError` constructor (`shared/api/http-client.ts`), which re-syncs the cookie and hard-navigates to `/pending` — don't add per-feature handling for these codes.

### Rate limiting

`@fastify/rate-limit` is registered globally with `global: false` (opt-in per route) in `backend/src/main.ts`, returning `{ code: 'RATE_LIMIT_EXCEEDED', message }` on 429. The plugin is configured with `hook: 'preHandler'` so route-level `keyGenerator` callbacks can read `request.userId` from the auth preHandler. Current per-route caps:

- CV Optimizer `/analyze`: 5 / 10 minutes, keyed by IP (`backend/src/routes/cv-optimizer.ts`)
- Dream Company: 10 / minute, keyed by IP, via a `RATE_1MIN()` helper (`backend/src/routes/dream-company.ts`)
- Outreach: 5–20 / minute, keyed by IP (`backend/src/routes/outreach.ts`)
- **Interview start** (`POST /api/interview` with `action: 'start'`): **5 / hour, keyed by user**. The same route also handles per-turn `action: 'message'` calls — those are explicitly bypassed via `allowList`, otherwise a single 5-question session would self-throttle. (`backend/src/routes/interview.ts`)
- **Coach answer preview** (`POST /api/interview/coach-answer/preview`): **10 / minute, keyed by user** — embedding retrieval, no LLM, so the cap is loose (`backend/src/routes/coach-answer.ts`)
- **Coach answer generate** (`POST /api/interview/coach-answer/generate`): **1 / minute, keyed by user** — runs the rewriter LLM (`backend/src/routes/coach-answer.ts`)
- **Coach understanding generate** (`POST /api/coach-understanding/generate`): **1 / 10 minutes, keyed by user** (`backend/src/routes/coach-understanding.ts`)
- **Extract job from URL** (`POST /api/interview-prep/extract-job-from-url`): **5 / 10 minutes, keyed by user** (`backend/src/routes/interview-prep.ts`)
- **Passwordless sign-up** (`POST /api/auth/passwordless`): **5 / minute, keyed by IP** — public route, so IP is the only key available (`backend/src/routes/auth.ts`)
- **Cover letter** (`POST /api/cover-letter/generate`): **10 / day, keyed by user** (`DAILY_LIMIT_COVER_LETTER`), plus 1 credit (`backend/src/routes/cover-letter.ts`)
- **Company contacts** (`GET /api/company-contacts/:companyId`): **30 / minute, keyed by user**, Membership only (`requireMembership`) — no LLM, the cap stops scraping. The public `/api/public/company-contacts/:id/summary` is 60 / minute by IP (`backend/src/routes/company-contacts.ts`)

`/api/admin/*` and `GET /api/account/me` are deliberately **not** rate-limited: admin-only or single-row reads, no LLM spend. `/api/admin/*` has no `preHandler` either — each handler calls `isAdminUser(request.userId)` inline and 403s.

When adding a new route that hits an LLM, opt it in with a `config.rateLimit` block. For per-user limits, set `keyGenerator: (req) => req.userId ?? req.ip` and provide a route-specific `errorResponseBuilder` so the frontend can show a feature-tailored message — `hooks/use-interview.ts` reads `body.message` from the 429 response and surfaces it in the existing red error banner.
