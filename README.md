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
npx tsc --noEmit && npm run typecheck --workspace backend
npm test && npm run test --workspace backend
```

## Documentation

Developer docs live in [`docs/`](./docs/README.md): [Getting Started](./docs/GETTING_STARTED.md),
[Architecture](./docs/ARCHITECTURE.md), [Backend](./docs/BACKEND.md),
[Frontend](./docs/FRONTEND.md), [API reference](./docs/API_REFERENCE.md),
[Conventions](./docs/CONVENTIONS.md), [Add a feature](./docs/ADD_A_FEATURE.md).
