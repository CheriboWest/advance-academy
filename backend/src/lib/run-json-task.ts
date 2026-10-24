/**
 * runJsonTask — minimal LLM-call → JSON helper for the CV Optimizer agent
 * architecture (Structure, Keywords, Bullets, Alignment).
 *
 * Intentionally narrow and opinionated toward CV analysis. It encapsulates only
 * the mechanical path the CV agents share: issue one Anthropic Messages call,
 * detect max_tokens truncation, extract the text block, strip code fences, and
 * JSON.parse the result into the caller's type.
 *
 * Everything else stays in the caller: model/API-key resolution, cost logging,
 * prompt caching, response normalization/validation, and — crucially —
 * fallback policy. This helper only ever returns parsed JSON or throws; callers
 * implement their own fallback by catching the throw.
 *
 * This is NOT a backend-wide LLM abstraction. Other services keep their own
 * bespoke paths — do not reach for this from them.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { withRetry } from './llm-anthropic.js';
import { extractJsonObject } from './coaching/json.js';

export interface RunJsonTaskOptions {
  /** Caller-constructed Anthropic client — the helper never creates one. */
  anthropic: Anthropic;
  /** Pre-resolved model string — the caller maps feature → model. */
  model: string;
  /** System prompt (caller prepends todayInstruction() etc.). */
  system: string;
  /** User prompt — target role + CV + optional JD. */
  user: string;
  /** Per-call output cap. Required; varies per agent. */
  maxTokens: number;
  /** Diagnostic identity for thrown errors, e.g. "cv-bullets". */
  label: string;
  /** Opt into 429 backoff via withRetry(). Defaults to false. */
  retry?: boolean;
}

/** The JSON object in the reply, dropping fences and any prose around them. */
function stripJsonFences(raw: string): string {
  return extractJsonObject(raw) ?? raw.trim();
}

/**
 * Run one CV-agent LLM call and return its parsed JSON payload.
 *
 * Throws (never falls back) when:
 *  - the response was truncated at max_tokens,
 *  - no text block is present,
 *  - the text is not valid JSON (native SyntaxError from JSON.parse).
 *
 * The helper is unaware of AnalyzeCvResult or any caller schema — T is supplied
 * by the caller, which is responsible for all post-parse validation.
 */
export async function runJsonTask<T>(options: RunJsonTaskOptions): Promise<T> {
  const { anthropic, model, system, user, maxTokens, label, retry = false } = options;

  const call = () => anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const response = retry ? await withRetry(call) : await call();

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`[${label}] response truncated at max_tokens (${maxTokens}).`);
  }

  const block = response.content[0];
  if (!block || block.type !== 'text') {
    throw new Error(`[${label}] response contained no text block.`);
  }

  return JSON.parse(stripJsonFences(block.text)) as T;
}
