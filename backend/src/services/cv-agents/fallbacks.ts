/**
 * Contract-safe fallbacks for the CV Optimizer V2 agents.
 *
 * One pure fallback per agent, returning the agent's narrow Out shape with
 * empty/neutral defaults. buildLlmAnalysisV2 substitutes them per branch
 * (e.g. analyzeStructure(input).catch(fallbackStructure)) so one agent's
 * failure does not collapse the whole result.
 *
 * Pure: no logging, no retries, no throws, empty arrays (never null).
 */
import type { StructureOut } from './structure.agent.js';
import type { KeywordsOut } from './keywords.agent.js';
import type { BulletsOut } from './bullets.agent.js';
import type { AlignmentOut } from './alignment.agent.js';

export function fallbackStructure(): StructureOut {
  return {
    sections: [],
    formatCheck: {
      issues: [],
      suggestions: ['Structure analysis unavailable this run.'],
    },
  };
}

export function fallbackKeywords(): KeywordsOut {
  return {
    keywordHighlights: [],
  };
}

export function fallbackBullets(): BulletsOut {
  return {
    bulletEvaluations: [],
    rewriteSuggestions: [],
  };
}

export function fallbackAlignment(): AlignmentOut {
  return {
    jdAlignment: {
      matchedRequirements: [],
      missingRequirements: [],
      alignmentSummary: '',
    },
  };
}
