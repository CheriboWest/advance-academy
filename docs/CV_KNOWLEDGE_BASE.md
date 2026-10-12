# CV Knowledge Base + Grounded Coach Answer

This feature adds a persistent **CV Library** and a per-answer **Enhanced Version** coach to the interview prep flow. The goal is to stop the LLM from inventing facts ("hallucinating") when it rewrites a candidate's interview answer, by grounding it in evidence the user has previously attached to specific CV bullets.

The system evolved through four migrations:
- `002_cv_knowledge_base.sql` — initial per-version bullet tables.
- `003_shared_bullet_pool.sql` — **key redesign**: bullets moved from per-CV-version to a user-scoped pool via a `cv_version_bullets` junction table, plus pgvector + Voyage embeddings for cross-CV similarity search.
- `004_coach_understanding_reports.sql` — markdown reports persisted per user for the "AI Coach Understanding" feature.

## The design flaw that 003 fixed

In migration `002`, `cv_bullets.cv_version_id` was a hard `NOT NULL` FK with `ON DELETE CASCADE`. That meant:
- The same project bullet ("Built ScholarPath") parsed from two different CV versions became two separate rows with separate gaps and separate artifacts.
- When the user filled gaps on CV version 1 and then ran an interview on CV version 2, the coach saw **none** of that evidence because it queried bullets `WHERE cv_version_id = active_cv`.
- All the effort the user spent filling gaps was wasted the moment they uploaded a second CV.

Migration `003` fixes this by making bullets belong to a **user** (not a version), with a junction table mapping versions to bullets:

```
BEFORE: cv_versions → cv_bullets (1:N, exclusive) → bullet_gaps → bullet_artifacts
AFTER:  cv_versions ←→ cv_version_bullets (M:N) → cv_bullets (user-scoped pool) → bullet_gaps → bullet_artifacts
```

A bullet is now a **shared node** in the user's experience graph. Multiple CV versions can reference it; its gaps and artifacts are visible to the coach regardless of which CV is "active".

## High-level flow

1. **First CV upload** (in the `/cv-library` page):
   1. User uploads a PDF/DOCX and names the version (e.g. *"2025 SWE CV"*).
   2. The backend extracts every bullet point and detects the field (`tech` / `business` / `marketing`).
   3. For each parsed bullet, the backend calls Voyage to embed the text, then queries pgvector for the **top 5 most similar** bullets in the user's existing pool (empty on the first CV).
   4. Phase 1 response returns `parsedBullets` + `candidates` per bullet. The user is taken to a **Resolve Bullets** step.
2. **Bullet resolution step (Phase 2)**:
   1. For each parsed bullet, the user picks: `new` (create a fresh bullet + generate 5 gaps) or `merge` with an existing pool bullet (no new gaps — the new CV version just links to the existing bullet via the junction table).
   2. On submit, the frontend POSTs to `/api/cv-library/versions/:id/finalize`, which writes all the chosen bullets, creates `cv_version_bullets` junction rows, and generates gaps only for the new ones.
3. **Gap filling** (CV detail view, unchanged behavior but now operates on the shared pool):
   - User fills gaps with text, file uploads, or URLs (Jina-fetched). Each artifact is summarized into a small structured `summary_json` blob.
   - **New button**: each bullet has a **Merge** action that fetches its top-5 similar bullets from the user's pool and lets the user merge the current bullet into another, re-parenting all gaps and junction rows.
4. **During every interview**:
   1. After each candidate answer is scored, the user can click **See enhanced version** below their message.
   2. The coach endpoint pulls bullets from the user's **entire pool** (`WHERE user_id = X`, not `WHERE cv_version_id = X`), picks the 1–3 most relevant for the interview question, fetches their `bullet_artifacts.summary_json` blobs, and asks Claude to rewrite the answer using ONLY that evidence pool. Anything missing becomes a `[CANDIDATE TO FILL: bulletId|question]` placeholder.
   3. The UI renders placeholders as yellow chips with inline forms. When the user types an answer, it's POSTed to the JIT-clarification endpoint, written back to `bullet_artifacts` with `source_type='jit_clarification'`, and the coach is re-run so the placeholder disappears. The knowledge base grows with every session.
