'use client'

import { CheckCircle, AlertCircle, RotateCcw } from 'lucide-react'
import { useInterview } from '@/features/interview-prep/hooks/use-interview'
import { IRSMeter } from '@/features/interview-prep/components/irs-meter'
import { irsScoreColor, irsScoreLabel } from '@/shared/utils/score-utils'

export function ReportStep({
  session,
  onNavigateHome,
  onNewInterview,
}: {
  session: NonNullable<ReturnType<typeof useInterview>['session']>
  onNavigateHome: () => void
  onNewInterview: () => void
}) {
  const report = session.finalReport!

  return (
    <div className="max-w-3xl mx-auto">
      <div className="text-center mb-8">
        <h2 className="text-3xl font-serif font-bold text-primary mb-2">Interview Complete</h2>
        <p className="text-muted-foreground">{report.summary}</p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <span className={`text-5xl font-bold tabular-nums ${irsScoreColor(report.overallIRS.overall)}`}>
            {report.overallIRS.overall.toFixed(1)}
          </span>
          <div className="text-left">
            <span className="text-lg text-subtle-foreground">/10</span>
            <p className={`text-sm font-semibold ${irsScoreColor(report.overallIRS.overall)}`}>
              {irsScoreLabel(report.overallIRS.overall)}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-background border rounded-xl p-6 mb-6">
        <h3 className="text-sm font-semibold text-primary mb-4">IRS Breakdown</h3>
        <IRSMeter score={report.overallIRS} />
      </div>

      <div className="mb-6">
        <h3 className="text-sm font-semibold text-emerald-700 mb-3 flex items-center gap-2">
          <CheckCircle className="w-4 h-4" /> Strengths
        </h3>
        <div className="space-y-3">
          {report.strengths.map((item, i) => (
            <div key={i} className="bg-emerald-50 border border-emerald-100 rounded-xl p-4">
              <h4 className="font-semibold text-emerald-800 text-sm mb-1">{item.title}</h4>
              <p className="text-sm text-emerald-700">{item.detail}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mb-8">
        <h3 className="text-sm font-semibold text-red-700 mb-3 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> Areas for Improvement
        </h3>
        <div className="space-y-3">
          {report.improvements.map((item, i) => (
            <div key={i} className="bg-red-50 border border-red-100 rounded-xl p-4">
              <h4 className="font-semibold text-red-800 text-sm mb-1">{item.title}</h4>
              <p className="text-sm text-red-700">{item.detail}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-center gap-4">
        <button
          onClick={onNavigateHome}
          className="px-5 py-2.5 text-muted-foreground hover:text-foreground border rounded-xl transition-colors"
        >
          Back to Home
        </button>
        <button
          onClick={onNewInterview}
          className="flex items-center gap-2 px-6 py-3 bg-secondary text-primary rounded-xl font-semibold hover:bg-secondary/90 transition-colors"
        >
          <RotateCcw className="w-4 h-4" /> New Interview
        </button>
      </div>
    </div>
  )
}
