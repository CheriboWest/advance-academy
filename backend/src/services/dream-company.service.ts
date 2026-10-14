/**
 * Dream Company — service called from routes only.
 * Uses lib/dream-company/prompts (all prompt builders) and lib/llm-anthropic (Anthropic SDK).
 */
import mammoth from 'mammoth';
import type {
  DreamCompanyInput,
  ProfileAnalysis,
  TargetRole,
  CareerRoadmap,
  ExaJobListing,
  RoadmapResponse,
} from '@advance-academy/contracts/dream-company';
import {
  buildCareerRoadmapPrompt,
  buildDreamCompanyCvParseInstructions,
  buildDreamCompanyCvParsePrompt,
  buildProfileAnalysisPrompt,
  buildTargetRolesPrompt,
} from '../lib/dream-company/prompts.js';
import { assertLlmConfigured, createAnthropicClient, getFeatureModel, withRetry, streamFinalWithRetry } from '../lib/llm-anthropic.js';
import { newCostBucket, type CostBucket } from '../lib/cost-tracker.js';
import { searchLiveJobs, searchMarketTitles } from './job-search.service.js';
import { getJobMaxRoleQueries } from '../config/job-source.js';

/**
 * Derive a few geocodable job-search keywords from the profile to anchor the roles step
 * to live demand (Item 3). Skills are the best signal (Adzuna/Reed `what` matches jobs
 * mentioning them); fall back to degree words. Deterministic, no LLM. The roles step has
 * no titles yet, so we search on skills and feed back the titles actually being hired.
 */
