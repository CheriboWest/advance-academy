/**
 * Keywords agent — owns `keywordHighlights`.
 *
 * One branch of the CV Optimizer V2 pipeline (buildLlmAnalysisV2). Wraps the
 * CV_KEYWORDS_PROMPT module and runJsonTask(), returning only its owned slice.
 * No todayInstruction(): keyword extraction does not judge date realism.
 *
 * NOTE: this JD keyword extraction intentionally overlaps the ATS pipeline's
 * extractAtsKeywords() — deduplication is out of scope for this refactor.
 */
import { assertLlmConfigured, createAnthropicClient } from '../../lib/llm-anthropic.js';
import { cvAgentModel, CV_LLM_CLIENT_OPTIONS } from './models.js';
import { runJsonTask } from '../../lib/run-json-task.js';
import { CV_KEYWORDS_PROMPT } from '../../prompts/cv-keywords.prompt.js';
import { normalizeKeywords } from './normalizers.js';
import type { KeywordHighlight } from '@advance-academy/contracts/cv-optimizer';

export interface KeywordsInput {
  targetRole: string;
  cvText: string;
  jobDescription?: string;
}

export interface KeywordsOut {
  keywordHighlights: KeywordHighlight[];
}

export async function extractKeywords(input: KeywordsInput): Promise<KeywordsOut> {
  assertLlmConfigured('cvOptimizer');
  const anthropic = createAnthropicClient('cvOptimizer', CV_LLM_CLIENT_OPTIONS);
  const model = cvAgentModel('keywords');

  const user = [
    `TARGET ROLE: ${input.targetRole}`,
    '',
    '=== CV ===',
    input.cvText,
    '',
    input.jobDescription?.trim()
      ? `=== JOB DESCRIPTION ===\n${input.jobDescription.trim()}`
      : '(No job description provided — evaluate the CV against the target role only.)',
  ].join('\n');

  const raw = await runJsonTask<Partial<KeywordsOut>>({
    anthropic,
    model,
    system: CV_KEYWORDS_PROMPT,
    user,
    maxTokens: 2048,
    label: 'cv-keywords',
  });

  return normalizeKeywords(raw);
}
