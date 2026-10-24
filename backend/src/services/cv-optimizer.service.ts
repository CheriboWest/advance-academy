/**
 * CV Optimizer — async job queue + structured CV analysis.
 * Uses Anthropic SDK directly (for high max_tokens) when LLM is enabled; otherwise local heuristics.
 */
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import type {
  ActionPlan,
  ActionPlanItem,
  AnalyzeCvAcceptedResponse,
  AnalyzeCvRequest,
  AnalyzeCvResult,
  AtsCheck,
  AtsExtractedKeyword,
  AtsRelevanceSignal,
  BulletEvaluation,
  FormatCheck,
  JdAlignment,
  KeywordHighlight,
  RewriteBulletRequest,
  RewriteBulletResponse,
  RewriteSuggestion,
  ScoreBreakdown,
} from '@advance-academy/contracts/cv-optimizer';
import type { ApiErrorResponse, JobStatus, JobStatusResponse } from '@advance-academy/contracts/jobs';
import { getLlmConfig } from '../config/llm.js';
import { getCvOptimizerFeatures } from '../config/features.js';
import { assertLlmConfigured, createAnthropicClient, getFeatureModel } from '../lib/llm-anthropic.js';
import { CV_LLM_CLIENT_OPTIONS } from './cv-agents/models.js';
import { getSupabase, isMissingColumnError } from '../lib/supabase.js';
import { ensureCvVersion } from '../lib/cv-version-link.js';
import { recordToolResult } from './tool-results.service.js';
import { changeJobStatus, updateSavedJob } from './job-tracking.service.js';
import { getReferenceExamples, formatReferencePatterns } from './reference-cv.service.js';

interface CvAnalysisJobRow {
  id: string;
  status: JobStatus;
  submitted_at: string;
  updated_at: string;
  result_json: AnalyzeCvResult | null;
  error_json: ApiErrorResponse | null;
}

function rowToJobResponse(row: CvAnalysisJobRow): JobStatusResponse<AnalyzeCvResult> {
  return {
    jobId: row.id,
    status: row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    result: row.result_json ?? undefined,
    error: row.error_json ?? undefined,
  };
}

// ─── Date injection helper ───────────────────────────────────────────────────

/**
 * Every prompt that evaluates CV content must be told today's date so Claude
 * doesn't flag legitimate past dates as "future" or "unrealistic". Injected
 * dynamically at call time — never baked into the prompt constants.
 */
function todayInstruction(): string {
  const today = new Date().toISOString().split('T')[0];
  return `Today's date is ${today}. Evaluate all dates in the CV relative to this date. Do not flag any date before today as future or unrealistic.`;
}

// ─── Template ─────────────────────────────────────────────────────────────────

export function getAnalyzeTemplate() {
  const llmConfig = getLlmConfig('cvOptimizer');

  return {
    endpoint: '/api/cv-optimizer/analyze',
    method: 'POST',
    statusEndpoint: '/api/cv-optimizer/jobs/:jobId',
    description: 'CV analysis endpoint. Returns a job id immediately, then the client polls the job endpoint until the analysis is completed.',
    llm: {
      enabled: llmConfig.enabled,
      provider: llmConfig.provider,
      model: llmConfig.model,
      baseUrl: llmConfig.baseUrl,
    },
    expectedBody: {
      targetRole: 'Frontend Developer',
      currentCvText: 'Paste CV text here...',
      jobDescription: 'Optional target job description...',
    },
  };
}

// ─── Job helpers ───────────────────────────────────────────────────────────────

interface JobUpdatePatch {
  status?: JobStatus;
  result?: AnalyzeCvResult;
  error?: ApiErrorResponse;
  clearResult?: boolean;
  clearError?: boolean;
}

async function updateJob(jobId: string, patch: JobUpdatePatch) {
  const supabase = getSupabase();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.result !== undefined) update.result_json = patch.result;
  if (patch.clearResult) update.result_json = null;
  if (patch.error !== undefined) update.error_json = patch.error;
  if (patch.clearError) update.error_json = null;

  const { error } = await supabase.from('cv_analysis_jobs').update(update).eq('id', jobId);
  if (error) {
    console.error(`[cv-optimizer] failed to update job ${jobId}:`, error.message);
  }
}

function buildJobError(message: string, details?: unknown): ApiErrorResponse {
  return { code: 'CV_ANALYSIS_FAILED', message, details };
}

// ─── Fallback (no LLM) ────────────────────────────────────────────────────────

