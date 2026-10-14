import { getExaClient } from '../lib/exa-client.js';
import { assertLlmConfigured, createAnthropicClient, getFeatureModel, withRetry } from '../lib/llm-anthropic.js';
import { withExaRetry } from '../lib/exa-client.js';
import { newCostBucket } from '../lib/cost-tracker.js';
import { isBlockedDomain } from './outreach-extractor.service.js';
import { rerankCards } from './outreach-rerank.service.js';
import type { EnrichmentCard, EnrichmentRequest, EnrichmentResponse } from '@advance-academy/contracts/outreach';

const EXA_OPTIONS = {
  useAutoprompt: true,
  type: 'fast',
} as const;

function firstTextContent(response: { content: Array<{ type: string; text?: string }> }): string {
  const block = response.content[0];
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

function toCard(result: { title: string | null; url: string; text?: string }): EnrichmentCard {
  const exaText = result.text ?? '';
  return {
    title: result.title ?? result.url,
    url: result.url,
    snippet: exaText.slice(0, 150),
    isBlockedDomain: isBlockedDomain(result.url),
    exaText,
  };
}

/**
 * Extracts the relevant JD section from a potentially noisy scraped page.
 * Prevents the LLM from receiving KB of navigation / footer boilerplate.
 */
function cleanJdForQueries(jdText: string, maxChars = 2000): string {
  if (jdText.length <= maxChars) return jdText;

  const JD_HEADERS = [
    /##\s*(Mô tả công việc|Job Description|Job Responsibilities|About the role)/i,
    /##\s*(Yêu cầu ứng viên|Requirements|Qualifications)/i,
    /##\s*(Software|Developer|Engineer|Manager|Designer|Analyst|Director)/i,
    /\n(Job Title|Position|Role|RESPONSIBILITIES|REQUIREMENTS)\s*[:\n]/i,
  ];

  for (const pattern of JD_HEADERS) {
    const idx = jdText.search(pattern);
    if (idx !== -1) {
      const FOOTER = /\[Việc làm|## Tìm việc|## Báo cáo|©\s*20\d{2}/i;
      const excerpt = jdText.slice(idx);
      const footerIdx = excerpt.search(FOOTER);
      const end = footerIdx > 300 ? Math.min(footerIdx, maxChars) : maxChars;
      return excerpt.slice(0, end).trim();
    }
  }

  // Skip probable navigation/header (first 15%) and take the middle slice
  const skip = Math.min(Math.floor(jdText.length * 0.15), 2000);
  return jdText.slice(skip, skip + maxChars).trim();
}

function buildFallbackQueries(req: EnrichmentRequest): string[] {
  const year = new Date().getFullYear();
  const loc = req.userLocation?.trim() ? ` ${req.userLocation.trim()}` : '';
  const person = req.personName?.trim() ? ` ${req.personName.trim()}` : '';
  return [
    `${req.companyName}${person} company culture values ${year}${loc}`,
    `${req.companyName} ${req.targetRole} team news announcement ${year}`,
    `${req.companyName} leadership interview social post ${year}`,
  ];
}

async function generateInsightQueries(req: EnrichmentRequest): Promise<string[]> {
  try {
    assertLlmConfigured('outreach');
    const anthropic = createAnthropicClient('outreach');
    const model = getFeatureModel('outreach');
    const year = new Date().getFullYear();
    const loc = req.userLocation?.trim() ? `\nCandidate location: ${req.userLocation.trim()}` : '';

    const jdExcerpt = cleanJdForQueries(req.jdText ?? '', 2000);

    const response = await withRetry(() => anthropic.messages.create({
      model,
      max_tokens: 200,
      system: 'You generate precise web search queries. Return only valid JSON, no other text.',
      messages: [{
        role: 'user',
        content: `Generate 3 web search queries to find recent ${year} insights about this company, tailored to someone applying for this specific role.

Company: ${req.companyName}
Role: ${req.targetRole}${loc}

Job description excerpt:
${jdExcerpt}

Focus on: recent announcements, team or product news tied to this role's responsibilities, leadership statements, social posts, culture signals that would help a candidate stand out.

Return ONLY: {"queries": ["query1", "query2", "query3"]}`,
      }],
    }));

    const raw = firstTextContent(response);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return buildFallbackQueries(req);

    const parsed = JSON.parse(match[0]) as { queries?: unknown };
    if (!Array.isArray(parsed.queries) || parsed.queries.length === 0) return buildFallbackQueries(req);

    return (parsed.queries as unknown[])
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .slice(0, 3);
  } catch {
    return buildFallbackQueries(req);
  }
}

export async function runEnrichment(req: EnrichmentRequest): Promise<EnrichmentResponse> {
  if (!req.companyName?.trim() || !req.targetRole?.trim() || !req.experienceLevel) {
    const err = new Error('Enrichment requires companyName, targetRole, and experienceLevel.');
    Object.assign(err, { statusCode: 400 });
    throw err;
  }

  // Hard cap: prevent huge raw page dumps from blowing up LLM prompts / timeouts
  const safeReq: EnrichmentRequest = req.jdText && req.jdText.length > 5000
    ? { ...req, jdText: cleanJdForQueries(req.jdText, 3000) }
    : req;

  const exa = getExaClient();
  const cost = newCostBucket('outreach.enrich');

  // Use LLM-generated queries when JD is available, else fall back to heuristic queries
  const queries = safeReq.jdText?.trim()
    ? await generateInsightQueries(safeReq)
    : buildFallbackQueries(safeReq);

  let insightRaw: EnrichmentCard[] = [];

  try {
    const results = await Promise.all(
      queries.map((q) => withExaRetry(() => exa.searchAndContents(q, EXA_OPTIONS))),
    );
    cost.exa('exa.search.insights', queries.length);

    // Merge results and deduplicate by URL
    const seen = new Set<string>();
    for (const r of results) {
      for (const item of r.results) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          insightRaw.push(toCard(item));
        }
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Exa search failed';
    const wrapped = new Error(`Exa enrichment failed: ${message}`);
    Object.assign(wrapped, { statusCode: 502 });
    throw wrapped;
  }

  const insightResults = await rerankCards(insightRaw, 'insight', safeReq, cost);
  cost.flush();
  return { insightResults };
}
