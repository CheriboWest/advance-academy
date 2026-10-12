'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CheckCircle2, Circle, ExternalLink } from 'lucide-react'
import type { SavedJob } from '@advance-academy/contracts/job-tracking'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { extractJobFromUrl } from '@/features/interview-prep/api/frontend-client'
import { CvPicker } from '@/features/cv-library/components/cv-picker'
import {
  todayLocalDay,
  useChangeSavedJobStatus,
  useSavedJob,
  useUpdateSavedJob,
} from '../hooks/use-job-tracking'
import { JobStatusBadge } from './job-status-badge'

/** Below this the JD is a title and a wish — same bar the Cover Letter tool uses. */
const JD_READY_CHARS = 400
const MAX_STORED_JD = 5000
const APPLIED_OR_LATER = new Set(['applied', 'follow_up', 'interview', 'offer', 'rejected'])

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number
  title: string
  done: boolean
  children: React.ReactNode
}) {
  return (
    <li className="rounded-lg border bg-background p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        {done ? (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-green-700" aria-label="Done" />
        ) : (
          <Circle className="h-5 w-5 shrink-0 text-muted-foreground" aria-label="To do" />
        )}
        <span className="text-muted-foreground tabular-nums">{n}.</span> {title}
      </h2>
      <div className="mt-3 space-y-3 pl-7 text-sm">{children}</div>
    </li>
  )
}

function inDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return todayLocalDay(d)
}

/** Step 1: make sure the card holds a real job description (Validate + quality check). */
function JobCheck({ job }: { job: SavedJob }) {
  const update = useUpdateSavedJob(job.id)
  const [pasted, setPasted] = useState('')
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const jdChars = job.description?.trim().length ?? 0
  const deadlinePassed = Boolean(job.deadlineAt && job.deadlineAt < todayLocalDay())

  // Reuses Interview Prep's extractor (the posting is read via Jina, never
  // fetched from our own server), then stores the JD on the card.
  const fetchJd = async () => {
    if (!job.jobUrl) return
    setFetching(true)
    setError(null)
    try {
      const res = await extractJobFromUrl({ url: job.jobUrl })
      const data = (await res.json().catch(() => ({}))) as { jobDescription?: string; message?: string }
      if (!res.ok) throw new Error(data.message ?? 'Could not read that link.')
      const jd = data.jobDescription?.trim() ?? ''
      if (jd.length <= jdChars) throw new Error("The link didn't have a fuller description. Paste it below instead.")
      await update.mutateAsync({ description: jd.slice(0, MAX_STORED_JD) })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that link.')
    } finally {
      setFetching(false)
    }
  }

  const savePasted = async () => {
    setError(null)
    try {
      await update.mutateAsync({ description: pasted.trim().slice(0, MAX_STORED_JD) })
      setPasted('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the description.')
    }
  }

  return (
    <>
      {jdChars >= JD_READY_CHARS ? (
        <details>
          <summary className="cursor-pointer text-green-800">Job description saved on this card</summary>
          <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-muted-foreground">{job.description}</p>
        </details>
      ) : (
        <>
          <p className="text-muted-foreground">
            {jdChars
              ? 'This card only has a short snippet of the job. The tools below need the full description.'
              : 'This card has no job description yet. The tools below need it.'}
          </p>
          {job.jobUrl ? (
            <Button variant="outline" size="sm" onClick={fetchJd} disabled={fetching}>
              {fetching ? 'Reading the posting…' : 'Read it from the job link'}
            </Button>
          ) : null}
          <Textarea
            rows={4}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            maxLength={20000}
            placeholder="…or paste the job description here"
            aria-label="Job description"
          />
          {pasted.trim() ? (
            <Button size="sm" onClick={savePasted} disabled={update.isPending}>
              Save description
            </Button>
          ) : null}
        </>
      )}
      {!job.jobUrl ? (
        <p className="text-orange-800">No application link on this card — add one with Edit on the tracker.</p>
      ) : null}
      {deadlinePassed ? <p className="text-orange-800">The deadline on this card has passed.</p> : null}
      {error ? <p className="text-red-700">{error}</p> : null}
    </>
  )
}