export function buildFallbackAnalysis(body: AnalyzeCvRequest): AnalyzeCvResult {
  const cvText = body.currentCvText.trim();
  const targetRole = body.targetRole.trim();
  const hasMetrics = /\b\d+%|\b\d+\+|\$\d+|\b\d+\s?(users|projects|clients|sales|team members)\b/i.test(cvText);
  const hasActionVerbs = /\b(built|led|improved|designed|launched|implemented|optimized|created|delivered)\b/i.test(cvText);
  const hasJobDescription = Boolean(body.jobDescription?.trim());

  const sections = [
    {
      title: 'Technical Skills',
      score: cvText.toLowerCase().includes(targetRole.toLowerCase()) ? 86 : 74,
      feedback: cvText.length > 250
        ? 'Your CV has enough detail to evaluate skills. Add more role-specific keywords if you want stronger matching.'
        : 'Add a clearer technical skills section with tools, frameworks, and certifications relevant to the role.',
    },
    {
      title: 'Experience',
      score: hasMetrics ? 84 : 70,
      feedback: hasMetrics
        ? 'Good use of measurable impact. Keep quantifying achievements in each role.'
        : 'Your experience will read stronger if each bullet includes metrics, outcomes, or business impact.',
    },
    {
      title: 'Role Alignment',
      score: hasJobDescription ? 82 : 68,
      feedback: hasJobDescription
        ? 'The target job description gives you a solid base for tailoring your CV.'
        : 'Include a target job description so the analysis can compare your CV against a specific role.',
    },
    {
      title: 'Writing Impact',
      score: hasActionVerbs ? 80 : 66,
      feedback: hasActionVerbs
        ? 'Your wording shows action and ownership. Keep using strong verbs at the start of bullet points.'
        : 'Start bullets with stronger action verbs like built, led, improved, or implemented.',
    },
  ];

  const atsCheck: AtsCheck = {
    score: 0,
    issues: ['LLM not configured — ATS check unavailable.'],
    passed: [],
    extractedKeywords: [],
    relevanceSignals: [],
  };
  const bulletEvaluations: BulletEvaluation[] = [];
  const { overallScore, breakdown } = computeCompositeScore(sections, atsCheck, bulletEvaluations);

  return {
    overallScore,
    scoreBreakdown: breakdown,
    sections,
    keywordHighlights: [],
    atsCheck,
    formatCheck: { issues: [], suggestions: ['Enable LLM to get format and typo analysis.'] },
    bulletEvaluations,
    rewriteSuggestions: [],
    jdAlignment: {
      matchedRequirements: [],
      missingRequirements: [],
      alignmentSummary: hasJobDescription
        ? 'Enable LLM for a detailed JD alignment analysis.'
        : 'No job description provided.',
    },
    actionPlan: {
      summary: `Action plan unavailable — enable the LLM to generate recommendations for the ${targetRole} role. Until then, focus on adding measurable outcomes to every bullet and listing a clear target job description.`,
      projectsToBuild: [],
      skillsToLearn: [],
      certifications: [],
      intermediateRoles: [],
    },
  };
}

// ─── ATS Dimension 1 — Keyword extraction from JD ───────────────────────────

const ATS_KEYWORD_EXTRACTION_PROMPT = `You are an ATS keyword extraction engine. Given a job description, extract every relevant keyword and classify it.

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "keywords": [
    {
      "keyword": string,
      "category": "job_title" | "tool_or_technical_skill" | "hard_skill" | "industry_term" | "certification" | "seniority_indicator" | "mandatory_requirement",
      "mandatory": boolean
    }
  ]
}

Categories:
- job_title: exact and closely related job titles mentioned
- tool_or_technical_skill: named software, frameworks, programming languages, platforms, libraries (e.g. "React", "Postgres", "Figma", "Salesforce", "Kubernetes")
- hard_skill: specific, verifiable technical methodologies (e.g. "financial modelling", "A/B testing", "statistical regression", "SEO", "penetration testing"). Must be concrete enough that you could test whether a candidate actually has it.
- industry_term: domain-specific vocabulary (e.g. "KYC", "CI/CD", "GDPR", "FDA submission", "underwriting")
- certification: named certifications or qualifications (e.g. "CFA", "AWS Solutions Architect", "PMP", "CPA")
- seniority_indicator: words indicating level (e.g. "senior", "lead", "junior", "principal")
- mandatory_requirement: non-negotiable requirements like driving licence, visa status, DBS check, right to work, specific degree requirements

CRITICAL — DO NOT extract generic soft skills or vague competencies. The following are EXAMPLES OF KEYWORDS TO EXCLUDE:
- "communication skills", "verbal communication", "written communication"
- "teamwork", "team player", "collaboration"
- "leadership", "leadership skills"
- "problem solving", "problem-solving skills", "critical thinking"
- "attention to detail", "organised", "self-motivated", "proactive"
- "fast-paced environment", "time management", "multitasking"
- "passion for", "interest in", "enthusiastic"
- any generic adjective or trait an ATS cannot reliably screen on

Only extract skills that are concrete, named, and testable. If a JD says "strong communication skills and experience with Salesforce CRM", extract "Salesforce CRM" — NOT "communication skills".

Rules:
- mandatory must be true ONLY for items that are clearly non-negotiable (driving licence, visa, DBS, right to work, specific degree). All other keywords are mandatory: false.
- Extract every meaningful SPECIFIC keyword. Do not invent keywords not in the JD. Quality over quantity — five precise keywords beat fifty vague ones.
- If no JD is provided, return {"keywords": []}.`;

async function extractAtsKeywords(
  jobDescription: string | undefined,
  targetRole: string,
  modelOverride?: string,
): Promise<AtsExtractedKeyword[]> {
  const jdText = jobDescription?.trim();
  if (!jdText) return [];

  assertLlmConfigured('cvOptimizer');
  const anthropic = createAnthropicClient('cvOptimizer', CV_LLM_CLIENT_OPTIONS);
  const model = modelOverride ?? getFeatureModel('cvOptimizer');

  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096, // 2048 truncated the JSON on long JDs (~6.5k chars of keywords)
    system: `${todayInstruction()}\n\n${ATS_KEYWORD_EXTRACTION_PROMPT}`,
    messages: [{
      role: 'user',
      content: `TARGET ROLE: ${targetRole}\n\n=== JOB DESCRIPTION ===\n${jdText}`,
    }],
  });

  const block = response.content[0];
  if (block.type !== 'text') return [];

  const parsed = JSON.parse(stripJsonFences(block.text)) as { keywords?: unknown[] };
  const raw = Array.isArray(parsed.keywords) ? parsed.keywords : [];

  return raw
    .filter((k): k is Record<string, unknown> => k !== null && typeof k === 'object')
    .map((k) => ({
      keyword: String(k.keyword ?? ''),
      category: String(k.category ?? 'hard_skill') as AtsExtractedKeyword['category'],
      mandatory: Boolean(k.mandatory),
      foundInCv: false, // filled in by dimension 2
    }))
    .filter((k) => k.keyword.length > 0);
}

// ─── ATS Dimension 2 — Relevance and experience scoring from CV ─────────────

