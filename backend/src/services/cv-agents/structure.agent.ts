/**
 * Structure agent — owns `sections` and `formatCheck`.
 *
 * One branch of the CV Optimizer V2 pipeline (buildLlmAnalysisV2). Wraps the
 * CV_STRUCTURE_PROMPT module and runJsonTask(), returning only its owned slice.
 * It is unaware of AnalyzeCvResult as a whole and does no business validation.
 */
import { assertLlmConfigured, createAnthropicClient } from '../../lib/llm-anthropic.js';
import { cvAgentModel, CV_LLM_CLIENT_OPTIONS } from './models.js';
import { runJsonTask } from '../../lib/run-json-task.js';
import { CV_STRUCTURE_PROMPT } from '../../prompts/cv-structure.prompt.js';
import { todayInstruction } from './today-instruction.js';
import { normalizeStructure } from './normalizers.js';
import type { AnalyzeCvResult, FormatCheck } from '@advance-academy/contracts/cv-optimizer';

export interface StructureInput {
  targetRole: string;
  cvText: string;
  jobDescription?: string;
}

export interface StructureOut {
  sections: AnalyzeCvResult['sections'];
  formatCheck: FormatCheck;
}

export async function analyzeStructure(input: StructureInput): Promise<StructureOut> {
  assertLlmConfigured('cvOptimizer');
  const anthropic = createAnthropicClient('cvOptimizer', CV_LLM_CLIENT_OPTIONS);
  const model = cvAgentModel('structure');

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

  const raw = await runJsonTask<Partial<StructureOut>>({
    anthropic,
    model,
    system: `${todayInstruction()}\n\n${CV_STRUCTURE_PROMPT}`,
    user,
    maxTokens: 2048,
    label: 'cv-structure',
  });

  return normalizeStructure(raw);
}
