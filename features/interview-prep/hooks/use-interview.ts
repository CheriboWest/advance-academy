'use client'

import { useState, useCallback, useRef } from 'react'
import { authedFetch } from '@/shared/auth/authed-fetch'
import type {
  InterviewStep,
  InterviewContext,
  PersonaId,
  InterviewSession,
  InterviewMessage,
  IRSScore,
  CoachResult,
  CoachPreview,
} from '@/features/interview-prep/types'

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as
    | { code?: string; message?: string; error?: string }
    | null
  return data?.message || data?.error || fallback
}

export type InterviewMode = 'text' | 'voice'

export function useInterview() {
  const [step, setStep] = useState<InterviewStep>('setup')
  const [context, setContext] = useState<InterviewContext>({
    cvText: '',
    jobTitle: '',
    jobDescription: '',
    companyName: '',
    companyUrl: '',
    extraLinks: [],
  })
  const [selectedPersona, setSelectedPersona] = useState<PersonaId | null>(null)
  const [mode, setMode] = useState<InterviewMode>('text')
  const [session, setSession] = useState<InterviewSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [transcribing, setTranscribing] = useState(false)

  // DB session ID tracked via ref (doesn't need to trigger re-renders)
  const dbSessionIdRef = useRef<string | null>(null)
  const questionIdRef = useRef<string | null>(null)

  const updateContext = useCallback((updates: Partial<InterviewContext>) => {
    setContext((prev) => ({ ...prev, ...updates }))
  }, [])

  const startSession = useCallback(async () => {
    if (!selectedPersona) return
    setLoading(true)
    setError(null)

    try {
      const res = await authedFetch('/api/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          personaId: selectedPersona,
          context,
        }),
      })

      if (!res.ok) {
        throw new Error(await readErrorMessage(res, 'Failed to start session'))
      }

      const data = await res.json()

      // Store DB session ID for subsequent requests
      if (data.dbSessionId) {
        dbSessionIdRef.current = data.dbSessionId
      }
      questionIdRef.current = data.questionId ?? null

      const openingMessage: InterviewMessage = {
        id: `msg_${Date.now()}`,
        role: 'interviewer',
        content: data.openingQuestion,
        timestamp: Date.now(),
      }

      const newSession: InterviewSession = {
        id: data.sessionId,
        personaId: selectedPersona,
        status: 'active',
        startedAt: Date.now(),
        messages: [openingMessage],
        context,
      }

      setSession(newSession)
      setStep('interview')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start session')
    } finally {
      setLoading(false)
    }
  }, [selectedPersona, context])

  const sendMessage = useCallback(async () => {
    if (!session || !input.trim() || loading) return

    const candidateMessage: InterviewMessage = {
      id: `msg_${Date.now()}`,
      role: 'candidate',
      content: input.trim(),
      timestamp: Date.now(),
    }

    const updatedMessages = [...session.messages, candidateMessage]
    setSession((prev) => prev ? { ...prev, messages: updatedMessages } : null)
    setInput('')
    setLoading(true)
    setError(null)

    const lastQuestion =
      [...session.messages].reverse().find((m) => m.role === 'interviewer')?.content ?? ''

    try {
      // Completed turns only. The current answer is carried separately in
      // `content`, preventing it from being sent to the interviewer twice.
      const messageHistory = session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }))

      const res = await authedFetch('/api/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'message',
          sessionId: session.id,
          content: candidateMessage.content,
          messageHistory,
          personaId: session.personaId,
          context: session.context,
          dbSessionId: dbSessionIdRef.current,
          questionId: questionIdRef.current,
        }),
      })

      if (!res.ok) throw new Error('Failed to send message')

      const data = await res.json()
      questionIdRef.current = data.nextQuestionId ?? null

      const scoredCandidate: InterviewMessage = {
        ...candidateMessage,
        irsScore: data.irsScore,
        questionAsked: lastQuestion,
        assessmentId: data.assessmentId,
      }

      const interviewerReply: InterviewMessage = {
        id: `msg_${Date.now() + 1}`,
        role: 'interviewer',
        content: data.reply,
        timestamp: Date.now(),
      }

      const finalMessages = [
        ...session.messages,
        scoredCandidate,
        interviewerReply,
      ]

      const updatedSession: InterviewSession = {
        ...session,
        messages: finalMessages,
      }

      setSession(updatedSession)

      if (data.isComplete) {
        await evaluateSession(updatedSession)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setLoading(false)
    }
  }, [session, input, loading])

  // Phase 1: pull the embedding-retrieved bullets + gaps + RAW artifacts
  // for the user to review. No LLM tokens spent here.
  const requestCoachPreview = useCallback(
    async (messageId: string) => {
      if (!session) return
      const msg = session.messages.find((m) => m.id === messageId)
      if (!msg || msg.role !== 'candidate' || !msg.questionAsked) return
      try {
        const res = await authedFetch('/api/interview/coach-answer/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: msg.questionAsked }),
        })
        if (!res.ok) {
          throw new Error(await readErrorMessage(res, 'Failed to load preview'))
        }
        const coachPreview: CoachPreview = await res.json()
        setSession((prev) =>
          prev
            ? {
                ...prev,
                messages: prev.messages.map((m) =>
                  m.id === messageId ? { ...m, coachPreview } : m,
                ),
              }
            : null,
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Coach preview failed')
      }
    },
    [session],
  )

  // Lightweight helper: replace the preview on a message after the user adds
  // a picker bullet (so we keep its loaded gaps + raw artifacts client-side
  // without re-running embedding retrieval).
  const setCoachPreview = useCallback((messageId: string, coachPreview: CoachPreview) => {
    setSession((prev) =>
      prev
        ? {
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === messageId ? { ...m, coachPreview } : m,
            ),
          }
        : null,
    )
  }, [])

  // Phase 2: take the user's edited bullet selection + conversation history
  // and run the LLM rewriter. selectedBulletIds defaults to whatever's in the
  // current preview when the user hasn't toggled anything.
  const requestCoachGenerate = useCallback(
    async (messageId: string, selectedBulletIds: string[]) => {
      if (!session) return
      const msg = session.messages.find((m) => m.id === messageId)
      if (!msg || msg.role !== 'candidate' || !msg.questionAsked) return
      // Build conversation history: every turn BEFORE the message we're enhancing.
      const idx = session.messages.findIndex((m) => m.id === messageId)
      const priorTurns = (idx >= 0 ? session.messages.slice(0, idx) : []).map((m) => ({
        role: m.role,
        content: m.content,
      }))
      try {
        const res = await authedFetch('/api/interview/coach-answer/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: msg.questionAsked,
            answer: msg.content,
            context: {
              jobTitle: session.context.jobTitle,
              jobDescription: session.context.jobDescription,
              companyName: session.context.companyName,
            },
            selectedBulletIds,
            conversationHistory: priorTurns,
            irsScore: msg.irsScore && {
              integrity: msg.irsScore.integrity.score,
              relevance: msg.irsScore.relevance.score,
              substance: msg.irsScore.substance.score,
              overall: msg.irsScore.overall,
            },
            assessmentId: msg.assessmentId,
          }),
        })
        if (!res.ok) {
          throw new Error(await readErrorMessage(res, 'Failed to coach'))
        }
        const coach: CoachResult = await res.json()
        setSession((prev) =>
          prev
            ? {
                ...prev,
                messages: prev.messages.map((m) => (m.id === messageId ? { ...m, coach } : m)),
              }
            : null,
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Coach failed')
      }
    },
    [session],
  )

  const submitJitClarification = useCallback(
    async (messageId: string, promptIndex: number, answer: string, selectedBulletIds: string[]) => {
      if (!session) return
      const msg = session.messages.find((m) => m.id === messageId)
      if (!msg?.coach) return
      const prompt = msg.coach.missingEvidencePrompts[promptIndex]
      if (!prompt) return
      try {
        await authedFetch('/api/cv-library/jit-clarification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bulletId: prompt.bulletId,
            question: prompt.question,
            answer,
          }),
        })
        // After saving, re-run the coach so the placeholder disappears.
        // Reuse the user's already-curated selection — don't re-run preview.
        await requestCoachGenerate(messageId, selectedBulletIds)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save clarification')
      }
    },
    [session, requestCoachGenerate],
  )

  const evaluateSession = useCallback(async (sessionToEvaluate: InterviewSession) => {
    setLoading(true)

    const evaluatingSession: InterviewSession = {
      ...sessionToEvaluate,
      status: 'evaluating',
    }
    setSession(evaluatingSession)

    try {
      const res = await authedFetch('/api/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: evaluatingSession,
          dbSessionId: dbSessionIdRef.current,
        }),
      })

      if (!res.ok) throw new Error('Failed to evaluate session')

      const data = await res.json()

      const completedSession: InterviewSession = {
        ...evaluatingSession,
        status: 'complete',
        endedAt: Date.now(),
        finalReport: data.report,
      }

      setSession(completedSession)
      setStep('report')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate report')
    } finally {
      setLoading(false)
    }
  }, [])

  const endInterview = useCallback(async () => {
    if (!session) return
    await evaluateSession(session)
  }, [session, evaluateSession])

  const transcribeAudio = useCallback(async (blob: Blob): Promise<string> => {
    setTranscribing(true)
    setError(null)
    try {
      const formData = new FormData()
      const extension = blob.type.includes('webm')
        ? 'webm'
        : blob.type.includes('ogg')
          ? 'ogg'
          : blob.type.includes('mp4')
            ? 'mp4'
            : 'webm'
      formData.append('file', blob, `answer.${extension}`)

      const res = await authedFetch('/api/interview/transcribe', {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null
        throw new Error(data?.message || data?.error || 'Transcription failed')
      }

      const data = (await res.json()) as { text?: string }
      return (data.text ?? '').trim()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transcription failed'
      setError(message)
      throw err
    } finally {
      setTranscribing(false)
    }
  }, [])

  const reset = useCallback(() => {
    setStep('setup')
    setContext({
      cvText: '',
      jobTitle: '',
      jobDescription: '',
      companyName: '',
      companyUrl: '',
      extraLinks: [],
    })
    setSelectedPersona(null)
    setMode('text')
    setSession(null)
    setLoading(false)
    setError(null)
    setInput('')
    setTranscribing(false)
    dbSessionIdRef.current = null
    questionIdRef.current = null
  }, [])

  const lastScore: IRSScore | undefined = session?.messages
    .filter((m) => m.role === 'candidate' && m.irsScore)
    .slice(-1)[0]?.irsScore

  const candidateAnswerCount = session?.messages.filter(
    (m) => m.role === 'candidate'
  ).length ?? 0

  return {
    step,
    setStep,
    context,
    updateContext,
    selectedPersona,
    setSelectedPersona,
    mode,
    setMode,
    session,
    loading,
    error,
    input,
    setInput,
    startSession,
    sendMessage,
    endInterview,
    reset,
    lastScore,
    candidateAnswerCount,
    requestCoachPreview,
    requestCoachGenerate,
    setCoachPreview,
    submitJitClarification,
    transcribeAudio,
    transcribing,
  }
}