const ATS_RELEVANCE_SCORING_PROMPT = `You are an ATS relevance scoring engine. You will receive a CV, a target role, and a list of extracted keywords from the job description.

You must evaluate two things:

1. For EACH keyword, determine whether it is present in the CV. A keyword is "found" if it appears in a real task description, experience bullet, or skills section. Mere proximity does not count — the candidate must demonstrably have the skill or meet the requirement.

2. Score the following relevance signals, each 1–10 with a one-sentence reasoning:
   - job_history_relevance: are past roles in the same or adjacent domain as the target role?
   - job_stability: average tenure per role. Flag anything under 12 months as a risk signal.
   - seniority_match: compare the candidate's most recent role level against the target. Flag mismatches (e.g. intern applying for senior).
   - industry_match: same industry, adjacent, or unrelated?
   - keyword_context_quality: are keywords used in real task descriptions or just listed in a bare skills section? Context usage scores higher.
   - job_title_match: does any previous job title directly or closely match the target role?

Return ONLY a valid JSON object:
{
  "keywordMatches": [
    { "keyword": string, "foundInCv": boolean }
  ],
  "signals": [
    { "signal": string, "score": <integer 1–10>, "reasoning": string }
  ]
}

Rules:
- keywordMatches must contain one entry per keyword provided in the input — same order, same spelling.
- Mandatory requirements (driving licence, visa, DBS, degree) are binary: found or not. No partial credit.
- signals must contain exactly 6 entries for the 6 signals listed above.
- Do not invent facts. Score only what is demonstrably present in the CV.`;

interface AtsRelevanceResult {
  keywordMatches: { keyword: string; foundInCv: boolean }[];
  signals: { signal: string; score: number; reasoning: string }[];
}

async function scoreAtsRelevance(
  cvText: string,
  targetRole: string,
  keywords: AtsExtractedKeyword[],
  modelOverride?: string,
): Promise<AtsRelevanceResult> {
  if (keywords.length === 0) {
    return { keywordMatches: [], signals: [] };
  }

  assertLlmConfigured('cvOptimizer');
  const anthropic = createAnthropicClient('cvOptimizer', CV_LLM_CLIENT_OPTIONS);
  const model = modelOverride ?? getFeatureModel('cvOptimizer');

  const keywordList = keywords.map((k) =>
    `- "${k.keyword}" (category: ${k.category}, mandatory: ${k.mandatory})`,
  ).join('\n');

  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    system: `${todayInstruction()}\n\n${ATS_RELEVANCE_SCORING_PROMPT}`,
    messages: [{
      role: 'user',
      content: [
        `TARGET ROLE: ${targetRole}`,
        '',
        '=== CV ===',
        cvText,
        '',
        '=== EXTRACTED KEYWORDS ===',
        keywordList,
      ].join('\n'),
    }],
  });

  const block = response.content[0];
  if (block.type !== 'text') return { keywordMatches: [], signals: [] };

  const parsed = JSON.parse(stripJsonFences(block.text)) as Partial<AtsRelevanceResult>;
  return {
    keywordMatches: Array.isArray(parsed.keywordMatches) ? parsed.keywordMatches : [],
    signals: Array.isArray(parsed.signals) ? parsed.signals : [],
  };
}

// ─── ATS score computation ──────────────────────────────────────────────────

function computeAtsScore(
  keywords: AtsExtractedKeyword[],
  signals: AtsRelevanceSignal[],
): { score: number; issues: string[]; passed: string[] } {
  const issues: string[] = [];
  const passed: string[] = [];

  // Keyword coverage scoring (50% of total)
  const mandatory = keywords.filter((k) => k.mandatory);
  const nonMandatory = keywords.filter((k) => !k.mandatory);

  const mandatoryFound = mandatory.filter((k) => k.foundInCv).length;
  const mandatoryTotal = mandatory.length;
  const nonMandatoryFound = nonMandatory.filter((k) => k.foundInCv).length;
  const nonMandatoryTotal = nonMandatory.length;

  // Mandatory: binary penalty — each missing mandatory item is a hard deduction
  const mandatoryScore = mandatoryTotal > 0
    ? (mandatoryFound / mandatoryTotal) * 100
    : 100;

  // Non-mandatory: percentage coverage
  const keywordCoverage = nonMandatoryTotal > 0
    ? (nonMandatoryFound / nonMandatoryTotal) * 100
    : 100;

  if (mandatoryTotal > 0 && mandatoryFound < mandatoryTotal) {
    const missing = mandatory.filter((k) => !k.foundInCv).map((k) => k.keyword);
    issues.push(`Missing mandatory requirements: ${missing.join(', ')}`);
  }
  if (mandatoryTotal > 0 && mandatoryFound === mandatoryTotal) {
    passed.push(`All ${mandatoryTotal} mandatory requirements met`);
  }

  if (nonMandatoryTotal > 0) {
    const pct = Math.round(keywordCoverage);
    if (pct >= 70) {
      passed.push(`Keyword coverage: ${nonMandatoryFound}/${nonMandatoryTotal} (${pct}%)`);
    } else {
      issues.push(`Low keyword coverage: ${nonMandatoryFound}/${nonMandatoryTotal} (${pct}%)`);
    }
  }

  // Relevance signals scoring (50% of total) — average of 6 signals mapped to 0–100
  const signalScores = signals.map((s) => Math.min(10, Math.max(1, s.score)));
  const avgSignal = signalScores.length > 0
    ? signalScores.reduce((a, b) => a + b, 0) / signalScores.length
    : 5;
  const signalScore = (avgSignal / 10) * 100;

  for (const s of signals) {
    if (s.score <= 4) {
      issues.push(`${formatSignalName(s.signal)}: ${s.reasoning}`);
    } else if (s.score >= 7) {
      passed.push(`${formatSignalName(s.signal)}: ${s.reasoning}`);
    }
  }

  // Final score: 30% mandatory + 30% keyword coverage + 40% relevance signals
  const weightedScore = mandatoryTotal > 0
    ? (mandatoryScore * 0.3) + (keywordCoverage * 0.3) + (signalScore * 0.4)
    : (keywordCoverage * 0.5) + (signalScore * 0.5);

  return {
    score: Math.round(Math.max(0, Math.min(100, weightedScore))),
    issues,
    passed,
  };
}

