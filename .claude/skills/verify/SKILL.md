---
name: verify
description: Verify a change in this repo before committing — type checks, all three test suites, and the build when routes or config changed. Use after any code change and before every commit.
---

# Verify

1. `npm run check` from the repo root (frontend + backend type checks, vitest,
   backend `node:test`, backend-python self-checks). It stops at the first failure.
2. Added, moved or deleted a page/route, or touched `next.config.mjs`, `middleware.ts`
   or `packages/contracts/package.json`? Also run `npm run build:all`. Note that
   `next build` ignores type errors (`ignoreBuildErrors`), so step 1 is still required.
3. Removed imports or code? `npx tsc --noEmit --incremental false --noUnusedLocals --noUnusedParameters`
   should report nothing new.

Common failures:

- `Cannot find module '…/app/api/…/route.js'` in `.next/types` or `.next/dev/types`
  after deleting a route — stale generated types: `npx next typegen`, and delete
  `.next/dev/types` if no dev server is running.
- `FAIL test_<name>.py` — rerun `cd backend-python && .venv/bin/python test_<name>.py`
  for the full output. Several Python checks read frontend files and migrations
  through `repo_paths.py`; a moved file means updating that module.
- A contracts import that type-checks but fails at runtime in Next.js — a value was
  imported from the package root instead of its subpath.

UI changes are not covered by tests: say so when reporting, and run
`npm run dev:all` to look at the screen if a browser is available.
