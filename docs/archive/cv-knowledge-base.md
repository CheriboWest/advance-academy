# Plan: Persistent CV Knowledge Base with Bullet-Level Artifacts

## Context

The previous strategy doc ([idempotent-bouncing-lynx.md](../../../.claude/plans/idempotent-bouncing-lynx.md)) proposed asking the user to attach 3 artifacts at the start of *every* interview prep session. The user has revised that approach: artifacts should be attached **once per CV bullet point**, persisted in the database, and **automatically reused** by the coaching prompt across every future interview session.

The end-state flow is:

1. **CV Library page** — user uploads a CV file (PDF/DOCX), names this version (e.g. *"2025 SWE CV"*, *"Marketing CV — agency focus"*), and confirms it.
2. **Bullet extraction (one-time, automatic)** — the model parses the CV into a flat list of bullet points (each with a parent section like *Experience > Acme Corp > Backend Engineer*).
3. **Gap analysis (one-time per bullet, automatic)** — for each bullet, the model picks the **5 most important missing details** an interviewer would dig into ("What was the team size?", "What stack?", "What was the measured outcome?"). Capped at 5 for MVP.
4. **Artifact intake (user-driven)** — the user sees each bullet's 5 gaps and fills them in: free-text, file upload, or URL (Jina). Skipping is fine. Filled answers are stored as `bullet_artifacts` rows linked to the gap.
5. **Reuse during interview prep** — when the coach-answer endpoint generates an enhanced response, it (a) picks the active CV version, (b) finds bullets relevant to the interview question, (c) injects their stored artifacts as evidence, and (d) only emits `[CANDIDATE TO FILL: ...]` placeholders for facts that *still* aren't covered. Those leftover placeholders feed Strategy 4's just-in-time clarification loop, and **answers given there are written back into the same `bullet_artifacts` table** so the knowledge base grows over time.

A user can have **multiple CV versions** (different roles, different industries). Each version is fully independent: bullets and gaps belong to one CV version only.

This plan covers **only** the CV-library + knowledge-base subsystem. Strategies 3 (field-specific intake) and 4 (just-in-time clarification) from the previous doc are still adopted as-is and slot in on top.

---

## Data model (new tables only)

Five new tables, all additive to [supabase/migrations/001_create_tables.sql](../../supabase/migrations/001_create_tables.sql). No changes to existing tables.

```
users (existing)
  └── cv_versions               one row per named CV the user uploads
        └── cv_bullets          one row per extracted bullet point
              └── bullet_gaps   exactly up to 5 rows per bullet (the "missing details")
                    └── bullet_artifacts   user-supplied evidence answering a gap
```

`cv_bullets.is_active_for_coaching` lets the user mark which CV version is "current" for interview prep, without deleting old versions.

### SQL (append to `001_create_tables.sql` or new migration `002_cv_knowledge_base.sql`)

```sql
-- ── 17. CV Versions ─────────────────────────────────────────────────────────
-- Each user can have multiple named CVs. One can be marked active at a time.

create table cv_versions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  name            text not null,                       -- user-given label e.g. "2025 SWE CV"
  source_file_path text,                                -- Supabase Storage path
  raw_text        text not null,                        -- extracted plain text of the CV
  detected_field  text,                                 -- 'tech' | 'business' | 'marketing' | null
  is_active       boolean not null default false,       -- the CV currently used for coaching
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_cv_versions_user on cv_versions(user_id);
-- only one active CV per user
create unique index idx_cv_versions_one_active_per_user
  on cv_versions(user_id) where is_active = true;

-- ── 18. CV Bullets ──────────────────────────────────────────────────────────
-- Flat list of bullets extracted from a CV version. section_path preserves
-- hierarchy as a single string e.g. "Experience > Acme Corp > Backend Engineer".

create table cv_bullets (
  id              uuid primary key default gen_random_uuid(),
  cv_version_id   uuid not null references cv_versions(id) on delete cascade,
  section_path    text,                                 -- e.g. "Experience > Acme > Backend Engineer"
  bullet_text     text not null,                        -- the bullet itself
  ordinal         int not null,                         -- order within the CV for display
  created_at      timestamptz not null default now()
);

create index idx_cv_bullets_version on cv_bullets(cv_version_id);

-- ── 19. Bullet Gaps ─────────────────────────────────────────────────────────
-- The 5 (max) "most important missing details" the model identified for each
-- bullet. status lets the user skip a gap without losing the question.

create table bullet_gaps (
  id              uuid primary key default gen_random_uuid(),
  bullet_id       uuid not null references cv_bullets(id) on delete cascade,
  question        text not null,                        -- "What was the team size?"
  rationale       text,                                 -- why this matters (optional, model-generated)
  ordinal         int not null,                         -- 1..5
  status          text not null default 'open',         -- 'open' | 'answered' | 'skipped'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_bullet_gaps_bullet on bullet_gaps(bullet_id);
-- enforce <= 5 gaps per bullet at the application layer (not a SQL constraint;
-- a CHECK with subquery isn't portable). Ordinal uniqueness still enforced:
create unique index idx_bullet_gaps_unique_ordinal on bullet_gaps(bullet_id, ordinal);

-- ── 20. Bullet Artifacts ────────────────────────────────────────────────────
-- A user-supplied answer to a single gap. Multiple artifacts per gap allowed
-- (e.g. the user pastes text AND attaches a URL). source_type tells the
-- coaching prompt whether to trust as primary evidence.

create table bullet_artifacts (
  id              uuid primary key default gen_random_uuid(),
  gap_id          uuid not null references bullet_gaps(id) on delete cascade,
  source_type     text not null,                        -- 'text' | 'file' | 'url' | 'jit_clarification'
  content_text    text,                                 -- inline text or extracted file/url body
  source_url      text,                                 -- original URL if source_type='url'
  source_file_path text,                                -- Supabase Storage path if source_type='file'
  summary_json    jsonb,                                -- output of summarize-with-quotes pass
  created_at      timestamptz not null default now()
);

create index idx_bullet_artifacts_gap on bullet_artifacts(gap_id);

-- ── 21. CV Version × Interview Session link ────────────────────────────────
-- Snapshot which CV version was used for each interview session, so the
-- coach-answer endpoint can pull the right artifacts later.

alter table interview_sessions
  add column cv_version_id uuid references cv_versions(id) on delete set null;

create index idx_sessions_cv_version on interview_sessions(cv_version_id);
```