5. **AI Coach Understanding report** (CV Library page, purple card):
   - A **"Get AI Coach's Understanding of {CV name}"** button generates a markdown report scoped to **one selected CV version** (bullets linked via `cv_version_bullets`) + those bullets' gaps + artifacts. When the account has more than one CV, a dropdown picks which one (defaults to the active CV). This differs from the coach-answer rewriter, which intentionally still draws on the whole shared bullet pool. `POST /generate` accepts an optional `cvVersionId`; omitting it falls back to the whole-pool report (back-compat).
   - The prompt asks Claude to summarize the profile, flag strongest evidence areas, list unanswered gaps and infer what the user "doesn't know", **detect suspected duplicate bullets** the user hasn't merged yet, and give prioritized recommendations.
   - Reports are persisted in `coach_understanding_reports` and viewable from a collapsible history list.

A user can have multiple CVs; only one is `is_active=true` at a time (enforced by a partial unique index). The `is_active` flag drives the interview-prep SetupStep CV picker (for display and for which `cv_version_id` the session records). **Evidence scoping is no longer tied to `is_active`** — the coach sees the entire user pool.

## Database schema

Three migrations are applied in order:
- [supabase/migrations/002_cv_knowledge_base.sql](../supabase/migrations/002_cv_knowledge_base.sql) — initial tables
- [supabase/migrations/003_shared_bullet_pool.sql](../supabase/migrations/003_shared_bullet_pool.sql) — pgvector, user-scoped pool, junction table
- [supabase/migrations/004_coach_understanding_reports.sql](../supabase/migrations/004_coach_understanding_reports.sql) — coach report persistence

All migrations are idempotent (`create … if not exists`, `add column if not exists`).

```
users (existing)
  ├── cv_versions               one row per named CV the user uploads
  │     └── cv_version_bullets  M:N junction linking versions to pooled bullets
  │           └── cv_bullets    user-scoped pool (one row per DISTINCT bullet)
  │                 └── bullet_gaps
  │                       └── bullet_artifacts
  └── coach_understanding_reports   markdown reports of the coach's view of the user
```

| Table | Notable columns | Notes |
|---|---|---|
| `cv_versions` | `user_id`, `name`, `raw_text`, `detected_field`, `is_active` (partial unique index: only one active per user) | Unchanged since 002. |
| `cv_bullets` | `user_id` ⭐, `cv_version_id` (now **nullable** — historical "originally parsed from"), `section_path`, `bullet_text`, `ordinal`, `bullet_embedding vector(1024)` ⭐ | 003 adds `user_id` (the real owner), `bullet_embedding` for Voyage vectors, and makes `cv_version_id` nullable. |
| `cv_version_bullets` ⭐ | `cv_version_id`, `bullet_id`, `ordinal`, `section_path`, unique(`cv_version_id`, `bullet_id`) | 003 adds this junction table. One row per (version, bullet) link. Version-specific metadata (ordinal, section_path) lives here since the same bullet may appear in different sections across CVs. |
| `bullet_gaps` | `bullet_id`, `question`, `rationale`, `ordinal` (1..5, unique per bullet), `status` (`open` \| `answered` \| `skipped`) | Unchanged. Still attached to the bullet, which is now pool-scoped — so gaps and artifacts are automatically visible across all CV versions. |
| `bullet_artifacts` | `gap_id`, `source_type` (`text` \| `file` \| `url` \| `jit_clarification`), `content_text`, `source_url`, `source_file_path`, `summary_json` | Unchanged. |
| `coach_understanding_reports` ⭐ | `user_id`, `report_md` (markdown text), `created_at` | 004. One row per generated "AI Coach's Understanding" report. |

`interview_sessions.cv_version_id` (FK added in 002) is still set from the SetupStep CV picker, but is used only for the session snapshot — **not** for coach evidence scoping anymore.

### Cascade behavior after 003

