/**
 * Individual Job Tracking (AI Job Tools 1.3, migration 023).
 *
 * One `SavedJob` is one card. Cards move through `SavedJobStatus` values and every
 * move is appended to `job_events`. These types are shared by the Fastify
 * service, the Next.js proxy and the React feature, so the status list here is
 * the single copy — keep it in sync with the CHECK constraint in
 * `supabase/migrations/023_saved_jobs.sql`.
 */

export const SAVED_JOB_STATUSES = [
  'saved',
  'preparing',
  'applied',
  'follow_up',
  'interview',
  'offer',
  'rejected',
] as const

export type SavedJobStatus = (typeof SAVED_JOB_STATUSES)[number]

/** Cards in these statuses are finished; the dashboard folds them away. */
export const TERMINAL_SAVED_JOB_STATUSES: readonly SavedJobStatus[] = ['offer', 'rejected']

export const SAVED_JOB_STATUS_LABELS: Record<SavedJobStatus, string> = {
  saved: 'Saved',
  preparing: 'Preparing',
  applied: 'Applied',
  follow_up: 'Follow-up',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
}

export const JOB_SOURCES = ['manual', 'dream_company', 'career_hub'] as const
export type JobSource = (typeof JOB_SOURCES)[number]

export function isSavedJobStatus(value: unknown): value is SavedJobStatus {
  return typeof value === 'string' && (SAVED_JOB_STATUSES as readonly string[]).includes(value)
}

export function isJobSource(value: unknown): value is JobSource {
  return typeof value === 'string' && (JOB_SOURCES as readonly string[]).includes(value)
}

/** A tracked job as the UI renders it. Dates are ISO strings; `*At` dates that are calendar days are `YYYY-MM-DD`. */
export interface SavedJob {
  id: string
  status: SavedJobStatus
  source: JobSource
  title: string
  companyName: string | null
  location: string | null
  jobUrl: string | null
  description: string | null
  salaryText: string | null
  sponsorVisa: boolean | null
  notes: string | null
  /** Instant the user marked it applied. */
  appliedAt: string | null
  /** Calendar day, `YYYY-MM-DD`. */
  deadlineAt: string | null
  /** Calendar day, `YYYY-MM-DD`. */
  nextFollowUpAt: string | null
  /** The CV Library version used for this application (Cover Letter / Assisted Apply write it). */
  cvVersionId: string | null
  /** The cover letter used for this application. */
  coverLetterText: string | null
  createdAt: string
  updatedAt: string
}

export interface JobEvent {
  id: string
  jobId: string
  /** Null on the creation event. */
  fromStatus: SavedJobStatus | null
  toStatus: SavedJobStatus
  note: string | null
  createdAt: string
}

/** POST /api/job-tracking */
export interface CreateSavedJobRequest {
  title: string
  companyName?: string | null
  location?: string | null
  jobUrl?: string | null
  description?: string | null
  salaryText?: string | null
  sponsorVisa?: boolean | null
  deadlineAt?: string | null
  nextFollowUpAt?: string | null
  notes?: string | null
  source?: JobSource
}

/** PATCH /api/job-tracking/:id — every field optional; omitted fields are untouched. */
export interface UpdateSavedJobRequest {
  title?: string
  companyName?: string | null
  location?: string | null
  jobUrl?: string | null
  description?: string | null
  salaryText?: string | null
  sponsorVisa?: boolean | null
  notes?: string | null
  appliedAt?: string | null
  deadlineAt?: string | null
  nextFollowUpAt?: string | null
  cvVersionId?: string | null
  coverLetterText?: string | null
}

/** POST /api/job-tracking/:id/status */
export interface ChangeJobStatusRequest {
  status: SavedJobStatus
  note?: string | null
}

export interface SavedJobListResponse {
  jobs: SavedJob[]
}

export interface SavedJobResponse {
  job: SavedJob
}

export interface SavedJobDetailResponse {
  job: SavedJob
  events: JobEvent[]
}
