# packages/contracts — types shared by frontend and backend

`@advance-academy/contracts` is the single definition of every request/response
shape that crosses the frontend ↔ Fastify boundary. Don't hand-copy a type into
`backend/src/types` or a feature's `types.ts`; import it from here.

- One module per feature (`src/<module>.ts`), each exposed as a subpath in
  `package.json` `exports` — **a new module needs an `exports` entry** or imports fail.
- Frontend imports **values** only from the subpath (`@advance-academy/contracts/leads`),
  never from the package root: `src/index.ts` re-exports with `.js` specifiers that
  Turbopack can't resolve. `import type` from the root is fine.
- Backend imports by package name too (`'@advance-academy/contracts/coaching'`, no `.js`).
- No build step: both sides compile the TypeScript source directly. Keep modules free
  of runtime dependencies so both bundlers accept them.
- Frontend style here (no semicolons, single quotes).
- Pure helpers that must agree on both sides live here too (`contactCategory`,
  `leadsToCsv`, `relativeDay`, engagement task definitions); their tests sit in the
  backend (`node:test`) or `features/career-hub/lib` (vitest), since this package has no runner.
