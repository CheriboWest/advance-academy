# Plan: Shared Bullet Pool + pgvector Similarity for Cross-CV Evidence Reuse

## Context

The current CV Library stores bullets **per CV version** (`cv_bullets.cv_version_id` is a hard NOT NULL FK). This means the same project bullet that appears across multiple CV versions creates separate, unlinked bullet rows. Evidence (artifacts) the user painstakingly fills for one version's gaps is invisible to the coach when a different CV version is active. This is the user's core frustration — their effort is wasted.

The fix has two parts:
1. **Schema redesign**: decouple bullets from CV versions into a user-scoped "bullet pool", linked to versions via a junction table. Gaps + artifacts stay attached to the pooled bullet, so they're accessible regardless of which CV is active.
2. **Similarity search**: when uploading a second+ CV, use pgvector + Voyage embeddings to suggest the top-5 most similar existing bullets, letting the user merge duplicates in one click.

## Schema changes (migration `003_shared_bullet_pool.sql`)

### Conceptual shift

```
BEFORE: cv_versions → cv_bullets (1:N, exclusive) → bullet_gaps → bullet_artifacts
AFTER:  cv_versions ←→ cv_version_bullets (M:N junction) → cv_bullets (user-scoped pool) → bullet_gaps → bullet_artifacts
```

A bullet is now owned by a **user**, not a CV version. Multiple versions can reference the same bullet. Gaps and artifacts are attached to the bullet, not the version.

### New and altered tables

```sql
-- Enable pgvector
create extension if not exists vector;

-- 1. Add user_id + embedding to cv_bullets
alter table cv_bullets
  add column if not exists user_id uuid references users(id) on delete cascade,
  add column if not exists bullet_embedding vector(1024);

-- Backfill user_id from the existing cv_versions FK
update cv_bullets
set user_id = cv.user_id
from cv_versions cv
where cv_bullets.cv_version_id = cv.id
  and cv_bullets.user_id is null;

-- Now make user_id NOT NULL
alter table cv_bullets alter column user_id set not null;

create index if not exists idx_cv_bullets_user on cv_bullets(user_id);

-- 2. Junction table: which bullets appear in which CV versions
create table if not exists cv_version_bullets (
  id            uuid primary key default gen_random_uuid(),
  cv_version_id uuid not null references cv_versions(id) on delete cascade,
  bullet_id     uuid not null references cv_bullets(id) on delete cascade,
  ordinal       int not null,
  section_path  text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_cvb_version on cv_version_bullets(cv_version_id);
create index if not exists idx_cvb_bullet on cv_version_bullets(bullet_id);
create unique index if not exists idx_cvb_unique on cv_version_bullets(cv_version_id, bullet_id);

-- Backfill junction rows from existing cv_bullets
insert into cv_version_bullets (cv_version_id, bullet_id, ordinal, section_path)
select cv_version_id, id, ordinal, section_path
from cv_bullets
where cv_version_id is not null
on conflict do nothing;

-- 3. Make cv_bullets.cv_version_id nullable (kept as "originally parsed from" reference)
alter table cv_bullets alter column cv_version_id drop not null;
```

### DBML addition (append to schema.dbml)

```dbml
Table cv_version_bullets {
  id uuid [pk, default: `gen_random_uuid()`]
  cv_version_id uuid [not null, ref: > cv_versions.id]
  bullet_id uuid [not null, ref: > cv_bullets.id]
  ordinal int [not null]
  section_path text
  created_at timestamptz [not null, default: `now()`]

  Indexes {
    cv_version_id [name: 'idx_cvb_version']
    bullet_id [name: 'idx_cvb_bullet']
    (cv_version_id, bullet_id) [unique, name: 'idx_cvb_unique']
  }
}
```

### Key behavior changes

| Operation | Before | After |
|---|---|---|
| Delete CV version | Cascades to bullets → gaps → artifacts (data loss!) | Cascades to `cv_version_bullets` junction rows only. Bullets + gaps + artifacts survive if linked to other versions. Orphan cleanup is a separate concern (can leave orphans or add a cleanup job). |
| Coach finds evidence | Queries bullets `WHERE cv_version_id = active_cv` | Queries bullets `WHERE user_id = mvp_user_id` (entire pool), then ranks by relevance |
| List bullets for a CV version | `WHERE cv_version_id = X` | `JOIN cv_version_bullets WHERE cv_version_id = X` |
| Upload new CV | Always inserts new bullets | Parses → finds similar via pgvector → user merges or creates new |

### Env var

```
VOYAGE_API_KEY=pa-...    # https://dash.voyageai.com — 200M free tokens on voyage-3.5-lite
```

Add to `backend/.env.example` and `backend/.env`.

## Backend changes

### New: `backend/src/lib/voyage.ts`

