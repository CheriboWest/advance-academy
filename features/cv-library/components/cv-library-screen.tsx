'use client'

// React 19 dropped the global JSX namespace; it's imported from 'react' now.
import { useCallback, useEffect, useState, type JSX } from 'react'
import { BackLink } from '@/components/back-link'
import {
  activateCvVersion,
  addGapArtifact,
  deleteCvVersion,
  finalizeCvVersion,
  findSimilarBullets,
  generateCoachReport,
  getCoachReport,
  getCvVersionBullets,
  listCoachReports,
  listCvVersions,
  mergeBullets,
  skipGap,
  updateArtifact,
  uploadCvVersion,
} from '@/features/cv-library/api/frontend-client'
import { useFakeProgress } from '@/shared/hooks/use-fake-progress'
import { ProgressBar } from '@/shared/components/progress-bar'
import {
  Loader2,
  Upload,
  Trash2,
  CheckCircle,
  AlertCircle,
  GitMerge,
  Brain,
  FileText,
  ChevronDown,
  ChevronUp,
  Pencil,
} from 'lucide-react'

interface CvVersionSummary {
  id: string
  name: string
  detectedField: 'tech' | 'business' | 'marketing' | null
  isActive: boolean
  bulletCount: number
  openGapCount: number
  createdAt: string
  sourceFilePath: string | null
}

