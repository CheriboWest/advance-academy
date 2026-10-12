/**
 * Anthropic SDK helpers + feature config — the one LLM client every feature uses.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmFeature } from '../config/llm.js';
import { getLlmApiKey, getLlmConfig } from '../config/llm.js';

export function assertLlmConfigured(feature: LlmFeature): void {
  const config = getLlmConfig(feature);
  if (!config.enabled) {
    const err = new Error(
      'LLM_API_KEY is not set in backend environment. Add it to backend/.env (see backend/.env.example).',
    );
    Object.assign(err, { statusCode: 503 });
    throw err;
  }
}

export interface AnthropicClientOptions {
  /** Abort the SDK request after this many ms. Omit to keep the SDK default (10 min). */
  timeoutMs?: number;
  /** SDK-level retry count. Omit to keep the SDK default (2). */
  maxRetries?: number;
}

export function createAnthropicClient(
  feature: LlmFeature = 'default',
  options: AnthropicClientOptions = {},
): Anthropic {
  const apiKey = getLlmApiKey(feature).trim();
  if (!apiKey) {
    const err = new Error('LLM_API_KEY is not set.');
    Object.assign(err, { statusCode: 503 });
    throw err;
  }
  // Only override timeout/maxRetries when a caller opts in, so features that make large,
  // slow calls (e.g. CV Optimizer at max_tokens 16384) keep the SDK's generous defaults.
  return new Anthropic({
    apiKey,
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  });
}

export function getFeatureModel(feature: LlmFeature): string {
  return getLlmConfig(feature).model;
}

// Transient statuses that are safe to retry with backoff: 429 (rate limit), 529 (overloaded),
// 503 (service unavailable). Anthropic returns overload/capacity errors as 529 quite often under
// load — before this they were NOT retried, so a momentary blip surfaced to the user as a hard
// error. 500 is deliberately excluded (often a real request problem, not transient).
export function isRetryableLlmError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = ('status' in err ? (err as { status?: number }).status : undefined)
    ?? ('statusCode' in err ? (err as { statusCode?: number }).statusCode : undefined);
  return status === 429 || status === 529 || status === 503;
}

// Reports whether an error is an Anthropic overload/capacity blip (429/529/503) — used by routes
// to map it to a friendly "briefly busy, try again" message instead of a bare 500.
export function isOverloadedError(err: unknown): boolean {
  return isRetryableLlmError(err);
}

// Retries fn up to maxRetries times on transient LLM errors, with exponential backoff (1s, 2s, 4s).
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isRetryableLlmError(err) && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  return fn();
}

// Streaming-safe retry. Anthropic overload/rate-limit errors surface at request START — before any
// token is emitted — so on a transient failure with nothing streamed yet we can safely recreate
// the stream. Once text has started we never retry (would double-emit deltas); the error is
// propagated instead. Mirrors withRetry's backoff (1s, 2s, 4s).
export async function streamFinalWithRetry<M>(
  makeStream: () => { on(ev: 'text', cb: (t: string) => void): unknown; finalMessage(): Promise<M> },
  onDelta?: (text: string) => void,
  maxRetries = 3,
): Promise<M> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let emitted = false;
    try {
      const stream = makeStream();
      if (onDelta) stream.on('text', (t) => { emitted = true; onDelta(t); });
      return await stream.finalMessage();
    } catch (err) {
      if (isRetryableLlmError(err) && !emitted && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error('streamFinalWithRetry: exhausted retries');
}
