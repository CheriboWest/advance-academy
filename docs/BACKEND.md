# Backend

The backend is a Fastify + TypeScript workspace at `backend/`. It is LLM-powered. Most routes are stateless request/response, but Interview Prep and the CV Library persist to Supabase Postgres via `backend/src/lib/supabase.ts`. See [CV_KNOWLEDGE_BASE.md](./CV_KNOWLEDGE_BASE.md) for the persistent flows.

## Tech stack

| Area | Choice |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Fastify 5 |
| Language | TypeScript (ES2022, strict mode) |
| LLM SDK | `@anthropic-ai/sdk` |
| CORS | `@fastify/cors` |
| File uploads | `@fastify/multipart` |
| PDF parsing | `pdf-parse` |
| DOCX parsing | `mammoth` |
| Database | `@supabase/supabase-js` (Interview Prep + CV Library only) |
| Vector search | `pgvector` Postgres extension, enabled in migration `003` |
| Embeddings | Voyage AI `voyage-3.5-lite` (1024 dims) via plain `fetch` — no SDK. Used by CV Library for cross-CV similarity search. |
| URL fetching | `fetch` against `https://r.jina.ai/` (Outreach + CV Library) |
| Dev runner | `tsx` |

Scripts (from `backend/package.json`):

```bash
npm run build          # tsc → dist/
npm run start          # runs from dist/
npm run start:dev      # tsx watch src/main.ts
npm run typecheck      # tsc --noEmit
```

From the repo root you can also use `npm run dev:backend` and `npm run build:backend`.

## Directory layout

```
backend/src/
├── main.ts                              Entry point — registers all route bundles
├── pdf-parse.d.ts                       Ambient types for pdf-parse
├── config/
│   └── llm.ts                           Feature → model mapping + provider config
├── routes/                              Thin HTTP handlers
│   ├── system.ts                        GET /api/health
│   ├── cv-optimizer.ts                  POST /analyze, GET /jobs/:jobId, GET /template
│   ├── dream-company.ts                 POST /generate, POST /parse-cv
│   ├── outreach.ts                      POST /generate, POST /extract
│   ├── interview-prep.ts                POST /api/interview-prep/extract-job-from-url
│   ├── interview.ts                     POST /api/interview, POST /api/evaluate, GET /api/interview/sessions[/:id]
│   ├── coach-answer.ts                  POST /api/interview/coach-answer
│   ├── coach-understanding.ts           POST /api/coach-understanding/generate, GET /reports[/:id]
│   └── cv-library.ts                    /api/cv-library/* (versions — two-phase upload, finalize, bullets/similar, bullets/merge, gaps, artifacts, jit-clarification, backfill-embeddings)
├── services/                            Business logic
│   ├── system.service.ts
│   ├── cv-optimizer.service.ts          Async job queue + heuristic fallback
│   ├── dream-company.service.ts         4-step Anthropic SDK pipeline
│   ├── outreach.service.ts              Single-call message generation
│   ├── outreach-extractor.service.ts    File + URL text extraction (Jina)
│   ├── job-extraction.service.ts        Jina + LLM → structured ExtractedJob
│   ├── interview.service.ts             startInterviewSession / sendInterviewMessage / evaluateInterview
│   ├── feedback-engine.service.ts       Final-report LLM call
│   ├── cv-knowledge.service.ts          CV Library: two-phase upload, pgvector similarity search, bullet merge, user-scoped bullet pool
│   ├── coach-answer.service.ts          Grounded "enhanced answer" coach — queries the whole user pool, not one CV version
│   └── coach-understanding.service.ts   Markdown "AI Coach Understanding" reports (profile + duplicate detection + gap analysis)
├── lib/                                 Pure helpers
│   ├── llm-anthropic.ts                 Anthropic SDK wrapper (assertLlmConfigured / createAnthropicClient / getFeatureModel)
│   ├── supabase.ts                      Supabase service-role client + getUserIdFromToken() (auth-hook validator)
│   ├── voyage.ts                        Voyage embedding HTTP client — embedText / embedTexts / isVoyageConfigured
│   ├── dream-company/prompts.ts
│   ├── outreach/prompts.ts
│   ├── cv-knowledge/prompts.ts          Bullet extraction, gap generation, summarize-with-quotes, coach prompt
│   └── interview-prep/                  personas.ts, irs-scoring.ts, db.ts (Supabase helpers)
└── types/
    ├── dream-company.ts
    ├── outreach.ts
    ├── interview-prep.ts                Interview-prep core types (mirrors features/interview-prep/types.ts)
    └── cv-knowledge.ts                  Row + DTO types for CV Library + coach-answer
```

