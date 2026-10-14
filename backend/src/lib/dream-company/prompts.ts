import type { DreamCompanyInput, ProfileAnalysis, TargetRole, ExaJobListing } from '@advance-academy/contracts/dream-company';

export function buildProfileAnalysisPrompt(profile: DreamCompanyInput): string {
  return `You are a senior career strategist with 20 years of experience assessing professionals across industries. You are direct, honest, and never inflate assessments to be encouraging.

Analyze the following candidate profile and produce a comprehensive market assessment.

CANDIDATE PROFILE:
- Degree: ${profile.degree}
- Work Experience: ${profile.workExperience}
- Skills: ${profile.skills}
- Interests: ${profile.interests}
- Target Salary: ${profile.targetSalary}
- Location: ${profile.location}

YOUR TASK:
1. Determine the candidate's market level (entry, junior, mid, senior, lead, or executive) based on their experience and skills. Provide a clear rationale.
2. Estimate a realistic salary range for their level and location. Include the currency and a note about market conditions.
3. Identify 3-5 core strengths with specific evidence from their profile (quote exact skills or experience details).
4. Identify 2-4 critical gaps that could hold them back, with impact description and urgency rating (high, medium, or low).
5. Write a unique value proposition — one sentence that captures what makes this specific candidate stand out.
6. Assign a readinessScore from 0-100 representing how ready they are to land their target role, with a note explaining the score.

Be honest and direct. Do not inflate the assessment to be encouraging. Base every claim on evidence from the profile.

Return ONLY a valid JSON object matching this exact schema:
{
  "marketLevel": "entry" | "junior" | "mid" | "senior" | "lead" | "executive",
  "marketLevelRationale": "string",
  "salaryRange": { "min": number, "max": number, "currency": "string", "note": "string" },
  "coreStrengths": [{ "strength": "string", "evidence": "string" }],
  "criticalGaps": [{ "gap": "string", "impact": "string", "urgency": "high" | "medium" | "low" }],
  "uniqueValueProposition": "string",
  "readinessScore": number,
  "readinessNote": "string"
}

Return ONLY a valid JSON object. No explanation, no markdown, no code blocks.`;
}

export function buildTargetRolesPrompt(
  profile: DreamCompanyInput,
  analysis: ProfileAnalysis,
  liveTitles: string[] = [],
): string {
  const liveSection = liveTitles.length > 0
    ? `ROLES CURRENTLY BEING HIRED NEAR YOU (live job listings pulled from the market for this candidate's location and skills):
${liveTitles.map((t) => `- ${t}`).join('\n')}

`
    : '';

  return `You are a talent acquisition specialist with 12 years of experience matching candidates to roles across tech, finance, consulting, and other industries. You understand job market dynamics and hiring trends deeply.

Based on the candidate profile and market assessment below, identify the best-fit job roles for this candidate based on their CURRENT skills and experience level.

CANDIDATE PROFILE:
- Degree: ${profile.degree}
- Work Experience: ${profile.workExperience}
- Skills: ${profile.skills}
- Interests: ${profile.interests}
- Target Salary: ${profile.targetSalary}
- Location: ${profile.location}

MARKET ASSESSMENT:
- Market Level: ${analysis.marketLevel}
- Rationale: ${analysis.marketLevelRationale}
- Salary Range: ${analysis.salaryRange.min}-${analysis.salaryRange.max} ${analysis.salaryRange.currency}
- Core Strengths: ${analysis.coreStrengths.map((s) => `${s.strength} (${s.evidence})`).join('; ')}
- Critical Gaps: ${analysis.criticalGaps.map((g) => `${g.gap} (${g.urgency} urgency)`).join('; ')}
- Unique Value: ${analysis.uniqueValueProposition}
- Readiness Score: ${analysis.readinessScore}/100

${liveSection}YOUR TASK:
Identify exactly 10 job titles that match this candidate's CURRENT abilities. These should be roles they could realistically apply for right now based on their existing skills and experience. Prioritise quality and variety — cover distinct role types and levels rather than near-duplicate titles.

${liveTitles.length > 0
    ? 'IMPORTANT: Anchor your suggestions to the live listings above — these are roles employers are ACTIVELY hiring for near this candidate right now. Prefer titles that appear in (or closely align with) that list, and set demandLevel to "high" for those. Only suggest a role absent from the live list when it is a strong, realistic fit the market simply did not surface in this snapshot.'
    : ''}

For each role provide:
- title: specific job title (e.g., "Senior Frontend Engineer", not just "Engineer")
- level: seniority level (e.g., "Senior", "Mid-Level", "Lead")
- fitScore: 0-100 how well this candidate matches the typical requirements
- fitReason: ONE concise sentence tied to their actual skills/experience
- demandLevel: current market demand for this role — "high", "medium", or "low"
- avgSalary: average salary for this role in ${profile.location}

Order the roles from highest fitScore to lowest.

Return ONLY a valid JSON array matching this exact schema:
[{
  "title": "string",
  "level": "string",
  "fitScore": number,
  "fitReason": "string",
  "demandLevel": "high" | "medium" | "low",
  "avgSalary": "string"
}]

Return ONLY a valid JSON array. No explanation, no markdown, no code blocks.`;
}

