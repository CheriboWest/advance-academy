import { assertLlmConfigured, createAnthropicClient, getFeatureModel, withRetry } from '../lib/llm-anthropic.js';
import { OUTREACH_SYSTEM_PROMPT, buildOutreachUserMessageParts } from '../lib/outreach/prompts.js';
import { truncateLinkedInMessage } from '../lib/outreach/truncate.js';
import { newCostBucket } from '../lib/cost-tracker.js';
import { extractContent } from './outreach-extractor.service.js';
import type { OutreachRequest, OutreachResult } from '@advance-academy/contracts/outreach';

// Anthropic prompt caching breakpoint (5-minute ephemeral). Applied to the static
// system prompt and the sender's CV so repeat requests re-read them instead of
// re-billing full input tokens (AAT-18).
const CACHE_CONTROL = { type: 'ephemeral' as const };

function firstTextContent(response: { content: Array<{ type: string; text?: string }> }): string {
  const block = response.content[0];
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

export async function generateOutreach(request: OutreachRequest): Promise<OutreachResult> {
  assertLlmConfigured('outreach');
  // Under the 90s proxy budget, which also has to cover the Jina fetches below.
  const anthropic = createAnthropicClient('outreach', { timeoutMs: 60_000 });
  const model = getFeatureModel('outreach');
  const cost = newCostBucket('outreach.generate');

  // JD text is passed directly — no URL extraction needed
  const jdContext = request.jdText?.trim() ?? '';

  // Extract content for all selected insight cards in parallel.
  // Blocked domains (LinkedIn, etc.) reuse Exa-returned text; everything else goes through Jina.
  const insightTexts = await Promise.all(
    (request.insightSignals ?? []).map((signal) =>
      extractContent(signal.url, signal.exaText),
    ),
  );
  const insightContext = insightTexts.filter((t) => t.trim()).join('\n\n---\n\n');

  // Split the user prompt so the stable CV prefix can carry its own cache breakpoint.
  // The breakpoint sits at the end of `system + CV` rather than on the ~660-token
  // system prompt alone: that is byte-stable across a user's repeat requests, and it
  // is the only arrangement that clears the cacheable minimum on either model. That
  // minimum is 1024 tokens on Sonnet-4 but 4096 on Haiku 4.5, which is the default
  // now — the system prompt would miss the cache entirely on its own.
  const { stable, variable } = buildOutreachUserMessageParts(request, jdContext, insightContext);

  const response = await withRetry(() => anthropic.messages.create({
    model,
    max_tokens: 1500,
    system: [
      { type: 'text', text: OUTREACH_SYSTEM_PROMPT, cache_control: CACHE_CONTROL },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: stable, cache_control: CACHE_CONTROL },
          { type: 'text', text: `\n\n${variable}` },
        ],
      },
    ],
  }));
  cost.llm('generate', model, response.usage);
  cost.flush();

  const rawText = firstTextContent(response);

  // Extract JSON block in case there is trailing markdown or text
  let jsonString = rawText.trim();
  const match = jsonString.match(/\{[\s\S]*\}/);
  if (match) {
    jsonString = match[0];
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error(`Failed to parse outreach response as JSON. Raw: ${rawText.slice(0, 200)}`);
  }

  const result: OutreachResult = {
    intent: request.intent,
  };

  if (request.outputs.linkedIn && typeof parsed.linkedInMessage === 'string') {
    result.linkedInMessage = truncateLinkedInMessage(parsed.linkedInMessage);
  }

  if (request.outputs.email && parsed.email && typeof parsed.email === 'object') {
    result.email = {
      subject: typeof parsed.email.subject === 'string' ? parsed.email.subject : '',
      body: typeof parsed.email.body === 'string' ? parsed.email.body : '',
    };
  }

  return result;
}
