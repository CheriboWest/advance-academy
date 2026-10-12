'use client'

import { useRef, useEffect } from 'react'
import { Send, Loader2 } from 'lucide-react'
import type { CoachPreview } from '@/features/interview-prep/types'
import { PERSONAS } from '@/features/interview-prep/data/personas'
import { useInterview } from '@/features/interview-prep/hooks/use-interview'
import type { InterviewMode } from '@/features/interview-prep/hooks/use-interview'
import { IRSMeter } from '@/features/interview-prep/components/irs-meter'
import { MicButton } from '@/features/interview-prep/components/mic-button'
import { irsScoreColor } from '@/shared/utils/score-utils'
import { CoachPanel } from '@/features/interview-prep/components/coach-panel'

export function InterviewStepView({
  session,
  mode,
  input,
  setInput,
  loading,
  onSend,
  onEnd,
  lastScore,
  candidateAnswerCount,
  onRequestCoachPreview,
  onRequestCoachGenerate,
  onSetCoachPreview,
  onSubmitJit,
  transcribeAudio,
  transcribing,
}: {
  session: NonNullable<ReturnType<typeof useInterview>['session']>
  mode: InterviewMode
  input: string
  setInput: (val: string) => void
  loading: boolean
  onSend: () => void
  onEnd: () => void
  lastScore: ReturnType<typeof useInterview>['lastScore']
  candidateAnswerCount: number
  onRequestCoachPreview: (messageId: string) => Promise<void>
  onRequestCoachGenerate: (messageId: string, selectedBulletIds: string[]) => Promise<void>
  onSetCoachPreview: (messageId: string, coachPreview: CoachPreview) => void
  onSubmitJit: (messageId: string, promptIndex: number, answer: string, selectedBulletIds: string[]) => Promise<void>
  transcribeAudio: (blob: Blob) => Promise<string>
  transcribing: boolean
}) {
  const chatEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const persona = PERSONAS.find((p) => p.id === session.personaId)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session.messages.length])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      onSend()
    }
  }

  const isEvaluating = session.status === 'evaluating'

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 flex flex-col">
        {persona && (
          <div className="flex items-center gap-3 mb-4 p-3 bg-primary/5 rounded-xl">
            <span className="text-2xl">{persona.avatar}</span>
            <div>
              <h3 className="font-semibold text-primary text-sm">{persona.name}</h3>
              <p className="text-xs text-muted-foreground">{persona.title}</p>
            </div>
            <div className="flex gap-1.5 ml-auto">
              {persona.style.split(' · ').map((tag) => (
                <span key={tag} className="px-2 py-0.5 bg-background text-muted-foreground text-xs rounded-full">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex-1 space-y-4 mb-4 max-h-[500px] overflow-y-auto pr-2">
          {session.messages.map((msg) => (
            <div key={msg.id}>
              <div className={`flex ${msg.role === 'candidate' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                    msg.role === 'candidate' ? 'bg-primary text-primary-foreground' : 'bg-card text-foreground'
                  }`}
                >
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  {msg.irsScore && (
                    <div className="mt-2 pt-2 border-t border-primary/30">
                      <IRSMeter score={msg.irsScore} compact />
                    </div>
                  )}
                </div>
              </div>
              {msg.role === 'candidate' && msg.questionAsked && (
                <CoachPanel
                  message={msg}
                  onRequestCoachPreview={onRequestCoachPreview}
                  onRequestCoachGenerate={onRequestCoachGenerate}
                  onSetCoachPreview={onSetCoachPreview}
                  onSubmitJit={onSubmitJit}
                />
              )}
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-card rounded-2xl px-4 py-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {isEvaluating ? 'Generating your feedback report...' : 'Thinking...'}
                </div>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {session.status === 'active' && (
          <div className="border rounded-xl p-3">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                mode === 'voice'
                  ? 'Press Record to speak your answer, or type here... (Ctrl + Enter to send)'
                  : 'Type your answer here... (Ctrl + Enter to send)'
              }
              disabled={loading || transcribing}
              rows={3}
              className="w-full text-sm text-foreground placeholder:text-subtle-foreground focus:outline-none resize-none disabled:opacity-50"
            />
            <div className="flex items-center justify-between mt-2 gap-2">
              <span className="text-xs text-subtle-foreground">{input.length} characters</span>
              <div className="flex items-center gap-2">
                {mode === 'voice' && (
                  <MicButton
                    disabled={loading}
                    transcribing={transcribing}
                    onTranscribe={transcribeAudio}
                    onTranscribed={(text) =>
                      setInput(input.trim() ? `${input.trim()} ${text}` : text)
                    }
                  />
                )}
                <button
                  onClick={onEnd}
                  disabled={candidateAnswerCount < 1 || loading}
                  className="px-4 py-2 text-sm text-muted-foreground hover:text-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  End Interview
                </button>
                <button
                  onClick={onSend}
                  disabled={!input.trim() || loading || transcribing}
                  className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Send className="w-3.5 h-3.5" /> Send
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {lastScore && (
          <div className="bg-background border rounded-xl p-4">
            <h3 className="text-sm font-semibold text-primary mb-3">Last Answer Score</h3>
            <IRSMeter score={lastScore} />
          </div>
        )}

        <div className="bg-background border rounded-xl p-4">
          <h3 className="text-sm font-semibold text-primary mb-3">Session Progress</h3>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Answers given</span>
              <span className="font-medium text-foreground">{candidateAnswerCount}</span>
            </div>
            {candidateAnswerCount > 0 && <RunningAverages messages={session.messages} />}
          </div>
        </div>

        <div className="bg-primary/5 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-primary mb-3">IRS Rubric</h3>
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              <span className="font-semibold text-primary">I - Integrity (30%):</span> Authenticity, honesty, internal consistency
            </p>
            <p>
              <span className="font-semibold text-primary">R - Relevance (30%):</span> Addresses the question and target role
            </p>
            <p>
              <span className="font-semibold text-primary">S - Substance (40%):</span> Depth, specifics, examples, metrics
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function RunningAverages({
  messages,
}: {
  messages: { role: string; irsScore?: { integrity: { score: number }; relevance: { score: number }; substance: { score: number }; overall: number } }[]
}) {
  const scored = messages.filter((m) => m.role === 'candidate' && m.irsScore)
  if (scored.length === 0) return null

  const avg = (fn: (s: NonNullable<(typeof scored)[0]['irsScore']>) => number) =>
    Math.round((scored.reduce((sum, m) => sum + fn(m.irsScore!), 0) / scored.length) * 10) / 10

  return (
    <div className="space-y-1.5 pt-2 border-t border-border">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">Avg Integrity</span>
        <span className="font-medium">{avg((s) => s.integrity.score).toFixed(1)}</span>
      </div>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">Avg Relevance</span>
        <span className="font-medium">{avg((s) => s.relevance.score).toFixed(1)}</span>
      </div>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">Avg Substance</span>
        <span className="font-medium">{avg((s) => s.substance.score).toFixed(1)}</span>
      </div>
      <div className="flex justify-between text-xs font-semibold">
        <span className="text-muted-foreground">Overall</span>
        <span className={irsScoreColor(avg((s) => s.overall))}>{avg((s) => s.overall).toFixed(1)}/10</span>
      </div>
    </div>
  )
}
