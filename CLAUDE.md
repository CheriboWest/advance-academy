# CLAUDE.md

Advance Academy: career tools for students (CV Optimizer, Dream Company, Outreach,
Interview Prep, CV Library, Cover Letter, Job Tracking, Coaching) plus Career Hub
(company/job search and the coach workspace). This file is the map; each area
keeps its own rules in a `CLAUDE.md` next to the code, loaded when you work there.

| Area | Path | Context file |
|---|---|---|
| Next.js pages | `app/` (`app/api/*` = proxy routes) | `app/api/CLAUDE.md` |
| Feature modules | `features/<name>/{components,hooks,api}` | `features/CLAUDE.md` + per-feature |
| Shared frontend | `shared/{api,auth,components,hooks,env,config}` | `shared/CLAUDE.md` |
| Fastify API | `backend/src/{routes,services,lib,config}` | `backend/CLAUDE.md`, `backend/src/services/CLAUDE.md` |
| Career Hub API (Python) | `backend-python/` | `backend-python/CLAUDE.md` |
| Cross-layer types | `packages/contracts/src` (`@advance-academy/contracts/<module>`) | `packages/contracts/CLAUDE.md` |
| Database | `supabase/migrations`, `supabase/reference` | `supabase/CLAUDE.md` |
| Manual harnesses / QA | `test/` | `test/README.md` |

## This repo is production now

It began as a sandbox merging AdvanceAcademyTools with career-hub. Since the
2026-10-09 cutover the **database is the production Supabase project** and local
`backend/.env` / `backend-python/.env` hold production credentials (staging copies
are `*.staging`). Any write — SQL, scripts, bulk LLM jobs — hits real users: ask first.

- `tools-upstream` and `careerhub` remotes are **fetch-only**; their push URLs are
  `DISABLED-production-repo` on purpose. Don't "fix" them.
- career-hub's history is reachable only with `-m`:
  `git log -m --follow -- backend-python/app/main.py`.

## Git workflow

- **Commit automatically** to the current branch once a task is done and
  `npm run check` passes — no need to ask. On `main`, branch first.
- **Never `git push`** and never open PRs. The user pushes.
- Commit only your files, with a pathspec: `git commit -m "…" -- <paths>`. Plain
  `git add && git commit` sweeps in what the user staged; never `git add -A`.
  Leave the user's own uncommitted or staged changes alone.
- Message: one imperative sentence naming the outcome ("Stop showing raw Anthropic
  errors from Coach Understanding"), then the attribution trailer.

## Commands (repo root)

- `npm run check` — both type checks + vitest + backend `node:test` + Python self-checks. Run before every commit.
- `npm run typecheck` / `npm run test:all` / `npm run test:python` — the pieces of `check`.
- `npm run dev:all` — Next.js :3000 + Fastify :4000. Career Hub also needs
  `cd backend-python && .venv/bin/uvicorn app.main:app --reload --port 8000`.
- `npm run build:all` — `next build` then backend `tsc -p tsconfig.build.json`.
- `npm run usage --workspace backend` (`usage:week`, `usage:month`) — LLM cost report from `backend/cost-log.jsonl`.
- There is no linter. `next.config.mjs` has `typescript.ignoreBuildErrors: true`,
  so `next build` passing proves nothing about types — run `npm run typecheck`.
- Stale `.next/types` errors after deleting a route: `npx next typegen`.

Env: `.env.local` (from `.env.local.example`) for the frontend, `backend/.env`,
`backend-python/.env`. Each `.env.example` documents its variables.

## How a request flows

```
features/<f>/components → hooks → api/frontend-client.ts → app/api/<f>/route.ts
  → shared/api/backend-client.ts → backend/src/routes → services → Anthropic / Supabase
```

New AI features follow this chain (the `add-feature` skill walks it). Career Hub is
the exception: the browser reaches backend-python through the `/api/careerhub/*`
rewrite (see `features/career-hub/CLAUDE.md`).

## Page access (`middleware.ts`)

- Middleware checks for a real `@supabase/ssr` session only; no session → `/login?next=…`.
- `PUBLIC_PATHS` is the one list of pages reachable signed-out (`/login`,
  `/register`, `/auth/callback`, `/search`, `/companies/*`, `/coach/login`,
  `/unsubscribe`). A new public page must be added there or it silently redirects.
- Approval (`users.status`) is **not** checked here: Fastify returns 403
  `ACCOUNT_PENDING`/`ACCOUNT_REJECTED` and `shared/api/http-client.ts` sends the
  user to `/pending`.
- `/coach/*` also requires `users.is_admin` (`app/coach/(workspace)/layout.tsx`,
  and `backend-python/app/auth.py` for the Python API). Coach and admin are the
  same set; there is no `is_coach` column.
