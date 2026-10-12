'use client'

import type { IRSScore } from '@/features/interview-prep/types'
import { irsScoreColor, irsScoreLabel } from '@/shared/utils/score-utils'

interface IRSMeterProps {
  score: IRSScore
  compact?: boolean
}

function ScoreBar({
  label,
  score,
  rationale,
  compact,
}: {
  label: string
  score: number
  rationale?: string
  compact?: boolean
}) {
  const pct = (score / 10) * 100
  const color =
    score >= 8 ? 'bg-emerald-500' : score >= 6 ? 'bg-amber-500' : 'bg-red-500'

  return (
    <div className={compact ? 'space-y-0.5' : 'space-y-1'}>
      <div className="flex items-center justify-between">
        <span className={`font-medium text-foreground ${compact ? 'text-xs' : 'text-sm'}`}>
          {label}
        </span>
        <span
          className={`font-bold tabular-nums ${compact ? 'text-xs' : 'text-sm'} ${irsScoreColor(score)}`}
        >
          {score.toFixed(1)}
        </span>
      </div>
      <div className="w-full bg-card rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {!compact && rationale && (
        <p className="text-xs text-muted-foreground leading-relaxed">{rationale}</p>
      )}
    </div>
  )
}

export function IRSMeter({ score, compact = false }: IRSMeterProps) {
  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {!compact && (
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            IRS Score
          </span>
          <div className="flex items-center gap-1.5">
            <span className={`text-2xl font-bold tabular-nums ${irsScoreColor(score.overall ?? 0)}`}>
              {(score.overall ?? 0).toFixed(1)}
            </span>
            <span className="text-sm text-subtle-foreground">/10</span>
          </div>
        </div>
      )}
      {compact && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground font-medium">IRS</span>
          <span className={`text-sm font-bold ${irsScoreColor(score.overall ?? 0)}`}>
            {(score.overall ?? 0).toFixed(1)}/10 · {irsScoreLabel(score.overall ?? 0)}
          </span>
        </div>
      )}
      <ScoreBar
        label="Integrity"
        score={score.integrity.score}
        rationale={score.integrity.rationale}
        compact={compact}
      />
      <ScoreBar
        label="Relevance"
        score={score.relevance.score}
        rationale={score.relevance.rationale}
        compact={compact}
      />
      <ScoreBar
        label="Substance"
        score={score.substance.score}
        rationale={score.substance.rationale}
        compact={compact}
      />
    </div>
  )
}
