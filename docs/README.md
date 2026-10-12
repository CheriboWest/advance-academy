# Advance Academy — Developer Documentation

This folder is the single source of truth for understanding, running, and extending the Advance Academy codebase.

## Where to start

| If you are... | Read this first |
|---|---|
| New to the project | [GETTING_STARTED.md](./GETTING_STARTED.md) |
| Looking for the big picture | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Building a new feature | [ADD_A_FEATURE.md](./ADD_A_FEATURE.md) |
| Working on the API / backend | [BACKEND.md](./BACKEND.md) + [API_REFERENCE.md](./API_REFERENCE.md) |
| Working on the UI | [FRONTEND.md](./FRONTEND.md) |
| Reviewing a pull request | [CONVENTIONS.md](./CONVENTIONS.md) |

## Index

- **[GETTING_STARTED.md](./GETTING_STARTED.md)** — prerequisites, install, env vars, running dev, smoke tests, troubleshooting.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — high-level system design, the 4-layer request flow, diagrams, the persistence model (Supabase for Interview Prep + CV Library, in-memory for CV Optimizer, stateless for the rest), cross-cutting concerns.
- **[BACKEND.md](./BACKEND.md)** — Fastify layout, routes → services → lib layering, LLM integration, error handling, async job pattern.
- **[FRONTEND.md](./FRONTEND.md)** — Next.js App Router layout, feature module anatomy, HTTP client pattern, proxy routes, state management.
- **[API_REFERENCE.md](./API_REFERENCE.md)** — full HTTP reference for every backend endpoint with request/response types.
- **[CV_KNOWLEDGE_BASE.md](./CV_KNOWLEDGE_BASE.md)** — CV Library schema, bullet/gap extraction, the grounded coach-answer flow, and the JIT clarification loop. Read this before touching anything in `cv_*` / `bullet_*` tables or `coach-answer.service.ts`.
- **[CONVENTIONS.md](./CONVENTIONS.md)** — naming, file layout, layering rules, error shape, environment access, commit style.
- **[ADD_A_FEATURE.md](./ADD_A_FEATURE.md)** — end-to-end walkthrough of adding a new feature using a "Job Tracker" example.

### Feature deep-dives

- **[INTERVIEW_PREP_WORKFLOW.md](./INTERVIEW_PREP_WORKFLOW.md)** — Interview Prep session lifecycle, LLM call sites, persistence, voice mode, prompt caching.
- **[COACH_ANSWER_FLOW.md](./COACH_ANSWER_FLOW.md)** — the "Enhance Response" (coach-answer) flow: retrieval, preview → generate, failure modes.
- **[CV_LIBRARY_UPLOAD_FLOW.md](./CV_LIBRARY_UPLOAD_FLOW.md)** — CV Library upload, from the Upload click to the bullet-resolution screen.
- **[LLM_TOKEN_BUDGET.md](./LLM_TOKEN_BUDGET.md)** — `max_tokens` sizing and token footprints for Interview Prep and CV Library.
- **[PERF_BATCHED_QUERIES.md](./PERF_BATCHED_QUERIES.md)** — the CV Library N+1 fix (batched queries).

### Operations

- **[JOB_SOURCE_RUNBOOK.md](./JOB_SOURCE_RUNBOOK.md)** — Dream Company live-vacancy sources (Adzuna + Reed).
- **[CUTOVER.md](./CUTOVER.md)** — moving the merged schema onto the production Supabase project.

### Planning

- **[BACKLOG.md](./BACKLOG.md)** — product feedback not built yet.
- **[archive/](./archive/)** — finished plans and sprint docs, kept for history. They describe the code as it was when written.

## Keeping these docs accurate

These docs describe patterns that already exist in the codebase (CV Optimizer, Dream Company, Outreach all follow the same shape). If you change a pattern in code, update the corresponding doc in the same PR. If you find a doc that disagrees with reality, trust the code and fix the doc.
