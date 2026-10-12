# features/interview-prep — Interview Prep (`/?view=interview`)

- `components/interview-prep-screen.tsx` is the step router (setup → persona →
  interview → report); each step is its own file. `coach-panel.tsx` is the
  "See enhanced version" panel under an answer.
- All requests go through `api/frontend-client.ts` (interview endpoints) and
  `features/cv-library/api/frontend-client.ts` (CV versions, bullets, artifacts).
  They return the raw `Response`; callers read their own error bodies — a 429
  `message` is shown verbatim in the red banner.
- `POST /api/interview` serves both `start` and `message` (`action` field). Only
  `start` counts against the daily cap and needs Membership.
- The whole `InterviewContext` is re-sent every turn and must stay byte-identical,
  or the backend's prompt cache misses (see `backend/src/services/CLAUDE.md`).
  Don't add volatile fields (timestamps, re-trimmed text) to it.
- Setup offers the student's tracked jobs (`useSavedJobs` minus
  `TERMINAL_SAVED_JOB_STATUSES`) and `?savedJob=<id>`; a thin JD with a link pre-fills
  the extract-from-URL box instead of fetching on load. Starting a session does not
  change the card's status. `?coaching=<id>` loads an approved coaching pack and
  skips setup.
- Coach panel flow: Preview (retrieval, no LLM) → user edits the bullet selection →
  Generate. JIT clarification answers re-run Generate with the same selection.
- `data/personas.ts` is a full copy of `backend/src/lib/interview-prep/personas.ts`,
  but only its display fields are used — the backend's copy is what the LLM gets.
  Change both together.
- Voice mode: `mic-button.tsx` records, `/api/interview/transcribe` (Groq Whisper,
  `GROQ_API_KEY`) returns text that goes through the normal text turn.
