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
  // Default on: only the exact string "false" falls back to the monolith.
  return {
    useV2: process.env.CV_OPTIMIZER_USE_V2?.trim().toLowerCase() !== 'false',
  };
}
