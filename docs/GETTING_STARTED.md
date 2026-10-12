# Getting Started

This guide takes you from a fresh clone to a running dev environment.

## Prerequisites

- **Node.js 20+** (the project uses Next.js 16 and Node's native `process.loadEnvFile`, which requires Node 20.6+).
- **npm** (the repo uses npm workspaces; do not use pnpm or yarn).
- **An Anthropic API key** — required for Dream Company, Outreach, and the LLM mode of CV Optimizer.
- *(Optional)* **A Jina API key** — only needed if you want the Outreach "extract from URL" feature.

## 1. Install

From the repo root:

```bash
npm install
```

This installs both the frontend dependencies and the `backend` workspace in one step (npm workspaces).

## 2. Environment variables

### Backend — `backend/.env` (required for LLM features)

Copy the template and fill in your key:

```bash
cp backend/.env.example backend/.env
```

The full list of variables the backend reads:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Fastify listen port |
| `FRONTEND_URL` | `http://localhost:3000` | CORS origin. Comma-separate for multiple origins. |
| `LLM_PROVIDER` | `anthropic` | `anthropic` or `openai`-compatible |
| `LLM_BASE_URL` | `https://api.anthropic.com/v1` | LLM API endpoint |
| `LLM_API_KEY` | *(empty)* | **Required** for Dream Company and Outreach |
| `LLM_ANTHROPIC_API_VERSION` | `2023-06-01` | Anthropic API version header |
| `LLM_TIMEOUT_MS` | `30000` | Per-request LLM timeout |
| `LLM_MODEL_DEFAULT` | `claude-sonnet-4-20250514` | Fallback model if no feature override |
| `LLM_MODEL_CV_OPTIMIZER` | same as default | Model for CV Optimizer |
| `LLM_MODEL_OUTREACH` | same as default | Model for Outreach |
| `LLM_MODEL_DREAM_COMPANY` | same as default | Model for Dream Company |
| `LLM_MODEL_INTERVIEW_PREP` | same as default | Model for Interview Prep + CV Library + coach-answer |
| `LLM_MODEL_INTERVIEW_SCORING` | Interview Prep model | Optional separately validated model for IRS scoring |
| `JINA_API_KEY` | *(empty)* | Optional bearer token for `https://r.jina.ai/` URL scraping (Outreach + CV Library + job-extract) |
| `SUPABASE_URL` | *(empty)* | **Required** for Interview Prep + CV Library persistence |
| `SUPABASE_SERVICE_ROLE_KEY` | *(empty)* | **Required** for Interview Prep + CV Library persistence (server-side only — never expose to the browser) |
| `MVP_USER_ID` | `00000000-0000-0000-0000-000000000000` | Owns all Supabase rows until real auth is wired in |
| `VOYAGE_API_KEY` | *(empty)* | Optional. Enables pgvector similarity search in the CV Library (bullet merge suggestions). Free tier at [dash.voyageai.com](https://dash.voyageai.com) includes 200M tokens of `voyage-3.5-lite` — plenty for this workload. Without it, upload still works but the Resolve Bullets step shows no candidates. |

### Frontend — `.env.local` (optional)

The only variable the frontend reads is `BACKEND_URL`, which defaults to `http://localhost:4000`. Create `.env.local` at the repo root only if your backend runs somewhere else:

```bash
# .env.local
BACKEND_URL=http://localhost:4000
```

`BACKEND_URL` is **server-only**: it is read by `shared/env/server.ts` and used by the Next.js route handlers under `app/api/*/route.ts`. The browser never sees it.

## 3. Run in development

| Command | What it does |
|---|---|
| `npm run dev:all` | Runs both frontend and backend concurrently *(recommended)* |
| `npm run dev:frontend` | Next.js dev server on `:3000` |
| `npm run dev:backend` | Fastify with `tsx watch` on `:4000` |

After `dev:all`, you should see:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:4000/api`

## 4. Smoke tests

Verify the backend is up:

```bash
curl http://localhost:4000/api/health
# => {"status":"ok","timestamp":"...","adapter":"..."}
```

Verify the frontend loads by opening `http://localhost:3000` in a browser — you should see the Advance Academy home page with the feature cards. The CV Library lives at `http://localhost:3000/cv-library`.

If you set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, also apply the migrations in `supabase/migrations/` (the SQL Editor in the Supabase dashboard works) so Interview Prep + CV Library can persist data.

Verify end-to-end (Dream Company):

```bash
curl -X POST http://localhost:4000/api/dream-company/analyze \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <supabase access token>" \
  -d '{"profile":{"degree":"CS","workExperience":"2 years frontend","skills":"React, TS","interests":"AI","targetSalary":"80k","location":"Remote"}}'
```

If `LLM_API_KEY` is unset, expect a `503`.

## 5. Build & start (production)

```bash
npm run build:all        # builds backend first, then Next.js
npm run start:backend    # starts compiled Fastify
npm run start:frontend   # starts Next.js in production mode
```

## 6. Degraded mode (no LLM key)

- **CV Optimizer** — falls back to local heuristic scoring and still works.
- **Dream Company** — returns `503` until `LLM_API_KEY` is set.
- **Outreach** — returns `503` until `LLM_API_KEY` is set.
- **Interview Prep** — start/score/report/coach all return `503` until `LLM_API_KEY` is set; session persistence and the CV Library additionally require `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. The interview will still run end-to-end without Supabase, it just won't persist or feed the coach with stored evidence.
- **CV Library** — returns `503` until both Supabase and `LLM_API_KEY` are set (it needs the LLM to extract bullets and generate gaps).

This is intentional so contributors can work on the CV Optimizer UI without needing a key.

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401` from `/api/dream-company/analyze` with a valid token | `LLM_API_KEY` wrong | Check `backend/.env` — the key is rejected by Anthropic |
| `502` mentioning "404 for the configured model" | Model name wrong or your account can't use it | Set `LLM_MODEL_DREAM_COMPANY` (or the feature-specific var) to a model your account has access to |
| CORS error in browser devtools | `FRONTEND_URL` mismatch | Match `backend/.env` `FRONTEND_URL` to where the browser is loaded from, including protocol and port |
| `413` / "File too large" on CV upload | File exceeds 15 MB limit | `@fastify/multipart` is capped at 15 MB in `backend/src/routes/dream-company.ts` |
| `npm run dev:backend` fails with `loadEnvFile is not a function` | Node version < 20.6 | Upgrade Node to 20.6 or later |
| `/api/outreach/extract` URL mode returns empty text | `JINA_API_KEY` missing or target site blocks Jina | Set `JINA_API_KEY` or have the user paste text directly |

## Next steps

- Read [ARCHITECTURE.md](./ARCHITECTURE.md) to understand the request flow.
- Read [ADD_A_FEATURE.md](./ADD_A_FEATURE.md) when you're ready to build something.
