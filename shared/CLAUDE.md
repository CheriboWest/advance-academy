# shared — frontend code used by more than one feature

## api/

- `http-client.ts` is isomorphic (browser features **and** server proxy routes):
  `fetchJson` defaults to 15s, `fetchFormDataJson` to 120s; errors become
  `HttpClientError { status, payload: ApiErrorResponse }`.
- A 403 `ACCOUNT_PENDING` / `ACCOUNT_REJECTED` is handled **centrally in the
  `HttpClientError` constructor** (hard-navigates to `/pending`, browser only).
  Don't add per-feature handling for those codes.
- `backend-client.ts` is **server-only** (reads `BACKEND_URL`): import it only from
  `app/api/*/route.ts`, never from a `'use client'` file or a hook. Its per-call
  timeouts range 10s–300s (CV upload is 300s; Dream Company steps are long) — match
  the backend's real latency when adding one.
- `stream-proxy.ts` (`proxyStream`) forwards SSE responses for streaming routes.
- `proxy-auth.ts` (`getProxyAuthToken`) pulls the user's bearer token in a proxy route.

## auth/

- `authedFetch` / `getAuthHeaders` attach the Supabase token for browser calls; the
  feature `api/frontend-client.ts` files are the only intended callers.
- `next-path.ts` sanitises `?next=` (same-origin paths only). The magic link carries
  `next` through localStorage, because the token arrives in the URL hash.

## components/, hooks/

- Actions with unknowable duration (LLM calls, multi-step pipelines) use
  `useFakeProgress` + `<ProgressBar>`: `ceiling * (1 - exp(-t / tauMs))`, plateaus
  near 92% until the response lands. Pick `tauMs` ≈ the "feels half done" point
  (CV upload 12s, Coach Understanding 15s, extract-from-URL 8s, CV finalise
  ~4s × new bullets). Don't add new spinners for these flows.
- `use-account.ts` reads `/api/account/me` (tier, credits, status).

## env/, config/

- Read env through `env/server.ts` / `env/client.ts`. (Exceptions today: Supabase
  clients in `auth/` and `features/career-hub/lib/`, which need the public keys directly.)
- `config/navigation.ts` is the nav: an item with `href` is a real route; one without
  is a `/?view=` screen (see `features/CLAUDE.md`).