interface BulletWithGaps {
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

interface SimilarCandidate {
  bulletId: string
  bulletText: string
  sectionPath: string | null
  similarity: number
  gapCount: number
  answeredGapCount: number
}

interface ParsedBullet {
  tempId: string
  bulletText: string
  sectionPath: string | null
  candidates: SimilarCandidate[]
}

interface Phase1Response {
  cvVersionId: string
  detectedField: string | null
  parsedBullets: ParsedBullet[]
}

// ── Root screen ─────────────────────────────────────────────────────────────

export function CvLibraryScreen() {
  const [versions, setVersions] = useState<CvVersionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [phase1, setPhase1] = useState<Phase1Response | null>(null)
  const [viewingReportId, setViewingReportId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listCvVersions()
      if (!res.ok) throw new Error('Failed to load CVs')
      setVersions(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // View a single report
  if (viewingReportId) {
    return (
      <ReportViewer
        reportId={viewingReportId}
        onBack={() => setViewingReportId(null)}
      />
    )
  }

  // Phase 2: resolve bullets
  if (phase1) {
    return (
      <BulletResolutionStep
        phase1={phase1}
        onDone={() => {
          setPhase1(null)
          refresh()
        }}
        onBack={() => setPhase1(null)}
      />
    )
  }

  if (selectedId) {
    const selectedVersion = versions.find((v) => v.id === selectedId)
    return (
      <CvDetail
        versionId={selectedId}
        version={selectedVersion}
        onBack={() => {
          setSelectedId(null)
          refresh()
        }}
      />
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-4xl font-serif font-bold text-primary mb-2">CV Library</h1>
        <p className="text-muted-foreground text-lg">
          Upload a CV once. We&apos;ll extract every bullet, find the 5 most important missing details
          per bullet, and store the evidence you provide so future interviews can use it.
        </p>
      </div>

      <UploadCard onParsed={setPhase1} />

      <CoachUnderstandingSection versions={versions} onViewReport={setViewingReportId} />

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : versions.length === 0 ? (
        <p className="text-muted-foreground text-sm">No CVs yet. Upload one above to get started.</p>
      ) : (
        <div className="space-y-3">
          {versions.map((v) => (
            <div
              key={v.id}
              className="border rounded-xl p-4 flex items-center justify-between bg-background"
            >
              <button onClick={() => setSelectedId(v.id)} className="flex-1 text-left">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-primary">{v.name}</h3>
                  {v.isActive && (
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs rounded-full font-medium">
                      Active
                    </span>
                  )}
                  {v.detectedField && (
                    <span className="px-2 py-0.5 bg-primary/5 text-primary text-xs rounded-full">
                      {v.detectedField}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {v.bulletCount} bullets · {v.openGapCount} gaps remaining
                </p>
                <p className="text-xs text-subtle-foreground mt-0.5 italic">
                  {v.sourceFilePath
                    ? `Uploaded from ${v.sourceFilePath}`
                    : "Cannot find source file's path"}
                </p>
              </button>
              <div className="flex items-center gap-2">
                {!v.isActive && (
                  <button
                    onClick={async () => {
                      await activateCvVersion(v.id)
                      refresh()
                    }}
                    className="px-3 py-1.5 text-sm border rounded-lg hover:bg-card"
                  >
                    Make active
                  </button>
                )}
                <button
                  onClick={async () => {
                    if (!confirm(`Delete "${v.name}"? Shared bullets will survive if linked to other versions.`))
                      return
                    await deleteCvVersion(v.id)
                    refresh()
                  }}
                  className="p-2 text-subtle-foreground hover:text-red-600"
                  aria-label="Delete CV"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Upload card (Phase 1) ───────────────────────────────────────────────────

function uploadPhaseLabel(elapsedMs: number): string {
  if (elapsedMs < 2_500) return 'Reading your file…'
  if (elapsedMs < 8_000) return 'Analysing your CV with AI…'
  if (elapsedMs < 25_000) return 'Extracting your bullet points…'
  return 'Finding similar bullets from your past CVs…'
}

function UploadCard({ onParsed }: { onParsed: (data: Phase1Response) => void }) {
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const { progress, phase, busy, start, finish, reset } = useFakeProgress({
    tauMs: 12_000,
    phaseLabel: uploadPhaseLabel,
  })

  const submit = async () => {
    if (!file || !name.trim()) return
    setErr(null)
    start()
    try {
      const fd = new FormData()
      fd.append('name', name.trim())
      fd.append('file', file)
      const res = await uploadCvVersion(fd)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || data?.message || 'Upload failed')
      }
      const data: Phase1Response = await res.json()
      finish()
      // Brief pause so the user sees the bar reach 100% before we navigate.
      await new Promise((r) => setTimeout(r, 250))
      setName('')
      setFile(null)
      onParsed(data)
    } catch (e) {
      reset()
      setErr(e instanceof Error ? e.message : 'Upload failed')
    }
  }

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 mb-6">
      <h2 className="text-sm font-semibold text-primary mb-3">Upload a new CV</h2>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='Name this CV (e.g. "2025 SWE CV")'
          disabled={busy}
          className="flex-1 p-3 border rounded-xl text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          type="file"
          accept=".pdf,.docx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={busy}
          className="flex-1 p-2 text-sm bg-background border rounded-xl"
        />
        <button
          onClick={submit}
          disabled={busy || !file || !name.trim()}
          className="flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 disabled:opacity-40"
        >
          {busy ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Parsing CV…
            </>
          ) : (
            <>
              <Upload className="w-4 h-4" /> Upload
            </>
          )}
        </button>
      </div>
      {busy && <ProgressBar progress={progress} phase={phase} />}
      {err && (
        <p className="mt-2 text-xs text-red-600 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> {err}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Parsing usually takes 20-60s. After parsing, you&apos;ll review each bullet and merge
        duplicates from previous CVs.
      </p>
    </div>
  )
}

// ── Phase 2: Bullet resolution step ─────────────────────────────────────────

function BulletResolutionStep({
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

// ── CV Detail: gap filling + manual merge ───────────────────────────────────

function CvDetail({
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

// ── Coach Understanding Section ─────────────────────────────────────────────

function coachReportPhaseLabel(elapsedMs: number): string {
  if (elapsedMs < 3_000) return 'Loading your bullets and evidence…'
  if (elapsedMs < 10_000) return 'Asking the AI coach to analyse your background…'
  if (elapsedMs < 25_000) return 'Identifying gaps and duplicates…'
  return 'Writing the report…'
}

function CoachUnderstandingSection({
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

function ReportViewer({ reportId, onBack }: { reportId: string; onBack: () => void }) {
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
