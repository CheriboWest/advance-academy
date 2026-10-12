/**
 * Normalizers for the CV Optimizer V2 agents.
 *
 * Relocates the still-useful per-item invariants from cv-optimizer.service.ts's
 * normalizeResult() into the agent that produces each slice, so each agent's Out
 * type is trustworthy at its boundary. Pure: no logging, retries, fallbacks, or
 * throws. The throw-on-empty-sections invariant is intentionally NOT reproduced.
 *
 * Behavioral goal: produce output equivalent to normalizeResult() for the same
 * LLM response — relocation, not hardening.
 */
import type { StructureOut } from './structure.agent.js';
import type { KeywordsOut } from './keywords.agent.js';
import type { BulletsOut } from './bullets.agent.js';
import type { AlignmentOut } from './alignment.agent.js';
import type { FormatCheck, JdAlignment } from '@advance-academy/contracts/cv-optimizer';

// ─── Shared coercion helpers (private; copied verbatim from cv-optimizer.service.ts) ───

function safeArray<T>(val: unknown, fallback: T[] = []): T[] {
  return Array.isArray(val) ? (val as T[]) : fallback;
}

function safeString(val: unknown, fallback = ''): string {
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : fallback;
}

/** 0–100 score clamp ONLY. Not generalized — bullet impactScore has its own 1–10 clamp. */
function safeNumber(val: unknown, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : fallback;
}

// ─── Structure ───────────────────────────────────────────────────────────────

export function normalizeStructure(raw: Partial<StructureOut>): StructureOut {
  const sections = safeArray<StructureOut['sections'][number]>(raw.sections)
    .map((s) => ({
      title: safeString(s?.title),
      score: safeNumber(s?.score),
      feedback: safeString(s?.feedback),
    }))
    .filter((s) => s.title && s.feedback);

  const rawFmt = (raw.formatCheck ?? {}) as Partial<FormatCheck>;

  return {
    sections,
    formatCheck: {
      issues: safeArray<string>(rawFmt.issues),
      suggestions: safeArray<string>(rawFmt.suggestions),
    },
  };
}

// ─── Keywords ────────────────────────────────────────────────────────────────

export function normalizeKeywords(raw: Partial<KeywordsOut>): KeywordsOut {
  return {
    keywordHighlights: safeArray(raw.keywordHighlights),
  };
}

// ─── Bullets ─────────────────────────────────────────────────────────────────

export function normalizeBullets(raw: Partial<BulletsOut>): BulletsOut {
  return {
    bulletEvaluations: safeArray<BulletsOut['bulletEvaluations'][number]>(raw.bulletEvaluations)
      .map((b) => ({
        original: safeString(b?.original),
        project: safeString(b?.project, 'Other'),
        hasImpact: Boolean(b?.hasImpact),
        // TODO:
        // Existing monolith behavior allows
        // non-numeric impactScore values to become NaN.
        // Preserved intentionally for behavioral fidelity.
        // Revisit in a future hardening pass.
        impactScore: Math.max(1, Math.min(10, Math.round(Number(b?.impactScore ?? 0)))),
        feedback: safeString(b?.feedback),
        autoRewrite: safeString(b?.autoRewrite),
        clarifyingQuestions: safeArray<string>(b?.clarifyingQuestions)
          .filter((q) => typeof q === 'string' && q.trim().length > 0),
      }))
      .filter((b) => b.original.length > 0),
    rewriteSuggestions: safeArray(raw.rewriteSuggestions),
  };
}

// ─── Alignment ───────────────────────────────────────────────────────────────

export function normalizeAlignment(raw: Partial<AlignmentOut>): AlignmentOut {
  const rawAlignment = (raw.jdAlignment ?? {}) as Partial<JdAlignment>;
  return {
    jdAlignment: {
      matchedRequirements: safeArray<string>(rawAlignment.matchedRequirements),
      missingRequirements: safeArray<string>(rawAlignment.missingRequirements),
      alignmentSummary: safeString(rawAlignment.alignmentSummary),
    },
  };
}
