'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { getCoachingMockContext } from '@/features/interview-prep/api/frontend-client'
import { CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
import type { InterviewContext } from '@/features/interview-prep/types'
import type { ViewName } from '@/shared/types/navigation'
import type { InterviewStep } from '@/features/interview-prep/types'
import { useInterview } from '@/features/interview-prep/hooks/use-interview'
import { getSavedJob } from '@/features/job-tracking/api/frontend-client'
import type { SavedJob } from '@advance-academy/contracts/job-tracking'
import { InterviewStepView } from '@/features/interview-prep/components/interview-step'
import { PersonaStep } from '@/features/interview-prep/components/persona-step'
import { ReportStep } from '@/features/interview-prep/components/report-step'
import { SetupStep } from '@/features/interview-prep/components/setup-step'

interface InterviewPrepScreenProps {
  onNavigate: (view: ViewName) => void
}

export function InterviewPrepScreen({ onNavigate }: InterviewPrepScreenProps) {
  const interview = useInterview()
  const searchParams = useSearchParams()
  const coachingSessionId = searchParams?.get('coaching') ?? null

  // ── One-click mock from an approved coaching pack (ticket T7) ──
  const [coachingLoad, setCoachingLoad] = useState<{
    state: 'idle' | 'loading' | 'ready' | 'error'
    companyName?: string
    questionCount?: number
    message?: string
  }>({ state: 'idle' })

  const { updateContext, setStep } = interview

  // ── Prep for a tracked job (`?savedJob=<id>` from a tracker card, or the
  // setup step's tracker picker) ──
  // Fills title, company and whatever JD the card holds. A thin JD with a link
  // pre-fills the "extract from URL" box instead of fetching on page load, so
  // the student decides when to spend the extraction.
  const savedJobId = searchParams?.get('savedJob') ?? null
  const [pickedJobId, setPickedJobId] = useState(savedJobId ?? '')
  const [savedJobUrl, setSavedJobUrl] = useState<string | null>(null)
  const applySavedJob = useCallback(
    (job: SavedJob) => {
      setPickedJobId(job.id)
      updateContext({
        jobTitle: job.title,
        companyName: job.companyName ?? '',
        jobDescription: job.description ?? '',
      })
      setSavedJobUrl(job.jobUrl && (job.description?.trim().length ?? 0) < 400 ? job.jobUrl : null)
    },
    [updateContext],
  )
  useEffect(() => {
    if (!savedJobId || coachingSessionId) return
    let cancelled = false
    getSavedJob(savedJobId)
      .then(({ job }) => {
        if (!cancelled) applySavedJob(job)
      })
      .catch(() => {
        // A deleted or foreign card: fall back to the empty setup form.
      })
    return () => {
      cancelled = true
    }
  }, [savedJobId, coachingSessionId, applySavedJob])

  useEffect(() => {
    // Runs once per session id. The whole point is that the student arrives with
    // the setup already done — asking them to retype the JD they gave their
    // coach last week would defeat the "one click" entirely.
    if (!coachingSessionId || coachingLoad.state !== 'idle') return
    let cancelled = false
    setCoachingLoad({ state: 'loading' })
    ;(async () => {
      try {
        const res = await getCoachingMockContext(coachingSessionId)
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.message ?? 'Could not load that coaching pack.')
        if (cancelled) return

        const ctx = body.context as InterviewContext & { questionBank?: string[] }
        updateContext({
          cvText: ctx.cvText ?? '',
          jobTitle: ctx.jobTitle ?? '',
          jobDescription: ctx.jobDescription ?? '',
          companyName: ctx.companyName ?? '',
          companyUrl: ctx.companyUrl ?? '',
          extraLinks: [],
          questionBank: ctx.questionBank ?? [],
          coachingSessionId,
        })
        setCoachingLoad({
          state: 'ready',
          companyName: ctx.companyName,
          questionCount: ctx.questionBank?.length ?? 0,
        })
        // Straight past setup: everything it asks for is already filled in.
        setStep('persona')
      } catch (err) {
        if (!cancelled) {
          setCoachingLoad({
            state: 'error',
            message: err instanceof Error ? err.message : 'Could not load that coaching pack.',
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [coachingSessionId, coachingLoad.state, updateContext, setStep])

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-4xl font-serif font-bold text-primary mb-2">
          Interview Preparation
        </h1>
        <p className="text-muted-foreground text-lg">
          Practice with AI interviewers tailored to your target role and company.
        </p>
      </div>

      {coachingLoad.state === 'loading' && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border bg-card p-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-foreground">Loading your coach&rsquo;s prep pack…</p>
        </div>
      )}

      {coachingLoad.state === 'ready' && (
        <div className="mb-6 rounded-lg border border-primary/20 bg-primary/5 p-4">
          <p className="text-sm font-medium text-primary">
            Practising the questions your coach approved
            {coachingLoad.companyName ? ` for ${coachingLoad.companyName}` : ''}
          </p>
          <p className="mt-0.5 text-sm text-primary/80">
            {coachingLoad.questionCount} question
            {coachingLoad.questionCount === 1 ? '' : 's'} loaded, starred ones first. Your CV, the
            job description and the company are already filled in — pick an interviewer and start.
          </p>
        </div>
      )}

      {coachingLoad.state === 'error' && (
        <div className="mb-6 rounded-lg border border-secondary/40 bg-secondary/10 p-4 text-sm text-highlight-ink">
          {coachingLoad.message} You can still set a mock up by hand below.
        </div>
      )}

      <StepIndicator currentStep={interview.step} />

      {interview.error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-red-700 text-sm">{interview.error}</p>
        </div>
      )}

      {interview.step === 'setup' && (
        <SetupStep
          context={interview.context}
          updateContext={interview.updateContext}
          onNext={() => interview.setStep('persona')}
          initialJobUrl={savedJobUrl}
          pickedJobId={pickedJobId}
          linkedJobId={savedJobId}
          onPickJob={applySavedJob}
        />
      )}

      {interview.step === 'persona' && (
        <PersonaStep
          selectedPersona={interview.selectedPersona}
          onSelect={interview.setSelectedPersona}
          mode={interview.mode}
          onSelectMode={interview.setMode}
          onBack={() => interview.setStep('setup')}
          onStart={interview.startSession}
          loading={interview.loading}
        />
      )}

      {interview.step === 'interview' && interview.session && (
        <InterviewStepView
          session={interview.session}
          mode={interview.mode}
          input={interview.input}
          setInput={interview.setInput}
          loading={interview.loading}
          onSend={interview.sendMessage}
          onEnd={interview.endInterview}
          lastScore={interview.lastScore}
          candidateAnswerCount={interview.candidateAnswerCount}
          onRequestCoachPreview={interview.requestCoachPreview}
          onRequestCoachGenerate={interview.requestCoachGenerate}
          onSetCoachPreview={interview.setCoachPreview}
          onSubmitJit={interview.submitJitClarification}
          transcribeAudio={interview.transcribeAudio}
          transcribing={interview.transcribing}
        />
      )}

      {interview.step === 'report' && interview.session?.finalReport && (
        <ReportStep
          session={interview.session}
          onNavigateHome={() => onNavigate('home')}
          onNewInterview={interview.reset}
        />
      )}
    </div>
  )
}

function StepIndicator({ currentStep }: { currentStep: InterviewStep }) {
  const steps: { key: InterviewStep; label: string }[] = [
    { key: 'setup', label: 'Context' },
    { key: 'persona', label: 'Persona' },
    { key: 'interview', label: 'Interview' },
    { key: 'report', label: 'Report' },
  ]
  const currentIndex = steps.findIndex((s) => s.key === currentStep)

  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              i === currentIndex
                ? 'bg-primary text-primary-foreground'
                : i < currentIndex
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-card text-subtle-foreground'
            }`}
          >
            {i < currentIndex ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <span className="w-5 h-5 flex items-center justify-center text-xs font-bold">
                {i + 1}
              </span>
            )}
            {s.label}
          </div>
          {i < steps.length - 1 && (
            <div className={`w-8 h-0.5 ${i < currentIndex ? 'bg-emerald-300' : 'bg-muted'}`} />
          )}
        </div>
      ))}
    </div>
  )
}
