# app/api — Next.js proxy routes

Every browser call to the Fastify backend goes through a route here. They are
thin, but not optional; each one does three jobs:

1. Keeps `BACKEND_URL` server-only (read via `shared/env/server.ts`).
2. Validates the request body with a type guard before forwarding — a malformed
   body never reaches Fastify (return `400 { code: 'INVALID_REQUEST', message }`).
3. Forwards the user's token (`getProxyAuthToken(request)` → the `*WithBackend`
   function in `shared/api/backend-client.ts`) and turns `HttpClientError` into the
   `ApiErrorResponse` shape (`{ code, message }`) with the backend's status.

Canonical example: `outreach/generate/route.ts`.

- Paths mirror the backend: `app/api/x/y/route.ts` ↔ Fastify `/api/x/y`.
- Streaming (SSE) routes use `proxyStream` instead of `backend-client.ts`
  (`dream-company/*/stream`).
- `interview/*` and `evaluate` used to hold LLM and DB logic; they are thin proxies
  now — new Interview Prep work goes in the backend.
- Career Hub does **not** use this folder: its calls go through the
  `/api/careerhub/*` rewrite in `next.config.mjs` to backend-python.
- Rewrites run after these routes, so a route here can never be shadowed by them.