function deriveMarketKeywords(profile: DreamCompanyInput): string[] {
  const fromSkills = (profile.skills ?? '')
    .split(/[,;/|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  if (fromSkills.length > 0) return fromSkills.slice(0, 5);
  return (profile.degree ?? '').split(/\s+/).filter((w) => w.length > 3).slice(0, 5);
}

/**
 * Per-step SDK timeouts (ms), env-overridable. Sized under the proxy budgets in
 * shared/api/backend-client.ts (analyze 60s, roles 60s, roadmap 180s, parse-cv 120s) so the
 * backend aborts in step with the client instead of hanging on the SDK's 10-minute default.
 * A single global timeout would kill the slow roles/roadmap steps on the happy path.
 * analyze is 45s (not 30s): measured ~26–29s on prod, so 30s left almost no headroom.
 */
function stepTimeoutMs(envVar: string, fallbackMs: number): number {
  const parsed = Number(process.env[envVar]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

const DREAM_TIMEOUTS = {
  analyze: () => stepTimeoutMs('LLM_TIMEOUT_DREAM_ANALYZE_MS', 45_000),
  roles: () => stepTimeoutMs('LLM_TIMEOUT_DREAM_ROLES_MS', 60_000),
  roadmap: () => stepTimeoutMs('LLM_TIMEOUT_DREAM_ROADMAP_MS', 120_000),
  parseCv: () => stepTimeoutMs('LLM_TIMEOUT_DREAM_PARSECV_MS', 90_000),
};

// maxRetries: 0 because withRetry() already handles 429 backoff — layering the SDK's own
// retries on top would multiply the effective timeout wall-time and defeat the bounded abort.
function dreamClient(timeoutMs: number) {
  return createAnthropicClient('dreamCompany', { timeoutMs, maxRetries: 0 });
}

function cleanJsonResponse(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?\s*```$/, '')
    .trim();
}

function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
  const block = response.content[0];
  if (block?.type === 'text' && typeof block.text === 'string') {
    return cleanJsonResponse(block.text);
  }
  return '';
}

/**
 * Parse an LLM JSON response for one Dream Company step.
 * Distinguishes a truncated response (hit max_tokens → retryable 502) from genuinely
 * malformed JSON (→ 500 with step), so the user never gets a raw parse error or a
 * confusing 500 when the model simply ran out of output budget.
 */
function parseStepResponse<T>(
  response: { stop_reason?: string | null; content: Array<{ type: string; text?: string }> },
  step: string,
): T {
  if (response.stop_reason === 'max_tokens') {
    console.error(`[dream-company] ${step} hit max_tokens — response truncated.`);
    throw Object.assign(
      new Error('The AI response was too long and got cut off. Please try again.'),
      { statusCode: 502, step },
    );
  }
  try {
    return JSON.parse(extractText(response)) as T;
  } catch {
    throw Object.assign(new Error('Failed to parse LLM response'), { step });
  }
}

export function validateDreamCompanyProfile(profile: DreamCompanyInput | undefined): string[] {
  const missing: string[] = [];
  if (!profile?.degree) missing.push('degree');
  if (!profile?.workExperience) missing.push('workExperience');
  if (!profile?.skills) missing.push('skills');
  if (!profile?.location) missing.push('location');
  return missing;
}

export async function generateProfileAnalysis(
  profile: DreamCompanyInput,
): Promise<ProfileAnalysis> {
  assertLlmConfigured('dreamCompany');
  const anthropic = dreamClient(DREAM_TIMEOUTS.analyze());
  const model = getFeatureModel('dreamCompany');
  const cost = newCostBucket('dreamCompany.analyze');

  const response = await withRetry(() => anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: 'You are a career intelligence engine. Return only valid JSON.',
    messages: [{ role: 'user', content: buildProfileAnalysisPrompt(profile) }],
  }));
  cost.llm('analyze', model, response.usage);
  cost.flush();

  return parseStepResponse<ProfileAnalysis>(response, 'profileAnalysis');
}

export async function generateTargetRoles(
  profile: DreamCompanyInput,
  analysis: ProfileAnalysis,
): Promise<TargetRole[]> {
  assertLlmConfigured('dreamCompany');
  const anthropic = dreamClient(DREAM_TIMEOUTS.roles());
  const model = getFeatureModel('dreamCompany');
  const cost = newCostBucket('dreamCompany.roles');

  // Anchor suggestions to live demand (Item 3): search the market on the candidate's skills
  // and feed back the titles actually being hired. Never throws — [] on any failure.
  const liveTitles = await searchMarketTitles(deriveMarketKeywords(profile), profile.location, cost);

  const response = await withRetry(() => anthropic.messages.create({
    model,
    // 10 roles ≈ ~1200 output tokens (measured: 20 roles ≈ 2384). 4096 leaves a wide safety
    // margin; M1.2's stop_reason=max_tokens guard turns any truncation into a clean 502.
    max_tokens: 4096,
    system: 'You are a career intelligence engine. Return only valid JSON.',
    messages: [{ role: 'user', content: buildTargetRolesPrompt(profile, analysis, liveTitles) }],
  }));
  cost.llm('roles', model, response.usage);
  cost.flush();

  return parseStepResponse<TargetRole[]>(response, 'targetRoles');
}

export async function generateRoadmapWithJobs(
  profile: DreamCompanyInput,
  analysis: ProfileAnalysis,
  selectedRoles: TargetRole[],
): Promise<RoadmapResponse> {
  assertLlmConfigured('dreamCompany');
  const anthropic = dreamClient(DREAM_TIMEOUTS.roadmap());
  const model = getFeatureModel('dreamCompany');
  const cost = newCostBucket('dreamCompany.roadmap');

  // Server-side clamp (C2): the maxRoles cap is only enforced client-side, so clamp here
  // too — otherwise a bypassing client gets a roadmap over N>6 roles but a job search over
  // only the top 6. Flag computed from the ORIGINAL length before clamping.
  const jobsTruncated = selectedRoles.length > getJobMaxRoleQueries();
  const roles = jobsTruncated ? selectedRoles.slice(0, getJobMaxRoleQueries()) : selectedRoles;

  // Fetch the Exa job listings FIRST so the roadmap prompt can reference real, current
  // openings. Running the search and the LLM call in parallel meant the prompt was always
  // built with an empty job list (AAT-9). Still exactly one Exa search — no extra calls.
  const { jobs, error: jobsError, notice: jobsNotice } = await searchJobsForRoles(roles, profile, cost);

  const roadmapResponse = await withRetry(() => anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: 'You are a career intelligence engine. Return only valid JSON.',
    messages: [{ role: 'user', content: buildCareerRoadmapPrompt(profile, analysis, roles, jobs) }],
  }));
  cost.llm('roadmap', model, roadmapResponse.usage);
  cost.flush();

  const roadmap = parseStepResponse<CareerRoadmap>(roadmapResponse, 'careerRoadmap');
  return { jobs, roadmap, jobsError, jobsNotice: jobsNotice ?? null, jobsTruncated };
}

// ---- Streaming variants (M2.1) --------------------------------------------------------
// Mirror the three generate functions but use messages.stream: `onDelta` receives text
// chunks as the model produces them (for the SSE routes), and the final parsed object is
// returned exactly as the non-streaming path — same prompts, models, per-step timeouts, and
// the M1.2 truncation guard (parseStepResponse). No quality change: identical request bodies.

export async function streamProfileAnalysis(
  profile: DreamCompanyInput,
  onDelta?: (text: string) => void,
): Promise<ProfileAnalysis> {
  assertLlmConfigured('dreamCompany');
  const anthropic = dreamClient(DREAM_TIMEOUTS.analyze());
  const model = getFeatureModel('dreamCompany');
  const cost = newCostBucket('dreamCompany.analyze.stream');

  const final = await streamFinalWithRetry(
    () => anthropic.messages.stream({
      model,
      max_tokens: 4096,
      system: 'You are a career intelligence engine. Return only valid JSON.',
      messages: [{ role: 'user', content: buildProfileAnalysisPrompt(profile) }],
    }),
    onDelta,
  );
  cost.llm('analyze', model, final.usage);
  cost.flush();

  return parseStepResponse<ProfileAnalysis>(final, 'profileAnalysis');
}

export async function streamTargetRoles(
  profile: DreamCompanyInput,
  analysis: ProfileAnalysis,
  onDelta?: (text: string) => void,
): Promise<TargetRole[]> {
  assertLlmConfigured('dreamCompany');
  const anthropic = dreamClient(DREAM_TIMEOUTS.roles());
  const model = getFeatureModel('dreamCompany');
  const cost = newCostBucket('dreamCompany.roles.stream');

  // Anchor suggestions to live demand (Item 3) — same as the non-streaming path.
  const liveTitles = await searchMarketTitles(deriveMarketKeywords(profile), profile.location, cost);

  const final = await streamFinalWithRetry(
    () => anthropic.messages.stream({
      model,
      max_tokens: 4096,
      system: 'You are a career intelligence engine. Return only valid JSON.',
      messages: [{ role: 'user', content: buildTargetRolesPrompt(profile, analysis, liveTitles) }],
    }),
    onDelta,
  );
  cost.llm('roles', model, final.usage);
  cost.flush();

  return parseStepResponse<TargetRole[]>(final, 'targetRoles');
}

export async function streamRoadmapWithJobs(
  profile: DreamCompanyInput,
  analysis: ProfileAnalysis,
  selectedRoles: TargetRole[],
  onDelta?: (text: string) => void,
): Promise<RoadmapResponse> {
  assertLlmConfigured('dreamCompany');
  const anthropic = dreamClient(DREAM_TIMEOUTS.roadmap());
  const model = getFeatureModel('dreamCompany');
  const cost = newCostBucket('dreamCompany.roadmap.stream');

  // Server-side clamp (C2) — same as the non-streaming path.
  const jobsTruncated = selectedRoles.length > getJobMaxRoleQueries();
  const roles = jobsTruncated ? selectedRoles.slice(0, getJobMaxRoleQueries()) : selectedRoles;

  // Job search runs first (same as the non-streaming path) so the prompt has real jobs.
  const { jobs, error: jobsError, notice: jobsNotice } = await searchJobsForRoles(roles, profile, cost);

  const final = await streamFinalWithRetry(
    () => anthropic.messages.stream({
      model,
      max_tokens: 4096,
      system: 'You are a career intelligence engine. Return only valid JSON.',
      messages: [{ role: 'user', content: buildCareerRoadmapPrompt(profile, analysis, roles, jobs) }],
    }),
    onDelta,
  );
  cost.llm('roadmap', model, final.usage);
  cost.flush();

  const roadmap = parseStepResponse<CareerRoadmap>(final, 'careerRoadmap');
  return { jobs, roadmap, jobsError, jobsNotice: jobsNotice ?? null, jobsTruncated };
}

/**
 * Fetch live job listings for the selected roles. Delegates to the job-search
 * orchestrator (routing over Adzuna/Reed). Returns `{ jobs, error, notice }`: `error` is
 * a genuine outage, `notice` is a benign message (e.g. region outside live coverage).
 * Both streaming and non-streaming roadmap paths call it identically.
 */
async function searchJobsForRoles(
  selectedRoles: TargetRole[],
  profile: DreamCompanyInput,
  costBucket?: CostBucket,
): Promise<{ jobs: ExaJobListing[]; error: string | null; notice?: string | null }> {
  return searchLiveJobs(
    { roleTitles: selectedRoles.map((r) => r.title), location: profile.location },
    costBucket,
  );
}

export async function parseDreamCompanyCv(buffer: Buffer, fileNameLower: string): Promise<Record<string, unknown>> {
  const isPdf = fileNameLower.endsWith('.pdf');
  const isDocx = fileNameLower.endsWith('.docx');

  if (!isPdf && !isDocx) {
    throw Object.assign(new Error('Only PDF and DOCX files are supported'), { statusCode: 400 });
  }

  assertLlmConfigured('dreamCompany');
  const anthropic = dreamClient(DREAM_TIMEOUTS.parseCv());
  const model = getFeatureModel('dreamCompany');
  const cost = newCostBucket('dreamCompany.parseCv');

  let response;

  if (isPdf) {
    response = await withRetry(() => anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: 'You are a CV parser. Extract career information and return only valid JSON.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: buffer.toString('base64'),
              },
            },
            {
              type: 'text',
              text: buildDreamCompanyCvParseInstructions(),
            },
          ],
        },
      ],
    }));
  } else {
    const result = await mammoth.extractRawText({ buffer });
    const extractedText = result.value;

    if (!extractedText.trim()) {
      throw Object.assign(new Error('Could not extract text from the uploaded file'), { statusCode: 422 });
    }

    response = await withRetry(() => anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: 'You are a CV parser. Extract career information and return only valid JSON.',
      messages: [
        {
          role: 'user',
          content: buildDreamCompanyCvParsePrompt(extractedText),
        },
      ],
    }));
  }
  cost.llm(isPdf ? 'parseCv.pdf' : 'parseCv.docx', model, response.usage);
  cost.flush();

  // Truncated output (CV too long for max_tokens) — surface a friendly 422 instead of
  // crashing on partial JSON. max_tokens here is only 2048, so long CVs can hit this.
  if (response.stop_reason === 'max_tokens') {
    console.error('[dream-company] parseCv hit max_tokens — CV likely too long, response truncated.');
    throw Object.assign(
      new Error('This CV is too long to read reliably. Please shorten it and try again.'),
      { statusCode: 422 },
    );
  }

  const block = response.content[0];
  if (block?.type !== 'text') {
    console.error('[dream-company] parseCv: no text block in LLM response.');
    throw Object.assign(
      new Error('Could not read this CV. Please try a different file.'),
      { statusCode: 422 },
    );
  }

  try {
    return JSON.parse(cleanJsonResponse(block.text)) as Record<string, unknown>;
  } catch {
    console.error('[dream-company] parseCv: LLM returned invalid JSON.');
    throw Object.assign(
      new Error('Could not read this CV. Please try a different file or format.'),
      { statusCode: 422 },
    );
  }
}
