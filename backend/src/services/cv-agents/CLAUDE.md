# cv-agents — CV Optimizer V2 pipeline

- Live when `CV_OPTIMIZER_USE_V2=true` (`config/features.ts`); otherwise
  `cv-optimizer.service.ts` runs the monolith `buildLlmAnalysis`. Entry:
  `build-llm-analysis-v2.ts`. All branches use Haiku (`models.ts`).
- Structure, keywords, ATS (two chained calls) and alignment fan out in parallel.
  **Bullets** is the slowest branch, so the CV is split into ≤4 parts evaluated in
  parallel (`splitCvIntoParts`), and `rewriteSuggestions` is derived from the
  weakest bullets' `autoRewrite` (`deriveRewriteSuggestions`) — not generated.
- The action plan starts once the four fast branches land and runs **alongside**
  bullets, so it gets no bullet stats. It is the critical path (~17s after an ~11s
  fan-out; total ~29s on a 13-bullet sample).
- Each agent owns one slice of `AnalyzeCvResult`, normalizes it (`normalizers.ts`)
  and has a contract-safe fallback (`fallbacks.ts`); one failed branch never fails
  the run, and the orchestrator never throws.
- Every call uses `CV_LLM_CLIENT_OPTIONS` (120s, 1 retry) so a stuck call falls back
  instead of hanging until the 10-minute stale-job reaper.
- Prompts are in `prompts/` (decomposed word-for-word from the monolith prompt);
  `lib/run-json-task.ts` is the shared one-call → JSON helper, meant only for these agents.
- Timings print as `⏱️ [v2] …` on stdout. CV calls are not in `cost-log.jsonl`.
- `today-instruction.ts` duplicates the monolith's private `todayInstruction()` on
  purpose; collapse them if the monolith path is retired.
