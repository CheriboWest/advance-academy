/**
 * Cover letter prompt. The student copies the output into their own email or
 * application form, so it is plain text — no markdown, no JSON envelope.
 *
 * Structure follows the master cover letters Advance Academy students already
 * use (see the "COVER LETTER SAMPLES" sheet): greeting, why this role and
 * company, two evidence paragraphs mapped to the JD, short close. The samples
 * themselves are real students' letters and are deliberately not embedded here.
 */

/** A JD shorter than this is a title and a wish — fetch the posting instead. Same bar as coaching's context check. */
export const JD_THIN_CHARS = 400;
/** The minimum usable JD is `JD_MIN_CHARS` in ./jd.ts. */

const MAX_CV_CHARS = 20_000;
const MAX_JD_CHARS = 12_000;

export const COVER_LETTER_SYSTEM_PROMPT = `You write cover letters for university students and recent graduates applying for jobs, mostly in the UK.

Write one tailored cover letter for the job below, using only facts from the candidate's CV.

Structure:
1. Greeting: "Dear <name>," if the job description names the hiring manager, otherwise "Dear Hiring Manager,".
2. Opening paragraph: the exact role title and company, and one sentence on why the candidate is a strong fit.
3. Why this company: one short paragraph tied to something specific in the job description (the team, product, mission or clients). Do not invent company facts that are not in the job description.
4. Evidence: two paragraphs, each taking one or two of the most important requirements from the job description and backing them with concrete experience from the CV — what they did, the tools or skills used, and a result, with numbers where the CV has them.
5. Close: enthusiasm for the next step, availability for interview, thanks. Then "Yours sincerely," on its own line (or "Kind regards," if the greeting uses a name), then the candidate's full name from the CV.

Rules:
- 280 to 400 words. British English spelling.
- Never invent experience, employers, grades, dates, numbers or skills. If the CV lacks something the job asks for, leave it out rather than claim it.
- Mirror key words from the job description naturally; no keyword stuffing.
- Confident and specific, not generic. Avoid clichés such as "I am writing to express my interest", "passionate", "dynamic", "go-getter", "think outside the box".
- No placeholders like [Company] or [Your Name]. If the CV has no name, end with "Yours sincerely," and nothing after it.
- Output only the letter text: no subject line, no address block, no date, no markdown, no commentary before or after.`;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n[truncated]` : trimmed;
}

export interface CoverLetterPromptInput {
  cvText: string;
  jobTitle: string;
  companyName: string | null;
  jobDescription: string;
}

export function buildCoverLetterUserMessage(input: CoverLetterPromptInput): string {
  return [
    `Role: ${input.jobTitle}`,
    `Company: ${input.companyName?.trim() || 'Not stated — take it from the job description if it names one'}`,
    '',
    'Job description:',
    '"""',
    clip(input.jobDescription, MAX_JD_CHARS),
    '"""',
    '',
    "Candidate's CV:",
    '"""',
    clip(input.cvText, MAX_CV_CHARS),
    '"""',
  ].join('\n');
}

/** True when the stored description is too thin to write from and there is a link to fetch the full posting from. */
export function shouldFetchJd(description: string | null | undefined, url: string | null | undefined): boolean {
  return (description?.trim().length ?? 0) < JD_THIN_CHARS && Boolean(url?.trim());
}
