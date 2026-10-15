'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Check, Copy, FileSignature } from 'lucide-react'
import { TERMINAL_SAVED_JOB_STATUSES } from '@advance-academy/contracts/job-tracking'
import { isCoverLetterJdErrorCode, type GenerateCoverLetterRequest } from '@advance-academy/contracts/cover-letter'
import { HttpClientError } from '@/shared/api/http-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useFakeProgress } from '@/shared/hooks/use-fake-progress'
import { ProgressBar } from '@/shared/components/progress-bar'
import { CvPicker } from '@/features/cv-library/components/cv-picker'
import { useSavedJobs } from '@/features/job-tracking/hooks/use-job-tracking'
import { useGenerateCoverLetter } from '../hooks/use-cover-letter'
import { JdRecovery } from './jd-recovery'

type JobMode = 'saved' | 'paste'

const PHASES: Array<[number, string]> = [
  [0, 'Reading the job…'],
  [6000, 'Matching your CV to the requirements…'],
  [14000, 'Writing your letter…'],
]

/** Codes after which the fix is "paste the job description": focus (or reveal) that box. */
function wantsPastedJd(code: string | undefined): boolean {
  return isCoverLetterJdErrorCode(code) || code === 'COVER_LETTER_TIMEOUT' || code === 'TIMEOUT'
}

const SLOW_MESSAGE =
  'This took too long, usually because the job page was slow to load. Paste the job description into the Job description box and try again.'

function phaseLabel(ms: number): string {
  let label = PHASES[0][1]
  for (const [at, text] of PHASES) if (ms >= at) label = text
  return label
}

/**
 * Cover Letter Generator. Two ways in, both deep-linkable:
 *   /cover-letter?savedJob=<id>[&cv=<id>]        — from a tracker card / Prepare application
 *   /cover-letter?url=<link>&title=…&company=…   — from a Career Hub job row
 * The letter is for copying; nothing is sent from here.
 */