export function buildCareerRoadmapPrompt(
  profile: DreamCompanyInput,
  analysis: ProfileAnalysis,
  selectedRoles: TargetRole[],
  selectedJobs: ExaJobListing[],
): string {
  const rolesSection = selectedRoles.length > 0
    ? `SELECTED TARGET ROLES:
${selectedRoles.map((r) => `- ${r.title} (${r.level}) — Fit: ${r.fitScore}%, ${r.demandLevel} demand`).join('\n')}`
    : '';

  const jobsSection = selectedJobs.length > 0
    ? `SELECTED REAL JOB LISTINGS:
${selectedJobs.map((j) => `- ${j.title} (${j.url})`).join('\n')}`
    : '';

  return `You are an executive career coach with 18 years of experience helping professionals advance from ${analysis.marketLevel}-level positions to leadership roles. You build actionable, specific career plans — never generic advice.

Based on the candidate profile, market assessment, and their chosen target roles and job listings below, build a career roadmap that transforms them into the person who can thrive in these roles.

CANDIDATE PROFILE:
- Degree: ${profile.degree}
- Work Experience: ${profile.workExperience}
- Skills: ${profile.skills}
- Interests: ${profile.interests}
- Target Salary: ${profile.targetSalary}
- Location: ${profile.location}

MARKET ASSESSMENT:
- Market Level: ${analysis.marketLevel}
- Readiness Score: ${analysis.readinessScore}/100
- Core Strengths: ${analysis.coreStrengths.map((s) => s.strength).join(', ')}
- Critical Gaps: ${analysis.criticalGaps.map((g) => `${g.gap} (${g.urgency} urgency, impact: ${g.impact})`).join('; ')}
- Unique Value: ${analysis.uniqueValueProposition}
- Readiness Note: ${analysis.readinessNote}

${rolesSection}
${jobsSection}

YOUR TASK:

1. First, write a "Future You" section — paint a vivid picture of who this candidate will become after completing the full roadmap, specifically in the context of the selected roles. Include:
   - personTheyWillBecome: A compelling 1-2 sentence description of the professional they will transform into. Be specific — reference the selected roles and the key skills they'll master.
   - achievementSummary: A concise 1-2 sentence summary of the key achievements and milestones they will have accomplished by the end of the roadmap.

2. Then build exactly 3 phases:
- Phase 1 (0-6 months): Foundation building and quick wins
- Phase 2 (6-18 months): Growth and positioning
- Phase 3 (2-5 years): Career advancement and leadership

For each phase provide:
- phase: the phase number (1, 2, or 3)
- duration: the time range (e.g., "0-6 months")
- goal: one clear overarching goal for this phase
- actions: 3-4 specific, actionable steps (e.g., "Build a portfolio project using React and TypeScript showcasing data visualization" not "improve your skills")
- skills: 3-4 specific skills to develop during this phase
- milestone: one concrete, measurable milestone that proves this phase is complete

RULES:
- Actions must be specific to this candidate's profile and their selected target roles
- Reference their actual skills, gaps, and interests
- Each milestone must be measurable and concrete
- Skills should address identified gaps from the assessment
- The roadmap should clearly map the candidate from their current state to their future version capable of excelling in the selected roles

Return ONLY a valid JSON object matching this exact schema:
{
  "futureYou": {
    "personTheyWillBecome": "string",
    "achievementSummary": "string"
  },
  "phases": [{
    "phase": number,
    "duration": "string",
    "goal": "string",
    "actions": ["string"],
    "skills": ["string"],
    "milestone": "string"
  }]
}

Return ONLY a valid JSON object. No explanation, no markdown, no code blocks.`;
}

export function buildDreamCompanyCvParseInstructions(): string {
  return `Extract structured career information from the attached CV document and map it to the specified fields.

YOUR TASK:
Parse the CV and extract the following fields:
- degree: highest education degree (e.g., "Bachelor of Computer Science")
- workExperience: summary of work experience as a single string describing roles and companies
- skills: comma-separated list of technical and soft skills mentioned
- interests: professional interests or areas of focus mentioned
- targetSalary: any salary expectations mentioned, or empty string if not found
- location: candidate's location or preferred work location

Also determine:
- currentLevel: the candidate's current career level — one of: intern, junior, mid, senior, lead, manager, director, executive
- confidence: an object with confidence levels for each extracted field:
  { "degree": "high"|"medium"|"low", "workExperience": "high"|"medium"|"low", "skills": "high"|"medium"|"low", "location": "high"|"medium"|"low" }

Use empty string "" for any field that cannot be determined from the CV.

Return ONLY a valid JSON object matching this schema:
{
  "degree": "string",
  "workExperience": "string",
  "skills": "string",
  "interests": "string",
  "targetSalary": "string",
  "location": "string",
  "currentLevel": "intern"|"junior"|"mid"|"senior"|"lead"|"manager"|"director"|"executive",
  "confidence": {
    "degree": "high"|"medium"|"low",
    "workExperience": "high"|"medium"|"low",
    "skills": "high"|"medium"|"low",
    "location": "high"|"medium"|"low"
  }
}

Return ONLY a valid JSON object. No explanation, no markdown, no code blocks.`;
}

export function buildDreamCompanyCvParsePrompt(extractedCvText: string): string {
  return `Extract structured career information from the following CV text and map it to the specified fields.

CV TEXT:
${extractedCvText}

${buildDreamCompanyCvParseInstructions()}`;
}
