'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Plus } from 'lucide-react'
import {
  SAVED_JOB_STATUSES,
  SAVED_JOB_STATUS_LABELS,
  isJobSource,
  type JobSource,
  type SavedJob,
  type SavedJobStatus,
} from '@advance-academy/contracts/job-tracking'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { todayLocalDay, useJobBoardSummary, useSavedJobs } from '../hooks/use-job-tracking'
import { JobCard } from './job-card'
import { JobFormDialog, type JobFormPrefill } from './job-form-dialog'
import { STATUS_TONE } from './job-status-badge'
import { JobsProgressStrip } from '@/features/gamification/components/progress-panel'

type Filter = 'all' | 'open' | SavedJobStatus

/**
 * Deep-link contract for Career Hub and anything else that wants to hand a job
 * over: `/jobs?add=<url>&title=…&company=…&location=…&salary=…&source=career_hub`.
 * Opens the add form pre-filled; nothing is saved until the user confirms.
 * An unauthenticated visitor goes through /login first and comes back here
 * (middleware passes `next`).
 */
function prefillFromSearch(params: URLSearchParams | null): JobFormPrefill | null {
  if (!params) return null
  const add = params.get('add')
  const title = params.get('title')
  if (!add && !title) return null
  return {
    jobUrl: add ?? undefined,
    title: title ?? undefined,
    companyName: params.get('company') ?? undefined,
    location: params.get('location') ?? undefined,
    salaryText: params.get('salary') ?? undefined,
    source: isJobSource(params.get('source')) ? (params.get('source') as JobSource) : undefined,
  }
}

export function JobTrackingScreen() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { data, isLoading, error } = useSavedJobs()
  const jobs = data?.jobs
  const summary = useJobBoardSummary(jobs)

  const [filter, setFilter] = useState<Filter>('open')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<SavedJob | undefined>(undefined)
  const [prefill, setPrefill] = useState<JobFormPrefill | undefined>(undefined)

  // Consume the ?add= deep link once, then clean the URL so a refresh doesn't
  // reopen the dialog.
  useEffect(() => {
    const p = prefillFromSearch(searchParams)
    if (!p) return
    setPrefill(p)
    setEditing(undefined)
    setFormOpen(true)
    router.replace('/jobs')
  }, [searchParams, router])

  const visible = useMemo(() => {
    if (!jobs) return []
    if (filter === 'all') return jobs
    if (filter === 'open') return jobs.filter((j) => j.status !== 'offer' && j.status !== 'rejected')
    return summary.byStatus[filter]
  }, [jobs, filter, summary])

  const openAdd = () => {
    setEditing(undefined)
    setPrefill(undefined)
    setFormOpen(true)
  }
  const openEdit = (job: SavedJob) => {
    setEditing(job)
    setPrefill(undefined)
    setFormOpen(true)
  }

  const total = jobs?.length ?? 0
  const openCount = total - summary.counts.offer - summary.counts.rejected

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My jobs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every role you are chasing, in one place. Save from Job Search or Dream Company, or add a link by hand,
            then move each card as things progress.
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus className="h-4 w-4" />
          Add job
        </Button>
      </header>

      <JobsProgressStrip />

      {/* Counts per stage. Each tile is also a filter. */}
      <section aria-label="Jobs by status" className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {SAVED_JOB_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(filter === s ? 'open' : s)}
            aria-pressed={filter === s}
            className={`rounded-lg border px-3 py-2 text-left transition-colors ${STATUS_TONE[s]} ${
              filter === s ? 'ring-2 ring-primary/20 ring-offset-1' : 'hover:brightness-95'
            }`}
          >
            <p className="text-xs font-medium">{SAVED_JOB_STATUS_LABELS[s]}</p>
            <p className="text-xl font-semibold tabular-nums">{isLoading ? '–' : summary.counts[s]}</p>
          </button>
        ))}
      </section>

      {summary.followUpsDue.length > 0 ? (
        <section className="mb-6 rounded-lg border border-orange-200 bg-orange-50 p-4">
          <h2 className="text-sm font-semibold text-orange-900">
            Follow up today ({summary.followUpsDue.length})
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-orange-900">
            {summary.followUpsDue.map((j) => (
              <li key={j.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{j.title}</span>
                {j.companyName ? <span className="text-orange-800/80">{j.companyName}</span> : null}
                <span className="text-xs text-orange-800/70">
                  {j.nextFollowUpAt && j.nextFollowUpAt < todayLocalDay()
                    ? `overdue since ${j.nextFollowUpAt}`
                    : 'due today'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-1 border-b">
        {(
          [
            ['open', `Open (${openCount})`],
            ['all', `All (${total})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            aria-current={filter === id ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              filter === id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
        {filter !== 'open' && filter !== 'all' ? (
          <span className="-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium text-primary">
            {SAVED_JOB_STATUS_LABELS[filter]} ({summary.counts[filter]})
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Could not load your jobs: {(error as Error).message}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {total === 0
              ? 'Nothing tracked yet. Add a job by hand, or hit Save on a role in Dream Company.'
              : 'No jobs in this view.'}
          </p>
          {total === 0 ? (
            <Button className="mt-4" onClick={openAdd}>
              <Plus className="h-4 w-4" />
              Add your first job
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((job) => (
            <JobCard key={job.id} job={job} onEdit={openEdit} />
          ))}
        </div>
      )}

      <JobFormDialog open={formOpen} onOpenChange={setFormOpen} job={editing} prefill={prefill} />
    </main>
  )
}
