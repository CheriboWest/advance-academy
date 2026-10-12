'use client'

import { useState } from 'react'
import { ArrowRight, Loader } from 'lucide-react'
import type { AnalyzeCvResult, BulletEvaluation } from '@advance-academy/contracts'
import { rewriteBullet } from '@/features/cv-optimizer/api/frontend-client'
import { HttpClientError } from '@/shared/api/http-client'
import { bulletBorder, impactColor } from '@/features/cv-optimizer/components/score-style'

interface BulletRewriteState {
  answers: string[]
  rewriting: boolean
  rewritten: string | null
  error: string | null
  personalizeOpen: boolean
}

function BulletCard({ bullet, bulletKey, targetRole, state, onAnswersChange, onRewrite, onCopySuggested, onCopyPersonalized, onTogglePersonalize, copiedSuggested, copiedPersonalized }: {
  bullet: BulletEvaluation
  bulletKey: string
  targetRole: string
  state: BulletRewriteState
  onAnswersChange: (answers: string[]) => void
  onRewrite: () => void
  onCopySuggested: () => void
  onCopyPersonalized: () => void
  onTogglePersonalize: () => void
  copiedSuggested: boolean
  copiedPersonalized: boolean
}) {
  const hasAutoRewrite = bullet.autoRewrite.trim().length > 0
  const hasQuestions = bullet.clarifyingQuestions.length > 0
  const isWeak = hasAutoRewrite || hasQuestions

  return (
    <div className={`rounded-xl border p-5 ${bulletBorder(bullet.impactScore)}`}>
      <div className="flex items-start justify-between gap-4 mb-2">
        <p className="text-sm text-foreground italic flex-1">&ldquo;{bullet.original}&rdquo;</p>
        <div className="flex-shrink-0 text-right">
          <span className={`text-xl font-bold ${impactColor(bullet.impactScore)}`}>{bullet.impactScore}</span>
          <span className="text-xs text-subtle-foreground">/10</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{bullet.feedback}</p>
      {!bullet.hasImpact && (
        <span className="inline-block mt-2 rounded-full bg-red-100 text-red-600 text-xs px-2 py-0.5 font-medium">No measurable impact</span>
      )}

      {isWeak && (
        <div className="mt-4 space-y-3">
          {/* OPTION 1 — Suggested rewrite (already prepared, no input needed) */}
          {hasAutoRewrite && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div>
                  <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">Option 1 — Suggested Rewrite</p>
                  <p className="text-[11px] text-green-600/80">Tightened using only what&apos;s already in your CV — no invented numbers.</p>
                </div>
                <button
                  onClick={onCopySuggested}
                  className="text-xs text-green-700 hover:text-green-900 font-medium flex-shrink-0"
                >
                  {copiedSuggested ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-sm text-foreground leading-relaxed">{bullet.autoRewrite}</p>
            </div>
          )}

          {/* OPTION 2 — Personalize with your answers */}
          {hasQuestions && (
            <div className="rounded-lg border border-primary/20 bg-background p-4">
              <button
                onClick={onTogglePersonalize}
                className="w-full flex items-center justify-between text-left"
              >
                <div>
                  <p className="text-xs font-semibold text-primary uppercase tracking-wide">Option 2 — Personalize It</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Answer a few quick questions and we&apos;ll rewrite using your real impact details.</p>
                </div>
                <span className="text-xs font-medium text-primary flex-shrink-0">
                  {state.personalizeOpen ? 'Hide' : 'Answer questions'}
                </span>
              </button>

              {state.personalizeOpen && (
                <div className="mt-4 space-y-3 border-t border-border pt-4">
                  {bullet.clarifyingQuestions.map((q, qIdx) => (
                    <div key={`${bulletKey}-q-${qIdx}`}>
                      <label className="block text-xs font-medium text-foreground mb-1">{q}</label>
                      <input
                        type="text"
                        value={state.answers[qIdx] ?? ''}
                        onChange={(e) => {
                          const next = [...state.answers]
                          next[qIdx] = e.target.value
                          onAnswersChange(next)
                        }}
                        placeholder="Your answer..."
                        className="w-full rounded-md border px-3 py-2 text-sm focus:border-ring focus:outline-none"
                      />
                    </div>
                  ))}
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={onRewrite}
                      disabled={state.rewriting || !targetRole}
                      className="inline-flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-sm font-semibold text-primary hover:bg-secondary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {state.rewriting ? <Loader className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                      {state.rewriting ? 'Rewriting...' : 'Generate personalized rewrite'}
                    </button>
                    {state.error && <span className="text-xs text-red-600">{state.error}</span>}
                  </div>

                  {state.rewritten && (
                    <div className="mt-3 rounded-lg border border-green-300 bg-green-50 p-4">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">Personalized Rewrite</p>
                        <button
                          onClick={onCopyPersonalized}
                          className="text-xs text-green-700 hover:text-green-900 font-medium"
                        >
                          {copiedPersonalized ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                      <p className="text-sm text-foreground leading-relaxed">{state.rewritten}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function BulletsTab({ results, targetRole }: { results: AnalyzeCvResult; targetRole: string }) {
  const [rewriteStates, setRewriteStates] = useState<Record<string, BulletRewriteState>>({})
  const [copiedSuggestedKey, setCopiedSuggestedKey] = useState<string | null>(null)
  const [copiedPersonalizedKey, setCopiedPersonalizedKey] = useState<string | null>(null)

  if (results.bulletEvaluations.length === 0) {
    return <p className="text-muted-foreground text-sm">No bullet evaluations returned. Ensure the CV contains structured experience bullets.</p>
  }

  // Group by project, preserving original order within each project
  const groups = new Map<string, { bullets: BulletEvaluation[]; originalIndices: number[] }>()
  results.bulletEvaluations.forEach((b, idx) => {
    const key = b.project || 'Other'
    if (!groups.has(key)) groups.set(key, { bullets: [], originalIndices: [] })
    const g = groups.get(key)!
    g.bullets.push(b)
    g.originalIndices.push(idx)
  })

  // Within each group, sort weakest → strongest so the bullets that need help surface first
  for (const g of groups.values()) {
    const paired = g.bullets.map((b, i) => ({ b, i: g.originalIndices[i] }))
    paired.sort((a, b) => a.b.impactScore - b.b.impactScore)
    g.bullets = paired.map((p) => p.b)
    g.originalIndices = paired.map((p) => p.i)
  }

  const getState = (key: string, questionCount: number): BulletRewriteState =>
    rewriteStates[key] ?? {
      answers: Array(questionCount).fill(''),
      rewriting: false,
      rewritten: null,
      error: null,
      personalizeOpen: false,
    }

  function updateState(key: string, patch: Partial<BulletRewriteState>) {
    setRewriteStates((prev) => ({ ...prev, [key]: { ...getState(key, 0), ...prev[key], ...patch } }))
  }

  async function handleRewrite(key: string, bullet: BulletEvaluation) {
    const current = getState(key, bullet.clarifyingQuestions.length)
    updateState(key, { rewriting: true, error: null, rewritten: null })
    try {
      const { rewritten } = await rewriteBullet({
        original: bullet.original,
        project: bullet.project,
        feedback: bullet.feedback,
        clarifyingQuestions: bullet.clarifyingQuestions,
        answers: current.answers,
        targetRole,
      })
      updateState(key, { rewriting: false, rewritten })
    } catch (err) {
      const message = err instanceof HttpClientError
        ? err.payload.message
        : err instanceof Error
          ? err.message
          : 'Failed to rewrite bullet.'
      updateState(key, { rewriting: false, error: message })
    }
  }

  async function handleCopySuggested(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedSuggestedKey(key)
      window.setTimeout(() => setCopiedSuggestedKey((k) => (k === key ? null : k)), 2000)
    } catch {
      // ignore clipboard failures
    }
  }

  async function handleCopyPersonalized(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedPersonalizedKey(key)
      window.setTimeout(() => setCopiedPersonalizedKey((k) => (k === key ? null : k)), 2000)
    } catch {
      // ignore clipboard failures
    }
  }

  const weakCount = results.bulletEvaluations.filter((b) => b.impactScore <= 6).length

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-5 py-4">
        <p className="text-sm text-primary">
          <span className="font-semibold">Bullet Impact</span> is <span className="font-semibold">35%</span> of your overall score. Bullets are grouped by project and sorted weakest first.
          {weakCount > 0 && <> {weakCount} bullet{weakCount === 1 ? '' : 's'} need{weakCount === 1 ? 's' : ''} strengthening — answer the clarifying questions below and we&apos;ll rewrite them using your real details.</>}
        </p>
      </div>

      {Array.from(groups.entries()).map(([project, group]) => (
        <div key={project} className="space-y-3">
          <h4 className="font-semibold text-primary text-base border-b pb-2">{project}</h4>
          {group.bullets.map((bullet, localIdx) => {
            const key = `${project}::${group.originalIndices[localIdx]}`
            const state = getState(key, bullet.clarifyingQuestions.length)
            return (
              <BulletCard
                key={key}
                bullet={bullet}
                bulletKey={key}
                targetRole={targetRole}
                state={state}
                onAnswersChange={(answers) => updateState(key, { answers })}
                onRewrite={() => handleRewrite(key, bullet)}
                onCopySuggested={() => handleCopySuggested(key, bullet.autoRewrite)}
                onCopyPersonalized={() => state.rewritten && handleCopyPersonalized(key, state.rewritten)}
                onTogglePersonalize={() => updateState(key, { personalizeOpen: !state.personalizeOpen })}
                copiedSuggested={copiedSuggestedKey === key}
                copiedPersonalized={copiedPersonalizedKey === key}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}
