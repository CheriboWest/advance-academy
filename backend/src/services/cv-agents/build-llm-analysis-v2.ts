/**
 * buildLlmAnalysisV2 — the CV Optimizer's parallel agent pipeline, used by
 * analyzeCv() when CV_OPTIMIZER_USE_V2=true (otherwise the monolith
 * buildLlmAnalysis() runs).
 *
 * It assembles a complete AnalyzeCvResult from the four agents plus the
 * existing buildAtsCheck, computeCompositeScore, and generateActionPlan —
 * WITHOUT normalizeResult (the agents own normalization).
 *
 * Reliability now mirrors the monolith: a no-LLM short-circuit returns
 * buildFallbackAnalysis() before any work, the four agents and the ATS pipeline
 * fan out in PARALLEL (each isolated by its own fallback); generateActionPlan
 * (isolated to buildActionPlanFallback()) starts once every branch but bullets
 * has landed and runs alongside it, then computeCompositeScore. It never throws. Per-agent
 * model routing is active (every branch → Haiku by default; see
 * models.ts), and it is wired into analyzeCv() behind the CV_OPTIMIZER_USE_V2
 * flag. Temporarily instrumented with per-branch timing logs for latency
 * diagnosis.
 */
import { analyzeStructure } from './structure.agent.js';
import { extractKeywords } from './keywords.agent.js';
import { analyzeBullets } from './bullets.agent.js';
import { analyzeAlignment } from './alignment.agent.js';
import { fallbackStructure, fallbackKeywords, fallbackBullets, fallbackAlignment } from './fallbacks.js';
import {
  buildAtsCheck,
  computeCompositeScore,
  generateActionPlan,
  buildActionPlanFallback,
  buildFallbackAnalysis,
} from '../cv-optimizer.service.js';
import { getLlmConfig } from '../../config/llm.js';
import { cvAgentModel } from './models.js';
import type { AnalyzeCvResult, AtsCheck } from '@advance-academy/contracts/cv-optimizer';

export type BuildLlmAnalysisV2Input = {
  targetRole: string;
  cvText: string;
  jobDescription?: string;
};

// Matches the inline ATS fallback in buildLlmAnalysis() exactly — preserves
// monolith behavior when the ATS pipeline fails.
const EMPTY_ATS_CHECK: AtsCheck = {
  score: 0,
  issues: ['ATS scoring pipeline failed — score unavailable.'],
  passed: [],
  extractedKeywords: [],
  relevanceSignals: [],
};

/** Run one branch, logging its duration and whether it fell back. Diagnostic only. */
async function timed<T>(label: string, run: () => Promise<T>, fallback: () => T): Promise<T> {
  const start = Date.now();
  try {
    const result = await run();
    console.log(`⏱️ [v2] ${label}: ${Date.now() - start}ms`);
    return result;
  } catch (error) {
    console.log(`⏱️ [v2] ${label}: ${Date.now() - start}ms — FALLBACK (${error instanceof Error ? error.message : String(error)})`);
    return fallback();
  }
}

export async function buildLlmAnalysisV2(input: BuildLlmAnalysisV2Input): Promise<AnalyzeCvResult> {
  console.log('🔥 Using CV Optimizer V2');
  const { targetRole, cvText, jobDescription } = input;

  // No-LLM short-circuit — mirror analyzeCv(): if the LLM is disabled, return the
  // local fallback analysis without running any agent, ATS, action-plan, or
  // Promise.all work.
  if (!getLlmConfig('cvOptimizer').enabled) {
    return buildFallbackAnalysis({ targetRole, currentCvText: cvText, jobDescription });
  }

  // 1–5: fan out the four agents + the ATS pipeline in parallel. Each branch
  // carries its own fallback (via timed()), so every promise resolves and
  // Promise.all never rejects — per-branch isolation is preserved. timed() logs
  // each branch's duration and any fallback (diagnostic instrumentation).
  // bullets is the slowest branch, so it isn't awaited with the others: the
  // action plan doesn't need it and starts as soon as the other four land.
  const startedAt = Date.now();
  const bulletsPromise = timed('bullets', () => analyzeBullets({ targetRole, cvText }), fallbackBullets);
  const [structure, keywords, atsCheck, alignment] = await Promise.all([
    timed('structure', () => analyzeStructure({ targetRole, cvText, jobDescription }), fallbackStructure),
    timed('keywords', () => extractKeywords({ targetRole, cvText, jobDescription }), fallbackKeywords),
    timed('ats', () => buildAtsCheck({ targetRole, currentCvText: cvText, jobDescription }, cvAgentModel('ats')), () => EMPTY_ATS_CHECK),
    jobDescription
      ? timed('alignment', () => analyzeAlignment({ targetRole, cvText, jobDescription }), fallbackAlignment)
      : Promise.resolve(fallbackAlignment()),
  ]);
  console.log(`⏱️ [v2] fan-out (without bullets): ${Date.now() - startedAt}ms`);

  // 6: action plan, isolated to the monolith's fallback, running alongside
  // bullets. ponytail: it loses the bullet-impact counts the monolith sends;
  // the bullets tab and score cover bullet quality.
  const [bullets, actionPlan] = await Promise.all([
    bulletsPromise,
    timed('actionPlan', () => generateActionPlan({
      targetRole,
      jobDescription,
      sections: structure.sections,
      atsCheck,
      jdAlignment: alignment.jdAlignment,
      keywordHighlights: keywords.keywordHighlights,
    }), buildActionPlanFallback),
  ]);

  // 7: composite score from agent + ATS outputs.
  const { overallScore, breakdown } = computeCompositeScore(
    structure.sections,
    atsCheck,
    bullets.bulletEvaluations,
  );

  console.log(`⏱️ [v2] TOTAL: ${Date.now() - startedAt}ms`);

  // 8: assemble the contract result (same field set/names as buildLlmAnalysis).
  return {
    overallScore,
    scoreBreakdown: breakdown,
    sections: structure.sections,
    keywordHighlights: keywords.keywordHighlights,
    atsCheck,
    formatCheck: structure.formatCheck,
    bulletEvaluations: bullets.bulletEvaluations,
    rewriteSuggestions: bullets.rewriteSuggestions,
    jdAlignment: alignment.jdAlignment,
    actionPlan,
  };
}
