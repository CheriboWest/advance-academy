'use client'

import { useState } from 'react'
import { BackLink } from '@/components/back-link'
import { finalizeCvVersion } from '@/features/cv-library/api/frontend-client'
import { useFakeProgress } from '@/shared/hooks/use-fake-progress'
import { ProgressBar } from '@/shared/components/progress-bar'
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react'
import type { ParsedBullet, Phase1Response } from '@/features/cv-library/types'

// ── Phase 2: Bullet resolution step ─────────────────────────────────────────

export function BulletResolutionStep({
  phase1,
  onDone,
  onBack,
}: {
  phase1: Phase1Response
  onDone: () => void
  onBack: () => void
}) {
  // For each bullet: which action? 'new' or 'merge' with an existing bulletId
  const [decisions, setDecisions] = useState<
    Map<string, { action: 'new' | 'merge'; existingBulletId?: string }>
  >(() => {
    const m = new Map<string, { action: 'new' | 'merge'; existingBulletId?: string }>()
    for (const pb of phase1.parsedBullets) {
      m.set(pb.tempId, { action: 'new' })
    }
    return m
  })
  const [err, setErr] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const mergedCount = [...decisions.values()].filter((d) => d.action === 'merge').length
  const newCount = phase1.parsedBullets.length - mergedCount
  // Adaptive TAU: gap generation is sequential per *new* bullet, ~4–10s each.
  // Floor 8s so single-bullet finalises don't feel jumpy.
  const finalizeTau = Math.max(8_000, newCount * 4_000)

  const {
    progress: finalizeProgress,
    phase: finalizePhase,
    busy,
    start: startFinalizeProgress,
    finish: finishFinalizeProgress,
    reset: resetFinalizeProgress,
  } = useFakeProgress({
    tauMs: finalizeTau,
    phaseLabel: (elapsedMs) => {
      if (elapsedMs < 3_000) return 'Saving your bullets…'
      if (elapsedMs < 12_000) return 'Generating 5 interview questions per new bullet…'
      return 'Still working — almost done…'
    },
  })

  const setDecision = (
    tempId: string,
    action: 'new' | 'merge',
    existingBulletId?: string,
  ) => {
    setDecisions((prev) => {
      const next = new Map(prev)
      next.set(tempId, { action, existingBulletId })
      return next
    })
  }

  const submit = async () => {
    setErr(null)
    setInfo(null)
    startFinalizeProgress()
    try {
      const resolutions = phase1.parsedBullets.map((pb) => {
        const d = decisions.get(pb.tempId) ?? { action: 'new' as const }
        return {
          tempId: pb.tempId,
          action: d.action,
          existingBulletId: d.existingBulletId,
        }
      })
      const res = await finalizeCvVersion(phase1.cvVersionId, { parsedBullets: phase1.parsedBullets, resolutions })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Finalize failed')
      }
      const data = await res.json()
      finishFinalizeProgress()
      setInfo(
        `Done! ${data.newBulletCount} new bullets, ${data.mergedBulletCount} merged, ${data.gapCount} gaps generated.`,
      )
      setTimeout(onDone, 1500)
    } catch (e) {
      resetFinalizeProgress()
      setErr(e instanceof Error ? e.message : 'Failed')
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <BackLink onClick={onBack} className="mb-4">
        Back
      </BackLink>
      <h1 className="text-3xl font-serif font-bold text-primary mb-2">Resolve bullet points</h1>
      <p className="text-muted-foreground mb-6">
        For each bullet we parsed, check if it&apos;s the same as one from a previous CV. Merging
        means the new CV will share that bullet&apos;s gaps and evidence — no re-typing.
      </p>

      <div className="mb-4 p-3 bg-card rounded-xl text-sm">
        <div className="flex items-center justify-between">
          <span>
            <strong>{phase1.parsedBullets.length}</strong> bullets parsed ·{' '}
            <strong>{mergedCount}</strong> will be merged ·{' '}
            <strong>{newCount}</strong> new
          </span>
          <button
            onClick={submit}
            disabled={busy}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Finalize'}
          </button>
        </div>
        {busy && <ProgressBar progress={finalizeProgress} phase={finalizePhase} />}
      </div>

      {err && (
        <p className="mb-4 text-xs text-red-600 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> {err}
        </p>
      )}
      {info && (
        <p className="mb-4 text-xs text-emerald-700 flex items-center gap-1.5">
          <CheckCircle className="w-3.5 h-3.5" /> {info}
        </p>
      )}

      <div className="space-y-4">
        {phase1.parsedBullets.map((pb) => (
          <BulletResolutionCard
            key={pb.tempId}
            parsed={pb}
            decision={decisions.get(pb.tempId) ?? { action: 'new' }}
            onDecide={(action, existingId) => setDecision(pb.tempId, action, existingId)}
          />
        ))}
      </div>
    </div>
  )
}

function BulletResolutionCard({
  parsed,
  decision,
  onDecide,
}: {
  parsed: ParsedBullet
  decision: { action: 'new' | 'merge'; existingBulletId?: string }
  onDecide: (action: 'new' | 'merge', existingBulletId?: string) => void
}) {
  const isMerged = decision.action === 'merge'
  const hasCandidates = parsed.candidates.length > 0

  return (
    <div
      className={`border rounded-xl p-4 ${
        isMerged ? 'border-emerald-200 bg-emerald-50/40' : 'bg-background'
      }`}
    >
      {parsed.sectionPath && (
        <p className="text-xs text-subtle-foreground mb-1">{parsed.sectionPath}</p>
      )}
      <p className="text-sm font-medium text-foreground mb-3">
        &ldquo;{parsed.bulletText}&rdquo;
      </p>

      <div className="space-y-2">
        {/* "This is new" option */}
        <label
          className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer border text-sm ${
            !isMerged ? 'border-primary/40 bg-primary/5' : 'hover:bg-card'
          }`}
        >
          <input
            type="radio"
            name={`resolve-${parsed.tempId}`}
            checked={!isMerged}
            onChange={() => onDecide('new')}
            className="accent-primary"
          />
          <span className="font-medium text-foreground">This is a new bullet (create fresh gaps)</span>
        </label>

        {/* Candidate matches */}
        {hasCandidates && (
          <p className="text-xs text-muted-foreground font-medium mt-2 mb-1">
            Or merge with an existing bullet:
          </p>
        )}
        {parsed.candidates.map((c) => (
          <label
            key={c.bulletId}
            className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer border text-sm ${
              isMerged && decision.existingBulletId === c.bulletId
                ? 'border-emerald-300 bg-emerald-50'
                : 'hover:bg-card'
            }`}
          >
            <input
              type="radio"
              name={`resolve-${parsed.tempId}`}
              checked={isMerged && decision.existingBulletId === c.bulletId}
              onChange={() => onDecide('merge', c.bulletId)}
              className="accent-emerald-600 mt-0.5"
            />
            <div className="flex-1">
              <p className="text-foreground">&ldquo;{c.bulletText}&rdquo;</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {c.sectionPath && `${c.sectionPath} · `}
                {c.similarity > 0 && `${Math.round(c.similarity * 100)}% similar · `}
                {c.answeredGapCount}/{c.gapCount} gaps filled
              </p>
            </div>
          </label>
        ))}
        {!hasCandidates && (
          <p className="text-xs text-subtle-foreground italic">No similar bullets found in previous CVs.</p>
        )}
      </div>
    </div>
  )
}
