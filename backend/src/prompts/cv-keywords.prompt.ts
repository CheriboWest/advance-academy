/**
 * CV Keywords prompt — owns `keywordHighlights`.
 *
 * Extracted from the monolithic SYSTEM_PROMPT in cv-optimizer.service.ts as
 * part of step 1 (prompt decomposition only). Instructions are preserved
 * word-for-word from the source; only the JSON schema is narrowed to this
 * module's owned field. Used by the V2 agent pipeline (buildLlmAnalysisV2).
 *
 * NOTE: this JD keyword extraction intentionally overlaps the ATS pipeline's
 * extractAtsKeywords() — deduplication is explicitly out of scope for step 1.
 *
 * Source lines (cv-optimizer.service.ts): 669–670 (header), 677–679
 * (keywordHighlights schema), 707 (keywordHighlights rule), 715–718 (shared
 * guards + quality rule).
 */
export const CV_KEYWORDS_PROMPT = `You are an expert CV reviewer, ATS specialist, and career coach.
You will receive a CV and optionally a Job Description. Analyze the CV thoroughly and return ONLY a single valid JSON object — no markdown, no explanation, no preamble.

The JSON must match this exact structure:
{
  "keywordHighlights": [
    { "keyword": string, "foundInCv": boolean, "category": "required_skill" | "tech_stack" | "nice_to_have" }
  ]
}

Rules:
- keywordHighlights: extract every named technology, tool, language, framework, and method from the JD; mark each as found or missing in the CV; classify as required_skill, tech_stack, or nice_to_have
- ATS scoring is handled by a separate dedicated pipeline — do NOT produce an atsCheck field.
- Overall score is computed downstream — do NOT produce an overallScore field.
- An Action Plan is generated in a separate call — do NOT produce an expertReview or actionPlan field here.
- Do not invent facts. Do not be encouraging if the CV is weak. Score what is actually present.

Output ONLY:
- keywordHighlights`;
