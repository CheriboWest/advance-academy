'use client'

import { useEffect, useMemo, useState } from 'react'
import { BackLink } from '@/components/back-link'
import { getInterviewSession, listInterviewSessions } from '@/features/interview-prep/api/frontend-client'
import {
  Loader2,
  AlertCircle,
  CheckCircle,
  Calendar,
  Clock,
  History,
  Briefcase,
  ChevronDown,
  MessageSquare,
  Sparkles,
  HelpCircle,
} from 'lucide-react'
import type {
  SessionListItem,
  SessionDetail,
  SessionExchange,
  SessionExchangeCoach,
  IRSScore,
} from '@/features/interview-prep/types'
import { PERSONAS } from '@/features/interview-prep/data/personas'
import { irsScoreColor, irsScoreLabel } from '@/shared/utils/score-utils'
import { IRSMeter } from '@/features/interview-prep/components/irs-meter'

export function InterviewHistoryScreen() {
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [selected, setSelected] = useState<SessionDetail | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchList()
  }, [])

  async function fetchList(cursor?: string) {
    if (cursor) setLoadingMore(true)
    else setLoadingList(true)
    setError(null)
    try {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      const res = await listInterviewSessions(query)
      if (!res.ok) throw new Error('Failed to load sessions')
      const data = await res.json()
      setSessions((previous) =>
        cursor ? [...previous, ...(data.sessions ?? [])] : (data.sessions ?? []),
      )
      setNextCursor(data.nextCursor ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    } finally {
      if (cursor) setLoadingMore(false)
      else setLoadingList(false)
    }
  }

  async function openSession(id: string) {
    setLoadingDetail(true)
    setError(null)
    try {
      const res = await getInterviewSession(id)
      if (!res.ok) throw new Error('Failed to load session')
      const data = await res.json()
      setSelected(data.session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session')
    } finally {
      setLoadingDetail(false)
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      {!selected ? (
        <ListView
          sessions={sessions}
          loading={loadingList}
          error={error}
          onOpen={openSession}
          openingId={loadingDetail}
          onLoadMore={() => nextCursor && fetchList(nextCursor)}
          hasMore={Boolean(nextCursor)}
          loadingMore={loadingMore}
        />
      ) : (
        <DetailView session={selected} onBack={() => setSelected(null)} />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// List
// ──────────────────────────────────────────────────────────────

function ListView({
  sessions,
  loading,
  error,
  onOpen,
  openingId,
  onLoadMore,
  hasMore,
  loadingMore,
}: {
  sessions: SessionListItem[]
  loading: boolean
  error: string | null
  onOpen: (id: string) => void
  openingId: boolean
  onLoadMore: () => void
  hasMore: boolean
  loadingMore: boolean
}) {
  return (
    <>
      <div className="mb-8">
        {/* h2, not h1: this screen now renders inside the History page, which
            owns the page-level heading. */}
        <h2 className="text-4xl font-serif font-bold text-primary mb-2 flex items-center gap-3">
          <History className="w-9 h-9 text-highlight-ink" />
          Interview History
        </h2>
        <p className="text-muted-foreground text-lg">
          Review your past mock interviews and feedback reports.
        </p>
      </div>

      {error && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {loading ? (
        <div className="bg-background rounded-xl border p-12 text-center">
          <Loader2 className="w-8 h-8 animate-spin text-highlight-ink mx-auto mb-3" />
          <p className="text-muted-foreground">Loading sessions…</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="bg-primary/5 rounded-xl p-12 text-center">
          <History className="w-12 h-12 text-primary/40 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-primary mb-2">
            No interviews yet
          </h2>
          <p className="text-muted-foreground">
            Complete your first mock interview to see it here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-3">
            {sessions.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                onClick={() => onOpen(s.id)}
                disabled={openingId}
              />
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore || openingId}
              className="mx-auto flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium text-primary hover:border-primary/40 disabled:opacity-50"
            >
              {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </>
  )
}

function SessionCard({
  session,
  onClick,
  disabled,
}: {
  session: SessionListItem
  onClick: () => void
  disabled: boolean
}) {
  const persona = PERSONAS.find((p) => p.id === session.persona_id)
  const overall = session.final_score_json?.overall ?? null
  const isComplete = session.status === 'complete'

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left bg-background rounded-xl border shadow-sm p-5 hover:border-primary/40 hover:shadow-md transition-all disabled:opacity-50"
    >
      <div className="flex items-start gap-4">
        <div className="text-4xl">{persona?.avatar ?? '🎙️'}</div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3 mb-1">
            <div>
              <h3 className="font-semibold text-primary">
                {persona?.name ?? session.persona_id}
                {session.context_json?.jobTitle && (
                  <span className="text-muted-foreground font-normal">
                    {' · '}
                    {session.context_json.jobTitle}
                  </span>
                )}
              </h3>
              {session.context_json?.companyName && (
                <p className="text-sm text-muted-foreground">
                  {session.context_json.companyName}
                </p>
              )}
            </div>

            <StatusBadge status={session.status} />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
            <span className="flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" />
              {formatDate(session.started_at)}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              {formatDuration(session.started_at, session.ended_at)}
            </span>
            <span className="capitalize">{session.mode.replace('_', ' ')}</span>
          </div>
        </div>

        {isComplete && overall != null && (
          <div className="text-right shrink-0">
            <div
              className={`text-3xl font-bold tabular-nums ${irsScoreColor(overall)}`}
            >
              {overall.toFixed(1)}
            </div>
            <div className="text-xs text-subtle-foreground">/10</div>
            <div className={`text-xs font-medium mt-0.5 ${irsScoreColor(overall)}`}>
              {irsScoreLabel(overall)}
            </div>
          </div>
        )}
      </div>
    </button>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    complete: 'bg-emerald-100 text-emerald-700',
    active: 'bg-primary/10 text-primary',
    evaluating: 'bg-amber-100 text-amber-700',
  }
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
        styles[status] ?? 'bg-card text-muted-foreground'
      }`}
    >
      {status}
    </span>
  )
}

// ──────────────────────────────────────────────────────────────
// Detail
// ──────────────────────────────────────────────────────────────

function DetailView({
  session,
  onBack,
}: {
  session: SessionDetail
  onBack: () => void
}) {
  const persona = PERSONAS.find((p) => p.id === session.persona_id)
  const score = session.final_score_json
  const report = session.final_report_json
  const overall = score?.overall ?? 0
  const exchanges = session.exchanges ?? []

  // Auto-select the first answered exchange so the IRS panel has something to show.
  const [selectedIdx, setSelectedIdx] = useState<number | null>(
    exchanges.length > 0 ? 0 : null,
  )

  const selectedScore: IRSScore | null = useMemo(() => {
    if (selectedIdx == null || !exchanges[selectedIdx]) return null
    return exchangeToIrsScore(exchanges[selectedIdx])
  }, [selectedIdx, exchanges])

  return (
    <div className="space-y-6">
      <BackLink onClick={onBack}>Back to history</BackLink>

      {/* Header card */}
      <div className="bg-background rounded-xl border shadow-sm p-8">
        <div className="flex items-start gap-4 mb-6">
          <div className="text-5xl">{persona?.avatar ?? '🎙️'}</div>
          <div className="flex-1">
            <h1 className="text-2xl font-serif font-bold text-primary">
              {persona?.name ?? session.persona_id}
            </h1>
            <p className="text-muted-foreground">{persona?.title}</p>
            {session.context_json?.jobTitle && (
              <p className="text-sm text-muted-foreground mt-2">
                <span className="font-medium">{session.context_json.jobTitle}</span>
                {session.context_json.companyName && (
                  <> · {session.context_json.companyName}</>
                )}
              </p>
            )}
          </div>
          <StatusBadge status={session.status} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm border-t border-border pt-5">
          <div>
            <div className="text-xs text-subtle-foreground uppercase tracking-wide">
              Started
            </div>
            <div className="text-foreground font-medium mt-0.5">
              {formatDateTime(session.started_at)}
            </div>
          </div>
          <div>
            <div className="text-xs text-subtle-foreground uppercase tracking-wide">
              Ended
            </div>
            <div className="text-foreground font-medium mt-0.5">
              {session.ended_at ? formatDateTime(session.ended_at) : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-subtle-foreground uppercase tracking-wide">
              Duration
            </div>
            <div className="text-foreground font-medium mt-0.5">
              {formatDuration(session.started_at, session.ended_at)}
            </div>
          </div>
          <div>
            <div className="text-xs text-subtle-foreground uppercase tracking-wide">
              Mode
            </div>
            <div className="text-foreground font-medium mt-0.5 capitalize">
              {session.mode.replace('_', ' ')}
            </div>
          </div>
        </div>
      </div>

      <JobContextCard ctx={session.context_json} />

      {/* Transcript + per-answer IRS panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <TranscriptView
            exchanges={exchanges}
            selectedIdx={selectedIdx}
            onSelect={setSelectedIdx}
          />
        </div>
        <div className="space-y-4">
          <SelectedAnswerPanel
            score={selectedScore}
            exchange={selectedIdx != null ? exchanges[selectedIdx] : null}
            answeredCount={exchanges.length}
          />
        </div>
      </div>

      {/* Overall score */}
      {score && (
        <div className="bg-background rounded-xl border shadow-sm p-8">
          <h3 className="text-sm font-semibold text-primary mb-4">
            Overall Session Score
          </h3>
          <div className="flex items-end gap-3 mb-6">
            <span
              className={`text-5xl font-bold tabular-nums ${irsScoreColor(overall)}`}
            >
              {overall.toFixed(1)}
            </span>
            <span className="text-xl text-subtle-foreground mb-1">/10</span>
            <span
              className={`ml-2 mb-2 text-sm font-semibold ${irsScoreColor(overall)}`}
            >
              {irsScoreLabel(overall)}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-4 text-sm">
            <ScoreStat label="Integrity" value={score.integrity} />
            <ScoreStat label="Relevance" value={score.relevance} />
            <ScoreStat label="Substance" value={score.substance} />
          </div>
        </div>
      )}

      {/* Final feedback report */}
      {report ? (
        <>
          {report.summary && (
            <div className="bg-background rounded-xl border shadow-sm p-6">
              <h3 className="text-sm font-semibold text-primary mb-3">
                Summary
              </h3>
              <p className="text-foreground leading-relaxed">{report.summary}</p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {report.strengths && report.strengths.length > 0 && (
              <div className="bg-background rounded-xl border shadow-sm p-6">
                <h3 className="text-sm font-semibold text-emerald-700 mb-4 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4" /> Strengths
                </h3>
                <div className="space-y-4">
                  {report.strengths.map((s, i) => (
                    <div key={i}>
                      <div className="font-semibold text-primary text-sm">
                        {s.title}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                        {s.detail}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {report.improvements && report.improvements.length > 0 && (
              <div className="bg-background rounded-xl border shadow-sm p-6">
                <h3 className="text-sm font-semibold text-amber-700 mb-4 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" /> Areas to Improve
                </h3>
                <div className="space-y-4">
                  {report.improvements.map((s, i) => (
                    <div key={i}>
                      <div className="font-semibold text-primary text-sm">
                        {s.title}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                        {s.detail}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="bg-primary/5 rounded-xl p-8 text-center text-muted-foreground">
          No final report available for this session yet.
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Job context card (collapsible — JD can be long)
// ──────────────────────────────────────────────────────────────

function JobContextCard({
  ctx,
}: {
  ctx: SessionDetail['context_json']
}) {
  const [expanded, setExpanded] = useState(false)
  if (!ctx) return null
  const extraLinksList = normalizeExtraLinks(ctx.extraLinks)
  const hasAnyField =
    ctx.jobTitle ||
    ctx.companyName ||
    ctx.companyUrl ||
    ctx.jobDescription ||
    extraLinksList.length > 0
  if (!hasAnyField) return null

  return (
    <div className="bg-background rounded-xl border shadow-sm">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between p-5 text-left hover:bg-card rounded-xl transition-colors"
      >
        <div className="flex items-center gap-3">
          <Briefcase className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold text-primary">
            Job context filled in for this session
          </h3>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="px-5 pb-5 pt-1 space-y-4 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ContextField label="Job title" value={ctx.jobTitle} />
            <ContextField label="Company" value={ctx.companyName} />
            <ContextField
              label="Company URL"
              value={ctx.companyUrl}
              isLink
            />
            <ExtraLinksField links={extraLinksList} />
          </div>
          {ctx.jobDescription && (
            <div>
              <div className="text-xs text-subtle-foreground uppercase tracking-wide mb-1">
                Job description
              </div>
              <pre className="text-sm text-foreground bg-card rounded-lg p-3 whitespace-pre-wrap font-sans leading-relaxed max-h-80 overflow-y-auto">
                {ctx.jobDescription}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Older sessions persisted extraLinks as a newline-separated string; newer
// ones use string[]. Normalize to string[] for display.
function normalizeExtraLinks(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
  if (typeof value === 'string') return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return []
}

function ExtraLinksField({ links }: { links: string[] }) {
  return (
    <div>
      <div className="text-xs text-subtle-foreground uppercase tracking-wide">Extra links</div>
      <div className="text-foreground mt-0.5 wrap-break-word">
        {links.length === 0 ? (
          <span className="text-subtle-foreground">—</span>
        ) : (
          <ul className="space-y-0.5">
            {links.map((url, idx) => (
              <li key={idx}>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline break-all"
                >
                  {url}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ContextField({
  label,
  value,
  isLink,
}: {
  label: string
  value: string | null | undefined
  isLink?: boolean
}) {
  return (
    <div>
      <div className="text-xs text-subtle-foreground uppercase tracking-wide">{label}</div>
      <div className="text-foreground mt-0.5 wrap-break-word">
        {value ? (
          isLink ? (
            <a
              href={value}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {value}
            </a>
          ) : (
            value
          )
        ) : (
          <span className="text-subtle-foreground">—</span>
        )}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Transcript (selectable candidate answers)
// ──────────────────────────────────────────────────────────────

function TranscriptView({
  exchanges,
  selectedIdx,
  onSelect,
}: {
  exchanges: SessionExchange[]
  selectedIdx: number | null
  onSelect: (idx: number) => void
}) {
  return (
    <div className="bg-background rounded-xl border shadow-sm p-6">
      <h3 className="text-sm font-semibold text-primary mb-4 flex items-center gap-2">
        <MessageSquare className="w-4 h-4" /> Conversation transcript
      </h3>
      {exchanges.length === 0 ? (
        <div className="text-center text-muted-foreground py-10">
          No answered exchanges recorded for this session.
        </div>
      ) : (
        <div className="space-y-4">
          {exchanges.map((ex, idx) => (
            <div key={idx} className="space-y-2">
              {/* Interviewer question */}
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-card text-foreground">
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {ex.question_text}
                  </p>
                </div>
              </div>
              {/* Candidate answer (clickable to select) */}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => onSelect(idx)}
                  className={`max-w-[85%] text-left rounded-2xl px-4 py-3 transition-all ${
                    selectedIdx === idx
                      ? 'bg-primary text-primary-foreground ring-2 ring-secondary ring-offset-2'
                      : 'bg-primary text-primary-foreground opacity-80 hover:opacity-100'
                  }`}
                >
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {ex.candidate_answer || (
                      <span className="italic opacity-60">(no answer text)</span>
                    )}
                  </p>
                  <div className="mt-2 pt-2 border-t border-primary/40 flex items-center justify-between text-xs">
                    <span className="opacity-80">Click for IRS breakdown</span>
                    <span className="font-bold tabular-nums">
                      IRS {ex.overall_score.toFixed(1)}/10
                    </span>
                  </div>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Right-side IRS panel for the selected answer
// ──────────────────────────────────────────────────────────────

function SelectedAnswerPanel({
  score,
  exchange,
  answeredCount,
}: {
  score: IRSScore | null
  exchange: SessionExchange | null
  answeredCount: number
}) {
  return (
    <>
      <div className="bg-background border rounded-xl p-4">
        <h3 className="text-sm font-semibold text-primary mb-3">
          Selected Answer Score
        </h3>
        {score && exchange ? (
          <IRSMeter score={score} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Click any candidate answer in the transcript to view its IRS breakdown.
          </p>
        )}
      </div>

      {exchange && exchange.coaches.length > 0 && (
        <CoachHistoryPanel coaches={exchange.coaches} />
      )}

      <div className="bg-background border rounded-xl p-4">
        <h3 className="text-sm font-semibold text-primary mb-3">
          Session Progress
        </h3>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Answers given</span>
          <span className="font-medium text-foreground">{answeredCount}</span>
        </div>
      </div>

      <div className="bg-primary/5 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-primary mb-3">IRS Rubric</h3>
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            <span className="font-semibold text-primary">I - Integrity (30%):</span>{' '}
            Authenticity, honesty, internal consistency
          </p>
          <p>
            <span className="font-semibold text-primary">R - Relevance (30%):</span>{' '}
            Addresses the question and target role
          </p>
          <p>
            <span className="font-semibold text-primary">S - Substance (40%):</span>{' '}
            Depth, specifics, examples, metrics
          </p>
        </div>
      </div>
    </>
  )
}

// Stacked read-only render of every coach generation stored for this answer.
// `coaches` is already newest-first (see backend `mapAllCoaches`); we label
// the latest as "v{N}" so users can tell at a glance which is the most recent.
function CoachHistoryPanel({ coaches }: { coaches: SessionExchangeCoach[] }) {
  const total = coaches.length
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-sm font-semibold text-primary flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-highlight-ink" />
          Enhanced Responses
        </h3>
        <span className="text-xs text-muted-foreground">
          {total} version{total === 1 ? '' : 's'}
        </span>
      </div>
      {coaches.map((coach, idxFromNewest) => (
        <CoachCard
          key={`${coach.created_at}-${idxFromNewest}`}
          coach={coach}
          versionLabel={`v${total - idxFromNewest}`}
          isLatest={idxFromNewest === 0}
        />
      ))}
    </div>
  )
}

function CoachCard({
  coach,
  versionLabel,
  isLatest,
}: {
  coach: SessionExchangeCoach
  versionLabel: string
  isLatest: boolean
}) {
  return (
    <div
      className={`rounded-xl p-4 space-y-4 border ${
        isLatest ? 'bg-background border-secondary/40 shadow-sm' : 'bg-card'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-semibold tabular-nums ${
              isLatest ? 'bg-secondary/15 text-highlight-ink' : 'bg-muted text-muted-foreground'
            }`}
          >
            {versionLabel}
          </span>
          {isLatest && (
            <span className="text-xs font-medium text-highlight-ink">Latest</span>
          )}
        </div>
        <span className="text-xs text-subtle-foreground" title={coach.created_at}>
          {formatDateTime(coach.created_at)}
        </span>
      </div>

      {coach.critique && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Critique
          </div>
          <p className="text-sm text-foreground leading-relaxed">{coach.critique}</p>
        </div>
      )}

      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
          Improved Answer
        </div>
        <div className="text-sm text-foreground leading-relaxed bg-secondary/10 rounded-lg p-3 whitespace-pre-wrap">
          <ImprovedAnswerWithPlaceholders text={coach.improved_answer} />
        </div>
      </div>

      {coach.missing_evidence_prompts.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1">
            <HelpCircle className="w-3.5 h-3.5" />
            Missing Evidence Prompts ({coach.missing_evidence_prompts.length})
          </div>
          <ul className="space-y-2">
            {coach.missing_evidence_prompts.map((p, i) => (
              <li key={i} className="text-sm text-foreground bg-background rounded-lg p-2.5 border border-border">
                <p className="font-medium">{p.question}</p>
                {p.bulletText && (
                  <p className="text-xs text-muted-foreground mt-1 italic">
                    Linked CV bullet: {p.bulletText}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const PLACEHOLDER_RE = /\[CANDIDATE TO FILL:\s*([^|\]]+)\|\s*([^\]]+)\]/g

// Highlight `[CANDIDATE TO FILL: ...]` placeholders inline so the reader can
// see exactly which facts the coach flagged as missing.
function ImprovedAnswerWithPlaceholders({ text }: { text: string }) {
  const parts: Array<string | { question: string }> = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  PLACEHOLDER_RE.lastIndex = 0
  while ((match = PLACEHOLDER_RE.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index))
    parts.push({ question: match[2].trim() })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))

  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : (
          <span
            key={i}
            className="inline-block bg-amber-100 border border-amber-300 text-amber-900 rounded px-1.5 py-0.5 text-xs font-medium mx-0.5"
            title="Missing evidence — flagged by the coach"
          >
            ⚠ {part.question}
          </span>
        ),
      )}
    </>
  )
}

function exchangeToIrsScore(ex: SessionExchange): IRSScore {
  return {
    integrity: { score: ex.integrity_score, rationale: ex.integrity_rationale ?? '' },
    relevance: { score: ex.relevance_score, rationale: ex.relevance_rationale ?? '' },
    substance: { score: ex.substance_score, rationale: ex.substance_rationale ?? '' },
    overall: ex.overall_score,
  }
}

function ScoreStat({ label, value }: { label: string; value: number | undefined }) {
  const v = value ?? 0
  return (
    <div className="bg-card rounded-lg p-3">
      <div className="text-xs text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      <div className={`text-2xl font-bold tabular-nums mt-1 ${irsScoreColor(v)}`}>
        {v.toFixed(1)}
        <span className="text-sm text-subtle-foreground font-normal">/10</span>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return 'In progress'
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime()
  const mins = Math.round(ms / 60000)
  if (mins < 1) return '<1 min'
  if (mins < 60) return `${mins} min`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`
}
