'use client'

import { useCallback, useEffect, useState } from 'react'
import { BackLink } from '@/components/back-link'
import {
  addGapArtifact,
  findSimilarBullets,
  getCvVersionBullets,
  mergeBullets,
  skipGap,
  updateArtifact,
} from '@/features/cv-library/api/frontend-client'
import { Loader2, GitMerge, FileText, Pencil } from 'lucide-react'
import type {
  BulletWithGaps,
  CvVersionSummary,
  SimilarCandidate,
} from '@/features/cv-library/types'

// ── CV Detail: gap filling + manual merge ───────────────────────────────────

export function CvDetail({
  versionId,
  version,
  onBack,
}: {
  versionId: string
  version: CvVersionSummary | undefined
  onBack: () => void
}) {
  const [bullets, setBullets] = useState<BulletWithGaps[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getCvVersionBullets(versionId)
      if (res.ok) setBullets(await res.json())
    } finally {
      setLoading(false)
    }
  }, [versionId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const totalGaps = bullets.reduce((s, b) => s + b.gaps.length, 0)
  const filledGaps = bullets.reduce(
    (s, b) => s + b.gaps.filter((g) => g.status !== 'open').length,
    0,
  )

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <BackLink onClick={onBack} className="mb-4">
        Back to library
      </BackLink>
      <h1 className="text-3xl font-serif font-bold text-primary mb-1">Fill in the gaps</h1>
      {version && (
        <div className="mb-3">
          <p className="text-base text-primary font-medium flex items-center gap-2">
            <FileText className="w-4 h-4" />
            Working on: <span className="font-semibold">{version.name}</span>
            {version.isActive && (
              <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs rounded-full font-medium">
                Active
              </span>
            )}
          </p>
          <p className="text-xs text-subtle-foreground mt-0.5 italic">
            {version.sourceFilePath
              ? `Uploaded from ${version.sourceFilePath}`
              : "Cannot find source file's path"}
          </p>
        </div>
      )}
      <p className="text-muted-foreground mb-6">
        For each bullet on your CV, answer the most important questions an interviewer would ask.
        Shared bullets show evidence from all linked CV versions.
      </p>

      <div className="mb-6 p-3 bg-card rounded-xl text-sm">
        <strong>{filledGaps}</strong> of {totalGaps} gaps filled
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading bullets…
        </div>
      ) : (
        <div className="space-y-6">
          {bullets.map((b, i) => (
            <BulletCard key={b.id} bullet={b} index={i + 1} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  )
}

function BulletCard({
  bullet,
  index,
  onChanged,
}: {
  bullet: BulletWithGaps
  index: number
  onChanged: () => void
}) {
  const [mergeMode, setMergeMode] = useState(false)
  const [candidates, setCandidates] = useState<SimilarCandidate[]>([])
  const [mergeLoading, setMergeLoading] = useState(false)

  const loadSimilar = async () => {
    setMergeLoading(true)
    try {
      const res = await findSimilarBullets(bullet.id)
      if (res.ok) setCandidates(await res.json())
      setMergeMode(true)
    } finally {
      setMergeLoading(false)
    }
  }

  const doMerge = async (targetId: string) => {
    if (!confirm('Merge this bullet into the selected one? Its gaps will be combined.')) return
    setMergeLoading(true)
    try {
      await mergeBullets({ sourceBulletId: bullet.id, targetBulletId: targetId })
      setMergeMode(false)
      onChanged()
    } finally {
      setMergeLoading(false)
    }
  }

  return (
    <div className="border rounded-xl p-5 bg-background">
      <p className="text-xs font-bold uppercase tracking-wide text-primary mb-1">
        CV bullet point {index}
      </p>
      {bullet.sectionPath && (
        <p className="text-xs text-subtle-foreground mb-1">{bullet.sectionPath}</p>
      )}
      <div className="flex items-start justify-between gap-2 mb-4">
        <p className="text-sm font-medium text-foreground">&ldquo;{bullet.bulletText}&rdquo;</p>
        <button
          onClick={loadSimilar}
          disabled={mergeLoading}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary shrink-0"
          title="Merge with another bullet"
        >
          {mergeLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />}
          Merge
        </button>
      </div>

      {mergeMode && (
        <div className="mb-4 border border-primary/20 bg-primary/5 rounded-lg p-3">
          <p className="text-xs font-medium text-primary mb-2">
            Merge into one of these similar bullets:
          </p>
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No similar bullets found.</p>
          ) : (
            <div className="space-y-2">
              {candidates.map((c) => (
                <button
                  key={c.bulletId}
                  onClick={() => doMerge(c.bulletId)}
                  className="w-full text-left p-2 rounded border hover:border-emerald-300 hover:bg-emerald-50 text-sm"
                >
                  <p className="text-foreground">&ldquo;{c.bulletText}&rdquo;</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {c.similarity > 0 && `${Math.round(c.similarity * 100)}% · `}
                    {c.answeredGapCount}/{c.gapCount} gaps filled
                  </p>
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => setMergeMode(false)}
            className="mt-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="space-y-3">
        {bullet.gaps.map((g) => (
          <GapForm key={g.id} gap={g} onChanged={onChanged} />
        ))}
      </div>
    </div>
  )
}

function ArtifactRow({
  artifact,
  onChanged,
}: {
  artifact: BulletWithGaps['gaps'][number]['artifacts'][number]
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

  const cancel = () => {
    setEditing(false)
    setErr(null)
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
        throw new Error(data?.error || 'Failed to update')
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
      <div className="border border-emerald-200 bg-emerald-50/30 rounded p-2">
        <p className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-1">
          Editing {artifact.sourceType}
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          disabled={busy}
          className="w-full p-2 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-emerald-300 resize-y min-h-20 bg-background"
        />
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={save}
            disabled={busy || !text.trim()}
            className="px-3 py-1 text-xs bg-emerald-700 text-primary-foreground rounded font-medium hover:bg-emerald-600 disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
          </button>
          <button
            onClick={cancel}
            disabled={busy}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          {busy && (
            <span className="text-xs text-muted-foreground italic">
              Re-summarising — this may take a few seconds…
            </span>
          )}
        </div>
      </div>
    )
  }

  const preview =
    artifact.contentText?.slice(0, 200) || artifact.sourceUrl || '(no content)'

  return (
    <div className="flex items-start gap-2 group">
      <p className="flex-1 text-xs text-emerald-700 line-clamp-2">
        ✓ {artifact.sourceType.toUpperCase()}: {preview}
      </p>
      <button
        onClick={startEdit}
        className="flex items-center gap-1 text-xs text-subtle-foreground hover:text-emerald-700 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        title="Edit this answer"
      >
        <Pencil className="w-3 h-3" /> Edit
      </button>
    </div>
  )
}

function GapForm({
  gap,
  onChanged,
}: {
  gap: BulletWithGaps['gaps'][number]
  onChanged: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!text.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const res = await addGapArtifact(gap.id, { text: text.trim() })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed')
      }
      setText('')
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const skip = async () => {
    setBusy(true)
    try {
      await skipGap(gap.id)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const isAnswered = gap.status === 'answered'
  const isSkipped = gap.status === 'skipped'

  return (
    <div
      className={`border rounded-lg p-3 ${
        isAnswered
          ? 'border-emerald-200 bg-emerald-50/40'
          : isSkipped
            ? 'bg-card'
            : 'border-border'
      }`}
    >
      <div className="flex items-start gap-2 mb-2">
        <span
          className={`mt-0.5 text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center ${
            isAnswered
              ? 'bg-emerald-500 text-primary-foreground'
              : isSkipped
                ? 'bg-muted text-muted-foreground'
                : 'bg-secondary text-primary'
          }`}
        >
          {gap.ordinal}
        </span>
        <div className="flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Bullet gap {gap.ordinal}
          </p>
          <p className="text-sm font-medium text-foreground">{gap.question}</p>
          {gap.rationale && <p className="text-xs text-muted-foreground mt-0.5">{gap.rationale}</p>}
        </div>
      </div>

      {gap.artifacts.length > 0 && (
        <div className="mb-2 space-y-2">
          {gap.artifacts.map((a) => (
            <ArtifactRow key={a.id} artifact={a} onChanged={onChanged} />
          ))}
        </div>
      )}

      {!isSkipped && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type or paste your answer. Drag the corner to make this bigger."
            rows={4}
            className="w-full p-2 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-ring resize-y min-h-20"
          />
          {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={submit}
              disabled={busy || !text.trim()}
              className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded font-medium hover:bg-primary/90 disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
            </button>
            {!isAnswered && (
              <button
                onClick={skip}
                disabled={busy}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Skip
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
