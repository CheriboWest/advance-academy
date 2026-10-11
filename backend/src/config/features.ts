/**
 * Feature flags for the CV Optimizer.
 *
 * Kept separate from config/llm.ts (which owns provider/model/key config) so a
 * code-path toggle does not couple to the global LLM configuration. Read lazily
 * at call time.
 */
export interface CvOptimizerFeatures {
  /** Route analyzeCv() through the parallel agent pipeline (buildLlmAnalysisV2). */
  useV2: boolean;
}

export function getCvOptimizerFeatures(): CvOptimizerFeatures {
  // Default off: anything other than the exact string "true" is false.
  return {
    useV2: process.env.CV_OPTIMIZER_USE_V2?.trim().toLowerCase() === 'true',
  };
}

/**
 * Gamification v2 (migration 047, docs/GAMIFICATION_V2.md). Off by default.
 *
 * Off: job cards, statuses and cover letters are written as before, and the
 * weekly-tasks panel (migration 045) awards its points on read. On: those writes
 * go through 047's transactional RPCs, the /api/gamification endpoints answer,
 * and nothing is awarded for reading a page. 047's capture triggers fire either
 * way, so intents recorded while the flag is off are judged once it is on.
 */
export function isGamificationV2Enabled(): boolean {
  return process.env.GAMIFICATION_V2_ENABLED?.trim().toLowerCase() === 'true';
}
