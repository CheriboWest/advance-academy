'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader, Target } from 'lucide-react'
import type { AnalyzeCvRequest } from '@advance-academy/contracts'
import { type CvOptimizerTab, useCvOptimizer } from '@/features/cv-optimizer/hooks/use-cv-analysis'
import { generateRewrittenCv, parseFileForCvOptimizer } from '@/features/cv-optimizer/api/frontend-client'
import { getSavedJob } from '@/features/job-tracking/api/frontend-client'
import { BulletsTab } from '@/features/cv-optimizer/components/bullets-tab'
import { FileUploadZone } from '@/features/cv-optimizer/components/file-upload-zone'
import {
  ActionPlanTab,
  AtsIntelligenceTab,
  CvOverviewTab,
  ScoreBar,
} from '@/features/cv-optimizer/components/results-tabs'
import { RewriteTab } from '@/features/cv-optimizer/components/rewrite-tab'
import { scoreBg, scoreColor } from '@/features/cv-optimizer/components/score-style'

// ─── Constants ────────────────────────────────────────────────────────────────

const INITIAL_FORM: AnalyzeCvRequest = {
  targetRole: '',
  currentCvText: '',
  jobDescription: '',
}

const TABS: { id: CvOptimizerTab; label: string; weight?: string }[] = [
  { id: 'overview', label: 'CV Overview', weight: '25%' },
  { id: 'ats', label: 'ATS Compatibility', weight: '40%' },
  { id: 'bullets', label: 'Bullet Impact', weight: '35%' },
  { id: 'rewrite', label: 'Rewrite Suggestions' },
  { id: 'action-plan', label: 'Action Plan' },
]

const ANALYZING_STEPS = [
  'Parsing your CV...',
  'Extracting job requirements...',
  'Running ATS & keyword analysis...',
  'Scoring every experience bullet...',
  'Generating rewrite suggestions...',
  'Building your action plan...',
]

function AnalyzingPanel({ status }: { status: 'submitting' | 'running' }) {
  const [stepIndex, setStepIndex] = useState(0)

  // Rotate through the steps every 3s so the user sees movement while the
  // async job is running in the background.
  useRefInterval(() => {
    setStepIndex((i) => (i + 1) % ANALYZING_STEPS.length)
  }, 3000)

  return (
    <div className="bg-primary rounded-2xl p-12 text-center text-primary-foreground">
      <div className="flex justify-center mb-6">
        <div className="relative">
          <div className="w-20 h-20 rounded-full border-4 border-primary border-t-secondary animate-spin" />
          <Target className="w-8 h-8 text-highlight-ink absolute inset-0 m-auto" />
        </div>
      </div>
      <h2 className="text-2xl font-serif font-semibold mb-2">
        {status === 'submitting' ? 'Sending your CV...' : 'Analyzing your CV'}
      </h2>
      <p className="text-primary-foreground/70 text-base mb-6 max-w-md mx-auto">
        Our AI is running a full recruitment-grade analysis. This usually takes 20–40 seconds — hang tight.
      </p>
      <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-sm text-primary-foreground/80">
        <Loader className="w-4 h-4 animate-spin text-highlight-ink" />
        <span className="transition-opacity duration-300">{ANALYZING_STEPS[stepIndex]}</span>
      </div>
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-primary-foreground/70 max-w-xl mx-auto">
        <div className="rounded-lg bg-primary/50 px-3 py-2"><strong className="text-highlight-ink">CV Overview</strong><br />Section-by-section scoring</div>
        <div className="rounded-lg bg-primary/50 px-3 py-2"><strong className="text-highlight-ink">ATS Intelligence</strong><br />Keyword & requirement match</div>
        <div className="rounded-lg bg-primary/50 px-3 py-2"><strong className="text-highlight-ink">Action Plan</strong><br />What to do next</div>
      </div>
    </div>
  )
}