| Operation | Effect |
|---|---|
| Delete `cv_versions` row | Cascades to `cv_version_bullets` junction rows only. The actual pooled bullet + its gaps + artifacts survive if linked to other versions. If the deleted version was the only link, the bullet becomes an orphan (not automatically cleaned up — acceptable for v1). |
| Delete `cv_bullets` row | Cascades to `bullet_gaps` → `bullet_artifacts` and `cv_version_bullets` links. Used by the merge flow to delete the source bullet after re-parenting. |
| `mergeBullets(source, target)` | Re-parents `bullet_gaps` and `cv_version_bullets` rows from source to target, bumps ordinals to avoid collisions, then deletes the source `cv_bullets` row. |

### pgvector setup

`003_shared_bullet_pool.sql` runs `create extension if not exists vector;` and adds `bullet_embedding vector(1024)` to `cv_bullets`. No index is created — at <500 bullets per user, sequential cosine scan is sub-millisecond. Add an HNSW index (`create index on cv_bullets using hnsw (bullet_embedding vector_cosine_ops);`) when per-user corpora regularly exceed ~5k bullets.

DBML mirrors live in [supabase/migrations/schema.dbml](../supabase/migrations/schema.dbml) — paste into https://dbdiagram.io/d to visualize.

## Backend changes (Fastify)

