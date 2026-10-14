# features — one folder per product feature

## Shape

```
features/<name>/
├── components/   'use client' screens and their parts (one file per step/panel)
├── hooks/        state + async actions; call api/, never backend-client.ts
├── api/          frontend-client.ts — every endpoint the feature calls, relative /api/* URLs
└── types.ts      feature-local types (cross-layer ones go in packages/contracts)
```

- `career-hub` is the exception: it uses `lib/` (server + client helpers) instead of
  `api/` + `hooks/` — see its own CLAUDE.md. `auth` is a React context only.
- Feature code imports other features' `api/` clients when it needs their endpoints
  (Interview Prep uses `cv-library/api`). Anything used by several features with no
  natural owner goes in `shared/`.
- Use `@/` imports. Don't read `process.env` here — use `shared/env`.

## Two kinds of screens

- **`/?view=<name>` screens** — rendered by `app/home-page-content.tsx`: Interview
  Prep (`interview`), CV Optimizer (`cv`), Outreach, Dream Company (`companies`),
  CV Library (`cv-library`), Coaching, History. A new one needs a `ViewName` in
  `shared/types/navigation.ts`, an entry in `VIEWS_FROM_QUERY`, and a render branch
  in `home-page-content.tsx`, or it never shows.
- **Real routes** — `app/<route>/page.tsx` (`/jobs`, `/cover-letter`, `/search`,
  `/companies/*`, `/coach/*`, `/admin`, `/cv-optimizer`, `/cv-library`). Give the
  nav item an `href` in `shared/config/navigation.ts`; add it to `PUBLIC_PATHS` in
  `middleware.ts` only if signed-out users must see it.

## Cross-feature links

- `?savedJob=<id>` is read by CV Optimizer, Cover Letter and Interview Prep to
  pre-fill from a tracked job (see `job-tracking/CLAUDE.md`).
- Long-running actions show `useFakeProgress` + `<ProgressBar>` (see `shared/CLAUDE.md`).
