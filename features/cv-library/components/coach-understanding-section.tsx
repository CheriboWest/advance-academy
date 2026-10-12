'use client'

// React 19 dropped the global JSX namespace; it's imported from 'react' now.
import { useEffect, useState, type JSX } from 'react'
import { BackLink } from '@/components/back-link'
import { generateCoachReport, getCoachReport, listCoachReports } from '@/features/cv-library/api/frontend-client'
import { useFakeProgress } from '@/shared/hooks/use-fake-progress'
import { ProgressBar } from '@/shared/components/progress-bar'
import { Loader2, AlertCircle, Brain, FileText, ChevronDown, ChevronUp } from 'lucide-react'
import type { CvVersionSummary } from '@/features/cv-library/types'

// ── Coach Understanding Section ─────────────────────────────────────────────

function coachReportPhaseLabel(elapsedMs: number): string {
  if (elapsedMs < 3_000) return 'Loading your bullets and evidence…'
  if (elapsedMs < 10_000) return 'Asking the AI coach to analyse your background…'
  if (elapsedMs < 25_000) return 'Identifying gaps and duplicates…'
  return 'Writing the report…'
}

export function CoachUnderstandingSection({
  versions,
  onViewReport,
}: {
  versions: CvVersionSummary[]
  onViewReport: (id: string) => void
}) {
  const [err, setErr] = useState<string | null>(null)
  const [reports, setReports] = useState<
    Array<{ id: string; createdAt: string; preview: string; cvVersionId: string | null }>
  >([])
  const [showReports, setShowReports] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState<string>('')
  const { progress, phase, busy: generating, start, finish, reset } = useFakeProgress({
    tauMs: 15_000,
    phaseLabel: coachReportPhaseLabel,
  })

  // Default the report to the active CV (fallback: first uploaded).
  useEffect(() => {
    if (selectedVersionId && versions.some((v) => v.id === selectedVersionId)) return
    const fallback = versions.find((v) => v.isActive) ?? versions[0]
    if (fallback) setSelectedVersionId(fallback.id)
  }, [versions, selectedVersionId])

  const selectedName = versions.find((v) => v.id === selectedVersionId)?.name

  const loadReports = async () => {
    try {
      const res = await listCoachReports()
      if (res.ok) setReports(await res.json())
    } catch {
      // non-fatal
    }
    setLoaded(true)
  }

  useEffect(() => {
    loadReports()
  }, [])

  const generate = async () => {
    setErr(null)
    start()
    try {
      const res = await generateCoachReport(selectedVersionId ? { cvVersionId: selectedVersionId } : {})
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.message || data?.error || 'Failed to generate report')
      }
      const data: { reportId: string } = await res.json()
      finish()
      await loadReports()
      await new Promise((r) => setTimeout(r, 250))
      onViewReport(data.reportId)
    } catch (e) {
      reset()
      setErr(e instanceof Error ? e.message : 'Failed')
    }
  }

  return (
    <div className="rounded-xl border border-purple-200 bg-purple-50/60 p-5 mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-purple-900 flex items-center gap-2">
          <Brain className="w-4 h-4" /> AI Coach Understanding
        </h2>
        {loaded && reports.length > 0 && (
          <button
            onClick={() => setShowReports((p) => !p)}
            className="flex items-center gap-1 text-xs text-purple-700 hover:text-purple-900"
          >
            {reports.length} past report{reports.length !== 1 ? 's' : ''}
            {showReports ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Generate a report showing what the AI coach currently knows about the selected CV,
        what&apos;s missing, and which bullet points might be duplicates worth merging.
      </p>
      {versions.length > 1 && (
        <div className="mb-3">
          <label className="block text-xs font-medium text-purple-900 mb-1">Report for CV</label>
          <select
            value={selectedVersionId}
            onChange={(e) => setSelectedVersionId(e.target.value)}
            disabled={generating}
            className="w-full sm:w-auto text-sm border border-purple-200 rounded-lg px-3 py-2 bg-background text-foreground disabled:opacity-40"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.isActive ? ' (Active)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      <button
        onClick={generate}
        disabled={generating || !selectedVersionId}
        className="flex items-center gap-2 px-4 py-2.5 bg-purple-700 text-primary-foreground rounded-xl text-sm font-semibold hover:bg-purple-600 disabled:opacity-40"
      >
        {generating ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" /> Generating report…
          </>
        ) : (
          <>
            <Brain className="w-4 h-4" />{' '}
            {selectedName
              ? `Get AI Coach's Understanding of ${selectedName}`
              : "Get AI Coach's Understanding About My Background"}
          </>
        )}
      </button>
      {generating && (
        <ProgressBar
          progress={progress}
          phase={phase}
          barClass="bg-purple-700"
          trackClass="bg-purple-100"
          labelClass="text-purple-900/70"
        />
      )}
      {err && (
        <p className="mt-2 text-xs text-red-600 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> {err}
        </p>
      )}

      {showReports && reports.length > 0 && (
        <div className="mt-3 space-y-2">
          {reports.map((r) => (
            <button
              key={r.id}
              onClick={() => onViewReport(r.id)}
              className="w-full text-left p-3 border border-purple-100 rounded-lg hover:bg-purple-50 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <FileText className="w-3.5 h-3.5 text-purple-500" />
                <span className="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleDateString()} {new Date(r.createdAt).toLocaleTimeString()}
                </span>
                <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-[10px] rounded-full">
                  {r.cvVersionId
                    ? versions.find((v) => v.id === r.cvVersionId)?.name ?? 'Deleted CV'
                    : 'All CVs'}
                </span>
              </div>
              <p className="text-xs text-foreground line-clamp-2">{r.preview}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Report Viewer ───────────────────────────────────────────────────────────

export function ReportViewer({ reportId, onBack }: { reportId: string; onBack: () => void }) {
  const [report, setReport] = useState<{ reportMd: string; createdAt: string } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      try {
        const res = await getCoachReport(reportId)
        if (res.ok) setReport(await res.json())
      } finally {
        setLoading(false)
      }
    })()
  }, [reportId])

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <BackLink onClick={onBack} className="mb-4">
        Back to CV Library
      </BackLink>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading report…
        </div>
      ) : report ? (
        <>
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-serif font-bold text-purple-900 flex items-center gap-2">
              <Brain className="w-6 h-6" /> Coach Understanding Report
            </h1>
            <span className="text-xs text-muted-foreground">
              {new Date(report.createdAt).toLocaleDateString()} {new Date(report.createdAt).toLocaleTimeString()}
            </span>
          </div>
          <div className="prose prose-sm max-w-none prose-headings:text-purple-900 prose-strong:text-foreground prose-li:text-foreground">
            <MarkdownRenderer content={report.reportMd} />
          </div>
        </>
      ) : (
        <p className="text-muted-foreground">Report not found.</p>
      )}
    </div>
  )
}

/**
 * Simple markdown renderer for the report. Handles headings, bold, bullets, and paragraphs.
 * For a real app you'd use react-markdown, but this avoids adding a dep.
 */
function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split('\n')
  const elements: JSX.Element[] = []
  let key = 0

  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (trimmed.startsWith('### ')) {
      elements.push(
        <h3 key={key++} className="text-lg font-semibold text-purple-900 mt-6 mb-2">
          {renderInline(trimmed.slice(4))}
        </h3>,
      )
    } else if (trimmed.startsWith('## ')) {
      elements.push(
        <h2 key={key++} className="text-xl font-bold text-purple-900 mt-8 mb-3">
          {renderInline(trimmed.slice(3))}
        </h2>,
      )
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      elements.push(
        <li key={key++} className="ml-4 text-sm text-foreground mb-1 list-disc">
          {renderInline(trimmed.slice(2))}
        </li>,
      )
    } else if (trimmed.length === 0) {
      elements.push(<div key={key++} className="h-2" />)
    } else {
      elements.push(
        <p key={key++} className="text-sm text-foreground mb-2 leading-relaxed">
          {renderInline(trimmed)}
        </p>,
      )
    }
  }

  return <>{elements}</>
}

function renderInline(text: string): (string | JSX.Element)[] {
  // Handle **bold** and "quoted bullet text"
  const parts: (string | JSX.Element)[] = []
  const re = /\*\*(.+?)\*\*|"(.+?)"/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    if (m[1]) {
      parts.push(<strong key={`b${i++}`} className="font-semibold text-foreground">{m[1]}</strong>)
    } else if (m[2]) {
      parts.push(<span key={`q${i++}`} className="italic text-muted-foreground">&ldquo;{m[2]}&rdquo;</span>)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