> Note: `interview_sessions.cv_version_id` is the only modification to an existing table. Everything else is additive.

### DBML (paste into https://dbdiagram.io/d to visualize)

Append the following to [supabase/migrations/schema.dbml](../../supabase/migrations/schema.dbml):

```dbml
// ── CV Knowledge Base ───────────────────────────────────────────────────────

Table cv_versions {
  id uuid [pk, default: `gen_random_uuid()`]
  user_id uuid [not null, ref: > users.id]
  name text [not null, note: 'User-given label, e.g. "2025 SWE CV"']
  source_file_path text [note: 'Supabase Storage path']
  raw_text text [not null, note: 'Extracted plain text of the CV']
  detected_field text [note: 'tech | business | marketing | null']
  is_active boolean [not null, default: false, note: 'Only one active CV per user']
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]

  Indexes {
    user_id [name: 'idx_cv_versions_user']
    (user_id) [unique, name: 'idx_cv_versions_one_active_per_user', note: 'Partial: where is_active = true']
  }
}

Table cv_bullets {
  id uuid [pk, default: `gen_random_uuid()`]
  cv_version_id uuid [not null, ref: > cv_versions.id]
  section_path text [note: 'e.g. "Experience > Acme > Backend Engineer"']
  bullet_text text [not null]
  ordinal int [not null]
  created_at timestamptz [not null, default: `now()`]

  Indexes {
    cv_version_id [name: 'idx_cv_bullets_version']
  }
}

Table bullet_gaps {
  id uuid [pk, default: `gen_random_uuid()`]
  bullet_id uuid [not null, ref: > cv_bullets.id]
  question text [not null, note: 'e.g. "What was the team size?"']
  rationale text [note: 'Why this matters (model-generated)']
  ordinal int [not null, note: '1..5']
  status text [not null, default: 'open', note: 'open | answered | skipped']
  created_at timestamptz [not null, default: `now()`]
  updated_at timestamptz [not null, default: `now()`]

  Indexes {
    bullet_id [name: 'idx_bullet_gaps_bullet']
    (bullet_id, ordinal) [unique, name: 'idx_bullet_gaps_unique_ordinal']
  }
}

Table bullet_artifacts {
  id uuid [pk, default: `gen_random_uuid()`]
  gap_id uuid [not null, ref: > bullet_gaps.id]
  source_type text [not null, note: 'text | file | url | jit_clarification']
  content_text text
  source_url text
  source_file_path text
  summary_json jsonb [note: 'Output of summarize-with-quotes pass']
  created_at timestamptz [not null, default: `now()`]

  Indexes {
    gap_id [name: 'idx_bullet_artifacts_gap']
  }
}

// And add this ref to the existing interview_sessions table block:
//   cv_version_id uuid [ref: > cv_versions.id]
```

---

## Backend changes

### New service: `backend/src/services/cv-knowledge.service.ts`

Pure functions, no HTTP. Each is a thin wrapper around Anthropic + Supabase.