Thin HTTP client for Voyage API. Two functions:
- `embedTexts(texts: string[], inputType: 'document' | 'query'): Promise<number[][]>` — batch call to `https://api.voyageai.com/v1/embeddings` with model `voyage-3.5-lite`, returns array of 1024-dim vectors. Uses `VOYAGE_API_KEY` from env. Falls back gracefully (returns empty array) if key is missing.
- Uses plain `fetch`, no npm package needed (matches the existing Jina pattern).

### Modified: `backend/src/services/cv-knowledge.service.ts`

**`createCvVersionFromText`** — major rewrite of the bullet insertion step:

1. Parse bullets from CV text via LLM (unchanged).
2. **NEW:** For each parsed bullet, call `findSimilarBullets(userId, bulletText, 5)`.
3. **NEW:** Return the parsed bullets + their similarity candidates to the caller, instead of immediately inserting gaps. The response shape becomes:
   ```ts
   {
     cvVersionId: string;
     parsedBullets: Array<{
       tempId: string;        // client-side reference
       bulletText: string;
       sectionPath: string | null;
       candidates: Array<{    // top-5 similar from pool
         bulletId: string;
         bulletText: string;
         sectionPath: string | null;
         similarity: number;
         gapCount: number;
         answeredGapCount: number;
       }>;
     }>;
   }
   ```
4. The client then POSTs back a **resolution** for each bullet: either `{ action: 'merge', existingBulletId: string }` or `{ action: 'new' }`.
5. **NEW:** `finalizeCvBullets(cvVersionId, resolutions)`:
   - For `merge`: insert a `cv_version_bullets` junction row linking the existing bullet to this version. No new bullet, no new gaps.
   - For `new`: insert a new `cv_bullets` row (with `user_id`, embed via Voyage, store `bullet_embedding`), insert a `cv_version_bullets` junction row, then generate gaps as before.

**`findSimilarBullets(userId, bulletText, limit)`** — new function:
1. Embed `bulletText` via Voyage (`inputType: 'query'`).
2. Query Supabase: `SELECT id, bullet_text, section_path, 1 - (bullet_embedding <=> $embedding) as similarity FROM cv_bullets WHERE user_id = $userId AND bullet_embedding IS NOT NULL ORDER BY bullet_embedding <=> $embedding LIMIT $limit`.
3. For each result, count gaps + answered gaps (one query).
4. Return sorted by similarity descending.

**Fallback** when `VOYAGE_API_KEY` is not set: skip embedding, return empty candidates. The user can still merge manually.

**`listBulletsWithGaps(cvVersionId)`** — change from:
```sql
SELECT ... FROM cv_bullets WHERE cv_version_id = $1
```
to:
```sql
SELECT b.*, cvb.ordinal, cvb.section_path
FROM cv_version_bullets cvb
JOIN cv_bullets b ON b.id = cvb.bullet_id
WHERE cvb.cv_version_id = $1
ORDER BY cvb.ordinal
```

**`getRelevantBulletsForQuestion(cvVersionId, question)`** — change to query by **user_id** instead of cv_version_id, so the coach sees the entire bullet pool:
```sql
SELECT ... FROM cv_bullets WHERE user_id = $userId
```
This is the key change that fixes the "wasted effort" problem.

**`getArtifactsForBullets`** — no change needed (already takes bulletIds directly).

**New: `mergeBullets(sourceBulletId, targetBulletId)`**:
1. Re-parent all `bullet_gaps` from source to target: `UPDATE bullet_gaps SET bullet_id = $target WHERE bullet_id = $source`.
2. Re-parent all `cv_version_bullets` from source to target: `UPDATE cv_version_bullets SET bullet_id = $target WHERE bullet_id = $source`.
3. Delete the source bullet (now orphaned).
4. Handle ordinal conflicts on `bullet_gaps` (bump ordinals on target to make room).

### Modified: `backend/src/services/coach-answer.service.ts`

**`coachAnswer`** — change the bullet query from filtering by `cv_version_id` to filtering by `user_id`:
```ts
// BEFORE (line 54-58):
const { data: allBullets } = await supabase
  .from('cv_bullets')
  .select('id, section_path, bullet_text')
  .eq('cv_version_id', cvVersionId)

// AFTER:
const { data: allBullets } = await supabase
  .from('cv_bullets')
  .select('id, bullet_text')
  .eq('user_id', getMvpUserId())
```

Similarly update `getRelevantBulletsForQuestion` to accept `userId` instead of `cvVersionId`.

