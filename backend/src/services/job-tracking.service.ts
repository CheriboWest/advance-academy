import type {
  ChangeJobStatusRequest,
  JobEvent,
  SavedJobStatus,
  SavedJob,
  UpdateSavedJobRequest,
} from '@advance-academy/contracts/job-tracking';
import { getSupabase } from '../lib/supabase.js';
import { jobUrlKey, type ValidCreate } from '../lib/job-tracking.js';
import { isGamificationV2Enabled } from '../config/features.js';
import { mapGamificationDbError } from '../lib/gamification-errors.js';

/**
 * Individual Job Tracking (AI Job Tools 1.3, migration 023).
 *
 * Every read and write is scoped by `user_id`. The tables are service-role only
 * (RLS on, no policies), so this filter IS the authorisation — a guessed id from
 * another account simply returns nothing. Nothing here calls an LLM or touches
 * the credit wallet: the tracker is free by design (AC9).
 */

/** Above this a single user's board is a bug, not a use case; keeps one page under PostgREST's 1,000-row cap. */
const MAX_JOBS_PER_USER = 500;

const JOB_COLUMNS =
  'id, status, source, title, company_name, location, job_url, description, salary_text, ' +
  'sponsor_visa, notes, applied_at, deadline_at, next_follow_up_at, cv_version_id, ' +
  'cover_letter_text, created_at, updated_at';

interface SavedJobRow {
  id: string;
  status: SavedJobStatus;
  source: SavedJob['source'];
  title: string;
  company_name: string | null;
  location: string | null;
  job_url: string | null;
  description: string | null;
  salary_text: string | null;
  sponsor_visa: boolean | null;
  notes: string | null;
  applied_at: string | null;
  deadline_at: string | null;
  next_follow_up_at: string | null;
  cv_version_id: string | null;
  cover_letter_text: string | null;
  created_at: string;
  updated_at: string;
}

interface JobEventRow {
  id: string;
  job_id: string;
  from_status: SavedJobStatus | null;
  to_status: SavedJobStatus;
  note: string | null;
  created_at: string;
}

function toJob(row: SavedJobRow): SavedJob {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    title: row.title,
    companyName: row.company_name,
    location: row.location,
    jobUrl: row.job_url,
    description: row.description,
    salaryText: row.salary_text,
    sponsorVisa: row.sponsor_visa,
    notes: row.notes,
    appliedAt: row.applied_at,
    deadlineAt: row.deadline_at,
    nextFollowUpAt: row.next_follow_up_at,
    cvVersionId: row.cv_version_id,
    coverLetterText: row.cover_letter_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: JobEventRow): JobEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    createdAt: row.created_at,
  };
}

function dbError(action: string, error: { message?: string } | null): Error {
  return Object.assign(new Error(`Failed to ${action}: ${error?.message ?? 'unknown error'}`), {
    statusCode: 500,
  });
}

/** Thrown by `createSavedJob` when the link is already on the board (AC7). */
export class JobAlreadySavedError extends Error {
  readonly statusCode = 409;
  readonly code = 'JOB_ALREADY_SAVED';
  constructor(readonly jobId: string) {
    super('This job is already in your tracker.');
  }
}

export async function listSavedJobs(userId: string): Promise<SavedJob[]> {
  const { data, error } = await getSupabase()
    .from('saved_jobs')
    .select(JOB_COLUMNS)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(MAX_JOBS_PER_USER);
  if (error) throw dbError('list jobs', error);
  return ((data ?? []) as unknown as SavedJobRow[]).map(toJob);
}

async function fetchJob(userId: string, jobId: string): Promise<SavedJob | null> {
  const { data, error } = await getSupabase()
    .from('saved_jobs')
    .select(JOB_COLUMNS)
    .eq('user_id', userId)
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw dbError('load job', error);
  return data ? toJob(data as unknown as SavedJobRow) : null;
}

export async function getSavedJob(
  userId: string,
  jobId: string,
): Promise<{ job: SavedJob; events: JobEvent[] } | null> {
  const job = await fetchJob(userId, jobId);
  if (!job) return null;
  const { data, error } = await getSupabase()
    .from('job_events')
    .select('id, job_id, from_status, to_status, note, created_at')
    .eq('user_id', userId)
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw dbError('load job events', error);
  return { job, events: ((data ?? []) as JobEventRow[]).map(toEvent) };
}

async function findByUrlKey(userId: string, urlKey: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from('saved_jobs')
    .select('id')
    .eq('user_id', userId)
    .eq('url_key', urlKey)
    .maybeSingle();
  if (error) throw dbError('check for duplicate job', error);
  return (data as { id: string } | null)?.id ?? null;
}

async function appendEvent(
  userId: string,
  jobId: string,
  fromStatus: SavedJobStatus | null,
  toStatus: SavedJobStatus,
  note: string | null,
): Promise<void> {
  const { error } = await getSupabase().from('job_events').insert({
    job_id: jobId,
    user_id: userId,
    from_status: fromStatus,
    to_status: toStatus,
    note,
  });
  if (error) throw dbError('record job event', error);
}

