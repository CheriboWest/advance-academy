# features/career-hub — Career Hub (search, companies, coach workspace)

Folded in from career-hub's own Next app. Routes live in `app/search`,
`app/companies/*` (both public, top of the funnel) and `app/coach/*` (admins only);
everything else is here. Data comes from **backend-python**, not Fastify.

## Layout

- `lib/` instead of `api/` + `hooks/`: `*-api.ts` are browser/server clients for
  backend-python, `queries.ts` reads Supabase directly, `coach.ts` is server-side
  coach auth, `types.ts` mirrors the Python schemas, `filters.ts` holds UI presets.
- Files use double quotes and semicolons (the old app's style; the rest of the
  frontend uses neither). Match the file you are editing; don't reformat whole files.

## Reaching backend-python (`lib/api-url.ts`)

- Browser: the same-origin rewrite `/api/careerhub/*` → `BACKEND_PYTHON_URL`
  (`next.config.mjs`). Server code: `careerHubApiUrl()` directly. Both go through
  `api-url.ts` — don't reintroduce a `NEXT_PUBLIC_` URL.
- The rewrite is fixed at **build time** and vanishes when `BACKEND_PYTHON_URL` is
  unset (the build warns), so every Career Hub call 404s until it is set **and** the
  frontend is rebuilt.
- 401 "Unknown token signing key" / "Invalid token issuer" = backend-python is wired
  to a different Supabase project.

## Supabase reads (`lib/supabase.ts`, `lib/queries.ts`)

- Its own anon client, read-only: public pages read the `public_company_summary`
  view and `jobs`. Since migration 048 the view lists **every** company
  (`open_jobs = 0` when none); add `.gt("open_jobs", 0)` where a page means
  "companies hiring" (`/search` default, coach dashboard and companies list).
  The `companies` table itself is not anon-readable since migration 040 — don't
  query it from here.

## Coach workspace

- `isCoach()` in `lib/coach.ts` asks Fastify (`/api/account/me`) so the
  `ADMIN_USER_IDS` allowlist counts; `app/coach/(workspace)/layout.tsx` gates on it.
- Sponsored Companies pages server-side: backend-python `GET /sponsors/companies`
  → SQL `coach_company_page` (migration 048), licensed sponsors by default, with
  contact counts. Don't go back to loading every company into the page.
- Bulk import (`/coach/contacts/import`, `lib/contact-import*.ts`,
  `components/coach/contact-import-*.tsx`) is a thin client of backend-python's
  wizard; the database decides every match (`backend-python/app/contacts_import/CLAUDE.md`).
  The review only offers contact matches at the row's own company.
- Contacts: coaches manage them via backend-python (`/contacts`); students on
  Membership see a reduced shape (no phone/notes) via Fastify on `/companies/[slug]`.
  `SECTOR_OPTIONS` in `lib/filters.ts` must match `backend-python/app/companies/sector.py`.
- Job rows (`components/job-item.tsx`) link to `/jobs?add=…&source=career_hub` (Save)
  and `/cover-letter?url=…`; signed-out visitors go through `/login?next=…` and come back.