/** Step 5: open the posting, then ask on return — the only honest "auto" mark we can make. */
function ApplyStep({ job }: { job: SavedJob }) {
  const changeStatus = useChangeSavedJobStatus(job.id)
  const update = useUpdateSavedJob(job.id)
  const [awaiting, setAwaiting] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The student submits on the employer's site, which can't tell us. So when
  // they come back to this tab after opening it, ask.
  useEffect(() => {
    if (!awaiting) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') setAsking(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [awaiting])

  const open = () => {
    if (!job.jobUrl) return
    window.open(job.jobUrl, '_blank', 'noopener,noreferrer')
    setAwaiting(true)
  }

  const markApplied = async () => {
    setError(null)
    try {
      await changeStatus.mutateAsync({ status: 'applied', note: 'Applied via Prepare application' })
      if (!job.nextFollowUpAt) await update.mutateAsync({ nextFollowUpAt: inDays(7) })
      setAsking(false)
      setAwaiting(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the card.')
    }
  }

  if (APPLIED_OR_LATER.has(job.status)) {
    return (
      <p className="text-green-800">
        Applied{job.appliedAt ? ` on ${new Date(job.appliedAt).toLocaleDateString()}` : ''}.
        {job.nextFollowUpAt ? ` Follow-up reminder set for ${job.nextFollowUpAt}.` : ''}
      </p>
    )
  }

  return (
    <>
      <p className="text-muted-foreground">
        Submit on the employer&rsquo;s site. When you come back here we&rsquo;ll ask whether it went in, and mark the
        card applied with a follow-up reminder a week later.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={open} disabled={!job.jobUrl}>
          <ExternalLink className="h-3.5 w-3.5" />
          Open the application
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>
          I&rsquo;ve already applied
        </Button>
      </div>
      {asking ? (
        <div role="dialog" aria-label="Did you apply?" className="rounded-md border border-primary/20 bg-primary/5 p-3">
          <p className="font-medium text-primary">Did you submit your application?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={markApplied} disabled={changeStatus.isPending}>
              Yes, mark it applied
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAsking(false)}>
              Not yet
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-red-700">{error}</p> : null}
    </>
  )
}

/**
 * Assisted Apply for one tracked job: check the JD → pick the CV → tailor it and
 * see the match score (CV Optimizer) → cover letter → open the application →
 * mark applied. Every step reuses an existing tool; this page only strings them
 * together and remembers what was used on the card.
 */
export function ApplyWizard({ jobId }: { jobId: string }) {
  const { data, isLoading, error } = useSavedJob(jobId)
  const update = useUpdateSavedJob(jobId)

  if (isLoading) return <Skeleton className="mx-auto mt-8 h-96 max-w-3xl" />
  if (error || !data) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <p className="text-sm text-muted-foreground">
          That job isn&rsquo;t in your tracker.{' '}
          <Link href="/jobs" className="text-primary underline">
            Back to your jobs
          </Link>
        </p>
      </main>
    )
  }

  const { job } = data
  const jdReady = (job.description?.trim().length ?? 0) >= JD_READY_CHARS
  const letterHref = `/cover-letter?savedJob=${job.id}${job.cvVersionId ? `&cv=${job.cvVersionId}` : ''}`

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <Link href="/jobs" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary">
        <ArrowLeft className="h-4 w-4" />
        Back to your jobs
      </Link>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Prepare application</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{job.title}</span>
          {job.companyName ? <span>· {job.companyName}</span> : null}
          <JobStatusBadge status={job.status} />
        </p>
      </header>

      <ol className="space-y-3">
        <Step n={1} title="Check the job" done={jdReady}>
          <JobCheck job={job} />
        </Step>

        <Step n={2} title="Pick the CV you'll send" done={Boolean(job.cvVersionId)}>
          <CvPicker
            value={job.cvVersionId ?? ''}
            onChange={(cvVersionId) => {
              if (cvVersionId !== job.cvVersionId) update.mutate({ cvVersionId })
            }}
          />
        </Step>

        <Step n={3} title="Tailor your CV and check your match score (recommended)" done={false}>
          <p className="text-muted-foreground">
            CV Optimizer scores your CV against this job (ATS match, keywords, bullet impact) and suggests rewrites. The
            CV you analyse there becomes the CV used for this job.
          </p>
          <Button size="sm" variant="outline" asChild>
            <Link href={`/cv-optimizer?savedJob=${job.id}`}>Open CV Optimizer for this job</Link>
          </Button>
        </Step>

        <Step n={4} title="Write the cover letter" done={Boolean(job.coverLetterText)}>
          {job.coverLetterText ? (
            <details>
              <summary className="cursor-pointer text-green-800">Cover letter saved on this card</summary>
              <p className="mt-2 whitespace-pre-wrap font-serif leading-relaxed">{job.coverLetterText}</p>
            </details>
          ) : (
            <p className="text-muted-foreground">A letter for this job, written from the CV above.</p>
          )}
          <Button size="sm" variant="outline" asChild>
            <Link href={letterHref}>{job.coverLetterText ? 'Write it again' : 'Write the cover letter'}</Link>
          </Button>
        </Step>

        <Step n={5} title="Apply" done={APPLIED_OR_LATER.has(job.status)}>
          <ApplyStep job={job} />
        </Step>
      </ol>
    </main>
  )
}
