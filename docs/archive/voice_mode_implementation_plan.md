# Interview Prep — Voice Mode MVP

## Context

The Interview Prep feature currently supports only **text mode**. In [features/interview-prep/components/interview-prep-screen.tsx:525-533](features/interview-prep/components/interview-prep-screen.tsx#L525-L533) a "Voice Mode (Coming Soon)" chip is rendered disabled next to the active "Text Mode" chip. The current branch is `feature/interview_voice_mode`.

**Goal for MVP:** enable the voice-mode toggle so users can answer interview questions by speaking instead of typing. The voice-mode UI is **identical** to text mode except for one addition: a mic button that records audio, transcribes it via a third-party STT API, and drops the resulting text into the existing textarea for the user to review and send. No new persistence, no new LLM flow — transcribed text flows through the exact same `sendInterviewMessage` path as typed text.

## Transcription API Choice — Groq Whisper Large v3 Turbo

**Decision: Groq Whisper Large v3 Turbo** via Groq's HTTP API.

| Factor | Groq Whisper v3 Turbo | OpenAI Whisper | Deepgram Nova-3 | AssemblyAI |
|---|---|---|---|---|
| Free tier | **2,000 req/day, 7,200 audio-seconds/hour** | None | $200 credit then pay | Limited trial |
| Paid rate | **$0.04/hour** | $0.36/hour | ~$0.22/hour | $0.45/hour |
| Speed | 228× real-time | ~10× real-time | Streaming < 400ms | ~10× real-time |
| Stack fit | HTTP POST multipart, no SDK needed | Same | SDK preferred | SDK preferred |

**Why Groq wins for this MVP:**
- Free tier alone covers the MVP indefinitely (~2h audio per real hour is plenty for a demo tool)
- If we ever exceed it, Groq is **~9× cheaper** than OpenAI Whisper
- Whisper large-v3-turbo is state-of-the-art open STT; multilingual, robust to accents
- OpenAI-compatible HTTP API — no SDK install, just `fetch` with multipart body
- Keeps the "external call" pattern identical to how the Anthropic SDK is already wired

**No new npm dependency required** — we'll use native `fetch` + a `FormData` body from the backend, mirroring how [backend/src/lib/anthropic.ts](backend/src/lib/anthropic.ts) talks to Claude.

## Architecture Fit

The change slots cleanly into the existing 4-layer pattern. One new endpoint (`POST /api/interview/transcribe`) plus small UI/hook edits. No schema changes, no new tables.

```
MicButton (new)
  → useInterview.transcribeAudio() (new hook method)
  → transcribeInterviewAudioWithBackend() (new frontend client fn)
  → app/api/interview/transcribe/route.ts (new Next.js proxy, multipart passthrough)
  → backend POST /api/interview/transcribe (new Fastify route, scoped multipart)
  → transcribeAudio() service (new, calls Groq HTTP API)
  → Groq Whisper Large v3 Turbo → returns { text }
```

After transcription returns, the existing text-mode flow (`sendMessage` → `/api/interview` → `sendInterviewMessage`) handles everything else unchanged.

## Implementation Steps

### 1. Backend — transcription service + route

**New file: `backend/src/services/transcription.service.ts`**
- Export `transcribeAudio(audioBuffer: Buffer, filename: string, mimeType: string): Promise<{ text: string }>`
- Reads `GROQ_API_KEY` from env; throws a 503 `Error` with `.statusCode = 503` if missing (mirrors the `assertLLMConfigured()` pattern in [backend/src/services/interview.service.ts](backend/src/services/interview.service.ts))
- Builds a `FormData` with fields: `file` (the buffer), `model: "whisper-large-v3-turbo"`, `response_format: "json"`, optional `language: "en"`
- POSTs to `https://api.groq.com/openai/v1/audio/transcriptions` with `Authorization: Bearer ${GROQ_API_KEY}`
- 60s timeout via `AbortController` (matches existing LLM timeout pattern)
- Maps upstream errors to `Error` with `.statusCode` and `.step = 'transcription'` so the route handler can translate to HTTP, matching [backend/src/routes/dream-company.ts](backend/src/routes/dream-company.ts)

**Modify: `backend/src/routes/interview.ts`**
- Add a scoped multipart sub-plugin at the bottom of `registerInterviewRoutes`, copying the exact pattern from [backend/src/routes/dream-company.ts:121-157](backend/src/routes/dream-company.ts#L121-L157):
  - `await app.register(async (scoped) => { await scoped.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } }); ... })`
  - 25 MB limit (Groq's per-request limit on free tier; larger than the 15 MB used for PDFs)
  - Allowed extensions: `.webm`, `.mp3`, `.wav`, `.m4a`, `.ogg` (MediaRecorder on Chrome/Edge emits `audio/webm;codecs=opus` by default)
  - `POST /api/interview/transcribe`:
    1. `await request.file()` → 400 if missing
    2. Validate extension / mimetype
    3. `const buffer = await data.toBuffer()`
    4. `const result = await transcribeAudio(buffer, data.filename, data.mimetype)`
    5. `return { text: result.text }`
    6. Catch, inspect `.statusCode` and `.step`, return appropriate error response
- Add `import multipart from '@fastify/multipart'` at the top (already a dependency)

**Modify: `backend/.env.example`**
- Add `GROQ_API_KEY=` with a comment that it's required for interview voice mode transcription

### 2. Shared contracts

**Modify: `packages/contracts/src/index.ts`** (or wherever interview types live — confirm by reading)
- Add `TranscribeAudioResponse = { text: string }` if cross-layer typing is needed. If the response is trivial enough, inline the type and skip this.

### 3. Frontend — Next.js proxy

**New file: `app/api/interview/transcribe/route.ts`**
- `POST` handler that:
  1. Reads the incoming `FormData` via `request.formData()`
  2. Forwards to backend via the new `transcribeInterviewAudioWithBackend(formData)` client
  3. Catches `HttpClientError`, normalizes to `ApiErrorResponse`
- Model after [app/api/dream-company/parse-cv/route.ts](app/api/dream-company/parse-cv/route.ts) if it exists, otherwise after any other multipart proxy in `app/api/*`

### 4. Frontend — backend client

**Modify: `shared/api/backend-client.ts`**
- Add:
  ```ts
  export function transcribeInterviewAudioWithBackend(formData: FormData) {
    return fetchFormDataJson<{ text: string }>(
      buildUrl('/api/interview/transcribe'),
      formData,
      { timeoutMs: 60_000 }
    )
  }
  ```
- Reuses the existing `fetchFormDataJson` helper from [shared/api/http-client.ts:77-130](shared/api/http-client.ts#L77-L130)

### 5. Frontend — `useInterview` hook

**Modify: `hooks/use-interview.ts`**
- Add state: `const [mode, setMode] = useState<'text' | 'voice'>('text')` + a setter exposed as `setInterviewMode`
- Add `transcribeAudio(blob: Blob): Promise<string>` callback:
  1. Build `FormData`, append blob as `file` with filename `answer.webm`
  2. Call `/api/interview/transcribe` via the frontend client
  3. Return the transcribed `text` (do NOT auto-submit; caller puts it in the textarea)
  4. Track a `transcribing` boolean in state for the button/spinner UI
- Expose `mode`, `setInterviewMode`, `transcribeAudio`, `transcribing` from the hook's return value

### 6. Frontend — mic recording UI

**New file: `features/interview-prep/components/mic-button.tsx`**
- Client component (`"use client"`)
- Props: `{ disabled: boolean; onTranscribed: (text: string) => void; transcribing: boolean; onTranscribeStart: (blob: Blob) => Promise<string> }`
- Internal state: `'idle' | 'recording' | 'transcribing'`
- Uses `navigator.mediaDevices.getUserMedia({ audio: true })` + `MediaRecorder` with `mimeType: 'audio/webm;codecs=opus'` (fallback to default if unsupported)
- On first click: start recording; show red pulsing indicator + elapsed-time display
- On second click: stop recording → assemble `Blob` from recorded chunks → call `onTranscribeStart(blob)` → spinner → call `onTranscribed(text)` when resolved
- Handles permission denial with a toast/inline error (reuses existing toast infra if present, else a local `<p>`)
- Shows a tooltip / disabled state if the browser lacks `MediaRecorder` support
- Icon: `Mic` / `MicOff` / `Loader2` from `lucide-react` (already a dep)

**Modify: `features/interview-prep/components/interview-prep-screen.tsx`**

Two edits:

**(a) PersonaStep mode toggle (lines 525-533):** replace the disabled Voice Mode chip with a functional toggle. Both chips become clickable buttons bound to the new `mode` state from `useInterview`. Active chip: `bg-blue-900 text-white`. Inactive: `bg-gray-200 text-gray-700 hover:bg-gray-300`. Remove the `(Coming Soon)` span and the `cursor-not-allowed` class.

**(b) InterviewStepView textarea area (around lines 664-694):** when `mode === 'voice'`, render `<MicButton />` next to the Send button. The textarea stays visible and editable in both modes. On successful transcription, call `setInputValue(prev => prev ? prev + ' ' + text : text)` so multi-take recordings append rather than overwrite. Keep the existing `Ctrl+Enter` shortcut intact.

No changes to the coach panel, IRS scoring display, session lifecycle, or evaluation flow — those all remain shared between the two modes.

### 7. Environment & docs

- **`backend/.env.example`:** add `GROQ_API_KEY=`
- **`CLAUDE.md`:** one-line note under the env section that `GROQ_API_KEY` is needed for interview voice mode
- **`docs/BACKEND.md`:** add a line in the feature list noting the new `/api/interview/transcribe` endpoint and that it uses Groq Whisper. (Skip if the doc doesn't enumerate endpoints.)

## Files to Create

- `backend/src/services/transcription.service.ts`
- `app/api/interview/transcribe/route.ts`
- `features/interview-prep/components/mic-button.tsx`

## Files to Modify

- `backend/src/routes/interview.ts` — add scoped multipart sub-plugin + route
- `backend/.env.example` — add `GROQ_API_KEY`
- `shared/api/backend-client.ts` — add `transcribeInterviewAudioWithBackend`
- `hooks/use-interview.ts` — add `mode` state + `transcribeAudio` method
- `features/interview-prep/components/interview-prep-screen.tsx` — wire mode toggle + mount `<MicButton />`
- `CLAUDE.md` — note new env var

## Existing Code to Reuse (do not reinvent)

- **Multipart scoped plugin pattern:** [backend/src/routes/dream-company.ts:121-157](backend/src/routes/dream-company.ts#L121-L157)
- **FormData upload helper:** `fetchFormDataJson` in [shared/api/http-client.ts:77-130](shared/api/http-client.ts#L77-L130)
- **Error → HTTP code mapping:** the `statusCode`/`step` pattern used across [backend/src/routes/dream-company.ts](backend/src/routes/dream-company.ts) and [backend/src/routes/interview.ts](backend/src/routes/interview.ts)
- **503 guard on missing API key:** `assertLLMConfigured()` pattern in [backend/src/services/interview.service.ts](backend/src/services/interview.service.ts)
- **Proxy route shape:** [app/api/interview/route.ts](app/api/interview/route.ts) for JSON, any existing multipart proxy in `app/api/*` for FormData passthrough
- **Mic/Loader icons:** `lucide-react` (already imported for the disabled chip)

## What We Are Explicitly NOT Doing

- No writes to `session_media` or `transcript_turns` tables — audio is discarded after transcription per user decision
- No Supabase Storage bucket for audio
- No streaming / real-time transcription — a single POST per recorded utterance is enough
- No voice output (TTS) for the interviewer — text only
- No separate `mode = 'voice_ai'` column value on `interview_sessions` — both modes use the existing `live_ai` mode since the stored data is identical

## Verification

1. **Backend env:** set `GROQ_API_KEY` in `backend/.env` (free tier key from console.groq.com works)
2. **Run both servers:** `npm run dev:all` → frontend on :3000, backend on :4000
3. **Typecheck:** `npx tsc --noEmit` (frontend) and `npm run typecheck --workspace backend`
4. **Lint:** `npm run lint`
5. **Manual E2E:**
   - Open `http://localhost:3000/?view=interview`
   - Fill in CV + job context → go to PersonaStep
   - Click "Voice Mode" chip → confirm it becomes active (blue)
   - Pick a persona → Start Interview
   - In the interview chat, click the mic button → grant mic permission → speak an answer → click stop
   - Confirm transcribed text appears in the textarea
   - Edit if desired, click Send → confirm message posts and interviewer replies normally
   - Confirm IRS score + coach panel appear (shared infrastructure)
   - Complete 5 answers → confirm evaluation report generates
6. **Toggle back to Text Mode mid-interview:** confirm textarea still works normally
7. **Error paths:**
   - Deny mic permission → confirm friendly error, no crash
   - Unset `GROQ_API_KEY`, try to transcribe → confirm 503 surfaces as a user-visible error
   - Upload a 30 MB file artificially → confirm 413/400 from multipart limit
8. **DB sanity check:** query `answer_assessments` in Supabase → confirm the transcribed answer is stored in `candidate_answer` like any text answer, and IRS scores are populated
