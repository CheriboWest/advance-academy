import type {
  GenerateCoverLetterRequest,
  GenerateCoverLetterResponse,
} from '@advance-academy/contracts/cover-letter';
import type { SavedJobStatus } from '@advance-academy/contracts/job-tracking';
import { assertLlmConfigured, createAnthropicClient, getFeatureModel, withRetry } from '../lib/llm-anthropic.js';
import { newCostBucket } from '../lib/cost-tracker.js';
import { COVER_LETTER_SYSTEM_PROMPT, buildCoverLetterUserMessage } from '../lib/cover-letter/prompts.js';
import { resolveJobDescription, type JdDeps } from '../lib/cover-letter/jd.js';
import { getCvVersion } from './cv-knowledge.service.js';
import { extractJobFromMarkdown } from './job-extraction.service.js';
import { readUrl } from './outreach-extractor.service.js';
import { getSavedJob, updateSavedJob } from './job-tracking.service.js';
import { spendCreditsWith } from '../lib/credits.js';
import { mapGamificationDbError } from '../lib/gamification-errors.js';
import { getSupabase } from '../lib/supabase.js';

/**
 * Cover Letter Generator: one CV from the student's CV Library + one job → one
 * plain-text letter the student copies and sends themselves.
 *
 * When the job is a tracked card, the letter and the CV used are written back
 * onto it (the "CV / cover letter used" the tracker records), and a card still
 * at `saved` moves to `preparing`.
 */

// saved_jobs.description is capped at 5000 by the tracker's validator; keep the stored copy inside it.
const MAX_STORED_JD = 5000;

function httpError(statusCode: number, message: string, extra: { code?: string; expose?: boolean } = {}): Error {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

/**
 * Time budget. The browser and the Next proxy give up at 120s, so the whole
 * request has to finish inside that: reading the link (12s × 2 attempts + 1s
 * backoff), picking the JD out of it (25s, no SDK retry) and writing the letter
 * (60s). With the defaults the read alone could take ~48s and the extraction had
 * the SDK's 10-minute timeout, so a slow job site ran the request past the
 * proxy's deadline and the student saw only "Please try again".
 */
const JD_READ = { timeoutMs: 12_000, maxRetries: 2 };
const JD_EXTRACT = { timeoutMs: 25_000, maxRetries: 0 };
const LETTER_CLIENT = { timeoutMs: 60_000, maxRetries: 0 }; // withRetry below still retries overloads

const jdDeps: JdDeps = {
  read: (url) => readUrl(url, JD_READ),
  extract: (markdown) => extractJobFromMarkdown(markdown, JD_EXTRACT),
  // The site and the outcome only: never the full link (it can carry tracking ids) or any JD text.
  log: ({ host, code }) => console.warn('[cover-letter] job link unusable', host, code),
};

interface ResolvedJob {
  title: string;
  companyName: string | null;
  description: string;
  url: string | null;
  savedJobId: string | null;
  status: SavedJobStatus | null;
  notice: string | null;
}

async function resolveJob(userId: string, req: GenerateCoverLetterRequest): Promise<ResolvedJob> {
  let job: ResolvedJob;
  if (req.savedJobId) {
    const found = await getSavedJob(userId, req.savedJobId);
    if (!found) throw httpError(404, 'That job is not in your tracker.');
    const j = found.job;
    job = {
      title: j.title,
      companyName: j.companyName,
      // A description pasted on the screen beats the card's (its link may be unreadable).
      description: req.jobDescription?.trim() || j.description || '',
      url: j.jobUrl,
      savedJobId: j.id,
      status: j.status,
      notice: null,
    };
  } else {
    job = {
      title: req.jobTitle?.trim() ?? '',
      companyName: req.companyName?.trim() || null,
      description: req.jobDescription?.trim() ?? '',
      url: req.jobUrl?.trim() || null,
      savedJobId: null,
      status: null,
      notice: null,
    };
  }
  const pastedForCard = Boolean(req.savedJobId && req.jobDescription?.trim());

  // Throws a JdError (code + recovery message) when there is no usable JD.
  const jd = await resolveJobDescription({ description: job.description, url: job.url }, jdDeps);
  job.description = jd.description;
  job.notice = jd.notice;
  if (jd.fetched) {
    job.title ||= jd.fetched.jobTitle;
    job.companyName ||= jd.fetched.companyName || null;
  }
  if (!job.title) throw httpError(400, 'A job title is required.', { code: 'INVALID_REQUEST' });
  // Keep a fetched or pasted JD on the card so the next tool doesn't have to fetch it again.
  if (job.savedJobId && (jd.fetched || pastedForCard)) {
    await updateSavedJob(userId, job.savedJobId, { description: job.description.slice(0, MAX_STORED_JD) });
  }
  return job;
}

export async function generateCoverLetter(
  userId: string,
  req: GenerateCoverLetterRequest,
): Promise<GenerateCoverLetterResponse> {
  const cv = await getCvVersion(req.cvVersionId, userId);
  if (!cv?.raw_text?.trim()) throw httpError(404, 'That CV is not in your CV Library.');

  const job = await resolveJob(userId, req);

  assertLlmConfigured('coverLetter');
  const anthropic = createAnthropicClient('coverLetter', LETTER_CLIENT);
  const model = getFeatureModel('coverLetter');
  const cost = newCostBucket('coverLetter.generate');

  const response = await withRetry(() =>
    anthropic.messages.create({
      model,
      max_tokens: 2000,
      system: COVER_LETTER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildCoverLetterUserMessage({
            cvText: cv.raw_text,
            jobTitle: job.title,
            companyName: job.companyName,
            jobDescription: job.description,
          }),
        },
      ],
    }),
  );
  cost.llm('generate', model, response.usage);
  cost.flush();

  if (response.stop_reason === 'max_tokens') {
    throw httpError(502, 'The letter came back cut off. Please try again — no credit was used.', { code: 'LLM_FAILED', expose: true });
  }
  const coverLetter = response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
  if (!coverLetter) {
    throw httpError(502, 'The letter came back empty. Please try again — no credit was used.', { code: 'LLM_FAILED', expose: true });
  }

  try {
    await chargeAndSaveCoverLetter(userId, job.savedJobId, coverLetter, cv.id);
  } catch (error) {
    throw coverLetterSaveError(error);
  }

  return {
    coverLetter,
    jobTitle: job.title,
    companyName: job.companyName,
    savedJobId: job.savedJobId,
    notice: job.notice,
  };
}

