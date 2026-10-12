import type { OutreachRequest } from '../../types/outreach.js';

export const OUTREACH_SYSTEM_PROMPT = `You are an expert career strategist and executive copywriter.
Your goal is to generate personalized, highly effective outreach messages for a job seeker.

You will receive the user's CV (and optional portfolio), Target Company, optional Target Person, Target Role, optional User Location, a JOB DESCRIPTION, and COMPANY INSIGHTS (recent posts, news, culture signals from Exa research). You will also receive an OUTREACH INTENT.

Generate the messages requested in the OUTPUT FORMAT block.

CRITICAL RULES:
- Open with a specific, concrete detail from COMPANY INSIGHTS whenever available. Never use generic openers like "I came across your profile" or "I noticed your work".
- Lead with the recipient (their company, their role, their recent activity). Do not lead with the sender.
- Do not mention that you used search results, scraping, or any research tool. The insights are woven in as if the sender naturally noticed them.
- Tailor the value proposition based on the user's CV AND the JOB DESCRIPTION requirements — match their skills to what the JD actually asks for.
- If USER LOCATION is provided, be mindful of regional context (local market norms, cultural tone, timezone).
- Do not use buzzwords (synergy, passionate, leverage, results-driven).
- LinkedIn message HARD LIMIT: 280 CHARACTERS total (including spaces and punctuation). This is LinkedIn's connection request limit. Do NOT exceed this. Before responding, count the characters of your linkedInMessage. If it is over 280, rewrite it shorter — drop adjectives, drop the sender's name from the closing, drop pleasantries. Aim for 240-270 characters. NO subject line.
- Email body HARD LIMIT: 150 words maximum.
- Format the output EXACTLY as valid JSON matching the OUTPUT FORMAT block. Do not include markdown formatting blocks.

INTENT GUIDELINES:
- direct_application: Hard pitch for a specific role. Match the sender's CV skills directly to the JOB DESCRIPTION requirements. End with a clear ask to be considered.
- referral_request: Soft ask to an employee. Lead with a shared interest or recent post from COMPANY INSIGHTS. Ask for advice or a referral, not a job.
- informational_interview: Networking focus. Reference COMPANY INSIGHTS. Ask for 15 minutes to learn about their experience at the company.
- agency_recruiter: Pitch to a headhunter. Focus on metrics, top skills, availability, and the specific Target Role. Reference the JOB DESCRIPTION as proof of relevance.
`;

/**
 * Splits the outreach user prompt into a STABLE prefix (the sender's CV +
 * portfolio — identical across every request for the same user) and the VARIABLE
 * remainder (target, JD, company insights, intent, output format). The split lets
 * the caller put a prompt-cache breakpoint at the end of the stable prefix so the
 * `system prompt + CV` span is cached and re-read on repeat requests (AAT-18).
 *
 * The two parts joined with `\n\n` are byte-identical to the previous single-string
 * prompt, so model behaviour is unchanged.
 */
export function buildOutreachUserMessageParts(
  request: OutreachRequest,
  jdContext: string,
  insightContext: string,
): { stable: string; variable: string } {
  const stableSections: string[] = [`SENDER CV:\n${request.cvText.trim()}`];

  if (request.portfolioText && request.portfolioText.trim()) {
    stableSections.push(`SENDER PORTFOLIO / ADDITIONAL CONTEXT:\n${request.portfolioText.trim()}`);
  }

  const sections: string[] = [];

  const targetLines: string[] = [`- Company: ${request.targetCompany}`];
  if (request.targetCountry && request.targetCountry.trim()) {
    targetLines.push(`- Target Country: ${request.targetCountry.trim()}`);
  }
  if (request.userLocation && request.userLocation.trim()) {
    targetLines.push(`- User Location: ${request.userLocation.trim()}`);
  }
  if (request.targetPersonName && request.targetPersonName.trim()) {
    targetLines.push(`- Person: ${request.targetPersonName.trim()}`);
  }
  targetLines.push(`- Role: ${request.targetRole}`);
  targetLines.push(`- Experience Level: ${request.experienceLevel}`);
  sections.push(`TARGET:\n${targetLines.join('\n')}`);

  if (request.manualContexts && request.manualContexts.length > 0) {
    const formatted = request.manualContexts
      .map((ctx) => {
        const title = ctx.title.trim() || 'Untitled context';
        const url = ctx.url.trim();
        const body = ctx.content.trim();
        const header = url ? `--- ${title} (${url}) ---` : `--- ${title} ---`;
        return `${header}\n${body}`;
      })
      .join('\n\n');
    sections.push(
      `ADDITIONAL CONTEXT FROM SENDER (use these details alongside the signals below):\n${formatted}`,
    );
  }

  if (jdContext.trim()) {
    sections.push(`JOB DESCRIPTION (match sender's skills to these requirements):\n${jdContext.trim()}`);
  }

  if (insightContext.trim()) {
    sections.push(`COMPANY INSIGHTS (use these to open with a specific, concrete detail):\n${insightContext.trim()}`);
  }

  sections.push(`OUTREACH INTENT: ${request.intent}`);

  const wantEmail = request.outputs.email;
  const wantLinkedIn = request.outputs.linkedIn;

  const linkedInRule =
    'string — HARD LIMIT 280 characters (count chars, not words). LinkedIn rejects connection requests over 300 chars. NO subject line. Aim 240-270 chars.';
  const emailBodyRule = 'string (≤ 150 words)';

  let formatBlock: string;
  if (wantEmail && wantLinkedIn) {
    formatBlock = `OUTPUT FORMAT — respond ONLY with this exact JSON object, no other text:
{
  "linkedInMessage": "${linkedInRule}",
  "email": {
    "subject": "string",
    "body": "${emailBodyRule}"
  }
}
Before you finalize your response, count the characters of linkedInMessage. If it is over 280 characters, REWRITE it shorter until it fits.`;
  } else if (wantEmail) {
    formatBlock = `OUTPUT FORMAT — respond ONLY with this exact JSON object, no other text:
{
  "email": {
    "subject": "string",
    "body": "${emailBodyRule}"
  }
}`;
  } else {
    formatBlock = `OUTPUT FORMAT — respond ONLY with this exact JSON object, no other text:
{
  "linkedInMessage": "${linkedInRule}"
}
Before you finalize your response, count the characters of linkedInMessage. If it is over 280 characters, REWRITE it shorter until it fits.`;
  }

  sections.push(formatBlock);

  return { stable: stableSections.join('\n\n'), variable: sections.join('\n\n') };
}
