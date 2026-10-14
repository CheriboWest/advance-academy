'use client'

import { useEffect, useMemo, useState } from 'react'
import { addGapArtifact, getBulletDetails, updateArtifact } from '@/features/cv-library/api/frontend-client'
import {
  Loader2,
  RotateCcw,
  Sparkles,
  Wand2,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  Search,
  Pencil,
} from 'lucide-react'
import type { InterviewMessage, CoachPreview, CoachPreviewBullet, UserBulletSummaryDto } from '@/features/interview-prep/types'

export function CoachPanel({
  message,
  onRequestCoachPreview,
  onRequestCoachGenerate,
  onSetCoachPreview,
  onSubmitJit,
}: {
  message: InterviewMessage
  onRequestCoachPreview: (id: string) => Promise<void>
  onRequestCoachGenerate: (id: string, selectedBulletIds: string[]) => Promise<void>
  onSetCoachPreview: (id: string, coachPreview: CoachPreview) => void
  onSubmitJit: (id: string, idx: number, answer: string, selectedBulletIds: string[]) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [generateBusy, setGenerateBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const preview = message.coachPreview
  const coach = message.coach

  // Seed user-editable selection from the embedding-preselected list the
  // first time a preview lands. After that the user owns it.
  useEffect(() => {
    if (preview && selectedIds === null) {
      setSelectedIds(preview.selectedBulletIds)
    }
  }, [preview, selectedIds])

  const effectiveSelected = selectedIds ?? preview?.selectedBulletIds ?? []

  const handleToggleOpen = async () => {
    if (!preview && !previewBusy) {
      setPreviewBusy(true)
      try {
        await onRequestCoachPreview(message.id)
      } finally {
        setPreviewBusy(false)
      }
    }
    setOpen((o) => !o)
  }

  const handleRefreshBullet = async (bulletId: string) => {
    if (!preview) return
    try {
      const res = await getBulletDetails(bulletId)
      if (!res.ok) return
      const detail = (await res.json()) as BulletWithGapsDto
      const updatedBullet: CoachPreviewBullet = adaptBulletDetail(detail, currentSimilarity(preview, bulletId))
      onSetCoachPreview(message.id, {
        ...preview,
        bullets: preview.bullets.some((b) => b.id === bulletId)
          ? preview.bullets.map((b) => (b.id === bulletId ? updatedBullet : b))
          : [...preview.bullets, updatedBullet],
        // Bump answered counts in the lightweight pool too so the picker stays accurate.
        allBullets: preview.allBullets.map((b) =>
          b.id === bulletId
            ? {
                ...b,
                gapCount: updatedBullet.gaps.length,
                answeredGapCount: updatedBullet.gaps.filter((g) => g.status === 'answered').length,
              }
            : b,
        ),
      })
    } catch {
      // non-fatal — UI just won't refresh, user can re-expand to retry
    }
  }

  const handleAddBullet = async (bulletId: string) => {
    if (!preview) return
    if (effectiveSelected.includes(bulletId)) {
      setPickerOpen(false)
      return
    }
    // If we already have its details, just add to the selection.
    if (preview.bullets.some((b) => b.id === bulletId)) {
      setSelectedIds([...effectiveSelected, bulletId])
      setPickerOpen(false)
      return
    }
    // Otherwise lazy-load the bullet's gaps + raw artifacts.
    try {
      const res = await getBulletDetails(bulletId)
      if (!res.ok) return
      const detail = (await res.json()) as BulletWithGapsDto
      const newBullet = adaptBulletDetail(detail, 0)
      onSetCoachPreview(message.id, {
        ...preview,
        bullets: [...preview.bullets, newBullet],
      })
      setSelectedIds([...effectiveSelected, bulletId])
      setPickerOpen(false)
    } catch {
      // ignore — user can retry
    }
  }

  const handleRemoveBullet = (bulletId: string) => {
    setSelectedIds(effectiveSelected.filter((id) => id !== bulletId))
  }

  const handleGenerate = async () => {
    if (generateBusy) return
    setGenerateBusy(true)
    try {
      await onRequestCoachGenerate(message.id, effectiveSelected)
    } finally {
      setGenerateBusy(false)
    }
  }

  // Bullets the user has currently selected, in selection order, joined with
  // their preview details (gaps + raw artifacts).
  const selectedBullets: CoachPreviewBullet[] = useMemo(() => {
    if (!preview) return []
    const byId = new Map(preview.bullets.map((b) => [b.id, b]))
    return effectiveSelected
      .map((id) => byId.get(id))
      .filter((b): b is CoachPreviewBullet => Boolean(b))
  }, [preview, effectiveSelected])

  return (
    <div className="flex justify-end mt-2">
      <div className="max-w-[80%] w-full">
        <button
          onClick={handleToggleOpen}
          disabled={previewBusy}
          className="flex items-center gap-1.5 text-xs text-primary hover:text-primary font-medium ml-auto"
        >
          {previewBusy ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" /> Loading evidence…
            </>
          ) : (
            <>
              <Wand2 className="w-3 h-3" />
              {coach
                ? open
                  ? 'Hide enhanced version'
                  : 'Show enhanced version'
                : preview
                  ? open
                    ? 'Hide evidence panel'
                    : 'Review evidence'
                  : 'See enhanced version'}
            </>
          )}
        </button>

        {open && preview && (
          <div className="mt-2 border border-primary/20 bg-primary/5 rounded-xl p-4 space-y-3">
            {!coach && (
              <>
                <div>
                  <p className="text-xs font-semibold text-primary mb-0.5">
                    Evidence the AI coach will use
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Top {preview.bullets.length || '0'} bullet
                    {preview.bullets.length === 1 ? '' : 's'} retrieved by similarity
                    (≥ {Math.round(preview.threshold * 100)}%). Add or remove bullets to control
                    what the coach sees. Raw evidence stays here — only structured summaries are
                    sent to the AI.
                  </p>
                </div>

                {selectedBullets.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-primary/20 p-3 text-xs text-muted-foreground italic">
                    No bullets selected. Add at least one from your CV pool below — or click
                    Generate anyway to let the coach work from your answer alone (expect more
                    placeholders).
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {selectedBullets.map((b) => (
                      <CoachBulletRow
                        key={b.id}
                        bullet={b}
                        onRemove={() => handleRemoveBullet(b.id)}
                        onChanged={() => handleRefreshBullet(b.id)}
                      />
                    ))}
                  </ul>
                )}

                <div>
                  {pickerOpen ? (
                    <CoachBulletPicker
                      allBullets={preview.allBullets}
                      excludeIds={effectiveSelected}
                      onPick={handleAddBullet}
                      onClose={() => setPickerOpen(false)}
                    />
                  ) : (
                    <button
                      onClick={() => setPickerOpen(true)}
                      className="flex items-center gap-1 text-xs text-primary hover:text-primary font-medium"
                    >
                      <Plus className="w-3 h-3" /> Add a CV bullet
                    </button>
                  )}
                </div>

                <div className="pt-2 border-t border-primary/20 flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">
                    {selectedBullets.length} bullet
                    {selectedBullets.length === 1 ? '' : 's'} will be sent to the coach
                  </span>
                  <button
                    onClick={handleGenerate}
                    disabled={generateBusy}
                    className="px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {generateBusy ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" /> Generating…
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3 h-3" /> Generate enhanced response
                      </>
                    )}
                  </button>
                </div>
              </>
            )}

            {coach && (
              <div>
                {coach.critique && (
                  <p className="text-xs text-muted-foreground italic mb-2">{coach.critique}</p>
                )}
                <div className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                  {renderImproved(coach.improvedAnswer)}
                </div>
                {coach.missingEvidencePrompts.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-primary/20 space-y-2">
                    <p className="text-xs font-semibold text-primary">
                      Help me fill in the missing details:
                    </p>
                    {coach.missingEvidencePrompts.map((p, i) => (
                      <JitForm
                        key={`${message.id}-${i}`}
                        question={p.question}
                        bulletText={p.bulletText}
                        onSubmit={(answer) => onSubmitJit(message.id, i, answer, effectiveSelected)}
                      />
                    ))}
                  </div>
                )}
                <div className="mt-3 pt-2 border-t border-primary/20 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>
                    Used {selectedBullets.length} bullet{selectedBullets.length === 1 ? '' : 's'}
                  </span>
                  <button
                    onClick={handleGenerate}
                    disabled={generateBusy}
                    className="text-primary hover:text-primary font-medium flex items-center gap-1"
                    title="Regenerate with the same selection"
                  >
                    {generateBusy ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <RotateCcw className="w-3 h-3" />
                    )}
                    Regenerate
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Shape the /api/cv-library/bullets/:id/details proxy returns. Same as the
// CV-Library page's BulletWithGaps but with raw artifact `contentText`.
interface BulletWithGapsDto {
  id: string
  sectionPath: string | null
  bulletText: string
  ordinal: number
  gaps: Array<{
    id: string
    question: string
    rationale: string | null
    ordinal: number
    status: 'open' | 'answered' | 'skipped'
    artifacts: Array<{
      id: string
      sourceType: 'text' | 'file' | 'url' | 'jit_clarification'
      contentText: string | null
      sourceUrl: string | null
      summary: unknown
      createdAt: string
    }>
  }>
}

function adaptBulletDetail(detail: BulletWithGapsDto, similarity: number): CoachPreviewBullet {
  return {
    id: detail.id,
    bulletText: detail.bulletText,
    sectionPath: detail.sectionPath,
    similarity,
    gaps: detail.gaps.map((g) => ({
      id: g.id,
      question: g.question,
      status: g.status,
      artifacts: g.artifacts.map((a) => ({
        id: a.id,
        sourceType: a.sourceType,
        contentText: a.contentText,
        sourceUrl: a.sourceUrl,
        createdAt: a.createdAt,
      })),
    })),
  }
}

function currentSimilarity(preview: CoachPreview, bulletId: string): number {
  return preview.bullets.find((b) => b.id === bulletId)?.similarity ?? 0
}

function CoachBulletRow({
  bullet,
  onRemove,
  onChanged,
}: {
  bullet: CoachPreviewBullet
  onRemove: () => void
  onChanged: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const artifactCount = bullet.gaps.reduce((s, g) => s + g.artifacts.length, 0)

  return (
    <li className="border border-primary/20 bg-background rounded-lg">
      <div className="flex items-start gap-2 p-2.5">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="mt-0.5 text-subtle-foreground hover:text-primary shrink-0"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>
        <div className="flex-1 min-w-0">
          {bullet.sectionPath && (
            <p className="text-[10px] text-subtle-foreground mb-0.5">{bullet.sectionPath}</p>
          )}
          <p className="text-xs text-foreground leading-snug">{bullet.bulletText}</p>
          <p className="text-[10px] text-muted-foreground mt-1">
            {bullet.similarity > 0 && (
              <span className="mr-2">{Math.round(bullet.similarity * 100)}% match</span>
            )}
            <span>
              {artifactCount} artifact{artifactCount === 1 ? '' : 's'} · {bullet.gaps.length} gap
              {bullet.gaps.length === 1 ? '' : 's'}
            </span>
          </p>
        </div>
        <button
          onClick={onRemove}
          className="text-subtle-foreground hover:text-red-600 shrink-0"
          title="Remove from coach evidence"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {expanded && (
        <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-primary/10">
          {bullet.gaps.length === 0 ? (
            <p className="text-[11px] text-subtle-foreground italic">No gaps generated for this bullet.</p>
          ) : (
            bullet.gaps.map((gap) => (
              <CoachGapBlock
                key={gap.id}
                gap={gap}
                onChanged={onChanged}
              />
            ))
          )}
        </div>
      )}
    </li>
  )
}

function CoachGapBlock({
  gap,
  onChanged,
}: {
  gap: CoachPreviewBullet['gaps'][number]
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  return (
    <div>
      <p className="text-[11px] font-medium text-foreground">{gap.question}</p>
      {gap.artifacts.length === 0 ? (
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
            unanswered
          </span>
          {!adding && (
            <button
              onClick={() => setAdding(true)}
              className="text-[11px] text-primary hover:text-primary font-medium flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add answer
            </button>
          )}
        </div>
      ) : (
        <div className="mt-1 space-y-1">
          {gap.artifacts.map((a) => (
            <CoachArtifactView
              key={a.id}
              artifact={a}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
      {adding && (
        <CoachArtifactComposer
          gapId={gap.id}
          onSaved={() => {
            setAdding(false)
            onChanged()
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  )
}

function CoachArtifactView({
  artifact,
  onChanged,
}: {
  artifact: CoachPreviewBullet['gaps'][number]['artifacts'][number]
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(artifact.contentText ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const startEdit = () => {
    setText(artifact.contentText ?? '')
    setErr(null)
    setEditing(true)
  }

  const save = async () => {
    if (!text.trim() || text.trim() === artifact.contentText?.trim()) {
      setEditing(false)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const res = await updateArtifact(artifact.id, { text: text.trim() })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || data?.message || 'Failed to update')
      }
      setEditing(false)
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="border border-emerald-200 bg-emerald-50/40 rounded p-2">
        <p className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-1">
          Editing {artifact.sourceType}
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          disabled={busy}
          className="w-full p-2 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-emerald-300 resize-y min-h-16 bg-background"
        />
        {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
        <div className="flex items-center gap-2 mt-1.5">
          <button
            onClick={save}
            disabled={busy || !text.trim()}
            className="px-2.5 py-1 text-[11px] bg-emerald-700 text-primary-foreground rounded font-medium hover:bg-emerald-600 disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
          </button>
          <button
            onClick={() => setEditing(false)}
            disabled={busy}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          {busy && (
            <span className="text-[10px] text-muted-foreground italic">Re-summarising…</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="group rounded border bg-card/60 p-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] uppercase tracking-wide text-emerald-700 font-semibold">
          ✓ {artifact.sourceType}
        </span>
        <button
          onClick={startEdit}
          className="flex items-center gap-1 text-[10px] text-subtle-foreground hover:text-emerald-700 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          title="Edit this answer"
        >
          <Pencil className="w-3 h-3" /> Edit
        </button>
      </div>
      <p className="mt-0.5 text-[11px] text-foreground whitespace-pre-wrap leading-snug">
        {artifact.contentText || artifact.sourceUrl || '(no content)'}
      </p>
    </div>
  )
}

function CoachArtifactComposer({
  gapId,
  onSaved,
  onCancel,
}: {
  gapId: string
  onSaved: () => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setErr(null)
    try {
      const res = await addGapArtifact(gapId, { text: text.trim() })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || data?.message || 'Failed')
      }
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-1 border border-amber-200 bg-amber-50/50 rounded p-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type the evidence (a paragraph, project blurb, etc.)…"
        rows={3}
        disabled={busy}
        className="w-full p-2 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-amber-300 resize-y min-h-16 bg-background"
      />
      {err && <p className="text-[11px] text-red-600 mt-1">{err}</p>}
      <div className="flex items-center gap-2 mt-1.5">
        <button
          onClick={submit}
          disabled={busy || !text.trim()}
          className="px-2.5 py-1 text-[11px] bg-amber-700 text-primary-foreground rounded font-medium hover:bg-amber-600 disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        {busy && <span className="text-[10px] text-muted-foreground italic">Summarising…</span>}
      </div>
    </div>
  )
}

function CoachBulletPicker({
  allBullets,
  excludeIds,
  onPick,
  onClose,
}: {
  allBullets: UserBulletSummaryDto[]
  excludeIds: string[]
  onPick: (bulletId: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const exclude = useMemo(() => new Set(excludeIds), [excludeIds])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allBullets
      .filter((b) => !exclude.has(b.id))
      .filter((b) =>
        !q ||
        b.bulletText.toLowerCase().includes(q) ||
        (b.sectionPath ?? '').toLowerCase().includes(q),
      )
      .slice(0, 30)
  }, [allBullets, exclude, query])

  return (
    <div className="border border-primary/20 bg-background rounded-lg p-2">
      <div className="flex items-center gap-2 mb-2">
        <Search className="w-3 h-3 text-subtle-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your CV bullets…"
          className="flex-1 text-xs p-1 border rounded focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button onClick={onClose} className="text-subtle-foreground hover:text-foreground" title="Close picker">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic px-1">
          {allBullets.length === 0
            ? 'No bullets in your CV pool yet.'
            : 'No matches — adjust the search.'}
        </p>
      ) : (
        <ul className="max-h-56 overflow-y-auto space-y-1">
          {filtered.map((b) => (
            <li key={b.id}>
              <button
                onClick={() => onPick(b.id)}
                className="w-full text-left p-1.5 rounded border hover:border-primary/40 hover:bg-primary/10"
              >
                {b.sectionPath && (
                  <p className="text-[10px] text-subtle-foreground">{b.sectionPath}</p>
                )}
                <p className="text-[11px] text-foreground line-clamp-2">{b.bulletText}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {b.answeredGapCount}/{b.gapCount} gaps filled
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function renderImproved(text: string) {
  // Highlight [CANDIDATE TO FILL: bulletId|question] placeholders
  const parts: Array<string | { ph: string }> = []
  const re = /\[CANDIDATE TO FILL:[^\]]+\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push({ ph: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.map((p, i) =>
    typeof p === 'string' ? (
      <span key={i}>{p}</span>
    ) : (
      <span
        key={i}
        className="inline-block bg-secondary/25 text-highlight-ink px-1.5 py-0.5 rounded text-xs font-medium mx-0.5"
      >
        {p.ph.replace(/\[CANDIDATE TO FILL:\s*[^|]+\|\s*([^\]]+)\]/, '?? $1')}
      </span>
    ),
  )
}

function JitForm({
  question,
  bulletText,
  onSubmit,
}: {
  question: string
  bulletText: string | null
  onSubmit: (answer: string) => Promise<void>
}) {
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="bg-background border border-secondary/40 rounded-lg p-2">
      <p className="text-xs font-medium text-foreground mb-0.5">{question}</p>
      {bulletText && <p className="text-[10px] text-subtle-foreground mb-1 truncate">re: {bulletText}</p>}
      <div className="flex gap-1.5">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="Type your answer…"
          className="flex-1 text-xs p-1.5 border rounded focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={async () => {
            if (!val.trim() || busy) return
            setBusy(true)
            try {
              await onSubmit(val.trim())
              setVal('')
            } finally {
              setBusy(false)
            }
          }}
          disabled={busy || !val.trim()}
          className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded font-medium disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
        </button>
      </div>
    </div>
  )
}