export async function createSavedJob(userId: string, input: ValidCreate): Promise<SavedJob> {
  const urlKey = jobUrlKey(input.jobUrl);
  if (urlKey) {
    const existing = await findByUrlKey(userId, urlKey);
    if (existing) throw new JobAlreadySavedError(existing);
  }

  const card = {
    source: input.source ?? 'manual',
    title: input.title,
    company_name: input.companyName ?? null,
    location: input.location ?? null,
    job_url: input.jobUrl ?? null,
    url_key: urlKey,
    description: input.description ?? null,
    salary_text: input.salaryText ?? null,
    sponsor_visa: input.sponsorVisa ?? null,
    deadline_at: input.deadlineAt ?? null,
    next_follow_up_at: input.nextFollowUpAt ?? null,
    notes: input.notes ?? null,
  };

  // Gamification v2: the card and its first event in one transaction (047's
  // create_saved_job), so the save is never captured without its event.
  const { data, error } = isGamificationV2Enabled()
    ? await getSupabase().rpc('create_saved_job', { p_user: userId, p_card: card }).single()
    : await getSupabase()
        .from('saved_jobs')
        .insert({ user_id: userId, ...card })
        .select(JOB_COLUMNS)
        .single();

  if (error) {
    // Two saves raced past the pre-check; the unique index caught the second.
    if (error.code === '23505' && urlKey) {
      const existing = await findByUrlKey(userId, urlKey);
      if (existing) throw new JobAlreadySavedError(existing);
    }
    throw dbError('save job', error);
  }

  const job = toJob(data as unknown as SavedJobRow);
  if (!isGamificationV2Enabled()) await appendEvent(userId, job.id, null, job.status, null);
  return job;
}

async function ownsCvVersion(userId: string, cvVersionId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from('cv_versions')
    .select('id')
    .eq('user_id', userId)
    .eq('id', cvVersionId)
    .maybeSingle();
  if (error) throw dbError('check CV', error);
  return Boolean(data);
}

export async function updateSavedJob(
  userId: string,
  jobId: string,
  patch: UpdateSavedJobRequest,
): Promise<SavedJob | null> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.companyName !== undefined) update.company_name = patch.companyName;
  if (patch.location !== undefined) update.location = patch.location;
  if (patch.jobUrl !== undefined) {
    update.job_url = patch.jobUrl;
    update.url_key = jobUrlKey(patch.jobUrl);
  }
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.salaryText !== undefined) update.salary_text = patch.salaryText;
  if (patch.sponsorVisa !== undefined) update.sponsor_visa = patch.sponsorVisa;
  if (patch.notes !== undefined) update.notes = patch.notes;
  if (patch.appliedAt !== undefined) update.applied_at = patch.appliedAt;
  if (patch.deadlineAt !== undefined) update.deadline_at = patch.deadlineAt;
  if (patch.nextFollowUpAt !== undefined) update.next_follow_up_at = patch.nextFollowUpAt;
  if (patch.cvVersionId !== undefined) {
    // The FK alone would accept another user's CV id; only link the caller's own.
    if (patch.cvVersionId !== null && !(await ownsCvVersion(userId, patch.cvVersionId))) {
      throw Object.assign(new Error('That CV is not in your CV Library.'), { statusCode: 400 });
    }
    update.cv_version_id = patch.cvVersionId;
  }
  if (patch.coverLetterText !== undefined) update.cover_letter_text = patch.coverLetterText;

  const { data, error } = await getSupabase()
    .from('saved_jobs')
    .update(update)
    .eq('user_id', userId)
    .eq('id', jobId)
    .select(JOB_COLUMNS)
    .maybeSingle();
  if (error) {
    if (error.code === '23505') {
      const key = jobUrlKey(patch.jobUrl);
      const existing = key ? await findByUrlKey(userId, key) : null;
      if (existing) throw new JobAlreadySavedError(existing);
    }
    throw dbError('update job', error);
  }
  return data ? toJob(data as unknown as SavedJobRow) : null;
}

/**
 * Move a card to a new status and log the move. Any transition is allowed —
 * people skip stages (applied → interview) and correct mistakes — so the rule is
 * "record everything", not "enforce a ladder". Moving to `applied` stamps
 * `applied_at` the first time. Re-sending the current status is a no-op.
 */
export async function changeJobStatus(
  userId: string,
  jobId: string,
  input: ChangeJobStatusRequest,
): Promise<SavedJob | null> {
  if (isGamificationV2Enabled()) return changeJobStatusV2(userId, jobId, input);

  const current = await fetchJob(userId, jobId);
  if (!current) return null;
  if (current.status === input.status) return current;

  const update: Record<string, unknown> = {
    status: input.status,
    updated_at: new Date().toISOString(),
  };
  if (input.status === 'applied' && !current.appliedAt) {
    update.applied_at = new Date().toISOString();
  }

  const { data, error } = await getSupabase()
    .from('saved_jobs')
    .update(update)
    .eq('user_id', userId)
    .eq('id', jobId)
    .select(JOB_COLUMNS)
    .maybeSingle();
  if (error) throw dbError('change job status', error);
  if (!data) return null;

  await appendEvent(userId, jobId, current.status, input.status, input.note ?? null);
  return toJob(data as unknown as SavedJobRow);
}

/**
 * The same move through 047's change_job_status: card update and event in one
 * transaction, the card row-locked so two clicks can't log two events. It
 * returns NULL for a card that isn't this user's — PostgREST may render that as
 * null or as a row of nulls, so both read as "not found".
 */
async function changeJobStatusV2(
  userId: string,
  jobId: string,
  input: ChangeJobStatusRequest,
): Promise<SavedJob | null> {
  const { data, error } = await getSupabase()
    .rpc('change_job_status', { p_user: userId, p_job: jobId, p_status: input.status, p_note: input.note ?? null })
    .maybeSingle();
  if (error) throw mapGamificationDbError(error, 'change job status');
  const row = data as SavedJobRow | null;
  return row?.id ? toJob(row) : null;
}

/** True when a row was deleted; false when there was nothing of this user's to delete. */
export async function deleteSavedJob(userId: string, jobId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from('saved_jobs')
    .delete()
    .eq('user_id', userId)
    .eq('id', jobId)
    .select('id');
  if (error) throw dbError('delete job', error);
  return (data?.length ?? 0) > 0;
}
