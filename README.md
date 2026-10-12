# Advance Academy

Career tools for students: CV Optimizer, Dream Company Finder, Outreach,
Interview Prep, CV Library, Cover Letter, Job Tracking, and Career Hub
(company/job search and the coach workspace).

| Part | Stack | Where |
|---|---|---|
| Frontend | Next.js 16 (App Router) + React 19 + Tailwind v4 | `app/`, `features/`, `shared/`, `components/` |
| API | Fastify 5 + TypeScript + Anthropic SDK | `backend/` |
| Career Hub API | FastAPI (Python) | `backend-python/` |
| Shared types | `@advance-academy/contracts` | `packages/contracts/` |
| Database | Supabase Postgres (migrations applied by hand) | `supabase/migrations/` |

## Run

```bash
npm install
cp .env.local.example .env.local         # BACKEND_URL, BACKEND_PYTHON_URL, Supabase public keys
cp backend/.env.example backend/.env     # LLM_API_KEY, FRONTEND_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm run dev:all                          # frontend :3000 + backend :4000
```

Career Hub pages also need `backend-python` on :8000 — see [`backend-python/README.md`](./backend-python/README.md).

## Check

```bash
npm run check   # both type checks + vitest + backend node:test + backend-python self-checks
```

## Documentation

Context lives next to the code it describes: start with [`CLAUDE.md`](./CLAUDE.md)
(a map of the repo), then the `CLAUDE.md` in the folder you are working in —
`backend/`, `backend/src/services/`, `backend-python/`, `supabase/`, `app/api/`,
`shared/`, `features/` and some features. They are written for AI agents and humans alike.
