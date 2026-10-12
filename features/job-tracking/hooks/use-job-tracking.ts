'use client'

import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  SAVED_JOB_STATUSES,
  type ChangeJobStatusRequest,
  type CreateSavedJobRequest,
  type SavedJob,
  type SavedJobStatus,
  type UpdateSavedJobRequest,
} from '@advance-academy/contracts/job-tracking'
import {
  changeSavedJobStatus,
  createSavedJob,
  deleteSavedJob,
  getSavedJob,
  listSavedJobs,
  updateSavedJob,
} from '../api/frontend-client'

const LIST_KEY = ['saved-jobs'] as const
const detailKey = (id: string) => ['saved-job', id] as const

export function useSavedJobs() {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: listSavedJobs,
    retry: false,
  })
}

export function useSavedJob(id: string | null) {
  return useQuery({
    queryKey: detailKey(id ?? ''),
    queryFn: () => getSavedJob(id!),
    enabled: Boolean(id),
    retry: false,
  })
}

/** Every write invalidates the board; detail views refetch their own card. */
function useJobMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>, jobId?: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LIST_KEY })
      if (jobId) queryClient.invalidateQueries({ queryKey: detailKey(jobId) })
      // A save or a status change may have earned something (gamification v2).
      queryClient.invalidateQueries({ queryKey: ['gamification'] })
    },
    retry: false,
  })
}

export function useCreateSavedJob() {
  return useJobMutation((body: CreateSavedJobRequest) => createSavedJob(body))
}

export function useUpdateSavedJob(jobId: string) {
  return useJobMutation((body: UpdateSavedJobRequest) => updateSavedJob(jobId, body), jobId)
}

export function useChangeSavedJobStatus(jobId: string) {
  return useJobMutation((body: ChangeJobStatusRequest) => changeSavedJobStatus(jobId, body), jobId)
}

export function useDeleteSavedJob() {
  return useJobMutation((id: string) => deleteSavedJob(id))
}

/** Local calendar day as `YYYY-MM-DD` — matches how the backend stores follow-up/deadline dates. */
export function todayLocalDay(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export interface JobBoardSummary {
  /** Cards per status, every status present (zero when empty). */
  counts: Record<SavedJobStatus, number>
  /** Cards whose follow-up day is today or already past, oldest first. Terminal cards excluded. */
  followUpsDue: SavedJob[]
  byStatus: Record<SavedJobStatus, SavedJob[]>
}

/**
 * Derived board data. Computed on the client from the one list query so the
 * dashboard needs no second endpoint, and "today" is the user's own day rather
 * than the server's.
 */
export function useJobBoardSummary(jobs: SavedJob[] | undefined): JobBoardSummary {
  return useMemo(() => {
    const counts = Object.fromEntries(SAVED_JOB_STATUSES.map((s) => [s, 0])) as Record<SavedJobStatus, number>
    const byStatus = Object.fromEntries(
      SAVED_JOB_STATUSES.map((s) => [s, [] as SavedJob[]]),
    ) as Record<SavedJobStatus, SavedJob[]>
    const today = todayLocalDay()
    const followUpsDue: SavedJob[] = []

    for (const job of jobs ?? []) {
      counts[job.status] += 1
      byStatus[job.status].push(job)
      const open = job.status !== 'offer' && job.status !== 'rejected'
      if (open && job.nextFollowUpAt && job.nextFollowUpAt <= today) followUpsDue.push(job)
    }
    followUpsDue.sort((a, b) => (a.nextFollowUpAt ?? '').localeCompare(b.nextFollowUpAt ?? ''))

    return { counts, followUpsDue, byStatus }
  }, [jobs])
}
