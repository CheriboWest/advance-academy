---
name: add-feature
description: Add a new tool or endpoint end to end in this repo (contracts type → Fastify route + service → backend-client → Next.js proxy → feature api/hook/component → navigation). Use when adding a feature, a new API endpoint the UI calls, or a new screen.
---

# Add a feature end to end

Work in this order; each layer compiles against the one before it. Model new code
on Outreach generate (`app/api/outreach/generate/route.ts` and its chain) unless a
closer sibling exists. Career Hub features are different: they go to backend-python
via `features/career-hub/lib/` — read `features/career-hub/CLAUDE.md` instead.

1. **Contract** — request/response types in `packages/contracts/src/<module>.ts`.
   New module → add its subpath to `packages/contracts/package.json` `exports`.
2. **Service** — `backend/src/services/<feature>.service.ts`. LLM calls go through
   `lib/llm-anthropic.ts` (`assertLlmConfigured`, `createAnthropicClient`,
   `getFeatureModel`); prompt text in `lib/<feature>/prompts.ts`; a new model/key goes
   in `config/llm.ts`. Throw `Error` with `statusCode` (and `step` for pipelines).
   Add a colocated `*.test.ts` (node:test) for any non-trivial pure logic.
3. **Route** — `backend/src/routes/<feature>.ts` exporting `register<Feature>Routes`;
   thin handler, error mapping copied from `routes/dream-company.ts`. LLM route →
   `perUserDaily(...)` from `lib/rate-limit.ts`; charging route → `assertCredits` before
   and `spendCredits` after. **Register it in `backend/src/main.ts`.** Public route →
   add to `skipPaths` there (keep the prefix specific).
4. **backend-client** — `<verb><Feature>WithBackend(payload, authToken)` in
   `shared/api/backend-client.ts`, `timeoutMs` above the backend's real latency.
5. **Proxy** — `app/api/<feature>/<action>/route.ts`: type-guard the body (400
   `INVALID_REQUEST`), `getProxyAuthToken(request)`, return
   `error.payload`/`error.status` for `HttpClientError`. Path mirrors the backend.
6. **Frontend client** — `features/<feature>/api/frontend-client.ts`, relative URL,
   `fetchJson` + `getAuthHeaders()`; raise `timeoutMs` for LLM calls (default 15s).
7. **Hook** — `features/<feature>/hooks/use-<feature>.ts` (TanStack Query
   `useMutation`/`useQuery`). Never import `backend-client.ts` from client code.
8. **UI** — `features/<feature>/components/`, one file per step/panel. Unknown-duration
   actions use `useFakeProgress` + `<ProgressBar>`.
9. **Wire it up** — `?view=` screen (`ViewName`, `VIEWS_FROM_QUERY`, render branch in
   `app/home-page-content.tsx`) or a real route `app/<route>/page.tsx` with an `href`
   in `shared/config/navigation.ts`. Signed-out access → `PUBLIC_PATHS` in `middleware.ts`.
10. **Schema change?** Use the `add-migration` skill.
11. **Context** — if the feature has a rule an agent would get wrong from the code
    alone, add `features/<feature>/CLAUDE.md` (a few bullets, no folder trees).
12. Run the `verify` skill, then commit with a pathspec.