function formatSignalName(signal: string): string {
  return signal
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Build full ATS check from two dimensions ───────────────────────────────

export async function buildAtsCheck(body: AnalyzeCvRequest, modelOverride?: string): Promise<AtsCheck> {
  // Dimension 1: extract keywords from JD
  const keywords = await extractAtsKeywords(body.jobDescription, body.targetRole, modelOverride);

  // Dimension 2: score relevance against CV
  const relevance = await scoreAtsRelevance(body.currentCvText, body.targetRole, keywords, modelOverride);

  // Merge keyword match results back into the keyword list
  for (const match of relevance.keywordMatches) {
    const kw = keywords.find((k) => k.keyword.toLowerCase() === match.keyword.toLowerCase());
    if (kw) kw.foundInCv = match.foundInCv;
  }

  // Normalize signals
  const relevanceSignals: AtsRelevanceSignal[] = (relevance.signals ?? [])
    .filter((s): s is { signal: string; score: number; reasoning: string } =>
      typeof s.signal === 'string' && typeof s.score === 'number' && typeof s.reasoning === 'string',
    )
    .map((s) => ({
      signal: s.signal,
      score: Math.min(10, Math.max(1, Math.round(s.score))),
      reasoning: s.reasoning,
    }));

  const { score, issues, passed } = computeAtsScore(keywords, relevanceSignals);

  return {
    score,
    issues,
    passed,
    extractedKeywords: keywords,
    relevanceSignals,
  };
}

// ─── Action Plan — forward-looking recommendation engine ─────────────────────

const ACTION_PLAN_PROMPT = `You are a career coach generating a concrete action plan for a candidate who has just had their CV evaluated against a target role.

You will receive the full evaluation result — section scores, ATS keyword gaps, relevance signals, bullet impact, and JD alignment. Use this to generate a **forward-looking, actionable** plan.

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "summary": string,
  "projectsToBuild": [ { "title": string, "description": string } ],
  "skillsToLearn": [ { "title": string, "description": string } ],
  "certifications": [ { "title": string, "description": string } ],
  "intermediateRoles": [ { "title": string, "description": string } ]
}

Rules:
- summary: 2–3 sentences framing the candidate's biggest gaps and the strategic direction of the plan.
- projectsToBuild: 2–5 specific portfolio project types that would directly close the gaps found. Every project must name a concrete build (e.g. "Build a React dashboard consuming a REST API with role-based auth"), not a vague theme ("learn frontend").
- skillsToLearn: 2–5 specific skills the candidate should develop to meet the target role. Each must include WHY it matters for THIS role (reference the gap it closes).
- certifications: 0–4 certifications that are genuinely recognised for the target role's industry. Do not invent certifications. If none are relevant, return an empty array.
- intermediateRoles: ONLY populate if there is a clear seniority mismatch (e.g. candidate is junior/intern but applying for senior). In that case, list 2–4 realistic stepping-stone roles (title + why it bridges the gap). If there is no seniority gap, return an empty array.
- Every recommendation must be specific and actionable. No generic verdicts. No platitudes. No "keep working hard" filler.
- Do not repeat bullet-level rewrite suggestions — those live in a separate section.`;

interface ActionPlanEvaluationContext {
  targetRole: string;
  jobDescription?: string;
  sections: AnalyzeCvResult['sections'];
  atsCheck: AtsCheck;
  /** Optional: V2 starts the plan before the (slow) bullets branch finishes. */
  bulletEvaluations?: BulletEvaluation[];
  jdAlignment: JdAlignment;
  keywordHighlights: KeywordHighlight[];
}

export function buildActionPlanFallback(): ActionPlan {
  return {
    summary: 'Action plan unavailable — LLM not configured.',
    projectsToBuild: [],
    skillsToLearn: [],
    certifications: [],
    intermediateRoles: [],
  };
}

function normalizeActionPlanItems(raw: unknown): ActionPlanItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      title: typeof r.title === 'string' ? r.title.trim() : '',
      description: typeof r.description === 'string' ? r.description.trim() : '',
    }))
    .filter((i) => i.title.length > 0);
}

export async function generateActionPlan(context: ActionPlanEvaluationContext): Promise<ActionPlan> {
  assertLlmConfigured('cvOptimizer');
  const anthropic = createAnthropicClient('cvOptimizer', CV_LLM_CLIENT_OPTIONS);
  const model = getFeatureModel('cvOptimizer');
  const bullets = context.bulletEvaluations;

  const evaluationSummary = {
    targetRole: context.targetRole,
    hasJobDescription: Boolean(context.jobDescription?.trim()),
    sections: context.sections.map((s) => ({ title: s.title, score: s.score, feedback: s.feedback })),
    atsScore: context.atsCheck.score,
    atsIssues: context.atsCheck.issues,
    atsPassed: context.atsCheck.passed,
    extractedKeywords: context.atsCheck.extractedKeywords.map((k) => ({
      keyword: k.keyword,
      category: k.category,
      mandatory: k.mandatory,
      foundInCv: k.foundInCv,
    })),
    relevanceSignals: context.atsCheck.relevanceSignals,
    bulletImpact: bullets && {
      total: bullets.length,
      weak: bullets.filter((b) => b.impactScore <= 4).length,
      averageScore: bullets.length > 0
        ? Math.round((bullets.reduce((s, b) => s + b.impactScore, 0) / bullets.length) * 10) / 10
        : 0,
    },
    jdAlignment: context.jdAlignment,
    missingKeywords: context.keywordHighlights.filter((k) => !k.foundInCv).map((k) => k.keyword),
  };

  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    system: `${todayInstruction()}\n\n${ACTION_PLAN_PROMPT}`,
    messages: [{
      role: 'user',
      content: [
        `TARGET ROLE: ${context.targetRole}`,
        '',
        '=== EVALUATION RESULT ===',
        JSON.stringify(evaluationSummary, null, 2),
      ].join('\n'),
    }],
  });

  const block = response.content[0];
  if (block.type !== 'text') return buildActionPlanFallback();

  const parsed = JSON.parse(stripJsonFences(block.text)) as Partial<ActionPlan>;
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    projectsToBuild: normalizeActionPlanItems(parsed.projectsToBuild),
    skillsToLearn: normalizeActionPlanItems(parsed.skillsToLearn),
    certifications: normalizeActionPlanItems(parsed.certifications),
    intermediateRoles: normalizeActionPlanItems(parsed.intermediateRoles),
  };
}

