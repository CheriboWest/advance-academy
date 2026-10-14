/**
 * Bullets agent — owns `bulletEvaluations` and `rewriteSuggestions`.
 *
 * The slowest branch of the V2 fan-out: its output grows with every bullet
 * (score, feedback, rewrite, questions). So the CV is split into parts that
 * are evaluated in parallel, and `rewriteSuggestions` is derived from the
 * weakest bullets' `autoRewrite` instead of costing more output tokens.
 * Does not use the JD — bullet impact is judged against the CV only.
 */
import { assertLlmConfigured, createAnthropicClient } from '../../lib/llm-anthropic.js';
import { cvAgentModel, CV_LLM_CLIENT_OPTIONS } from './models.js';
import { runJsonTask } from '../../lib/run-json-task.js';
import { CV_BULLETS_PROMPT } from './prompts/cv-bullets.prompt.js';
import { todayInstruction } from './today-instruction.js';
import { normalizeBullets } from './normalizers.js';
import type { BulletEvaluation, RewriteSuggestion } from '@advance-academy/contracts/cv-optimizer';

export interface BulletsInput {
  targetRole: string;
  cvText: string;
}

export interface BulletsOut {
  bulletEvaluations: BulletEvaluation[];
  rewriteSuggestions: RewriteSuggestion[];
}

/** Roughly one part per this many CV characters, capped at MAX_PARTS. */
const CHARS_PER_PART = 1200;
const MAX_PARTS = 4;

/**
 * Split the CV at blank lines into up to `parts` chunks of similar length.
 * ponytail: blank-line split is a heuristic — a CV pasted without blank lines
 * stays one part (one slower call, same result). Split on role headings if
 * that turns out to be common.
 */
export function splitCvIntoParts(cvText: string, parts: number): string[] {
  const blocks = cvText.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (parts <= 1 || blocks.length <= 1) return [cvText];
  const target = cvText.length / parts;
  const out: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const block of blocks) {
    current.push(block);
    size += block.length;
    if (size >= target && out.length < parts - 1) {
      out.push(current.join('\n\n'));
      current = [];
      size = 0;
    }
  }
  if (current.length) out.push(current.join('\n\n'));
  return out;
}

/** The 3–6 weakest bullets that have a rewrite, as side-by-side suggestions. */
export function deriveRewriteSuggestions(bullets: BulletEvaluation[]): RewriteSuggestion[] {
  return bullets
    .filter((b) => b.autoRewrite.trim().length > 0)
    .sort((a, b) => a.impactScore - b.impactScore)
    .slice(0, 6)
    .map((b) => ({ section: b.project, current: b.original, suggested: b.autoRewrite, reason: b.feedback }));
}

export async function analyzeBullets(input: BulletsInput): Promise<BulletsOut> {
  assertLlmConfigured('cvOptimizer');
  const anthropic = createAnthropicClient('cvOptimizer', CV_LLM_CLIENT_OPTIONS);
  const model = cvAgentModel('bullets');

  const header = [`TARGET ROLE: ${input.targetRole}`, '', '=== CV ===', input.cvText];
  const parts = splitCvIntoParts(
    input.cvText,
    Math.min(MAX_PARTS, Math.ceil(input.cvText.length / CHARS_PER_PART)),
  );

  // allSettled: one failed part loses its bullets, not the whole tab.
  const settled = await Promise.allSettled(parts.map((part, i) => runJsonTask<Partial<BulletsOut>>({
    anthropic,
    model,
    system: `${todayInstruction()}\n\n${CV_BULLETS_PROMPT}`,
    user: parts.length === 1
      ? header.join('\n')
      : [...header, '', '=== EVALUATE ONLY THE BULLETS IN THIS PART ===', part].join('\n'),
    maxTokens: 16384,
    label: `cv-bullets[${i + 1}/${parts.length}]`,
  })));
  const results = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (!results.length) throw (settled[0] as PromiseRejectedResult).reason;

  // A bullet sitting on a part boundary can come back twice — keep the first.
  const seen = new Set<string>();
  const bulletEvaluations = results
    .flatMap((r) => normalizeBullets(r).bulletEvaluations)
    .filter((b) => {
      const key = b.original.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return { bulletEvaluations, rewriteSuggestions: deriveRewriteSuggestions(bulletEvaluations) };
}