The backend now talks to Supabase. New environment variables in [backend/.env.example](../backend/.env.example):

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
MVP_USER_ID=00000000-0000-0000-0000-000000000000
VOYAGE_API_KEY=pa-...
```

`MVP_USER_ID` is the placeholder user — there's no auth yet, so all CVs belong to this hardcoded UUID (matches the seeded MVP user in `001_create_tables.sql`).

`VOYAGE_API_KEY` (added with migration 003) enables the pgvector similarity search for the merge-on-upload flow. Get a key from https://dash.voyageai.com — the free tier includes 200M tokens of `voyage-3.5-lite`, which is more than enough for this workload. If the key is missing, CV upload still works — the similarity-candidate list is just empty and the user creates every bullet as new.

New dependency: `@supabase/supabase-js` (already hoisted in the workspace root). No embedding SDK is needed — Voyage is a plain JSON POST through `fetch` from [backend/src/lib/voyage.ts](../backend/src/lib/voyage.ts).

### New files

| File | Purpose |
|---|---|
| [backend/src/lib/supabase.ts](../backend/src/lib/supabase.ts) | Server-side Supabase client (service-role key, RLS bypassed) + `getUserIdFromToken()` for the Fastify auth preHandler |
| [backend/src/lib/voyage.ts](../backend/src/lib/voyage.ts) ⭐ | Plain-`fetch` client for Voyage `/v1/embeddings`. Exports `embedText`, `embedTexts`, `isVoyageConfigured`. 1024-dim `voyage-3.5-lite` model. |
| [backend/src/types/cv-knowledge.ts](../backend/src/types/cv-knowledge.ts) | Row types, `CvVersionSummary`, `BulletWithGaps`, `CoachAnswerRequest/Response`, `MissingEvidencePrompt`, `ArtifactSummary`, `SimilarBulletCandidate` ⭐, `ParsedBulletWithCandidates` ⭐, `BulletResolution` ⭐, `CvUploadPhase1Response` ⭐, `CvFinalizeResponse` ⭐ |
| [backend/src/lib/cv-knowledge/prompts.ts](../backend/src/lib/cv-knowledge/prompts.ts) | All prompt builders: bullet extraction, gap generation (field-aware), artifact summarize-with-quotes, bullet relevance ranking, coach-answer (constrained "no invention" prompt with placeholder format) |
| [backend/src/services/cv-knowledge.service.ts](../backend/src/services/cv-knowledge.service.ts) | Orchestrates Anthropic + Supabase + Voyage. Now supports two-phase upload, similarity search, and bullet merging. |
| [backend/src/services/coach-answer.service.ts](../backend/src/services/coach-answer.service.ts) | Builds the evidence pool from the **user's entire bullet pool** (not just the active CV) and runs the constrained coach prompt. |
| [backend/src/services/coach-understanding.service.ts](../backend/src/services/coach-understanding.service.ts) ⭐ | Fetches the whole bullet pool + gaps + artifacts, prompts Claude for a markdown "profile understanding" report, persists to `coach_understanding_reports`. |
| [backend/src/routes/cv-library.ts](../backend/src/routes/cv-library.ts) | REST surface for CV library (extended with finalize, similar, merge, backfill routes). |
| [backend/src/routes/coach-answer.ts](../backend/src/routes/coach-answer.ts) | `POST /api/interview/coach-answer` |
| [backend/src/routes/coach-understanding.ts](../backend/src/routes/coach-understanding.ts) ⭐ | `POST /generate`, `GET /reports`, `GET /reports/:id` |

### Modified files

- [backend/src/main.ts](../backend/src/main.ts) — registers all route bundles including the two new ones
- [backend/package.json](../backend/package.json) — adds `@supabase/supabase-js`
- [backend/.env.example](../backend/.env.example) — adds `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MVP_USER_ID`, `VOYAGE_API_KEY`

### `cv-knowledge.service.ts` exports

**Two-phase upload** (post-003):

| Function | What it does |
|---|---|
| `parseCvVersion({ name, rawText })` ⭐ | **Phase 1.** Inserts `cv_versions` row → extracts bullets via LLM → for each parsed bullet, embeds via Voyage and calls `findSimilarBullets` to get top-5 pool candidates. Returns `CvUploadPhase1Response = { cvVersionId, detectedField, parsedBullets[] }`. **Does NOT write any bullets or gaps yet** — the user must resolve each bullet first. |
| `parseCvVersionFromFile(name, buffer, fileName)` ⭐ | Same as `parseCvVersion` but extracts text from a PDF/DOCX first via the existing outreach-extractor helpers. |
| `finalizeCvBullets(cvVersionId, parsedBullets, resolutions)` ⭐ | **Phase 2.** Takes the user's merge/new decision for each bullet. For `merge`, inserts a `cv_version_bullets` junction row linking the existing bullet. For `new`, inserts a new pooled `cv_bullets` row (with `user_id` + batch Voyage embedding) + junction row + generates 5 gaps. Returns `{ bulletCount, newBulletCount, mergedBulletCount, gapCount }`. |

**Similarity + merge** ⭐ (new in 003):

| Function | What it does |
|---|---|
| `findSimilarBullets(userId, bulletText, limit=5)` | Embeds the input via Voyage (`input_type='query'`), then runs a pgvector cosine-distance query (`ORDER BY bullet_embedding <=> $embedding LIMIT 5`) scoped to the user. Each result carries `similarity`, `gapCount`, `answeredGapCount`. Uses a `match_bullets` RPC if present; falls back to a direct query otherwise. Returns `[]` if Voyage is not configured. |
| `mergeBullets(sourceBulletId, targetBulletId)` | Re-parents every `bullet_gaps` row from source to target (bumping ordinals to avoid collisions), re-parents every `cv_version_bullets` junction row (dropping duplicates where the target is already linked), then deletes the orphaned source. Both bullets must belong to the same user. |
| `backfillEmbeddings()` | Idempotent backfill: picks up to 128 bullets `WHERE bullet_embedding IS NULL`, batch-embeds them via Voyage, writes the vectors back. Run once after applying 003, or any time Voyage is first configured. |

**Existing functions** (behavior changes noted ⚠️):

| Function | What it does |
|---|---|
| `listCvVersions()` | Returns `CvVersionSummary[]` with bullet count and open-gap count. ⚠️ Now counts via the `cv_version_bullets` junction. |
| `activateCvVersion(id)` | Clears any existing active CV, then sets this one active. |
| `deleteCvVersion(id)` | Deletes the `cv_versions` row. ⚠️ Cascades only to `cv_version_bullets` junction rows now — the pooled bullets + gaps + artifacts survive if linked to other versions. |
| `getCvVersion(id)` | Returns one `cv_versions` row (raw text + metadata) for the interview-prep CV picker. |
| `listBulletsWithGaps(cvVersionId)` | Returns bullets nested with gaps and artifacts for a given version. ⚠️ Now joins through `cv_version_bullets` to find the bullet ids, then reads from the shared pool. |
| `addArtifactToGap(gapId, payload)` | Accepts `text`, `file`, `url`, or `jit_clarification`. Runs the **summarize-with-quotes** LLM pass biased toward the gap question, producing `summary_json: { overview, my_contribution, concrete_facts[], metrics[] }`. Marks the gap `answered`. Short text (≤80 chars) skips the LLM and stores a single literal fact. |
| `skipGap(gapId)` | Marks the gap `skipped`. |
| `recordJitClarification({ bulletId, question, answer })` | Finds or creates a gap on the bullet, then writes the answer as a `bullet_artifacts` row with `source_type='jit_clarification'`. |
| `getRelevantBulletsForQuestion(_cvVersionId, question)` | ⚠️ **Now queries the entire user pool** (`WHERE user_id = X`) instead of one version. `cvVersionId` is accepted but ignored — only used to preserve the signature. Still asks the LLM to pick the top 1–3 bullets most relevant to the question. |
| `getArtifactsForBullets(bulletIds)` | Returns `Map<bulletId, ArtifactSummary[]>`. Unchanged. |

### `coach-answer.service.ts`

Single export `coachAnswer(req: CoachAnswerRequest): Promise<CoachAnswerResponse>`. Steps:

1. ⚠️ **Query bullets by `user_id`**, not `cv_version_id`. This is the core fix: evidence from all CV versions is now accessible.
2. Call `getRelevantBulletsForQuestion` + `getArtifactsForBullets` to build an evidence pool.
3. Build the coach prompt via `buildCoachAnswerPrompt`. The system prompt forbids invention and instructs the model to emit `[CANDIDATE TO FILL: <bulletId>|<short question>]` placeholders for any missing facts.
4. Parse the JSON response. If the model forgot to populate `missingEvidencePrompts`, scan the rewritten text with a regex to recover them. Decorate each prompt with `bulletText` for the UI.

### `coach-understanding.service.ts` ⭐

Three exports:

| Function | What it does |
|---|---|
| `generateCoachUnderstanding(userId, cvVersionId?)` | When `cvVersionId` is given, scopes to that version's bullets via `cv_version_bullets` (404s if the version isn't owned); otherwise fetches all bullets for the user (`user_id`-scoped). Plus every gap + every artifact for the selected bullets. Builds a structured user-prompt listing each bullet with its gaps tagged `[ANSWERED]` / `[SKIPPED]` / `[UNANSWERED]` and inlined evidence. Sends to Claude with a system prompt that enforces a 5-section markdown report: **Profile Summary**, **Strongest Evidence Areas**, **Knowledge Gaps & Blind Spots** (citing each unanswered gap and inferring what the silence implies), **Potential Duplicate Bullet Points** (proactive merge suggestions), **Recommendations**. Persists to `coach_understanding_reports`. |
| `listCoachReports()` | Returns the user's past reports (`id`, `createdAt`, short preview) for the history dropdown. |
| `getCoachReport(id)` | Returns one full report by id for the viewer. |

### REST routes

CV library — registered in `cv-library.ts`:

| Method | Path | Purpose |
|---|---|---|
| `GET`    | `/api/cv-library/versions` | List the user's CVs |
| `POST`   | `/api/cv-library/versions` | Multipart `file + name` (or JSON `{ name, rawText }`). ⚠️ **Phase 1 only** — returns parsed bullets + similarity candidates, does NOT persist bullets yet. |
| `POST`   | `/api/cv-library/versions/:id/finalize` ⭐ | Phase 2. Body: `{ parsedBullets, resolutions }`. Executes the user's merge/new decisions. |
| `GET`    | `/api/cv-library/versions/:id` | Returns one CV (`{ id, name, rawText, detectedField, isActive }`) — used by the interview-prep CV picker. |
| `POST`   | `/api/cv-library/versions/:id/activate` | Mark active |
| `DELETE` | `/api/cv-library/versions/:id` | Delete version. ⚠️ Shared bullets survive. |
| `GET`    | `/api/cv-library/versions/:id/bullets` | Bullets nested with gaps and artifacts (drives intake UI) |
| `POST`   | `/api/cv-library/bullets/:id/similar` ⭐ | Returns top-5 similar bullets to the given one — drives the manual merge modal. |
| `POST`   | `/api/cv-library/bullets/merge` ⭐ | Body: `{ sourceBulletId, targetBulletId }`. Re-parents gaps + junctions, deletes source. |
| `POST`   | `/api/cv-library/backfill-embeddings` ⭐ | One-shot: embed any `cv_bullets` rows missing `bullet_embedding`. Run once after applying 003 or first setting `VOYAGE_API_KEY`. |
| `POST`   | `/api/cv-library/gaps/:gapId/artifacts` | Multipart with `file`, or JSON `{ text }` / `{ url }` |
| `POST`   | `/api/cv-library/gaps/:gapId/skip` | Mark gap skipped |
| `POST`   | `/api/cv-library/jit-clarification` | `{ bulletId, question, answer }` — JIT writeback during an interview |

Coach — registered in `coach-answer.ts`:

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/interview/coach-answer` | `{ question, answer, context: { jobTitle, jobDescription, companyName }, cvVersionId?, irsScore? }` → `{ critique, improvedAnswer, missingEvidencePrompts[] }` |