/**
 * What a failed charge-and-save tells the student. "Out of credits" and "not
 * your card" already carry their own status and message; anything else is a
 * database problem on our side (e.g. migration 047's charge_credits /
 * record_cover_letter missing), which used to surface as the bare "Could not
 * write the cover letter. Please try again." — after the letter had been
 * written and paid for. The real cause goes to the log (no letter text).
 */
export function coverLetterSaveError(error: unknown): Error {
  const e = error as { statusCode?: number; code?: string; message?: string } | null;
  if (e?.statusCode && e.statusCode < 500) return error as Error;
  console.error('[cover-letter] charge/save failed:', e?.code ?? 'UNKNOWN', e?.message ?? String(error));
  return Object.assign(
    new Error(
      "Your letter was written but couldn't be saved, so no credit was used. This is a problem on our side, not with your CV or job description. Please try again later.",
    ),
    { statusCode: 500, code: 'COVER_LETTER_SAVE_FAILED', expose: true, cause: error },
  );
}

/**
 * Migration 047. The charge and the write-back are one
 * transaction: record_cover_letter charges, writes the letter and CV onto the
 * card, sets the cover-letter marker (the only way to — guard G2) and moves a
 * `saved` card to `preparing`; any failure rolls all of it back. With no card
 * there is nothing to write, so it only charges.
 */
export async function chargeAndSaveCoverLetter(
  userId: string,
  savedJobId: string | null,
  text: string,
  cvVersionId: string | null,
): Promise<void> {
  await spendCreditsWith(userId, 'coverLetter', async (cost) => {
    const sb = getSupabase();
    const { error } = savedJobId
      ? await sb.rpc('record_cover_letter', {
          p_user: userId,
          p_job: savedJobId,
          p_text: text,
          p_cv_version: cvVersionId,
          p_cost: cost,
        })
      : await sb.rpc('charge_credits', { p_user: userId, p_cost: cost });
    if (error) throw mapGamificationDbError(error, 'save the cover letter');
  });
}
