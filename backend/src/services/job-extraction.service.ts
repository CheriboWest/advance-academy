/**
 * Job extraction service.
 *
 * Given a job posting URL (e.g. LinkedIn), fetches the page markdown via Jina Reader
 * (reusing the outreach extractor) and asks the LLM to pull structured fields out of it.
 * Any field the LLM cannot confidently determine is returned as an empty string so the
 * UI can leave it blank for the user to fill in manually.
 */
import { extractTextFromUrl } from './outreach-extractor.service.js';
import { assertLlmConfigured, createAnthropicClient, getFeatureModel } from '../lib/llm-anthropic.js';
import type { ExtractedJob } from '../types/interview-prep.js';

const MAX_MARKDOWN_CHARS = 20000;

const EMPTY: ExtractedJob = {
  jobTitle: '',
  jobDescription: '',
  companyName: '',
  companyUrl: '',
  extraLinks: [],
};

function cleanJsonResponse(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?\s*```$/, '')
    .trim();
}

function coerceString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join('\n').trim();
  return '';
}

// Accept either a JSON array of strings (preferred) or a newline-separated
// string (older prompt shape) and return a clean string[]. Empty entries
// are dropped.
function coerceUrlArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function buildPrompt(markdown: string): string {
  return `You are extracting structured data from a job posting. Below is the markdown of a job listing page.

Return ONLY valid JSON (no prose, no code fences) with EXACTLY these keys:
- jobTitle: string — the role title (e.g. "Senior Frontend Engineer")
- jobDescription: string — the full responsibilities + requirements text. Preserve bullet points using "- ". Do NOT summarize.
- companyName: string — the hiring company's name
- companyUrl: string — the hiring company's main website (NOT the job listing URL). Empty if not found.
- extraLinks: string[] — JSON array of other relevant URLs found on the page (apply link, careers page, recruiter LinkedIn). Each entry must be a full http(s) URL. Return [] if none. Maximum 30 entries.

For ANY string field you cannot confidently determine, return an empty string "". For extraLinks return []. Never invent values.

Job posting markdown:
"""
${markdown}
"""`;
}

export async function extractJobFromUrl(url: string): Promise<ExtractedJob> {
  if (!url || typeof url !== 'string') {
    throw Object.assign(new Error('url is required'), { statusCode: 400 });
  }
  try {
    new URL(url);
  } catch {
    throw Object.assign(new Error('Invalid URL'), { statusCode: 400 });
  }

  const markdown = await extractTextFromUrl(url);
  return extractJobFromMarkdown(markdown);
}

/**
 * The LLM half of extractJobFromUrl, for a caller that read the page itself
 * (Cover Letter, which needs to know *why* a page failed and must fit a
 * deadline: pass `timeoutMs`/`maxRetries`; omitted, the SDK defaults apply as
 * before). Throws statusCode 502 when the model returns nothing usable.
 */
export async function extractJobFromMarkdown(
  markdown: string,
  clientOptions: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<ExtractedJob> {
  const truncated = markdown.length > MAX_MARKDOWN_CHARS ? markdown.slice(0, MAX_MARKDOWN_CHARS) : markdown;

  assertLlmConfigured('interviewPrep');
  const anthropic = createAnthropicClient('interviewPrep', clientOptions);
  const model = getFeatureModel('interviewPrep');

  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: 'You extract structured job posting data and return only valid JSON.',
    messages: [{ role: 'user', content: buildPrompt(truncated) }],
  });

  const block = response.content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw Object.assign(new Error('LLM returned no text'), { statusCode: 502 });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleanJsonResponse(block.text));
  } catch {
    throw Object.assign(new Error('Failed to parse LLM response'), { statusCode: 502 });
  }

  return {
    ...EMPTY,
    jobTitle: coerceString(parsed.jobTitle),
    jobDescription: coerceString(parsed.jobDescription),
    companyName: coerceString(parsed.companyName),
    companyUrl: coerceString(parsed.companyUrl),
    extraLinks: coerceUrlArray(parsed.extraLinks),
  };
}