Coach Understanding — registered in `coach-understanding.ts` ⭐:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/coach-understanding/generate` | Generate a new report. Optional body `{ cvVersionId }` scopes it to one CV; omit for the whole pool. Returns `{ reportId, reportMd }`. Takes 20–60s. |
| `GET`  | `/api/coach-understanding/reports` | List the user's past reports (id + preview). |
| `GET`  | `/api/coach-understanding/reports/:id` | Full markdown of one report. |

## Frontend changes (Next.js)

### New page

- [app/cv-library/page.tsx](../app/cv-library/page.tsx) — entry, renders `<CvLibraryScreen />`
- [features/cv-library/components/cv-library-screen.tsx](../features/cv-library/components/cv-library-screen.tsx) — full UI with four distinct views the root switches between:
  - **Main list view**:
    - **UploadCard** — name input + PDF/DOCX file picker; on submit, hits Phase 1 and transitions to `BulletResolutionStep`.
    - **CoachUnderstandingSection ⭐** (purple card) — "Get AI Coach's Understanding About My Background" button + collapsible history of past reports. Clicking any past report opens the `ReportViewer`.
    - **Versions list**: per-CV card with detected field tag, "X bullets · Y gaps remaining", an "Active" badge, "Make active" / Delete buttons.
  - **BulletResolutionStep ⭐** (Phase 2): each parsed bullet shows its text + radio options for "This is new" or one of the top-5 similarity candidates (with %, gap count, answered count). Submit calls `/finalize`, then returns to the main list view.
  - **CvDetail**: bullets grouped under their `section_path`. Each bullet has:
    - A new **Merge** button that fetches `/bullets/:id/similar` and opens an inline merge picker.
    - Its gaps as numbered yellow chips with a 3-mode form (text / url / file), Save and Skip buttons, and answered/skipped state styling. Existing artifacts show as ✓ chips above the form.
    - Progress counter "X of Y gaps filled" at the top.
  - **ReportViewer ⭐**: markdown-rendered coach understanding report with back button. Uses a lightweight in-file markdown renderer (headings / bullets / bold / quoted strings) to avoid adding a dep.

### Navigation

- [shared/types/navigation.ts](../shared/types/navigation.ts) — added `'cv-library'` to `ViewName`
- [shared/config/navigation.ts](../shared/config/navigation.ts) — added a `{ label: 'CV Library', view: 'cv-library', href: '/cv-library' }` entry between CV Optimizer and Interview Prep

### Next.js proxies (thin pass-throughs to Fastify)

| File | Routes |
|---|---|
| [app/api/cv-library/versions/route.ts](../app/api/cv-library/versions/route.ts) | `GET`, `POST` (multipart — Phase 1) |
| [app/api/cv-library/versions/[id]/route.ts](../app/api/cv-library/versions/[id]/route.ts) | `GET`, `DELETE` |
| [app/api/cv-library/versions/[id]/activate/route.ts](../app/api/cv-library/versions/[id]/activate/route.ts) | `POST` |
| [app/api/cv-library/versions/[id]/bullets/route.ts](../app/api/cv-library/versions/[id]/bullets/route.ts) | `GET` |
| [app/api/cv-library/versions/[id]/finalize/route.ts](../app/api/cv-library/versions/[id]/finalize/route.ts) ⭐ | `POST` (Phase 2) |
| [app/api/cv-library/bullets/[id]/similar/route.ts](../app/api/cv-library/bullets/[id]/similar/route.ts) ⭐ | `POST` |
| [app/api/cv-library/bullets/merge/route.ts](../app/api/cv-library/bullets/merge/route.ts) ⭐ | `POST` |
| [app/api/cv-library/gaps/[gapId]/artifacts/route.ts](../app/api/cv-library/gaps/[gapId]/artifacts/route.ts) | `POST` (multipart or JSON) |
| [app/api/cv-library/gaps/[gapId]/skip/route.ts](../app/api/cv-library/gaps/[gapId]/skip/route.ts) | `POST` |
| [app/api/cv-library/jit-clarification/route.ts](../app/api/cv-library/jit-clarification/route.ts) | `POST` |
| [app/api/interview/coach-answer/route.ts](../app/api/interview/coach-answer/route.ts) | `POST` |
| [app/api/coach-understanding/generate/route.ts](../app/api/coach-understanding/generate/route.ts) ⭐ | `POST` |
| [app/api/coach-understanding/reports/route.ts](../app/api/coach-understanding/reports/route.ts) ⭐ | `GET` |
| [app/api/coach-understanding/reports/[id]/route.ts](../app/api/coach-understanding/reports/[id]/route.ts) ⭐ | `GET` |

### Backend client helpers

In [shared/api/backend-client.ts](../shared/api/backend-client.ts):

- `listCvVersionsWithBackend()`, `uploadCvFileWithBackend(formData)`
- `getCvVersionWithBackend(id)`, `activateCvVersionWithBackend(id)`, `deleteCvVersionWithBackend(id)`
- `getCvBulletsWithBackend(id)`
- `finalizeCvVersionWithBackend(id, payload)` ⭐
- `findSimilarBulletsWithBackend(bulletId)` ⭐, `mergeBulletsWithBackend({ sourceBulletId, targetBulletId })` ⭐
- `addGapArtifactWithBackend(gapId, { text|url })`, `addGapArtifactFileWithBackend(gapId, formData)`
- `skipGapWithBackend(gapId)`, `jitClarificationWithBackend({ bulletId, question, answer })`
- `coachAnswerWithBackend({ question, answer, context, cvVersionId?, irsScore? })`
- `generateCoachUnderstandingWithBackend()` ⭐, `listCoachReportsWithBackend()` ⭐, `getCoachReportWithBackend(id)` ⭐

Plus exported types: `CvVersionSummary`, `BulletWithGaps`, `MissingEvidencePrompt`, `CoachAnswerResponse`.

### Interview prep changes

- [features/interview-prep/types.ts](../features/interview-prep/types.ts) — added `CoachResult`, `MissingEvidencePrompt`. Extended `InterviewMessage` with optional `coach?: CoachResult` and `questionAsked?: string` (the interviewer question this candidate message answered).
- [hooks/use-interview.ts](../hooks/use-interview.ts):
  - `sendMessage` now records `questionAsked` on each scored candidate message.
  - New `requestCoach(messageId)` — POSTs to `/api/interview/coach-answer` and stores the result on the message.
  - New `submitJitClarification(messageId, promptIndex, answer)` — POSTs to `/api/cv-library/jit-clarification`, then re-runs the coach so the resolved placeholder disappears.
  - Both are returned from the hook.
- [features/interview-prep/components/interview-prep-screen.tsx](../features/interview-prep/components/interview-prep-screen.tsx):
  - `InterviewStepView` now takes `onRequestCoach` and `onSubmitJit` props.
  - New `CoachPanel` component renders below each candidate message: a **See enhanced version** button that lazy-loads the coach call, and a collapsible card showing the critique + improved answer.
  - New `renderImproved(text)` highlights `[CANDIDATE TO FILL:...]` placeholders as yellow inline chips.
  - New `JitForm` renders one inline form per `missingEvidencePrompts` entry — type an answer and the JIT writeback fires.

## How to run it end-to-end

1. **Install** new deps if you haven't yet:
   ```
   npm install --workspace backend
   ```
2. **Apply** all migrations **in order** in Supabase SQL Editor:
   ```
   supabase/migrations/002_cv_knowledge_base.sql
   supabase/migrations/003_shared_bullet_pool.sql
   supabase/migrations/004_coach_understanding_reports.sql
   ```
3. **Configure** [backend/.env](../backend/.env):
   ```
   SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
   MVP_USER_ID=00000000-0000-0000-0000-000000000000
   VOYAGE_API_KEY=pa-...
   ```
4. **Restart** backend (`npm run dev:backend`) and frontend (`npm run dev`).
5. **Backfill embeddings** (once, if you already had CVs uploaded before migration 003):
   ```powershell
   curl.exe -X POST http://localhost:4000/api/cv-library/backfill-embeddings
   ```
   Repeat until the response reports `{ "updated": 0 }`.
6. Open the app, click **CV Library** in the top nav, upload a PDF/DOCX and name it. Wait for parsing (20–60s). You'll land in the **Resolve Bullets** step.
7. Upload a **second** CV with some overlapping content. In the Resolve Bullets step, confirm that recurring bullets show similarity candidates from CV #1 and merge them.
8. Fill in some gaps for the merged bullets — text is fine.
9. Mark either CV **active**. Open **Interview Prep**, run a session, click **See enhanced version** under any answered question. Confirm the rewrite cites evidence from ANY CV version (not just the active one). Yellow placeholders should appear for anything still missing — fill one inline and watch it disappear on the next coach run.
10. Back on the CV Library page, click **Get AI Coach's Understanding About My Background**. Wait 20–60s. The report should flag any duplicate bullets you didn't merge and list every unanswered gap.

## Verification checklist

- **Bullet extraction** preserves `section_path` and produces sensible bullet count.
- Each bullet has up to 5 gaps; gaps look field-appropriate.
- **Phase 1 similarity**: uploading a second CV with an overlapping project shows that project as a top-5 candidate for the equivalent bullet. Merging it via the radio options creates a `cv_version_bullets` row, no new bullet, no duplicate gaps.
- **Manual merge**: in the CV detail view, the **Merge** button on a bullet returns similar bullets. Selecting one re-parents gaps correctly (check `bullet_gaps` in Supabase — `bullet_id` should now point at the target; source bullet is gone).
- **Cross-CV evidence**: a fact filled on CV-A's version of a merged bullet is visible when the interview coach is invoked while CV-B is active. This is the core regression test for the 003 redesign.
- **Persistence**: refresh the CV detail page after filling some gaps → state survives.
- **JIT writeback**: trigger a `[CANDIDATE TO FILL]`, fill the inline form, check Supabase for a new `bullet_artifacts` row with `source_type='jit_clarification'` and the parent gap flipped to `answered`.
- **Cascade delete**: deleting a CV version removes its junction rows only; bullets linked to other versions survive.
- **Coach Understanding**: a generated report (a) mentions only real bullets (no hallucinated ones), (b) calls out any duplicate bullets the user hasn't merged, (c) lists unanswered gaps and infers the meaning of the silence, (d) the row appears in `coach_understanding_reports` in Supabase.
- **No Voyage key**: deliberately unset `VOYAGE_API_KEY` and re-upload. Candidate list should be empty (no similarity search), but upload + finalize still work and the user creates everything as new.

## Out of scope for this MVP

- More than 5 gaps per initial extraction (JIT-clarification can add more later).
- HNSW index on `bullet_embedding` — not needed at <500 bullets per user; add when scale demands it.
- Automatic merge without user confirmation — too risky, false positives would combine unrelated bullets.
- Editing bullet text or section paths after extraction — re-upload the CV instead.
- True PII redaction.
- Field-specific intake templates (Strategy 3 from the original plan) — current intake is uniform across tech/business/marketing. Field detection is stored in `cv_versions.detected_field` and biases the gap-generation prompt, but the UI doesn't yet swap templates.
- Cross-user knowledge sharing.
- An FTS layer alongside pgvector for hybrid retrieval — revisit if short-bullet embeddings miss hard acronyms (e.g. "SAP S/4HANA").
