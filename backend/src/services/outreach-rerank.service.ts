import { assertLlmConfigured, createAnthropicClient, getFeatureModel, withRetry } from '../lib/llm-anthropic.js';
import { newCostBucket, type CostBucket } from '../lib/cost-tracker.js';
import type { EnrichmentCard, EnrichmentRequest } from '@advance-academy/contracts/outreach';

export type RerankCategory = 'hiring' | 'social' | 'insight';

const CATEGORY_LABEL: Record<RerankCategory, string> = {
  hiring: 'current hiring / job listing',
  social: 'recent activity / news / interview',
  insight: 'company insight / news / social post',
};

const RERANK_SYSTEM_PROMPT = `You rank web search results for a B2B outreach message drafter.
You score each candidate result 0-100 based on how useful it is as an opening hook
for a cold outreach email / LinkedIn message. Prefer results that are:
- Specific to the target role and country (not generic company news)
- Fresh and actionable
- Concrete (an actual job posting, a quoted interview, a recent post) over PR fluff

Always return strict JSON. Never include markdown, prose, or any text outside the JSON.`;

interface RankingEntry {
  index: number;
  score: number;
  reason: string;
}

function firstTextContent(response: { content: Array<{ type: string; text?: string }> }): string {
  const block = response.content[0];
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

function formatManualContexts(ctx: EnrichmentRequest): string | null {
  if (!ctx.manualContexts || ctx.manualContexts.length === 0) return null;
  // Cap each context to 400 chars to keep the rerank prompt small.
  return ctx.manualContexts
    .map((c) => {
      const title = c.title.trim() || 'Untitled context';
      const body = c.content.trim().slice(0, 400);
      return `- ${title}: ${body}`;
    })
    .join('\n');
}

function buildUserPrompt(
  cards: EnrichmentCard[],
  category: RerankCategory,
  ctx: EnrichmentRequest,
): string {
  const header: string[] = [
    `CATEGORY: ${CATEGORY_LABEL[category]}`,
    `TARGET COMPANY: ${ctx.companyName}`,
    `TARGET ROLE: ${ctx.targetRole}`,
    `EXPERIENCE LEVEL: ${ctx.experienceLevel}`,
  ];
  if (ctx.targetCountry?.trim()) header.push(`TARGET COUNTRY: ${ctx.targetCountry.trim()}`);
  if (ctx.personName?.trim()) header.push(`TARGET PERSON: ${ctx.personName.trim()}`);
  if (ctx.intent) header.push(`OUTREACH INTENT: ${ctx.intent}`);
  const manual = formatManualContexts(ctx);
  if (manual) {
    header.push(`ADDITIONAL CONTEXT FROM SENDER:\n${manual}`);
  }

  const candidates = cards
    .map((card, i) => {
      const snippet = (card.exaText || card.snippet || '').slice(0, 350);
      return `[${i}] ${card.title}\nURL: ${card.url}\nSNIPPET: ${snippet}`;
    })
    .join('\n\n');

  return `${header.join('\n')}

CANDIDATES:
${candidates}

Score each candidate 0-100 and give a short (≤ 15 words) reason.
Respond ONLY with this exact JSON shape (no markdown, no prose):
{
  "rankings": [
    { "index": 0, "score": 0, "reason": "string" }
  ]
}
Include ALL candidate indices. Do not add extra fields.`;
}

function parseRankings(raw: string, expectedCount: number): RankingEntry[] | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { rankings?: unknown };
    if (!Array.isArray(parsed.rankings)) return null;
    const out: RankingEntry[] = [];
    for (const item of parsed.rankings) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      if (typeof o.index !== 'number' || typeof o.score !== 'number') continue;
      if (o.index < 0 || o.index >= expectedCount) continue;
      out.push({
        index: o.index,
        score: Math.max(0, Math.min(100, Math.round(o.score))),
        reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '',
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Re-ranks Exa enrichment cards using Claude based on how useful they'd be
 * as opening hooks for the outreach message. Falls back to the original order
 * on any failure (parse error, LLM error, empty cards, LLM not configured).
 */
export async function rerankCards(
  cards: EnrichmentCard[],
  category: RerankCategory,
  ctx: EnrichmentRequest,
  costBucket?: CostBucket,
): Promise<EnrichmentCard[]> {
  if (cards.length <= 1) return cards;

  try {
    assertLlmConfigured('outreach');
  } catch {
    return cards;
  }

  // Use the parent bucket if provided, otherwise log this call standalone.
  const cost = costBucket ?? newCostBucket(`outreach.rerank.${category}`);
  const isOwnedBucket = !costBucket;

  try {
    const anthropic = createAnthropicClient('outreach');
    const model = getFeatureModel('outreach');

    const response = await withRetry(() => anthropic.messages.create({
      model,
      max_tokens: 600,
      system: RERANK_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildUserPrompt(cards, category, ctx),
        },
      ],
    }));
    cost.llm(`rerank.${category}`, model, response.usage);
    if (isOwnedBucket) cost.flush();

    const rawText = firstTextContent(response);
    const rankings = parseRankings(rawText, cards.length);
    if (!rankings) return cards;

    // Annotate each card with its score + reason
    const annotated = cards.map((card) => ({ ...card }));
    for (const r of rankings) {
      annotated[r.index] = {
        ...annotated[r.index],
        score: r.score,
        reason: r.reason || undefined,
      };
    }

    // Sort by score descending; cards without a score go last but keep original order
    const scored = annotated.filter((c) => typeof c.score === 'number');
    const unscored = annotated.filter((c) => typeof c.score !== 'number');
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return [...scored, ...unscored];
  } catch {
    return cards;
  }
}