## Bootstrap

`backend/src/main.ts` does exactly four things:

1. **Load env** — `loadBackendEnvFile()` looks for `.env` in the cwd, then `backend/.env`, and calls Node's native `process.loadEnvFile`.
2. **Configure CORS** — reads `FRONTEND_URL`, splits on commas, passes to `@fastify/cors`.
3. **Register routes** — `registerSystemRoutes` → `registerCvOptimizerRoutes` → `registerDreamCompanyRoutes` → `registerOutreachRoutes` → `registerInterviewPrepRoutes` → `registerCvLibraryRoutes` → `registerCoachAnswerRoutes` → `registerInterviewRoutes` → `registerCoachUnderstandingRoutes`.
4. **Listen** — `0.0.0.0:PORT` (default `4000`).

If you add a new route module, **you must call it here** or the routes will never be reachable.

## Layered architecture

Three layers, one rule each:

### 1. `routes/` — thin HTTP handlers

- Parse the request body (type guard).
- Call exactly one service function.
- Catch errors and map to HTTP status codes.
- **No business logic.** If you find yourself writing an `if`/`else` that makes a product decision, it belongs in the service.

Canonical example: `backend/src/routes/dream-company.ts:18-66`.

### 2. `services/` — business logic

- Own all decisions: what to prompt, what to retry, how to shape the response.
- Return plain typed objects.
- Throw errors carrying `statusCode` and/or `step` properties when something goes wrong so the route can map them cleanly.
- **Do not import `fastify`.** Services are Fastify-agnostic so they can be unit tested or reused.

### 3. `lib/` — pure helpers

- Prompts, SDK wrappers, JSON parsers.
- No I/O beyond the LLM call itself.
- No Fastify types.
- Anything that could move to a separate npm package without friction belongs here.

## LLM integration

### `lib/llm-anthropic.ts` + Anthropic SDK

- The one place the official `@anthropic-ai/sdk` client is built; every LLM feature goes through it.
- Resolves the per-feature model and API key from `config/llm.ts`; `assertLlmConfigured` and `withRetry` live here too.
- `lib/run-json-task.ts` is a narrow one-call → JSON helper on top of it, used only by the CV Optimizer V2 agents.

### Model configuration

`backend/src/config/llm.ts` maps each feature to an env var:

| Feature | Env var | Default |
|---|---|---|
| CV Optimizer | `LLM_MODEL_CV_OPTIMIZER` | `LLM_MODEL_DEFAULT` |
| Dream Company | `LLM_MODEL_DREAM_COMPANY` | `LLM_MODEL_DEFAULT` |
| Outreach | `LLM_MODEL_OUTREACH` | `LLM_MODEL_DEFAULT` |
| Interview Prep | `LLM_MODEL_INTERVIEW_PREP` | `LLM_MODEL_DEFAULT` |
| Interview IRS scoring | `LLM_MODEL_INTERVIEW_SCORING` | `LLM_MODEL_INTERVIEW_PREP` |

To change a model for a single feature, set only the feature-specific env var.

## Error handling pattern

Look at `backend/src/routes/dream-company.ts:28-65`. It's the template. The rules:

