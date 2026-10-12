'use client'

import { useEffect, useMemo, useState } from 'react'
import { extractJobFromUrl } from '@/features/interview-prep/api/frontend-client'
import { activateCvVersion, getCvVersion, listCvVersions } from '@/features/cv-library/api/frontend-client'
import { useFakeProgress } from '@/shared/hooks/use-fake-progress'
import { ProgressBar } from '@/shared/components/progress-bar'
import Link from 'next/link'
import {
  ArrowRight,
  CheckCircle,
  AlertCircle,
  Loader2,
  Sparkles,
  FileText,
  Plus,
  X,
} from 'lucide-react'
import type { InterviewContext } from '@/features/interview-prep/types'
import { useInterview } from '@/features/interview-prep/hooks/use-interview'
import { useSavedJobs } from '@/features/job-tracking/hooks/use-job-tracking'
import { TERMINAL_SAVED_JOB_STATUSES, type SavedJob } from '@advance-academy/contracts/job-tracking'

interface CvVersionOption {
  id: string
  name: string
  isActive: boolean
  detectedField: 'tech' | 'business' | 'marketing' | null
  bulletCount: number
  openGapCount: number
}

export function SetupStep({
  context,
  updateContext,
  onNext,
  initialJobUrl,
  pickedJobId,
  linkedJobId,
  onPickJob,
}: {
  context: ReturnType<typeof useInterview>['context']
  updateContext: ReturnType<typeof useInterview>['updateContext']
  onNext: () => void
  /** A tracked job's link, when its stored JD is too thin to interview against. */
  initialJobUrl?: string | null
  pickedJobId: string
  /** The `?savedJob=` card, kept in the picker even once it's offer/rejected. */
  linkedJobId: string | null
  onPickJob: (job: SavedJob) => void
}) {
  // Same list + terminal-status filter as the Cover Letter picker.
  const { data: jobsData } = useSavedJobs()
  const savedJobs = useMemo(
    () =>
      (jobsData?.jobs ?? []).filter(
        (j) => !TERMINAL_SAVED_JOB_STATUSES.includes(j.status) || j.id === linkedJobId,
      ),
    [jobsData, linkedJobId],
  )

  const isValid =
    context.cvText.trim().length > 0 &&
    context.jobTitle.trim().length > 0 &&
    context.jobDescription.trim().length > 0 &&
    context.companyName.trim().length > 0

  // ── CV Library picker ──────────────────────────────────────────────
  const [cvVersions, setCvVersions] = useState<CvVersionOption[]>([])
  const [cvLoading, setCvLoading] = useState(true)
  const [cvError, setCvError] = useState<string | null>(null)
  const [selectedCvId, setSelectedCvId] = useState<string>('')
  const [loadingRawText, setLoadingRawText] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setCvLoading(true)
      setCvError(null)
      try {
        const res = await listCvVersions()
        if (!res.ok) throw new Error('Failed to load CVs')
        const data: CvVersionOption[] = await res.json()
        if (cancelled) return
        setCvVersions(data)
        // Default to active CV (or first one)
        const active = data.find((c) => c.isActive) ?? data[0]
        if (active && !selectedCvId) {
          setSelectedCvId(active.id)
        }
      } catch (err) {
        if (!cancelled) setCvError(err instanceof Error ? err.message : 'Failed to load CVs')
      } finally {
        if (!cancelled) setCvLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When the selected CV changes, fetch its raw text and put it into context.cvText
  // so the existing scoring/feedback path stays grounded.
  useEffect(() => {
    if (!selectedCvId) return
    let cancelled = false
    ;(async () => {
      setLoadingRawText(true)
      try {
        const res = await getCvVersion(selectedCvId)
        if (!res.ok) throw new Error('Failed to load CV')
        const data: { rawText: string } = await res.json()
        if (cancelled) return
        updateContext({ cvText: data.rawText ?? '' })
      } catch (err) {
        if (!cancelled) setCvError(err instanceof Error ? err.message : 'Failed to load CV')
      } finally {
        if (!cancelled) setLoadingRawText(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCvId])

  // Also keep the active CV in sync so the coach-answer service uses the same one.
  const handleSelectCv = async (id: string) => {
    setSelectedCvId(id)
    try {
      await activateCvVersion(id)
      setCvVersions((prev) => prev.map((c) => ({ ...c, isActive: c.id === id })))
    } catch {
      // non-fatal
    }
  }

  const [jobUrl, setJobUrl] = useState('')
  useEffect(() => {
    setJobUrl(initialJobUrl ?? '')
  }, [initialJobUrl])
  const [extractError, setExtractError] = useState<string | null>(null)
  const [extractInfo, setExtractInfo] = useState<string | null>(null)
  const {
    progress: extractProgress,
    phase: extractPhase,
    busy: extracting,
    start: startExtractProgress,
    finish: finishExtractProgress,
    reset: resetExtractProgress,
  } = useFakeProgress({
    tauMs: 8_000,
    phaseLabel: (elapsedMs) => {
      if (elapsedMs < 2_500) return 'Fetching the job posting…'
      if (elapsedMs < 10_000) return 'Extracting job details with AI…'
      return 'Finalising the structured fields…'
    },
  })

  const handleExtractFromUrl = async () => {
    const url = jobUrl.trim()
    if (!url) return
    setExtractError(null)
    setExtractInfo(null)
    startExtractProgress()
    try {
      const res = await extractJobFromUrl({ url })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || data?.message || 'Failed to extract job details')
      }
      const data: {
        jobTitle?: string
        jobDescription?: string
        companyName?: string
        companyUrl?: string
        extraLinks?: string[]
      } = await res.json()

      // Only overwrite fields that came back non-empty so user-typed data is preserved.
      const updates: Partial<InterviewContext> = {}
      if (data.jobTitle) updates.jobTitle = data.jobTitle
      if (data.jobDescription) updates.jobDescription = data.jobDescription
      if (data.companyName) updates.companyName = data.companyName
      if (data.companyUrl) updates.companyUrl = data.companyUrl
      if (data.extraLinks?.length) updates.extraLinks = data.extraLinks
      updateContext(updates)

      const filled = Object.keys(updates).length
      const missing = 5 - filled
      finishExtractProgress()
      setExtractInfo(
        missing === 0
          ? 'All fields extracted. Review and edit as needed.'
          : `Filled ${filled} of 5 fields. Please complete the remaining ${missing} manually.`,
      )
    } catch (err) {
      resetExtractProgress()
      setExtractError(err instanceof Error ? err.message : 'Failed to extract job details')
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <div className="lg:col-span-2 space-y-4">
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <label htmlFor="interview-saved-job" className="block text-sm font-semibold text-primary mb-2">
            Prepare for a job from your tracker
          </label>
          {savedJobs.length ? (
            <select
              id="interview-saved-job"
              value={pickedJobId}
              onChange={(e) => {
                const job = savedJobs.find((j) => j.id === e.target.value)
                if (job) onPickJob(job)
              }}
              className="w-full p-3 border rounded-xl text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring"
            >
              <option value="" disabled>
                — Pick a saved job —
              </option>
              {savedJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                  {j.companyName ? ` — ${j.companyName}` : ''}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-muted-foreground">
              No saved jobs yet — save one from{' '}
              <Link href="/search" className="underline">
                Job Search
              </Link>
              , or paste a job link below.
            </p>
          )}
        </div>
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <label className="block text-sm font-semibold text-primary mb-2">
            Or paste a job posting URL to auto-fill
          </label>
          <p className="text-xs text-muted-foreground mb-3">
            We use Jina Reader + AI to pull the job title, description, company name, website, and links from a LinkedIn (or similar) job page. Anything we can&apos;t find is left blank for you to fill in.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="url"
              value={jobUrl}
              onChange={(e) => setJobUrl(e.target.value)}
              placeholder="https://www.linkedin.com/jobs/view/..."
              disabled={extracting}
              className="flex-1 p-3 border rounded-xl text-sm text-foreground placeholder:text-subtle-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleExtractFromUrl}
              disabled={extracting || !jobUrl.trim()}
              className="flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {extracting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Extracting...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" /> Extract
                </>
              )}
            </button>
          </div>
          {extracting && <ProgressBar progress={extractProgress} phase={extractPhase} />}
          {extractError && (
            <p className="mt-2 text-xs text-red-600 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> {extractError}
            </p>
          )}
          {extractInfo && !extractError && (
            <p className="mt-2 text-xs text-emerald-700 flex items-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5" /> {extractInfo}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-semibold text-primary mb-2">
            CV from your library *
          </label>
          {cvLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 border rounded-xl">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading your CVs…
            </div>
          ) : cvVersions.length === 0 ? (
            <div className="p-4 border border-secondary/40 bg-secondary/10 rounded-xl text-sm">
              <p className="text-highlight-ink font-medium mb-1 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" /> No CVs in your library yet
              </p>
              <p className="text-highlight-ink text-xs mb-2">
                Upload one in the CV Library so we can ground your interview answers in real evidence.
              </p>
              <Link
                href="/cv-library"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary"
              >
                <FileText className="w-3.5 h-3.5" /> Go to CV Library →
              </Link>
            </div>
          ) : (
            <>
              <div className="relative">
                <select
                  value={selectedCvId}
                  onChange={(e) => handleSelectCv(e.target.value)}
                  disabled={loadingRawText}
                  className="w-full p-3 pr-10 border rounded-xl text-sm text-foreground bg-background focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring disabled:opacity-50 appearance-none"
                >
                  {cvVersions.map((cv) => (
                    <option key={cv.id} value={cv.id}>
                      {cv.name}
                      {cv.isActive ? ' (active)' : ''}
                      {cv.detectedField ? ` · ${cv.detectedField}` : ''}
                      {' · '}
                      {cv.bulletCount} bullets, {cv.openGapCount} gaps remaining
                    </option>
                  ))}
                </select>
                <FileText className="w-4 h-4 text-subtle-foreground absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
              <div className="flex items-center justify-between mt-1">
                <p className="text-xs text-subtle-foreground">
                  {loadingRawText
                    ? 'Loading CV…'
                    : context.cvText.length > 0
                      ? `${context.cvText.length} characters loaded`
                      : 'Select a CV to use for this interview'}
                </p>
                <Link
                  href="/cv-library"
                  className="text-xs text-primary hover:text-primary font-medium"
                >
                  Manage library →
                </Link>
              </div>
            </>
          )}
          {cvError && (
            <p className="mt-2 text-xs text-red-600 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> {cvError}
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-semibold text-primary mb-2">Job Title *</label>
          <input
            type="text"
            value={context.jobTitle}
            onChange={(e) => updateContext({ jobTitle: e.target.value })}
            placeholder="e.g., Senior Frontend Engineer"
            className="w-full p-3 border rounded-xl text-sm text-foreground placeholder:text-subtle-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring"
          />
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-semibold text-primary mb-2">Job Description *</label>
          <textarea
            value={context.jobDescription}
            onChange={(e) => updateContext({ jobDescription: e.target.value })}
            placeholder="Paste the full job description here..."
            className="w-full h-32 p-4 border rounded-xl text-sm text-foreground placeholder:text-subtle-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring resize-none"
          />
        </div>

        <div>
          <label className="block text-sm font-semibold text-primary mb-2">Company Name *</label>
          <input
            type="text"
            value={context.companyName}
            onChange={(e) => updateContext({ companyName: e.target.value })}
            placeholder="e.g., Google"
            className="w-full p-3 border rounded-xl text-sm text-foreground placeholder:text-subtle-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring"
          />
        </div>

        <div>
          <label className="block text-sm font-semibold text-primary mb-2">
            Company URL <span className="text-subtle-foreground font-normal">(optional)</span>
          </label>
          <input
            type="url"
            value={context.companyUrl}
            onChange={(e) => updateContext({ companyUrl: e.target.value })}
            placeholder="e.g., https://google.com"
            className="w-full p-3 border rounded-xl text-sm text-foreground placeholder:text-subtle-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring"
          />
        </div>

        <AdditionalLinksField
          value={context.extraLinks}
          onChange={(next) => updateContext({ extraLinks: next })}
        />

        <div>
          <label className="block text-sm font-semibold text-primary mb-2">
            Preferred questions <span className="text-subtle-foreground font-normal">(optional)</span>
          </label>
          <textarea
            rows={4}
            value={(context.questionBank ?? []).join('\n')}
            onChange={(e) =>
              updateContext({
                // One question per line. Blank lines are dropped, and an empty box
                // means "no bank" — the interviewer then behaves exactly as before.
                questionBank: e.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
            placeholder={'One question per line, e.g.\nWalk me through the payments migration you led.\nHow do you decide what not to build?'}
            className="w-full p-3 border rounded-xl text-sm text-foreground placeholder:text-subtle-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            The interviewer asks these first, rephrased in their own voice, while still
            following up on your answers. Leave empty for the usual behaviour.
          </p>
        </div>
      </div>

      <div className="lg:col-span-2 flex justify-end">
        <button
          onClick={onNext}
          disabled={!isValid}
          className="flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-xl font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Choose Interviewer <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Additional Links field — variable-length list of URLs with per-row
// validation. Backed by company_additional_url table on save (max 30).
// Validation rules mirror the backend in db.ts:sanitizeAdditionalUrls.
// ──────────────────────────────────────────────────────────────────────────

const ADDITIONAL_LINKS_MAX = 30
const ADDITIONAL_LINK_MAX_LENGTH = 2048

function validateLink(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null // empty rows are fine — they just won't be saved
  if (trimmed.length > ADDITIONAL_LINK_MAX_LENGTH) {
    return `URL is too long (max ${ADDITIONAL_LINK_MAX_LENGTH} characters)`
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return 'Not a valid URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'URL must start with http:// or https://'
  }
  return null
}

function AdditionalLinksField({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  // Always render at least one empty input so the user has somewhere to type.
  const rows = value.length > 0 ? value : ['']

  const handleChange = (idx: number, next: string) => {
    const out = [...rows]
    out[idx] = next
    onChange(out)
  }

  const handleRemove = (idx: number) => {
    const out = rows.filter((_, i) => i !== idx)
    onChange(out)
  }

  const handleAdd = () => {
    if (rows.length >= ADDITIONAL_LINKS_MAX) return
    onChange([...rows, ''])
  }

  return (
    <div>
      <label className="block text-sm font-semibold text-primary mb-2">
        Additional Links{' '}
        <span className="text-subtle-foreground font-normal">
          (optional · max {ADDITIONAL_LINKS_MAX})
        </span>
      </label>
      <div className="space-y-2">
        {rows.map((url, idx) => {
          const err = validateLink(url)
          return (
            <div key={idx}>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={url}
                  onChange={(e) => handleChange(idx, e.target.value)}
                  maxLength={ADDITIONAL_LINK_MAX_LENGTH}
                  placeholder="https://linkedin.com/in/..."
                  className={`flex-1 p-3 border rounded-xl text-sm text-foreground placeholder:text-subtle-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring ${
                    err ? 'border-red-300' : 'border-border'
                  }`}
                />
                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemove(idx)}
                    aria-label="Remove link"
                    className="px-3 py-2 text-muted-foreground hover:text-red-600 hover:bg-red-50 rounded-xl border transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              {err && (
                <p className="mt-1 text-xs text-red-600 flex items-center gap-1.5">
                  <AlertCircle className="w-3 h-3" /> {err}
                </p>
              )}
            </div>
          )
        })}
      </div>
      <button
        type="button"
        onClick={handleAdd}
        disabled={rows.length >= ADDITIONAL_LINKS_MAX}
        className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus className="w-4 h-4" /> Add link
      </button>
    </div>
  )
}