### New routes in `backend/src/routes/cv-library.ts`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/cv-library/versions` | Changed: now returns parsed bullets + similarity candidates instead of auto-inserting. Two-phase upload. |
| `POST` | `/api/cv-library/versions/:id/finalize` | NEW: receives the user's merge/new resolutions, creates bullets + junction rows + gaps. |
| `POST` | `/api/cv-library/bullets/:id/similar` | NEW: returns top-5 similar bullets for a given bullet (for manual merge UI). Body: `{}` (uses the bullet's own text). |
| `POST` | `/api/cv-library/bullets/merge` | NEW: body `{ sourceBulletId, targetBulletId }`. Re-parents gaps + junction rows, deletes source. |

### Embedding backfill

A one-time script (or a new route `POST /api/cv-library/backfill-embeddings`) that:
1. Selects all `cv_bullets WHERE bullet_embedding IS NULL`.
2. Batches them (128 at a time, Voyage limit).
3. Calls Voyage, updates each row.

Run once after deploying. New bullets get embedded at upload time.

## Frontend changes

### CV upload flow (two-phase)

**Phase 1 — Parse** (existing upload card in `cv-library-screen.tsx`):
- User uploads file + name → `POST /api/cv-library/versions` → response now includes `parsedBullets[]` with `candidates[]` per bullet.
- UI navigates to a **new "Resolve Bullets" step** instead of the gap-filling detail view.

**Phase 2 — Resolve** (new component `BulletResolutionStep`):
- For each parsed bullet, show:
  - The bullet text (left side)
  - Top-5 candidates as radio options (right side), each showing: text, similarity %, gap count, answered count
  - An "Expand all" button to see every bullet in the pool
  - A "This is new" radio option (default if no candidates or similarity < threshold)
- Submit button → `POST /api/cv-library/versions/:id/finalize` with the resolutions array.
- After finalize, navigate to the gap-filling detail view (only new bullets will have open gaps).

### Manual merge in CV Library detail view

Add a "Merge with another bullet" button on each `BulletCard`. On click:
- Call `POST /api/cv-library/bullets/:id/similar` to get top-5.
- Show a modal/panel with the candidates (same UI as the resolve step but for one bullet).
- On confirm → `POST /api/cv-library/bullets/merge`.
- Refresh the bullet list.

### Interview prep — no change needed

The coach-answer flow already goes through `coachAnswer` → `getRelevantBulletsForQuestion` → `getArtifactsForBullets`. Once those query by `user_id` instead of `cv_version_id`, the coach automatically sees all evidence across all CV versions. The SetupStep CV picker still works — it just sets the active CV for display purposes, not for evidence scoping.

## Critical files to modify

| File | Change |
|---|---|
| `supabase/migrations/003_shared_bullet_pool.sql` | New migration: pgvector extension, `user_id` + `bullet_embedding` columns, `cv_version_bullets` junction table, backfill queries |
| `supabase/migrations/schema.dbml` | Append `cv_version_bullets` table |
| `backend/.env.example` | Add `VOYAGE_API_KEY` |
| `backend/src/lib/voyage.ts` | New: Voyage embedding HTTP client |
| `backend/src/services/cv-knowledge.service.ts` | Major: two-phase upload, `findSimilarBullets`, `finalizeCvBullets`, `mergeBullets`, change all `cv_version_id` filters to `user_id` or junction joins |
| `backend/src/services/coach-answer.service.ts` | Change bullet query from `cv_version_id` to `user_id` |
| `backend/src/routes/cv-library.ts` | New endpoints: finalize, similar, merge. Change upload response shape. |
| `backend/src/types/cv-knowledge.ts` | Add `ParsedBulletWithCandidates`, `BulletResolution`, `SimilarBullet` types |
| `features/cv-library/components/cv-library-screen.tsx` | New: `BulletResolutionStep` component, "Merge" button on BulletCard |
| `shared/api/backend-client.ts` | Add helpers for finalize, similar, merge |
| Next proxy routes | Add `versions/[id]/finalize`, `bullets/[id]/similar`, `bullets/merge` |
| `docs/CV_KNOWLEDGE_BASE.md` | Update schema section, flow description |

## Verification

1. **Upload CV #1** — bullets + gaps created as before (no candidates since pool is empty).
2. **Upload CV #2 with overlapping content** — each bullet shows similarity candidates. Merge a duplicate → confirm the merged bullet has gaps from BOTH versions, and artifacts from CV#1 are visible.
3. **Coach evidence** — start an interview on CV#2, ask about the merged project. Click "See enhanced version" → confirm it uses evidence from CV#1's filled gaps (the whole point!).
4. **Manual merge** — in the CV detail view, merge two bullets. Confirm gaps are combined, source bullet disappears, junction rows updated.
5. **Delete CV version** — only junction rows are removed. The shared bullet + its gaps + artifacts survive if linked to another version.
6. **Embedding quality** — upload two CVs where the same project is described differently ("Built ScholarPath, a course recommendation platform" vs "Developed a course recommendation system called ScholarPath"). Confirm the system suggests them as similar (should appear in top-5 with >0.7 similarity).
7. **No Voyage key** — disable `VOYAGE_API_KEY`. Confirm upload still works (no candidates shown, user must create all bullets as new). Manual merge still works (returns empty similar list, but user can expand to see all bullets).

## Out of scope

- Automatic merge without user confirmation (too risky — false positive merges could combine unrelated bullets).
- Cross-user bullet sharing.
- HNSW index on `bullet_embedding` (not needed at <500 bullets/user; add when scale demands it).
- Backfill UI (run the backfill route once via curl after deploy).
- Voyage model upgrade path (voyage-3.5-lite is fine for short texts; revisit if quality degrades).