1. **Service throws** an `Error` with `statusCode` (our own) or `status` (from Anthropic SDK) or `step` (which step of a multi-step pipeline failed).
2. **Route catches** and inspects those properties:
   - `statusCode === 503` → "LLM is not configured (set `LLM_API_KEY`)"
   - Anthropic `status === 401` → "Anthropic API rejected the key"
   - Anthropic `status === 404` → "Model not accessible, set `LLM_MODEL_*`"
   - Has `step` → 500 with `{ error, step }` so the frontend can show "failed at step X"
   - Otherwise → `request.log.error(error)` + 500
3. **Never leak raw error messages** that contain stack traces or internal paths. Use the helpful strings in the canonical example.

When you add a new route, **copy this catch block** and adapt the strings. Do not invent a new error-handling pattern per route.

## Async job pattern (CV Optimizer)

CV Optimizer is the only feature with long-running async work. It uses an in-memory job queue:

```ts
const jobs = new Map<string, JobStatusResponse<AnalyzeCvResult>>()
```

Flow:

1. `POST /api/cv-optimizer/analyze` — accepts the request, generates a UUID, stores `{ status: 'pending' }` in the map, kicks off the work asynchronously, returns `202 { jobId }`.
2. `GET /api/cv-optimizer/jobs/:jobId` — reads from the map, returns current status or the finished result.
3. The frontend polls every `1500ms` (see `shared/env/client.ts:cvAnalysisPollIntervalMs`).

**Do not use this pattern lightly.** It works for CV Optimizer because analysis finishes in under a minute on a single process. It breaks if you deploy multiple backend instances without sticky sessions. See [ARCHITECTURE.md](./ARCHITECTURE.md#state--persistence) for the full warning.

If you need durable async work, you need to introduce a queue (Redis + BullMQ or similar) first.

## File upload pattern

`@fastify/multipart` is registered **inside a scoped plugin**, not globally, so only routes that actually accept files get the overhead. See `backend/src/routes/dream-company.ts:68-128`:

```ts
await app.register(async (scoped) => {
  await scoped.register(multipart, {
    limits: { fileSize: 15 * 1024 * 1024 },
  })

  scoped.post('/api/dream-company/parse-cv', async (request, reply) => {
    const data = await request.file()
    // ... validate filename ends with .pdf or .docx
    const buffer = await data.toBuffer()
    // ... call service
  })
})
```

Rules:

- **15 MB limit.** Hard-coded in the plugin registration. Change it in one place.
- **Whitelist by extension.** `.pdf` and `.docx` only. Reject others with 400.
- **PDF → `pdf-parse`, DOCX → `mammoth`.** Both libraries are already installed.
- **Errors from parsing → 422.** The file was valid multipart but unreadable.

## Adding a new backend feature — 5-step checklist

Assume you're adding a "Job Tracker" feature. (The frontend side is in [ADD_A_FEATURE.md](./ADD_A_FEATURE.md).)

1. **Types** — `backend/src/types/job-tracker.ts` with `JobTrackerInput` and `JobTrackerResult`.
2. **Prompts** — `backend/src/lib/job-tracker/prompts.ts` with `JOB_TRACKER_SYSTEM_PROMPT`.
3. **Service** — `backend/src/services/job-tracker.service.ts` with `analyzeJob(input): Promise<JobTrackerResult>`. Throw `Error` with `statusCode: 503` if `LLM_API_KEY` is missing. Call the model through `lib/llm-anthropic.ts` (`createAnthropicClient('jobTracker')` + `getFeatureModel`).
4. **Config** — `backend/src/config/llm.ts`: add `jobTracker` to the feature map, reading `LLM_MODEL_JOB_TRACKER`.
5. **Route** — `backend/src/routes/job-tracker.ts` with `registerJobTrackerRoutes(app)`. Copy the catch block from `routes/dream-company.ts`.
6. **Register** — in `backend/src/main.ts`, import and call `registerJobTrackerRoutes(app)` after the existing routes.
7. **Env** — add `LLM_MODEL_JOB_TRACKER=` to `backend/.env.example`.

See [ADD_A_FEATURE.md](./ADD_A_FEATURE.md) for the full end-to-end walkthrough including the frontend side.