- `parseCvIntoBullets(cvVersionId, rawText)` — one LLM call. Prompt: *"Extract every bullet/achievement line from this CV. Return JSON array of `{ section_path, bullet_text }`. Preserve order. Do NOT invent bullets."* Inserts rows into `cv_bullets`.
- `generateGapsForBullet(bulletId, bulletText, sectionPath, detectedField)` — one LLM call per bullet. Prompt: *"You are an interviewer. Given this CV bullet, list the **5 most important factual details a strong interviewer would ask the candidate to elaborate on**. Return JSON: `[{question, rationale}]`. Exactly 5 items, ordered by importance. Do not invent answers — only ask."* Inserts up to 5 `bullet_gaps` rows. Field-aware: tech bullets get stack/scale/contribution gaps; business gets metrics/scope; marketing gets channel/spend/lift. (Single prompt, branches on `detected_field`.)
- `ingestArtifact(gapId, { sourceType, text?, file?, url? })` — reuses [`extractTextFromFile`](../../backend/src/services/outreach-extractor.service.ts) and [`extractTextFromUrl`](../../backend/src/services/outreach-extractor.service.ts) (already exists, do not duplicate). Runs the **summarize-with-quotes** pass from the previous strategy doc to produce `summary_json: { overview, my_contribution, concrete_facts[], metrics[] }`. Inserts a `bullet_artifacts` row and flips the gap status to `answered`.
- `getRelevantArtifactsForQuestion(activeCvVersionId, interviewQuestion)` — used by the coach-answer endpoint at interview time. v1: cheap keyword/embedding-free retrieval — pull every bullet for the active CV, ask one LLM call to rank "which bullets are most relevant to this interview question", return the top 3 with all their `bullet_artifacts.summary_json` blobs. v2 can swap in real embeddings.
- `recordJitClarification(bulletId, gapQuestion, userAnswer)` — when the just-in-time clarification loop captures a new fact, write it back as a `bullet_artifacts` row with `source_type='jit_clarification'`. If a matching open gap exists, mark it `answered`; otherwise create a new gap+artifact pair so the knowledge base grows.

### New route file: `backend/src/routes/cv-knowledge.ts`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/cv-library/versions` | Upload + name a new CV. Body: multipart file + `name`. Triggers `parseCvIntoBullets` then `generateGapsForBullet` for every bullet (background or sync — see below). Returns `{ cvVersionId, bulletCount, gapCount }`. |
| `GET`  | `/api/cv-library/versions` | List the user's CVs. Returns `[{ id, name, isActive, bulletCount, openGapCount, createdAt }]`. |
| `POST` | `/api/cv-library/versions/:id/activate` | Mark this CV as the active one (clears the flag on others). |
| `DELETE` | `/api/cv-library/versions/:id` | Cascade-delete bullets/gaps/artifacts. |
| `GET`  | `/api/cv-library/versions/:id/bullets` | Returns bullets nested with their gaps + existing artifacts. Drives the intake UI. |
| `POST` | `/api/cv-library/gaps/:gapId/artifacts` | Add an artifact to a gap. Multipart: `text` or `file` or `url`. |
| `POST` | `/api/cv-library/gaps/:gapId/skip` | Mark a gap skipped. |

Register in [backend/src/main.ts](../../backend/src/main.ts) next to `registerInterviewPrepRoutes`.

**Sync vs background gap generation:** for MVP, parse + gap-generate **synchronously** on upload. Worst case: 30 bullets × 1 LLM call ≈ 30s. Show a progress UI. If this is too slow in practice, move gap generation to a background job in v2 — the schema doesn't change.

### Wiring into the existing coach-answer flow

The earlier plan introduced `POST /api/interview/coach-answer`. Update it (when it gets built) to:

1. Read `interview_sessions.cv_version_id` (set when the session was started — SetupStep should default to the user's active CV).
2. Call `getRelevantArtifactsForQuestion` to fetch relevant `summary_json` blobs.
3. Inject those blobs into the coaching prompt as the **evidence pool**, alongside the literal CV bullets they came from.
4. The constrained prompt (Strategy 1 from the previous doc) stays the same — but now it has *real evidence* to work with most of the time, and `[CANDIDATE TO FILL: ...]` placeholders are reserved for the cases where even the artifacts don't cover something.
5. When the user answers a JIT clarification, call `recordJitClarification` so future sessions benefit.

---

## Frontend changes

### New top-level page: `app/cv-library/page.tsx`

A standalone page reachable from the main nav, NOT inside the interview prep flow.

- **Empty state:** "Upload your first CV" → file picker + name field.
- **List view:** cards for each CV version showing name, "X bullets · Y gaps remaining", an Active toggle, and a Delete button.
- **Detail view (clicking a CV):** scrollable list of bullets grouped by `section_path`. Each bullet renders its 5 gaps as a small form:
  - Question text
  - Three input modes: text / file / URL (tabbed)
  - Submit button → POSTs to `/api/cv-library/gaps/:gapId/artifacts`
  - Skip link → POSTs to `.../skip`
  - When a gap has artifacts, show them as collapsible chips (so the user can edit/replace).
- A progress bar at the top: *"12 of 30 gaps filled. Skipped: 4. Open: 14."*

### Upload flow

1. POST file to `/api/cv-library/versions` (multipart).
2. Show a *"Parsing CV…"* spinner; the request returns when bullet+gap generation is complete.
3. Redirect to the detail view; user begins filling gaps.
4. The user can leave at any time; everything is persisted.

### Tiny touch in interview-prep SetupStep

[features/interview-prep/components/interview-prep-screen.tsx](../../features/interview-prep/components/interview-prep-screen.tsx) currently has a `cvText` textarea. Replace it with:

> **Active CV:** *2025 SWE CV* — [change ▾]   [Manage CV Library →]

A dropdown lets the user pick which CV version to use for *this* session (defaulting to the active one). On session start, write the chosen `cv_version_id` into `interview_sessions`. The textarea fallback stays for users who haven't uploaded a CV yet but should be deprecated.

---

## What happens during an interview (end-to-end)

1. User clicks **Start interview** on the SetupStep — `interview_sessions.cv_version_id` is recorded.
2. User answers a question.
3. Existing IRS scoring runs unchanged.
4. New coach-answer endpoint runs:
   - Pulls top-3 relevant bullets + their `bullet_artifacts.summary_json` for the active CV.
   - Calls Claude with: `{question, candidate answer, IRS scores, JD, evidence pool}` and the constrained "no invention" prompt.
   - Gets back `{ improvedAnswer, missingEvidencePrompts[] }`.
5. UI renders the enhanced answer below the candidate's message; missing evidence prompts appear as yellow inline chips.
6. User clicks a chip and types an answer → `recordJitClarification` writes a new `bullet_artifacts` row → the knowledge base grows. Re-rendering the enhanced answer now resolves that placeholder.

---

## Critical files

- New: [supabase/migrations/002_cv_knowledge_base.sql](../../supabase/migrations/002_cv_knowledge_base.sql) — the SQL above
- [supabase/migrations/schema.dbml](../../supabase/migrations/schema.dbml) — append the DBML block above
- New: [backend/src/services/cv-knowledge.service.ts](../../backend/src/services/cv-knowledge.service.ts)
- New: [backend/src/routes/cv-knowledge.ts](../../backend/src/routes/cv-knowledge.ts)
- [backend/src/main.ts](../../backend/src/main.ts) — register the new route
- [backend/src/services/outreach-extractor.service.ts](../../backend/src/services/outreach-extractor.service.ts) — **reuse** `extractTextFromFile` and `extractTextFromUrl`, no changes
- New: `app/cv-library/page.tsx` and supporting components under `features/cv-library/`
- [features/interview-prep/components/interview-prep-screen.tsx](../../features/interview-prep/components/interview-prep-screen.tsx) — swap the CV textarea for the version picker
- [hooks/use-interview.ts](../../hooks/use-interview.ts) — pass `cvVersionId` to `/api/interview` on session start

## Verification

1. **Upload happy path:** upload a real CV, confirm bullets appear with sensible `section_path`, confirm each bullet has exactly 5 (or fewer, if the bullet is trivial) gap questions, and that the gaps are field-appropriate.
2. **Persistence:** fill 3 gaps for a bullet, refresh the page, confirm the artifacts and `answered` status survive.
3. **Multi-CV:** upload two CVs, mark CV-A active, start an interview, confirm `interview_sessions.cv_version_id` points at CV-A. Mark CV-B active, start another, confirm the new session uses CV-B's bullets and not CV-A's.
4. **Knowledge reuse:** answer an interview question whose enhanced version *should* pull from a filled gap. Confirm the enhanced answer cites a fact that exists in the artifact (trace it verbatim). Then, on a *second* session with the same CV, confirm the same fact is still pulled in without re-asking the user.
5. **JIT writeback:** trigger a `[CANDIDATE TO FILL]` placeholder, answer it inline, then check the DB for a new `bullet_artifacts` row with `source_type='jit_clarification'` and the corresponding gap flipped to `answered`.
6. **Cascade delete:** delete a CV version, confirm its bullets/gaps/artifacts are gone but other CVs are untouched.

## Out of scope for this MVP

- More than 5 gaps per bullet (hard cap; ranking is up to the model).
- Embedding-based retrieval for `getRelevantArtifactsForQuestion` — keyword/LLM-rank is fine until users have many bullets.
- Editing bullet text or section paths after extraction (re-upload the CV instead).
- Sharing knowledge across users.
- True PII redaction; the "anonymize manually" hint from the previous doc still applies.
