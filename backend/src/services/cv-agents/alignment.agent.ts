/**
 * Alignment agent — owns `jdAlignment`.
 *
 * One branch of the CV Optimizer V2 pipeline (buildLlmAnalysisV2). Wraps the
 * CV_ALIGNMENT_PROMPT module and runJsonTask(), returning only its owned slice.
 * The JD is REQUIRED — JD alignment is meaningless without it. No
 * todayInstruction(): requirement matching does not judge date realism.
 */
import { assertLlmConfigured, createAnthropicClient } from '../../lib/llm-anthropic.js';
import { cvAgentModel, CV_LLM_CLIENT_OPTIONS } from './models.js';
import { runJsonTask } from '../../lib/run-json-task.js';
import { CV_ALIGNMENT_PROMPT } from './prompts/cv-alignment.prompt.js';
import { normalizeAlignment } from './normalizers.js';
import type { JdAlignment } from '@advance-academy/contracts/cv-optimizer';

export interface AlignmentInput {
  targetRole: string;
  cvText: string;
  jobDescription: string;
}

export interface AlignmentOut {
  jdAlignment: JdAlignment;
}

export async function analyzeAlignment(input: AlignmentInput): Promise<AlignmentOut> {
  assertLlmConfigured('cvOptimizer');
  const anthropic = createAnthropicClient('cvOptimizer', CV_LLM_CLIENT_OPTIONS);
  const model = cvAgentModel('alignment');

  const user = [
    `TARGET ROLE: ${input.targetRole}`,
    '',
    '=== CV ===',
    input.cvText,
    '',
    `=== JOB DESCRIPTION ===\n${input.jobDescription.trim()}`,
  ].join('\n');

  const raw = await runJsonTask<Partial<AlignmentOut>>({
    anthropic,
    model,
    system: CV_ALIGNMENT_PROMPT,
    user,
    maxTokens: 2048,
    label: 'cv-alignment',
  });

  return normalizeAlignment(raw);
}
