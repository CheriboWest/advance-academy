# Dream Company — M1 Acceptance-Criteria test harness

Automated + documented checks that grade every M1 acceptance criterion (the sprint's
"Dream Company must be stable, no errors, fully tested" gate).

- **Harness:** [`m1-ac-check.mjs`](./m1-ac-check.mjs) — drives the real HTTP surface and
  prints an AC-by-AC pass/fail matrix.
- Run from the repo root. Requires Node 18+ (uses global `fetch`/`FormData`/`Blob`).
- It calls the JSON steps (`/api/dream-company/{analyze,roles,roadmap}`). The Next.js app in
  this repo only proxies their `/stream` variants, so against a frontend built from here use
  `--base` with the backend URL.

## Run it

```bash
# Production (needs a real production access token — see below)
node test/dream-company/m1-ac-check.mjs --token "<PROD_ACCESS_TOKEN>"

# A specific base URL
node test/dream-company/m1-ac-check.mjs --base https://advance-academy-tools-ashy.vercel.app --token "<JWT>"

# Local backend (npm run dev:all first) — mints a throwaway user automatically,
# because the local backend uses the same Supabase project as backend/.env
node test/dream-company/m1-ac-check.mjs --base http://localhost:4000
```

### Getting a production token

The throwaway-user auto-mint only works locally: `backend/.env` points at the **dev**
Supabase project (`tiumnkknbgnqhrvohnxy`), while the **production** backend on Railway
validates against a *different* Supabase project. A token minted from the dev project is
rejected by prod as `Invalid or expired token`. So to test prod you need a real prod token:

1. Log in at <https://cvadvance.com> as any real user.
2. Open DevTools → Application → Local Storage → the `sb-<ref>-auth-token` entry (or run
   `JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.includes('auth-token')))).access_token`
   in the Console).
3. Copy the `access_token` and pass it as `--token`. (Tokens expire ~1h — grab a fresh one.)

## AC coverage matrix

| AC | Criterion | How it's graded | Where |
|----|-----------|-----------------|-------|
| **M1.1** | Timeout read from config/env, not hard-coded | code-review + `--base local` with env override | `DREAM_TIMEOUTS`, `LLM_TIMEOUT_DREAM_*_MS` |
| **M1.1** | Happy path unaffected by timeout | **harness C1/C2/C3** (prod) | analyze/roles/roadmap 200, under budget |
| **M1.1** | Timeout → controlled 504, no hang | **LOCAL-ONLY** — see §Timeout | env-forceable, don't run on prod |
| **M1.2** | Truncated output → not 500, clear message | **LOCAL-ONLY** — see §Truncation | needs `max_tokens` fault injection |
| **M1.2** | Applies to all 3 generate steps | code-review + §Truncation per step | shared `parseStepResponse()` |
| **M1.2** | Has per-step debug log | code-review / §Truncation | `console.error("{step} hit max_tokens")` |
| **M1.3** | Bad/oversized CV → friendly, no 500 | **harness C5** (unsupported→400) + §Truncation (422) | route + parser |
| **M1.3** | Valid PDF & DOCX still parse | **harness C4** (DOCX) + §PDF (manual) | parse-cv |
| **M1.4** | E2E analyze→roles→roadmap on prod | **harness C1→C2→C3** | full chain 200 |
| **M1.4** | No 404 on any endpoint | **harness C0** + token-free sweep | all routes resolve |

**Why some ACs are LOCAL-ONLY:** the timeout→504 and truncation→502/422 error paths can only
be triggered by shrinking a timeout or `max_tokens`. Doing that on production would break the
tool for real users, so those ACs are graded against a local backend (fault injection), and the
happy-path + routing ACs are graded against production.

## §Timeout — verify M1.1 504 (local)

```bash
# start backend with a tiny analyze timeout, then call analyze
LLM_TIMEOUT_DREAM_ANALYZE_MS=50 npm run dev:backend   # in one shell
# in another shell (token auto-minted against local Supabase):
node test/dream-company/m1-ac-check.mjs --base http://localhost:4000
```
Expected: `analyze` returns **HTTP 504** `"The AI service took too long to respond. Please try again."`
Backend log shows `APIConnectionTimeoutError` → mapped to 504. No hang (aborts in <1s).

## §Truncation — verify M1.2 502 / M1.3 422 (local)

Temporarily force a step to hit `max_tokens`, then revert:

```bash
# in backend/src/services/dream-company.service.ts, set the roles step max_tokens: 8192 -> 16
#   (for parse-cv 422, set the parseCv max_tokens 2048 -> 16 instead)
npm run dev:backend        # restart (tsx-watch does NOT hot-reload on the /mnt/c mount)
# call the step; then: git checkout -- backend/src/services/dream-company.service.ts
```
Expected (roles): **HTTP 502** `{"error":"The AI response was too long and got cut off...","step":"targetRoles"}`,
log `[dream-company] targetRoles hit max_tokens — response truncated.`
Expected (parse-cv with a real file): **HTTP 422** `"This CV is too long to read reliably..."`.

## §PDF — verify M1.3 PDF happy path (manual)

The harness builds a DOCX in-memory. To cover the PDF branch, upload a real PDF CV:
```bash
curl -X POST "$BASE/api/dream-company/parse-cv" -H "Authorization: Bearer $TOKEN" -F "file=@your-cv.pdf"
```
Expected: **HTTP 200** with parsed `degree`/`skills`/`location`/`currentLevel`.

## Evidence already captured

- **Pre-merge (local, branch `fix/dream-company-m1-stability`):** all paths driven — happy
  analyze/roles/roadmap 200; forced timeout→504; forced truncation→502; parse-cv unsupported→400,
  valid DOCX→200. Recorded in `GIANG_progress_report.xlsx` (rows M1.1–M1.4).
- **Post-merge (production, token-free):** deploy live (Railway commit `b67be0c` SUCCESS); all 4
  routes resolve (proxy body-validation 400s, backend auth 401) — **no 404, no 500, no Vercel HTML**;
  proxy forwards `Authorization` correctly. Full happy-path E2E on prod pending a prod token (above).
