/**
 * Cost tracker for LLM (Anthropic) and Exa calls.
 * Logs per-call usage + cost to the backend console and appends a JSONL
 * record to `backend/cost-log.jsonl` on each flush() so costs are persisted
 * for the usage-report script (`npm run usage`).
 *
 * Pricing is defined in this file — keep it in sync with provider price cards.
 *  - Anthropic Sonnet 4:  $3 / MTok input,  $15 / MTok output
 *  - Anthropic Opus 4:    $15 / MTok input, $75 / MTok output
 *  - Anthropic Haiku 4.5: $1 / MTok input,  $5 / MTok output
 *  - Exa fast search + contents: ~$5 / 1000 calls
 */

import { appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Resolves to backend/cost-log.jsonl (2 levels up from src/lib/ or dist/lib/)
const COST_LOG_PATH = join(__dirname, '..', '..', 'cost-log.jsonl');

interface ModelPricing {
  /** USD per 1,000,000 input tokens */
  input: number;
  /** USD per 1,000,000 output tokens */
  output: number;
  /** USD per 1,000,000 cache-write tokens (defaults to 1.25× input) */
  cacheWrite?: number;
  /** USD per 1,000,000 cache-read tokens (defaults to 0.10× input) */
  cacheRead?: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Sonnet 4 family (default)
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  // Opus 4 family
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  // Haiku 4 family
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // The undated alias is what the code actually asks for — config/llm.ts and
  // cv-agents/models.ts both name it. Without this key every Haiku call fell
  // through to FALLBACK_PRICING and was reported at Sonnet's 3/15.
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Conservative fallback when an unknown model name is reported. */
const FALLBACK_PRICING: ModelPricing = { input: 3, output: 15 };

/** Exa fast searchAndContents — public price card is ~$5 per 1k calls. */
const EXA_COST_PER_SEARCH_USD = 0.005;

export interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Shape of each item recorded inside a CostLogEntry */
export interface CostLogItem {
  type: 'llm' | 'exa' | 'adzuna' | 'reed';
  label: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  /** Number of API calls/searches for provider items (exa/adzuna/reed). */
  searches?: number;
  cost: number;
}

/** Shape of one line in cost-log.jsonl */
export interface CostLogEntry {
  ts: string;
  feature: string;
  items: CostLogItem[];
  total: number;
}

function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? FALLBACK_PRICING;
}

function fmtUsd(amount: number): string {
  return `$${amount.toFixed(5)}`;
}

function num(value: number | null | undefined): number {
  return typeof value === 'number' ? value : 0;
}

export function calcLlmCost(model: string, usage: AnthropicUsage): number {
  const p = pricingFor(model);
  const inputCost = (num(usage.input_tokens) * p.input) / 1_000_000;
  const outputCost = (num(usage.output_tokens) * p.output) / 1_000_000;
  const cacheWriteCost =
    (num(usage.cache_creation_input_tokens) * (p.cacheWrite ?? p.input * 1.25)) / 1_000_000;
  const cacheReadCost =
    (num(usage.cache_read_input_tokens) * (p.cacheRead ?? p.input * 0.1)) / 1_000_000;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

export function calcExaCost(numSearches: number): number {
  return numSearches * EXA_COST_PER_SEARCH_USD;
}

/** A bucket that collects costs incurred during a single request. */
export interface CostBucket {
  /** Track an LLM call and log it. Returns the cost in USD. */
  llm(label: string, model: string, usage: AnthropicUsage | undefined | null): number;
  /** Track Exa searches and log them. Returns the cost in USD. */
  exa(label: string, numSearches: number): number;
  /** Track Adzuna API calls (free tier — cost 0). Returns the cost in USD (0). */
  adzuna(label: string, numCalls: number): number;
  /** Track Reed API calls (free tier — cost 0). Returns the cost in USD (0). */
  reed(label: string, numCalls: number): number;
  /** Print the accumulated total and persist to cost-log.jsonl. */
  flush(): number;
  /** Current accumulated total (without printing). */
  total(): number;
}

export function newCostBucket(requestLabel: string): CostBucket {
  let runningTotal = 0;
  const items: CostLogItem[] = [];

  // Free-tier job sources (Adzuna/Reed): recorded for call-count observability, cost 0.
  function trackFreeSource(type: 'adzuna' | 'reed', label: string, numCalls: number): number {
    items.push({ type, label, searches: numCalls, cost: 0 });
    // eslint-disable-next-line no-console
    console.log(
      `[cost] ${requestLabel} :: ${label.padEnd(22)} provider=${type} calls=${numCalls} cost=${fmtUsd(0)}`,
    );
    return 0;
  }

  return {
    llm(label, model, usage) {
      const u: AnthropicUsage = usage ?? {};
      const cost = calcLlmCost(model, u);
      runningTotal += cost;
      items.push({
        type: 'llm',
        label,
        model,
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheWriteTokens: num(u.cache_creation_input_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cost,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[cost] ${requestLabel} :: ${label.padEnd(22)} model=${model} ` +
          `in=${num(u.input_tokens)} out=${num(u.output_tokens)} ` +
          `cache_read=${num(u.cache_read_input_tokens)} cache_write=${num(u.cache_creation_input_tokens)} ` +
          `cost=${fmtUsd(cost)}`,
      );
      return cost;
    },

    exa(label, numSearches) {
      const cost = calcExaCost(numSearches);
      runningTotal += cost;
      items.push({ type: 'exa', label, searches: numSearches, cost });
      // eslint-disable-next-line no-console
      console.log(
        `[cost] ${requestLabel} :: ${label.padEnd(22)} provider=exa searches=${numSearches} cost=${fmtUsd(cost)}`,
      );
      return cost;
    },

    adzuna(label, numCalls) {
      return trackFreeSource('adzuna', label, numCalls);
    },

    reed(label, numCalls) {
      return trackFreeSource('reed', label, numCalls);
    },

    flush() {
      // eslint-disable-next-line no-console
      console.log(`[cost] ${requestLabel} :: TOTAL                 cost=${fmtUsd(runningTotal)}`);

      // Persist to JSONL — non-fatal if the write fails (e.g. read-only FS in prod)
      const entry: CostLogEntry = {
        ts: new Date().toISOString(),
        feature: requestLabel,
        items: [...items],
        total: runningTotal,
      };
      try {
        appendFileSync(COST_LOG_PATH, JSON.stringify(entry) + '\n');
      } catch {
        // intentionally silent
      }

      return runningTotal;
    },

    total() {
      return runningTotal;
    },
  };
}