// ─── Composite score computation ────────────────────────────────────────────

export function computeCompositeScore(
  sections: AnalyzeCvResult['sections'],
  atsCheck: AtsCheck,
  bulletEvaluations: BulletEvaluation[],
): { overallScore: number; breakdown: ScoreBreakdown } {
  const cvOverview = sections.length > 0
    ? Math.round(sections.reduce((s, sec) => s + sec.score, 0) / sections.length)
    : 0;

  const atsAndKeywordIntelligence = atsCheck.score;

  const bulletImpact = bulletEvaluations.length > 0
    ? Math.round((bulletEvaluations.reduce((s, b) => s + b.impactScore, 0) / bulletEvaluations.length) * 10)
    : 0;

  const overallScore = Math.round(
    cvOverview * 0.25 +
    atsAndKeywordIntelligence * 0.40 +
    bulletImpact * 0.35,
  );

  return {
    overallScore: Math.max(0, Math.min(100, overallScore)),
    breakdown: { cvOverview, atsAndKeywordIntelligence, bulletImpact },
  };
}

// ─── LLM analysis ─────────────────────────────────────────────────────────────

function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function safeArray<T>(val: unknown, fallback: T[] = []): T[] {
  return Array.isArray(val) ? (val as T[]) : fallback;
}

function safeString(val: unknown, fallback = ''): string {
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : fallback;
}

function safeNumber(val: unknown, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : fallback;
}

function normalizeResult(_targetRole: string, raw: Partial<AnalyzeCvResult>): Omit<AnalyzeCvResult, 'atsCheck' | 'actionPlan' | 'overallScore' | 'scoreBreakdown'> & { atsCheck?: AtsCheck } {
  const sections = safeArray<AnalyzeCvResult['sections'][number]>(raw.sections)
    .map((s) => ({
      title: safeString(s?.title),
      score: safeNumber(s?.score),
      feedback: safeString(s?.feedback),
    }))
    .filter((s) => s.title && s.feedback);

  if (sections.length === 0) {
    throw new Error('LLM result did not include any valid sections.');
  }

  const rawFmt = (raw.formatCheck ?? {}) as Partial<FormatCheck>;
  const rawAlignment = (raw.jdAlignment ?? {}) as Partial<JdAlignment>;

  return {
    sections,
    keywordHighlights: safeArray<KeywordHighlight>(raw.keywordHighlights),
    formatCheck: {
      issues: safeArray<string>(rawFmt.issues),
      suggestions: safeArray<string>(rawFmt.suggestions),
    },
    bulletEvaluations: safeArray<BulletEvaluation>(raw.bulletEvaluations).map((b) => ({
      original: safeString(b?.original),
      project: safeString(b?.project, 'Other'),
      hasImpact: Boolean(b?.hasImpact),
      impactScore: Math.max(1, Math.min(10, Math.round(Number(b?.impactScore ?? 0)))),
      feedback: safeString(b?.feedback),
      autoRewrite: safeString(b?.autoRewrite),
      clarifyingQuestions: safeArray<string>(b?.clarifyingQuestions).filter((q) => typeof q === 'string' && q.trim().length > 0),
    })).filter((b) => b.original.length > 0),
    rewriteSuggestions: safeArray<RewriteSuggestion>(raw.rewriteSuggestions),
    jdAlignment: {
      matchedRequirements: safeArray<string>(rawAlignment.matchedRequirements),
      missingRequirements: safeArray<string>(rawAlignment.missingRequirements),
      alignmentSummary: safeString(rawAlignment.alignmentSummary),
    },
  };
}

