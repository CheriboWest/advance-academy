import { assertLlmConfigured, createAnthropicClient, getFeatureModel } from '../lib/llm-anthropic.js';
import { extractTextFromUrl } from './outreach-extractor.service.js';
import type { JdValidationResult } from '@advance-academy/contracts/outreach';

function firstTextContent(response: { content: Array<{ type: string; text?: string }> }): string {
  const block = response.content[0];
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

/**
 * Tries to locate the job description section inside a noisy scraped page
 * (navigations, modals, footers, ads) without an LLM call.
 * Returns a trimmed excerpt starting at the first recognisable JD header.
 */
function heuristicJdSlice(content: string, maxChars = 4000): string {
  // Common section headers in Vietnamese and English job boards
  const JD_HEADERS = [
    /##\s*(Mô tả công việc|Job Description|Job Responsibilities|About the role)/i,
    /##\s*(Yêu cầu ứng viên|Requirements|Qualifications|What we.re looking)/i,
    /##\s*(Software|Developer|Engineer|Manager|Designer|Analyst|Director|Head of)/i,
    /\n(Job Title|Position|Role|RESPONSIBILITIES|REQUIREMENTS)\s*[:\n]/i,
  ];

  for (const pattern of JD_HEADERS) {
    const idx = content.search(pattern);
    if (idx !== -1) {
      // Stop before common footer markers to avoid sending KB of boilerplate
      const excerpt = content.slice(idx);
      const FOOTER_MARKERS = /\[Việc làm|## Tìm việc|## Báo cáo|## Kỹ năng cần|## Danh mục|## Thông tin chung|©\s*20\d{2}/i;
      const footerIdx = excerpt.search(FOOTER_MARKERS);
      const end = footerIdx > 300 ? Math.min(footerIdx, maxChars) : maxChars;
      return excerpt.slice(0, end).trim();
    }
  }

  // Fallback: skip probable navigation (first 15% of content) and take the next slice
  const skip = Math.min(Math.floor(content.length * 0.15), 3000);
  return content.slice(skip, skip + maxChars).trim();
}

/**
 * Shown to the user when the LLM response can't be parsed into a validation
 * verdict. We must NOT assert the page is a valid JD in this case (AAT-16) —
 * otherwise navigation/footer junk flows into the generation prompt.
 */
export const JD_PARSE_FAILURE_REASON =
  "We couldn't read this page as a job description. Please paste the job description text directly instead.";

/**
 * Pure interpreter for the validator LLM's raw text response. Kept separate from
 * the network/LLM call so the parse-failure path is unit-testable (AAT-16).
 *
 * On any parse failure (no JSON object, or malformed JSON) it returns
 * `valid: false` with a clear reason — never `valid: true` with a raw slice.
 */
export function interpretJdValidation(rawText: string, excerpt: string): JdValidationResult {
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn('[outreach-jd-validator] LLM response contained no JSON object — treating as not a JD.');
    return { valid: false, reason: JD_PARSE_FAILURE_REASON };
  }

  let parsed: { isJobDescription?: boolean; reason?: string; extractedJd?: string | null };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    console.warn('[outreach-jd-validator] LLM response JSON failed to parse — treating as not a JD.');
    return { valid: false, reason: JD_PARSE_FAILURE_REASON };
  }

  if (!parsed.isJobDescription) {
    return { valid: false, reason: parsed.reason || undefined };
  }

  // Prefer LLM-extracted text; fall back to heuristic slice if extraction is empty.
  const jdText = (typeof parsed.extractedJd === 'string' && parsed.extractedJd.trim())
    ? parsed.extractedJd.trim()
    : excerpt.slice(0, 1500);

  return { valid: true, jdText, reason: parsed.reason || undefined };
}

export async function validateJdUrl(url: string): Promise<JdValidationResult> {
  assertLlmConfigured('outreach');

  let content: string;
  try {
    content = await extractTextFromUrl(url);
  } catch {
    return { valid: false, reason: 'Could not fetch this URL. Please check the link is accessible and try again.' };
  }

  if (!content.trim()) {
    return { valid: false, reason: 'The page appears to be empty or blocked.' };
  }

  // Use a heuristic slice to focus the LLM on the actual JD section,
  // not on navigation / ads / footer that dominate the raw scraped text.
  const excerpt = heuristicJdSlice(content, 3000);

  const anthropic = createAnthropicClient('outreach');
  const model = getFeatureModel('outreach');

  const response = await anthropic.messages.create({
    model,
    // Higher token limit: we want the LLM to both validate AND extract clean JD text
    max_tokens: 1200,
    system: 'You validate and extract job descriptions from web page content. Return only valid JSON, no other text.',
    messages: [{
      role: 'user',
      content: `Analyze this web page excerpt and:
1. Decide if it is a job description / job posting.
2. If yes, extract ONLY the relevant job information as clean plain text (job title, company, location, description, responsibilities, requirements, benefits). Remove all navigation, ads, modals, links, and unrelated boilerplate. Max 1500 characters.

Page excerpt:
${excerpt}

Return ONLY this JSON:
{
  "isJobDescription": true,
  "reason": "one short sentence",
  "extractedJd": "clean extracted job description text here"
}
or:
{
  "isJobDescription": false,
  "reason": "one short sentence",
  "extractedJd": null
}`,
    }],
  });

  return interpretJdValidation(firstTextContent(response), excerpt);
}