// Lightweight setInterval wrapper that cleans itself up on unmount.
function useRefInterval(callback: () => void, delay: number) {
  const savedCallback = useRef(callback)
  savedCallback.current = callback
  useEffect(() => {
    const id = window.setInterval(() => savedCallback.current(), delay)
    return () => window.clearInterval(id)
  }, [delay])
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function CvOptimizerScreen() {
  const [form, setForm] = useState<AnalyzeCvRequest>(INITIAL_FORM)
  const [cvFile, setCvFile] = useState<File | null>(null)
  const [cvFileName, setCvFileName] = useState<string | null>(null)
  const [jdFileName, setJdFileName] = useState<string | null>(null)
  const [cvParsing, setCvParsing] = useState(false)
  const [jdParsing, setJdParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [downloadingRewrite, setDownloadingRewrite] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null)
  const [tailoringFor, setTailoringFor] = useState<string | null>(null)

  // Assisted Apply hands a tracked job over as `?savedJob=<id>`: pre-fill the
  // role and JD, and send the id so the analysed CV is linked onto that card.
  // Read from window.location, not useSearchParams, so /cv-optimizer needs no
  // Suspense boundary.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('savedJob')
    if (!id) return
    getSavedJob(id)
      .then(({ job }) => {
        setForm((f) => ({
          ...f,
          targetRole: f.targetRole || job.title,
          jobDescription: f.jobDescription || job.description || '',
          savedJobId: job.id,
        }))
        setTailoringFor(job.companyName ? `${job.title} at ${job.companyName}` : job.title)
      })
      .catch(() => {
        // Deleted or foreign card: carry on as a normal run.
      })
  }, [])

  function validateForm(values: AnalyzeCvRequest): string[] {
    const errors: string[] = []
    if (!values.targetRole.trim()) {
      errors.push('Please enter a target role so we know what to compare your CV against.')
    }
    if (values.currentCvText.trim().length < 30) {
      errors.push('Please upload your CV or paste at least a few sentences of CV content.')
    }
    return errors
  }

  function handleSubmit() {
    const errors = validateForm(form)
    if (errors.length > 0) {
      setValidationErrors(errors)
      return
    }
    setValidationErrors([])
    submit(form)
  }

  function friendlyServerError(message: string | undefined): string[] {
    if (!message) return []
    // Legacy Zod issues may leak through as a JSON array string — parse them.
    const trimmed = message.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as Array<{ message?: string }>
        const messages = parsed.map((i) => i?.message).filter((m): m is string => Boolean(m))
        if (messages.length > 0) return messages
      } catch {
        // fall through to raw display
      }
    }
    return [message]
  }

  const { tab, setTab, state, submit, reset } = useCvOptimizer()
  const isBusy = state.status === 'submitting' || state.status === 'running'
  const results = state.data

  function updateField<K extends keyof AnalyzeCvRequest>(key: K, value: AnalyzeCvRequest[K]) {
    setForm((current) => ({ ...current, [key]: value }))
    if (validationErrors.length > 0) setValidationErrors([])
  }

  async function handleCvFile(file: File) {
    setCvFile(file); setCvFileName(file.name); setCvParsing(true); setParseError(null)
    try {
      const { text } = await parseFileForCvOptimizer(file)
      updateField('currentCvText', text)
    } catch (error) {
      console.error('CV file parse failed', error)
      const status = (error as { status?: number })?.status
      const detail = (error as { payload?: { message?: string } })?.payload?.message
      const suffix = status ? ` (${status}${detail ? `: ${detail}` : ''})` : ''
      setParseError(`Failed to extract text from CV file${suffix}. Try pasting it manually.`)
      setCvFile(null)
      setCvFileName(null)
    } finally { setCvParsing(false) }
  }

  async function handleDownloadRewrittenCv() {
    if (!cvFile || !results) return
    setDownloadingRewrite(true)
    setDownloadError(null)
    setDownloadNotice(null)
    try {
      const { blob, filename, appliedCount, totalCount } = await generateRewrittenCv(
        cvFile,
        results.rewriteSuggestions,
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      if (totalCount > 0 && appliedCount < totalCount) {
        setDownloadNotice(
          `Downloaded ${filename}. Applied ${appliedCount} of ${totalCount} rewrites — the rest couldn't be matched against the original document text.`,
        )
      } else {
        setDownloadNotice(`Downloaded ${filename} with ${appliedCount} rewrite${appliedCount === 1 ? '' : 's'} applied.`)
      }
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'Failed to generate rewritten CV.')
    } finally {
      setDownloadingRewrite(false)
    }
  }

  async function handleJdFile(file: File) {
    setJdFileName(file.name); setJdParsing(true); setParseError(null)
    try {
      const { text } = await parseFileForCvOptimizer(file)
      updateField('jobDescription', text)
    } catch (error) {
      console.error('JD file parse failed', error)
      const status = (error as { status?: number })?.status
      const detail = (error as { payload?: { message?: string } })?.payload?.message
      const suffix = status ? ` (${status}${detail ? `: ${detail}` : ''})` : ''
      setParseError(`Failed to extract text from JD file${suffix}. Try pasting it manually.`)
      setJdFileName(null)
    } finally { setJdParsing(false) }
  }

  function handleReset() {
    reset(); setForm(INITIAL_FORM); setCvFile(null); setCvFileName(null); setJdFileName(null); setParseError(null)
    setValidationErrors([])
    setDownloadError(null); setDownloadNotice(null)
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <h1 className="text-4xl font-serif font-bold text-primary mb-2">CV Optimizer</h1>
      <p className="text-muted-foreground mb-8">Upload your CV and a job description — our AI runs a full recruitment-grade analysis in seconds.</p>
      {tailoringFor && form.savedJobId ? (
        <p className="mb-6 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary">
          Tailoring for <strong>{tailoringFor}</strong>. The CV you analyse is saved to this job in your tracker.
          {form.jobDescription ? '' : ' Paste the job description below for a sharper score.'}
        </p>
      ) : null}

      {isBusy && !results ? (
        <AnalyzingPanel status={state.status === 'submitting' ? 'submitting' : 'running'} />
      ) : !results ? (
        <div className="grid md:grid-cols-2 gap-8">
          {/* Left — inputs */}
          <div className="bg-card rounded-xl p-8 space-y-5">
            <input
              value={form.targetRole}
              onChange={(e) => updateField('targetRole', e.target.value)}
              placeholder="Target role (e.g. Frontend Developer)"
              className="w-full rounded-lg border px-4 py-3 bg-background"
            />
            <div className="space-y-2">
              <FileUploadZone label="CV" fileName={cvFileName} parsing={cvParsing} onFile={handleCvFile}
                onClear={() => { setCvFile(null); setCvFileName(null); updateField('currentCvText', '') }} />
              <textarea value={form.currentCvText} onChange={(e) => updateField('currentCvText', e.target.value)}
                placeholder="Or paste your CV text here..." className="min-h-36 w-full rounded-lg border px-4 py-3 bg-background text-sm" />
            </div>
            <div className="space-y-2">
              <FileUploadZone label="Job Description" fileName={jdFileName} parsing={jdParsing} onFile={handleJdFile}
                onClear={() => { setJdFileName(null); updateField('jobDescription', '') }} />
              <textarea value={form.jobDescription} onChange={(e) => updateField('jobDescription', e.target.value)}
                placeholder="Or paste the job description here..." className="min-h-28 w-full rounded-lg border px-4 py-3 bg-background text-sm" />
            </div>

            {(() => {
              const messages: string[] = []
              if (parseError) messages.push(parseError)
              if (validationErrors.length > 0) messages.push(...validationErrors)
              else if (state.error?.message) {
                const details = state.error as { details?: { fieldErrors?: { message: string }[] } }
                const fieldErrors = details.details?.fieldErrors?.map((f) => f.message) ?? []
                if (fieldErrors.length > 0) messages.push(...fieldErrors)
                else messages.push(...friendlyServerError(state.error.message))
              }
              if (messages.length === 0) return null
              return (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {messages.length === 1 ? (
                    <p>{messages[0]}</p>
                  ) : (
                    <ul className="space-y-1 list-disc list-inside">
                      {messages.map((m, idx) => <li key={idx}>{m}</li>)}
                    </ul>
                  )}
                </div>
              )
            })()}

            <button onClick={handleSubmit} disabled={isBusy || cvParsing || jdParsing}
              className="w-full mt-2 px-6 py-3 bg-secondary text-primary rounded-lg font-semibold hover:bg-secondary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {isBusy ? (
                <><Loader className="w-4 h-4 animate-spin" />{state.status === 'submitting' ? 'Submitting...' : 'Analyzing...'}</>
              ) : 'Analyze My CV'}
            </button>

          </div>

          {/* Right — description + tips */}
          <div className="space-y-6">
            <div className="bg-primary rounded-xl p-8 text-primary-foreground">
              <h3 className="text-xl font-serif font-semibold mb-3">What this tool does</h3>
              <p className="text-primary-foreground/80 leading-relaxed mb-4">
                Upload your CV and a job description — our AI runs a full recruitment-grade analysis in seconds.
              </p>
              <ul className="space-y-3 text-primary-foreground/70 text-sm">
                {[
                  ['CV Overview', 'Your overall match score and a breakdown of how your CV performs across every dimension. See exactly where you stand before you apply.', '25% of total score'],
                  ['ATS Compatibility', 'Every requirement, technology, and qualification the employer is screening for — mapped against your CV line by line. Know exactly what an Applicant Tracking System sees before a human ever does.', '40% of total score'],
                  ['Bullet Impact', 'Every experience bullet analysed for real-world impact. Are you showing outcomes or just listing duties?', '35% of total score'],
                  ['Rewrite Suggestions', 'Side-by-side view of weak content and a stronger AI-generated version, driven directly by the gaps found in your analysis.', 'unscored'],
                  ['Action Plan', 'Concrete next steps tailored to your gaps. Specific projects to build, skills to acquire, certifications to pursue, and experiences to target — so you know exactly what to do before your next application.', 'unscored'],
                ].map(([title, desc, weight], i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-highlight-ink font-bold mt-0.5">{i + 1}.</span>
                    <div className="flex-1">
                      <strong className="text-primary-foreground">{title}</strong> — {desc}
                      <div className="text-[10px] uppercase tracking-wide text-highlight-ink mt-0.5">{weight}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-primary/5 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-primary mb-3">Optimization Tips</h3>
              <ul className="space-y-2 text-sm text-foreground">
                {[
                  'Upload both a CV and JD for the most accurate keyword and alignment analysis.',
                  'Quantify every bullet — numbers and percentages score significantly higher.',
                  'Mirror exact keywords from the job description to pass ATS filters.',
                  'Start each bullet with a strong action verb (built, led, reduced, delivered).',
                ].map((tip, i) => (
                  <li key={i} className="flex gap-2">
                    <AlertCircle className="w-4 h-4 text-highlight-ink flex-shrink-0 mt-0.5" />
                    <span>{tip}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-6">
            <button onClick={handleReset} className="px-4 py-2 text-highlight-ink font-medium hover:bg-secondary/10 rounded-lg">
              &larr; Analyze Another CV
            </button>
          </div>

          {/* Score header: overall + 25/40/35 breakdown */}
          <div className="grid sm:grid-cols-4 gap-4 mb-8">
            <div className={`rounded-xl border p-6 ${scoreBg(results.overallScore)}`}>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Overall Score</p>
              <p className={`text-4xl font-bold ${scoreColor(results.overallScore)}`}>{results.overallScore}<span className="text-lg text-subtle-foreground">/100</span></p>
              <ScoreBar score={results.overallScore} />
              <p className="text-[10px] text-muted-foreground mt-2">Weighted composite of the three dimensions</p>
            </div>
            <div className={`rounded-xl border p-6 ${scoreBg(results.scoreBreakdown.cvOverview)}`}>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">CV Overview <span className="text-subtle-foreground">(25%)</span></p>
              <p className={`text-4xl font-bold ${scoreColor(results.scoreBreakdown.cvOverview)}`}>{results.scoreBreakdown.cvOverview}<span className="text-lg text-subtle-foreground">/100</span></p>
              <ScoreBar score={results.scoreBreakdown.cvOverview} />
            </div>
            <div className={`rounded-xl border p-6 ${scoreBg(results.scoreBreakdown.atsAndKeywordIntelligence)}`}>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">ATS & Keywords <span className="text-subtle-foreground">(40%)</span></p>
              <p className={`text-4xl font-bold ${scoreColor(results.scoreBreakdown.atsAndKeywordIntelligence)}`}>{results.scoreBreakdown.atsAndKeywordIntelligence}<span className="text-lg text-subtle-foreground">/100</span></p>
              <ScoreBar score={results.scoreBreakdown.atsAndKeywordIntelligence} />
            </div>
            <div className={`rounded-xl border p-6 ${scoreBg(results.scoreBreakdown.bulletImpact)}`}>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Bullet Impact <span className="text-subtle-foreground">(35%)</span></p>
              <p className={`text-4xl font-bold ${scoreColor(results.scoreBreakdown.bulletImpact)}`}>{results.scoreBreakdown.bulletImpact}<span className="text-lg text-subtle-foreground">/100</span></p>
              <ScoreBar score={results.scoreBreakdown.bulletImpact} />
            </div>
          </div>

          {/* Tabs */}
          <div className="mb-6 flex gap-1 overflow-x-auto border-b">
            {TABS.map(({ id, label }) => (
              <button key={id} onClick={() => setTab(id)}
                className={`px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  tab === id ? 'border-secondary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'overview' && <CvOverviewTab results={results} />}
          {tab === 'ats' && <AtsIntelligenceTab results={results} />}
          {tab === 'bullets' && <BulletsTab results={results} targetRole={form.targetRole} />}
          {tab === 'rewrite' && (
            <RewriteTab
              results={results}
              cvFile={cvFile}
              onDownload={handleDownloadRewrittenCv}
              downloading={downloadingRewrite}
              downloadError={downloadError}
              downloadNotice={downloadNotice}
            />
          )}
          {tab === 'action-plan' && <ActionPlanTab plan={results.actionPlan} />}
        </div>
      )}
    </div>
  )
}