const SYSTEM_PROMPT = `You are an expert CV reviewer, ATS specialist, and career coach.
You will receive a CV and optionally a Job Description. Analyze the CV thoroughly and return ONLY a single valid JSON object — no markdown, no explanation, no preamble.

The JSON must match this exact structure:
{
  "sections": [
    { "title": string, "score": <integer 0–100>, "feedback": string }
  ],
  "keywordHighlights": [
    { "keyword": string, "foundInCv": boolean, "category": "required_skill" | "tech_stack" | "nice_to_have" }
  ],
  "formatCheck": {
    "issues": [string],
    "suggestions": [string]
  },
  "bulletEvaluations": [
    {
      "original": string,
      "project": string,
      "hasImpact": boolean,
      "impactScore": <integer 1–10>,
      "feedback": string,
      "autoRewrite": string,
      "clarifyingQuestions": [string]
    }
  ],
  "rewriteSuggestions": [
    { "section": string, "current": string, "suggested": string, "reason": string }
  ],
  "jdAlignment": {
    "matchedRequirements": [string],
    "missingRequirements": [string],
    "alignmentSummary": string
  }
}

Rules:
- sections: produce exactly 4 items covering Technical Skills, Experience, Role Alignment, Writing Impact. These feed the "CV Overview" dimension of the composite score.
- keywordHighlights: extract every named technology, tool, language, framework, and method from the JD; mark each as found or missing in the CV; classify as required_skill, tech_stack, or nice_to_have
- formatCheck: flag any typos, inconsistent capitalisation, inconsistent date formats, punctuation issues, or missing section headers
- bulletEvaluations: evaluate every experience bullet in the CV. Score impact 1–10. Be strict — vague bullets score 1–4. These feed the "Bullet Impact" dimension of the composite score.
  - "project" MUST identify the role, project, or company the bullet belongs to. Use the exact heading from the CV (e.g. "Software Engineer — Acme Corp", "Personal Project: Portfolio Site"). If no project context exists, use "Other".
  - "autoRewrite": for ANY bullet scoring 6 or below, produce ONE rewritten version that immediately improves the bullet using ONLY information present in the original CV text. Start with a strong action verb, tighten the wording, surface any latent impact already mentioned. **Do NOT invent metrics, percentages, team sizes, dollar amounts, or outcomes that are not in the original.** If the original has no quantifiable detail, focus on stronger phrasing, clearer scope, and tighter language. One bullet, no leading symbol, ≤30 words. For bullets scoring 7+, return an empty string.
  - "clarifyingQuestions": for ANY bullet scoring 6 or below, produce 2–4 targeted questions asking the candidate for the missing impact details that would make the bullet truly strong. Questions must be concrete and answerable (e.g. "What percentage did conversion improve?", "How many users did this affect?", "What was the measurable outcome?"). For bullets scoring 7+, return an empty array. Never ask open-ended or generic questions.
- rewriteSuggestions: provide 3–6 concrete rewrites targeting the weakest bullets and summary. Show the original and improved version side by side with the reason
- jdAlignment: list specific JD requirements that are clearly evidenced in the CV vs clearly absent
- ATS scoring is handled by a separate dedicated pipeline — do NOT produce an atsCheck field.
- Overall score is computed downstream from three dimensions (CV Overview 25%, ATS Compatibility 40%, Bullet Impact 35%) — do NOT produce an overallScore field.
- An Action Plan is generated in a separate call — do NOT produce an expertReview or actionPlan field here.
- Do not invent facts. Do not be encouraging if the CV is weak. Score what is actually present.`;

// How the model must treat the REFERENCE PATTERNS block. Placed in the user
// prompt (not SYSTEM_PROMPT) so the response schema and scoring rules stay
// untouched — these lines only govern how the few-shot references are used.
const REFERENCE_USAGE_INSTRUCTIONS = [
  '- Use the reference patterns only as guidance for structure, phrasing style, and ATS optimization.',
  '- Do not copy wording, bullet points, or achievements from the reference examples.',
  '- Do not invent experience, metrics, technologies, or responsibilities.',
  '- If a metric is missing, suggest where the user could add one.',
  '- Keep the output ATS-friendly and concise.',
].join('\n');

