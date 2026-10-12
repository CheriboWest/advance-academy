---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "backend-python/test_*.py"
---

# Tests: three runners, one command

- Frontend (`app/`, `features/`, `shared/`, `components/`): **vitest** + jsdom,
  `npm test`. `vitest.config.ts` deliberately skips `backend/` — its tests use `node:test`.
- Backend (`backend/src/**/*.test.ts`): **`node:test` + `node:assert/strict`**, run by
  `npm run test --workspace backend`. A `.spec.ts` file is never run — name it `.test.ts`.
- backend-python (`test_*.py` at the package root): plain scripts with a local
  `check()` helper and a non-zero exit on failure, no pytest. Use the fakes in
  `fake_supabase.py` / `crawl_test_support.py`, never the real database (`.env` is production).
- `npm run check` runs all three plus both type checks. Colocate new tests with the code.
- `test/` at the root is manual: QA spreadsheet and Dream Company harnesses that call
  paid live APIs. Nothing runs them automatically.
