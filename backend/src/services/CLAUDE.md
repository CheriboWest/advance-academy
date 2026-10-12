# backend/src/services — invariants that aren't visible from one file

## Interview Prep (`interview.service.ts`, `lib/interview-prep/*`)

- Prompt caching, 1h TTL, two breakpoints: (1) system block = persona prompt +
  `buildContextPreamble(JD + CV)`, (2) the last assistant message. The
  `[IMPORTANT: This is the final exchange]` addendum is a **separate, uncached**
  system block — concatenating it into the cached block invalidates the cache on
  the last turn.
- The cached prefix must be byte-identical across turns. If `cache_read` stays 0 in
  the `[interview-prep:start|turn]` logs, something in `body.context` changed (e.g.
  whitespace in `cvText`); diff the rendered system prompt of two requests.
  `questionBank` and `coachingSessionId` live on the context for this reason, and
  `coachingSessionId` is deliberately left out of the preamble.
- IRS scoring (`lib/interview-prep/irs-scoring.ts`) also caches rubric + CV/JD in
  the system block. `generateFeedbackReport` is uncached (one-shot transcript).
- Limits: max 4 breakpoints per request, 20-block lookback, minimum cacheable size
  and the cache itself are per model.
- Persistence is write-through, best-effort; the client `sessionId` and DB
  `dbSessionId` are different ids. Assessments are stored in `answer_assessments`.
- To add a persona: append to `PERSONAS` in `lib/interview-prep/personas.ts`, extend
  `PersonaId` in `packages/contracts/src/interview-prep.ts`, and copy the persona
  into `features/interview-prep/data/personas.ts` (the UI reads its display fields).

## Coach answer (`coach-answer.service.ts`, routes/coach-answer.ts)

- Two phases. **Preview** = embedding retrieval over the user's whole bullet pool via
  the `match_bullets` RPC (migration 007): top 5, cosine ≥ 0.50, no LLM. **Generate**
  = rewriter LLM over the user's edited `selectedBulletIds`, last 10 turns
  (`COACH_HISTORY_TURNS`), the IRS score and per-dimension `rationale_json` read
  server-side from `answer_assessments`.
- Raw artifact `content_text` is shown to the user but **never sent to the LLM** —
  only `summary_json`.
- A JIT clarification re-runs Generate, not Preview, so the user's selection survives.
  No `missingEvidencePrompts` from the LLM → regex the `[CANDIDATE TO FILL: …]`
  placeholders. Voyage down → empty preview. Saving to `answer_coaching` is best-effort.
- If `match_bullets` is missing, retrieval silently falls back to an arbitrary slice
  with `similarity: 0` — this also breaks CV Library merge suggestions (threshold 0.40).

## CV Library (`cv-knowledge.service.ts`)

- Bullets belong to the **user**, not a CV version (`cv_version_bullets` is the M:N
  link). Deleting a version removes only junction rows; orphan bullets are not cleaned up.
  `mergeBullets` re-parents gaps and links, then deletes the source. Only one
  `is_active` CV per user (partial unique index); coach evidence uses the whole pool.
- **No blob storage.** Gap artifacts are text only (`POST …/gaps/:gapId/artifacts`
  takes `{ text }`); rows with `source_type` `file`/`url` are historical and read-only.
  CV upload keeps extracted text plus the original filename in `source_file_path`.
- Adding and editing an artifact both go through `summarizeArtifactText` so
  `summary_json` matches the text — keep the two paths aligned.
- Upload is one synchronous request (frontend timeout 300s); the per-bullet
  similarity loop runs sequentially. Never auto-merge without the user confirming.

## Other

- CV Optimizer jobs are rows in `cv_analysis_jobs` (`POST /analyze` → 202 + jobId,
  client polls), so polling works across instances; `lib/cv-analysis-reaper.ts` fails
  jobs stuck 10+ minutes. V2 pipeline: see `cv-agents/CLAUDE.md`.
- `outreach.service.ts` orchestrates `outreach-extractor`, `-enrichment`,
  `-jd-validator`, `-rerank` — find the right sub-service before editing.
- Cover Letter writes the letter and CV back onto the saved job and moves a `saved`
  card to `preparing`; a thin JD with a link is fetched via `extractJobFromUrl` first.
- Coach Understanding sends the CV with no size cap — mind token cost if inputs grow.

## Gamification v2 (`gamification.service.ts`, `routes/gamification.ts`)

- Dark unless `GAMIFICATION_V2_ENABLED=true` (`isGamificationV2Enabled()` in
  `config/features.ts`). Off: `GET /api/gamification` returns `{ enabled: false }`,
  the other routes 404, everything else behaves as before — but 047's triggers still
  capture intents, so nothing is lost before the flag flips.
- **Never write a gamification table from the backend.** With the flag on, job-card
  create/status go through the `create_saved_job` / `change_job_status` RPCs; Cover
  Letter charges and writes back in one transaction via `record_cover_letter` /
  `charge_credits`, called through `spendCreditsWith` in `lib/credits.ts` (the route
  then skips `spendCredits`). `GET /api/engagement` stops writing `points_ledger`.
- Nothing is awarded for reading a page: the summary endpoint only runs the processor
  over captured intents.
- SQL error codes are mapped in `lib/gamification-errors.ts`: `GC001` → 429
  `CREDIT_EXHAUSTED`, `GN001` → 404, `GN002` → 409, `GX00x` / `42501` → 500.
- Stuck intents block a user's queue until an admin calls
  `POST /api/admin/gamification/intents/:seq/skip` (reason ≥ 10 chars); no UI yet.
- `gamification.integration.test.ts` is skipped unless `GAMIFICATION_IT_SUPABASE_URL`
  and `GAMIFICATION_IT_SERVICE_KEY` point at a local scratch Supabase.

## Interview ownership

`/api/interview` (message), `/api/evaluate` and `GET /api/interview/sessions/:id`
check that the `dbSessionId` belongs to the caller. Keep that check on any new
endpoint that takes a session id from the client.
