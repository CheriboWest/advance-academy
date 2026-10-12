import type {
  GenerateCoverLetterRequest,
  GenerateCoverLetterResponse,
} from '@advance-academy/contracts/cover-letter';
import type { SavedJobStatus } from '@advance-academy/contracts/job-tracking';
import { AuthenticationError } from '@anthropic-ai/sdk';
import { assertLlmConfigured, createAnthropicClient, getFeatureModel, withRetry } from '../lib/llm-anthropic.js';
import { newCostBucket } from '../lib/cost-tracker.js';
import {
  COVER_LETTER_SYSTEM_PROMPT,
  JD_MISSING_CHARS,
  buildCoverLetterUserMessage,
  shouldFetchJd,
} from '../lib/cover-letter/prompts.js';
import { getCvVersion } from './cv-knowledge.service.js';
import { extractJobFromUrl } from './job-extraction.service.js';
import { changeJobStatus, getSavedJob, updateSavedJob } from './job-tracking.service.js';
import { isGamificationV2Enabled } from '../config/features.js';
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

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

interface ResolvedJob {
  title: string;
  companyName: string | null;
  description: string;
  url: string | null;
  savedJobId: string | null;
  status: SavedJobStatus | null;
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
      description: j.description ?? '',
      url: j.jobUrl,
      savedJobId: j.id,
      status: j.status,
    };
  } else {
    job = {
      title: req.jobTitle?.trim() ?? '',
      companyName: req.companyName?.trim() || null,
      description: req.jobDescription?.trim() ?? '',
      url: req.jobUrl?.trim() || null,
      savedJobId: null,
      status: null,
    };
  }

  if (shouldFetchJd(job.description, job.url)) {
    try {
      const extracted = await extractJobFromUrl(job.url!);
      const fetched = extracted.jobDescription.trim();
      if (fetched.length > job.description.length) {
        job.description = fetched;
        job.title ||= extracted.jobTitle.trim();
        job.companyName ||= extracted.companyName.trim() || null;
        // Keep the fetched JD on the card so the next tool doesn't pay to fetch it again.
        if (job.savedJobId) {
          await updateSavedJob(userId, job.savedJobId, { description: fetched.slice(0, MAX_STORED_JD) });
        }
      }
    } catch (error) {
      // A rejected key would otherwise surface below as "couldn't read that link".
      if (error instanceof AuthenticationError) throw error;
      // Plenty of job boards block bots (Adzuna redirects do); carry on with what we have.
      console.warn('[cover-letter] JD fetch failed', job.url, error instanceof Error ? error.message : error);
    }
  }

  if (!job.title) throw httpError(400, 'A job title is required.');
  if (job.description.length < JD_MISSING_CHARS) {
    throw httpError(
      400,
      job.url
        ? "We couldn't read the job description from that link. Paste the description instead."
        : 'Paste the job description so the letter can match it.',
    );
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
  const anthropic = createAnthropicClient('coverLetter', { timeoutMs: 60_000 });
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

  if (response.stop_reason === 'max_tokens') throw httpError(502, 'The letter came back cut off. Please try again.');
  const coverLetter = response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
  if (!coverLetter) throw httpError(502, 'The letter came back empty. Please try again.');

  if (isGamificationV2Enabled()) {
    await chargeAndSaveCoverLetter(userId, job.savedJobId, coverLetter, cv.id);
  } else if (job.savedJobId) {
    await updateSavedJob(userId, job.savedJobId, { coverLetterText: coverLetter, cvVersionId: cv.id });
    // Writing the letter is preparing the application — but never move a card backwards.
    if (job.status === 'saved') {
      await changeJobStatus(userId, job.savedJobId, { status: 'preparing', note: 'Cover letter written' });
    }
  }

  return {
    coverLetter,
    jobTitle: job.title,
    companyName: job.companyName,
    savedJobId: job.savedJobId,
  };
}

/**
 * Gamification v2 (migration 047). The charge and the write-back are one
 * transaction: record_cover_letter charges, writes the letter and CV onto the
 * card, sets the cover-letter marker (the only way to — guard G2) and moves a
 * `saved` card to `preparing`; any failure rolls all of it back. With no card
 * there is nothing to write, so it only charges. The route then skips
 * spendCredits.
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