async function buildLlmAnalysis(body: AnalyzeCvRequest): Promise<AnalyzeCvResult | null> {
  console.log('🐘 Using Monolith');
  assertLlmConfigured('cvOptimizer');

  const anthropic = createAnthropicClient('cvOptimizer');
  const model = getFeatureModel('cvOptimizer');

  // Few-shot references (hardcoded role-family library — no RAG, no retrieval).
  // Never throws: getReferenceExamples() returns up to 3 relevance-ordered
  // references (the CV drives seniority-aware ranking) or a generic ATS
  // reference when no family matches; formatReferencePatterns() emits only the
  // four pattern fields.
  const referenceExamples = getReferenceExamples(body.targetRole, body.currentCvText);
  const referencePatterns = formatReferencePatterns(referenceExamples);

  const userPrompt = [
    `TARGET ROLE: ${body.targetRole}`,
    '',
    '=== REFERENCE PATTERNS FROM SUCCESSFUL CVS ===',
    referencePatterns,
    '',
    '=== USER CV ===',
    body.currentCvText,
    '',
    body.jobDescription?.trim()
      ? `=== JOB DESCRIPTION ===\n${body.jobDescription.trim()}`
      : '=== JOB DESCRIPTION ===\n(No job description provided — evaluate the CV against the target role only.)',
    '',
    '=== INSTRUCTIONS ===',
    REFERENCE_USAGE_INSTRUCTIONS,
  ].join('\n');

  // Run main analysis and ATS scoring in parallel
  const [mainResponse, atsCheck] = await Promise.all([
    anthropic.messages.create({
      model,
      max_tokens: 16384,
      system: `${todayInstruction()}\n\n${SYSTEM_PROMPT}`,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    buildAtsCheck(body).catch((err) => {
      console.error('ATS scoring failed, falling back to basic ATS check.', err);
      return null;
    }),
  ]);

  if (mainResponse.stop_reason === 'max_tokens') {
    console.error('CV analysis hit max_tokens cap — response truncated, falling back.');
    return null;
  }

  const block = mainResponse.content[0];
  if (block.type !== 'text') return null;

  const raw = JSON.parse(stripJsonFences(block.text)) as Partial<AnalyzeCvResult>;
  const partial = normalizeResult(body.targetRole.trim(), raw);

  // ATS comes from the dedicated pipeline — fall back to an empty ATS check if it failed.
  const finalAtsCheck: AtsCheck = atsCheck ?? {
    score: 0,
    issues: ['ATS scoring pipeline failed — score unavailable.'],
    passed: [],
    extractedKeywords: [],
    relevanceSignals: [],
  };

  const { overallScore, breakdown } = computeCompositeScore(
    partial.sections,
    finalAtsCheck,
    partial.bulletEvaluations,
  );

  // Action Plan call — runs AFTER we have the full evaluation context so
  // Claude can produce targeted, gap-aware recommendations.
  const actionPlan = await generateActionPlan({
    targetRole: body.targetRole.trim(),
    jobDescription: body.jobDescription,
    sections: partial.sections,
    atsCheck: finalAtsCheck,
    bulletEvaluations: partial.bulletEvaluations,
    jdAlignment: partial.jdAlignment,
    keywordHighlights: partial.keywordHighlights,
  }).catch((err) => {
    console.error('Action plan generation failed.', err);
    return buildActionPlanFallback();
  });

  return {
    overallScore,
    scoreBreakdown: breakdown,
    sections: partial.sections,
    keywordHighlights: partial.keywordHighlights,
    atsCheck: finalAtsCheck,
    formatCheck: partial.formatCheck,
    bulletEvaluations: partial.bulletEvaluations,
    rewriteSuggestions: partial.rewriteSuggestions,
    jdAlignment: partial.jdAlignment,
    actionPlan,
  };
}

// ─── Job runner ───────────────────────────────────────────────────────────────

async function analyzeCv(body: AnalyzeCvRequest): Promise<AnalyzeCvResult> {
  // Feature flag (default off): route through the parallel V2 agent pipeline.
  // Dynamic import keeps V2 off this file's static module graph — V2 imports
  // back from here, so a static import would introduce a permanent cycle.
  if (getCvOptimizerFeatures().useV2) {
    const { buildLlmAnalysisV2 } = await import('./cv-agents/build-llm-analysis-v2.js');
    return buildLlmAnalysisV2({
      targetRole: body.targetRole,
      cvText: body.currentCvText,
      jobDescription: body.jobDescription,
    });
  }

  if (!getLlmConfig('cvOptimizer').enabled) {
    return buildFallbackAnalysis(body);
  }

  // A failed LLM run fails the job (runCvAnalysisJob marks it `failed`, the UI
  // offers a retry) instead of returning buildFallbackAnalysis(), whose canned
  // scores and "LLM not configured" message would be wrong here.
  const result = await buildLlmAnalysis(body).catch((error) => {
    console.error('CV analysis LLM call failed.', error);
    throw error;
  });
  if (!result) throw new Error('The AI analysis returned an unusable response. Please try again.');
  return result;
}

/**
 * Point the job at the `cv_versions` row holding the CV it analysed (migration
 * 018). Runs in the background rather than in `createCvAnalysisJob` so the 202
 * still returns immediately, and is best-effort throughout: a job that analyses
 * a CV fine but fails to link it is a job that succeeded.
 */
async function linkJobToCvVersion(
  jobId: string,
  body: AnalyzeCvRequest,
  userId: string,
): Promise<string | null> {
  try {
    const cvVersionId = await ensureCvVersion({
      userId,
      rawText: body.currentCvText,
      name: `CV Optimiser · ${body.targetRole}`.slice(0, 200),
      origin: 'cv_optimizer',
    });
    if (!cvVersionId) return null;
    await getSupabase()
      .from('cv_analysis_jobs')
      .update({ cv_version_id: cvVersionId })
      .eq('id', jobId);
    return cvVersionId;
  } catch (err) {
    console.error(`[cv-optimizer] could not link job ${jobId} to a cv_version:`, err);
    return null;
  }
}

/**
 * Assisted Apply: a run started from a tracked job records the analysed CV as
 * that card's "CV used" and moves a card still at `saved` to `preparing`.
 * Best-effort like the link above — the analysis already succeeded. Scoped by
 * user in the tracker service, so a foreign card id changes nothing.
 */
async function linkSavedJob(userId: string, savedJobId: string, cvVersionId: string): Promise<void> {
  try {
    const job = await updateSavedJob(userId, savedJobId, { cvVersionId });
    if (job?.status === 'saved') {
      await changeJobStatus(userId, savedJobId, { status: 'preparing', note: 'CV tailored in CV Optimizer' });
    }
  } catch (err) {
    console.error(`[cv-optimizer] could not link saved job ${savedJobId}:`, err);
  }
}

/**
 * Short label for the history list, e.g. "Data Analyst · against a JD".
 *
 * The role alone is ambiguous once a student has run the same role twice, so the
 * JD flag distinguishes the two runs that differ only by it — the request has no
 * other field worth showing in a list.
 */
export function cvSummary(body: AnalyzeCvRequest): string {
  const role = body.targetRole?.trim() || 'CV Optimiser';
  return body.jobDescription?.trim() ? `${role} · against a JD` : role;
}

async function runCvAnalysisJob(jobId: string, body: AnalyzeCvRequest, userId: string) {
  await updateJob(jobId, { status: 'running', clearError: true });
  // Kicked off, not awaited: the link runs alongside the analysis, and its id is
  // only needed once the analysis has finished.
  const linking = linkJobToCvVersion(jobId, body, userId);

  try {
    const result = await analyzeCv(body);
    await updateJob(jobId, { status: 'completed', result, clearError: true });

    // History (migration 017). CV Optimiser was the one tool that never recorded
    // a run, so "My history" showed Dream Company and Interview Lab only. Written
    // after the job row so a history failure can never lose the analysis itself;
    // `recordToolResult` swallows its own errors for the same reason.
    // `cvText` is deliberately not in `input` — it lives in `cv_versions` and is
    // pointed at, not copied per run.
    const cvVersionId = await linking;
    await recordToolResult(userId, 'cv', cvSummary(body), result, {
      input: {
        targetRole: body.targetRole,
        jobDescription: body.jobDescription ?? null,
        savedJobId: body.savedJobId ?? null,
      },
      cvVersionId,
    });
    if (body.savedJobId && cvVersionId) await linkSavedJob(userId, body.savedJobId, cvVersionId);
  } catch (error) {
    await updateJob(jobId, {
      status: 'failed',
      clearResult: true,
      error: buildJobError('The CV analysis job failed.', error instanceof Error ? error.message : error),
    });
  }
}

export async function createCvAnalysisJob(body: AnalyzeCvRequest, userId: string): Promise<AnalyzeCvAcceptedResponse> {
  const supabase = getSupabase();
  // `input_json` records WHAT was analysed, so the stored result stops being an
  // orphan (migration 018). The CV body is deliberately not in here — it lives
  // once in `cv_versions`, reached via `cv_version_id`, which the background
  // job fills in.
  // Gamification (047): the run names its card at creation (047's saved_job_id),
  // which is what makes a completed run count as tailoring that card. 047's G1
  // trigger refuses another user's card; that run simply goes unlinked, as a
  // foreign card id always has (linkSavedJob below changes nothing either).
  let savedJobId = body.savedJobId ?? null;
  const insertJob = (withInput: boolean) =>
    supabase
      .from('cv_analysis_jobs')
      .insert({
        user_id: userId,
        status: 'queued',
        ...(savedJobId ? { saved_job_id: savedJobId } : {}),
        ...(withInput
          ? {
              input_json: {
                targetRole: body.targetRole,
                jobDescription: body.jobDescription?.trim() || null,
                cvTextChars: body.currentCvText?.length ?? 0,
              },
            }
          : {}),
      })
      .select('id, status, submitted_at, updated_at')
      .single();

  let { data, error } = await insertJob(true);

  if (error && savedJobId && error.code === '23503') {
    savedJobId = null;
    ({ data, error } = await insertJob(true));
  }

  // Migrations here are applied by hand, so code can reach production before its
  // schema does. Losing `input_json` for a while is a shame; failing every CV
  // analysis until someone opens the SQL editor is an outage. Fall back once,
  // loudly, so the error log is how this gets noticed.
  if (error && isMissingColumnError(error)) {
    console.error('[cv-optimizer] cv_analysis_jobs.input_json is missing — run migration 018.');
    savedJobId = null; // a schema without 018 has no 047 either
    ({ data, error } = await insertJob(false));
  }

  if (error || !data) {
    const err = new Error(`Failed to create CV analysis job: ${error?.message ?? 'unknown error'}`);
    Object.assign(err, { statusCode: 500 });
    throw err;
  }

  const jobId = data.id as string;
  setTimeout(() => { void runCvAnalysisJob(jobId, body, userId); }, 50);

  return {
    jobId,
    status: data.status as Extract<JobStatus, 'queued' | 'running'>,
    submittedAt: data.submitted_at as string,
    updatedAt: data.updated_at as string,
  };
}

export async function getCvAnalysisJob(jobId: string): Promise<JobStatusResponse<AnalyzeCvResult> | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('cv_analysis_jobs')
    .select('id, status, submitted_at, updated_at, result_json, error_json')
    .eq('id', jobId)
    .maybeSingle();

  if (error) {
    console.error(`[cv-optimizer] failed to fetch job ${jobId}:`, error.message);
    return null;
  }
  if (!data) return null;
  return rowToJobResponse(data as CvAnalysisJobRow);
}

// ─── File parsing ─────────────────────────────────────────────────────────────

// ─── Bullet rewrite with user-supplied answers ─────────────────────────────

const BULLET_REWRITE_PROMPT = `You rewrite weak CV bullet points into strong, impact-driven bullets using a candidate's own answers to clarifying questions.

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "rewritten": string
}

Rules:
- Use ONLY information the candidate actually provided in their answers. Do not invent numbers, percentages, timelines, team sizes, or outcomes. If the candidate did not provide a metric, do not add one.
- Preserve the technical accuracy of the original bullet. Do not contradict it.
- Start with a strong action verb (built, led, delivered, optimised, reduced, shipped, migrated, etc.).
- Follow the standard impact formula where possible: [action verb] + [what you did] + [measurable outcome or scope] + [tools/tech if relevant].
- Keep it to ONE single bullet, no more than ~30 words. No bullet symbol at the start.
- If the candidate's answers are blank or uninformative, do your best with the original bullet and feedback — but still do not invent metrics.
- Do not wrap the output in quotes.`;

export async function rewriteBulletWithAnswers(body: RewriteBulletRequest): Promise<RewriteBulletResponse> {
  if (!getLlmConfig('cvOptimizer').enabled) {
    throw Object.assign(new Error('LLM is not configured.'), { statusCode: 503 });
  }

  assertLlmConfigured('cvOptimizer');
  const anthropic = createAnthropicClient();
  const model = getFeatureModel('cvOptimizer');

  const qa = body.clarifyingQuestions
    .map((q, i) => `Q: ${q}\nA: ${body.answers[i]?.trim() || '(no answer provided)'}`)
    .join('\n\n');

  const userPrompt = [
    `TARGET ROLE: ${body.targetRole}`,
    `PROJECT / ROLE: ${body.project}`,
    '',
    '=== ORIGINAL BULLET ===',
    body.original,
    '',
    '=== REVIEWER FEEDBACK ===',
    body.feedback,
    '',
    '=== CANDIDATE ANSWERS TO CLARIFYING QUESTIONS ===',
    qa || '(none)',
  ].join('\n');

  const response = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system: `${todayInstruction()}\n\n${BULLET_REWRITE_PROMPT}`,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const block = response.content[0];
  if (block.type !== 'text') {
    throw new Error('LLM returned no text content.');
  }

  const parsed = JSON.parse(stripJsonFences(block.text)) as { rewritten?: string };
  const rewritten = typeof parsed.rewritten === 'string' ? parsed.rewritten.trim() : '';

  if (!rewritten) {
    throw new Error('LLM did not return a rewritten bullet.');
  }

  return { rewritten };
}

// ─── File parsing ─────────────────────────────────────────────────────────────

export async function extractFileText(buffer: Buffer, fileNameLower: string): Promise<string> {
  if (!fileNameLower.endsWith('.pdf') && !fileNameLower.endsWith('.docx')) {
    throw Object.assign(new Error('Only PDF and DOCX files are supported'), { statusCode: 400 });
  }

  let text: string;

  if (fileNameLower.endsWith('.pdf')) {
    const pdfData = await pdfParse(buffer);
    text = pdfData.text;
  } else {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  }

  if (!text.trim()) {
    throw Object.assign(new Error('Could not extract text from the uploaded file'), { statusCode: 422 });
  }

  return text.trim();
}