export function CoverLetterScreen() {
  const params = useSearchParams()
  const { data: jobsData, isLoading: jobsLoading } = useSavedJobs()
  const generate = useGenerateCoverLetter()

  // `?cv=` comes from Prepare application: write from the CV already linked to the job.
  const [cvVersionId, setCvVersionId] = useState(params?.get('cv') ?? '')
  const [mode, setMode] = useState<JobMode>(params?.get('url') || params?.get('title') ? 'paste' : 'saved')
  const [savedJobId, setSavedJobId] = useState(params?.get('savedJob') ?? '')
  const [jobTitle, setJobTitle] = useState(params?.get('title') ?? '')
  const [companyName, setCompanyName] = useState(params?.get('company') ?? '')
  const [jobUrl, setJobUrl] = useState(params?.get('url') ?? '')
  const [jobDescription, setJobDescription] = useState('')
  // A tracked job whose link can't be read: the student pastes its description here.
  const [savedJobDescription, setSavedJobDescription] = useState('')
  // Set when the JD couldn't be read: the backend's reason, shown in the recovery panel.
  const [jdProblem, setJdProblem] = useState<string | null>(null)
  const needsJd = jdProblem !== null
  const jdBoxRef = useRef<HTMLTextAreaElement>(null)
  const [letter, setLetter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const { progress, phase, busy, start, finish, reset } = useFakeProgress({ tauMs: 10000, phaseLabel })

  // Open cards only (a letter for a job already offered or rejected is rare),
  // plus the deep-linked card whatever its status, so the select can show it.
  const linkedJobId = params?.get('savedJob')
  const savedJobs = useMemo(() => {
    const all = jobsData?.jobs ?? []
    return all.filter((j) => !TERMINAL_SAVED_JOB_STATUSES.includes(j.status) || j.id === linkedJobId)
  }, [jobsData, linkedJobId])

  // No tracked jobs and no deep link → the saved-job picker would be empty.
  useEffect(() => {
    if (!jobsLoading && savedJobs.length === 0 && !params?.get('savedJob')) setMode('paste')
  }, [jobsLoading, savedJobs.length, params])

  useEffect(() => {
    if (mode === 'saved' && !savedJobId && savedJobs[0]) setSavedJobId(savedJobs[0].id)
  }, [mode, savedJobId, savedJobs])

  const canSubmit =
    Boolean(cvVersionId) &&
    (mode === 'saved' ? Boolean(savedJobId) : Boolean(jobTitle.trim() && (jobUrl.trim() || jobDescription.trim())))

  // After a JD error, put the cursor where the fix goes.
  useEffect(() => {
    if (jdProblem) jdBoxRef.current?.focus()
  }, [jdProblem, mode])

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || busy) return
    setError(null)
    setCopied(false)
    const body: GenerateCoverLetterRequest =
      mode === 'saved'
        ? { cvVersionId, savedJobId, jobDescription: savedJobDescription.trim() || undefined }
        : {
            cvVersionId,
            jobTitle: jobTitle.trim(),
            companyName: companyName.trim() || undefined,
            jobUrl: jobUrl.trim() || undefined,
            jobDescription: jobDescription.trim() || undefined,
          }
    start()
    try {
      const res = await generate.mutateAsync(body)
      finish()
      setJdProblem(null)
      setLetter(res.coverLetter)
    } catch (err) {
      reset()
      const code = err instanceof HttpClientError ? err.payload.code : undefined
      setError(code === 'TIMEOUT' ? SLOW_MESSAGE : err instanceof Error ? err.message : 'Could not write the cover letter.')
      if (wantsPastedJd(code)) {
        // The recovery panel replaces the plain error; every input stays as it is.
        setJdProblem(code === 'TIMEOUT' ? SLOW_MESSAGE : err instanceof Error ? err.message : SLOW_MESSAGE)
        setError(null)
      } else {
        setJdProblem(null)
      }
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(letter)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Copy failed — select the text and copy it by hand.')
    }
  }

  const savedTo = generate.data?.savedJobId
  const selectedJob = mode === 'saved' ? savedJobs.find((j) => j.id === savedJobId) ?? null : null

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <FileSignature className="h-6 w-6 text-primary" />
          Cover Letter
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a CV and a job. You get a letter tailored to that job, written only from what is on your CV — copy it
          into your email or application form.
        </p>
      </header>

      <form onSubmit={handleGenerate} className="space-y-6 rounded-lg border bg-background p-4 sm:p-6">
        <div className="space-y-1.5">
          <Label htmlFor="cl-cv">Your CV</Label>
          <CvPicker id="cl-cv" value={cvVersionId} onChange={setCvVersionId} />
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">The job</legend>
          <div className="inline-flex rounded-md border p-0.5 text-sm" role="radiogroup" aria-label="Job source">
            {(['saved', 'paste'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={`rounded px-3 py-1.5 ${mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-primary'}`}
              >
                {m === 'saved' ? 'From my tracker' : 'Paste a job'}
              </button>
            ))}
          </div>

          {jdProblem ? (
            <JdRecovery
              message={jdProblem}
              jobUrl={mode === 'saved' ? selectedJob?.jobUrl ?? null : jobUrl}
              card={selectedJob ? { id: selectedJob.id, title: selectedJob.title, companyName: selectedJob.companyName } : null}
              pastedChars={(mode === 'saved' ? savedJobDescription : jobDescription).trim().length}
            />
          ) : null}
          {mode === 'saved' ? (
            savedJobs.length ? (
              <div className="space-y-3">
                <select
                  aria-label="Saved job"
                  value={savedJobId}
                  onChange={(e) => {
                    setSavedJobId(e.target.value)
                    setSavedJobDescription('')
                    setJdProblem(null)
                  }}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {savedJobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.title}
                      {j.companyName ? ` — ${j.companyName}` : ''}
                    </option>
                  ))}
                </select>
                {needsJd || savedJobDescription ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="cl-saved-jd">Job description</Label>
                    <Textarea
                      id="cl-saved-jd"
                      ref={jdBoxRef}
                      rows={6}
                      value={savedJobDescription}
                      onChange={(e) => setSavedJobDescription(e.target.value)}
                      maxLength={20000}
                      placeholder="Paste the job's full description: responsibilities and requirements."
                    />
                    <p className="text-xs text-muted-foreground">It is saved on this job, so other tools can use it too.</p>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {jobsLoading ? 'Loading your jobs…' : 'No saved jobs yet — paste one instead, or save one from '}
                {jobsLoading ? null : (
                  <Link href="/search" className="text-primary underline">
                    Job Search
                  </Link>
                )}
                {jobsLoading ? null : '.'}
              </p>
            )
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="cl-title">Job title *</Label>
                  <Input id="cl-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} maxLength={200} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cl-company">Company</Label>
                  <Input
                    id="cl-company"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    maxLength={200}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cl-url">Job link</Label>
                <Input
                  id="cl-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://…"
                  value={jobUrl}
                  onChange={(e) => setJobUrl(e.target.value)}
                  maxLength={2000}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cl-jd">Job description</Label>
                <Textarea
                  id="cl-jd"
                  ref={jdBoxRef}
                  rows={6}
                  value={jobDescription}
                  onChange={(e) => setJobDescription(e.target.value)}
                  maxLength={20000}
                  placeholder="Paste the description, or leave it empty and we read it from the link."
                />
              </div>
            </div>
          )}
        </fieldset>

        {error ? (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div>
          <Button type="submit" disabled={!canSubmit || busy}>
            {busy ? 'Writing…' : letter ? 'Write it again' : 'Write my cover letter'}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">Uses 1 credit.</p>
          {busy ? <ProgressBar progress={progress} phase={phase} /> : null}
        </div>
      </form>

      {letter ? (
        <section className="mt-6 space-y-3" aria-label="Your cover letter">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Your letter</h2>
            <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {generate.data?.notice ? (
            <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {generate.data.notice}
            </p>
          ) : null}
          <Textarea
            aria-label="Cover letter text"
            value={letter}
            onChange={(e) => setLetter(e.target.value)}
            rows={20}
            className="font-serif leading-relaxed"
          />
          <p className="text-xs text-muted-foreground">
            Read it through and make it sound like you before sending.
            {savedTo ? (
              <>
                {' '}
                Saved to{' '}
                <Link href={`/jobs/${savedTo}/apply`} className="text-primary underline">
                  this job in your tracker
                </Link>
                .
              </>
            ) : null}
          </p>
        </section>
      ) : null}
    </main>
  )
}
