# features/job-tracking — Job Tracking (`/jobs`) and Assisted Apply

- A real route, `/jobs`, not a `?view=`, so other tools can deep-link
  `/jobs?add=<url>&title=&company=&source=` to pre-fill the add form (Career Hub's
  Save, Dream Company's "Currently Hiring" cards via `SaveJobButton`).
- Statuses: `saved → preparing → applied → follow_up → interview → offer | rejected`
  (`packages/contracts/src/job-tracking.ts`; `TERMINAL_SAVED_JOB_STATUSES` are folded
  away and excluded from job pickers). Every change appends a `job_events` row.
- Duplicates are blocked by the DB index on `(user_id, url_key)`; `url_key` is
  `jobUrlKey()` in `backend/src/lib/job-tracking.ts` — the same host+path rule as
  `dedupeJobs` in job search. A duplicate save returns 409 `JOB_ALREADY_SAVED`.
- Zero LLM, zero credits: the backend deliberately calls neither `spendCredits` nor
  `recordToolResult`.
- `SaveJobButton` is the reusable "Save" for any tool that shows a vacancy; that is
  why `ExaJobListing` carries optional `company` / `location` / `salaryText`.

## Assisted Apply (`/jobs/[id]/apply`, `components/apply-wizard.tsx`)

Frontend only: it chains existing tools with `?savedJob=<id>` (CV Optimizer, Cover
Letter, Interview Prep read it) and marks the card `applied` when the student
confirms on returning from the employer's site.

Status side effects of the other tools: Cover Letter writes `cover_letter_text` +
`cv_version_id` onto the card and moves `saved` → `preparing`; starting an Interview
Prep session does **not** change status.
