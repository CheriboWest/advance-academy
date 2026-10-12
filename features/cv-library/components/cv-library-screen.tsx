'use client'

import { useCallback, useEffect, useState } from 'react'
import { activateCvVersion, deleteCvVersion, listCvVersions } from '@/features/cv-library/api/frontend-client'
import { Loader2, Trash2, AlertCircle } from 'lucide-react'
import { BulletResolutionStep } from '@/features/cv-library/components/bullet-resolution-step'
import {
  CoachUnderstandingSection,
  ReportViewer,
} from '@/features/cv-library/components/coach-understanding-section'
import { CvDetail } from '@/features/cv-library/components/cv-detail'
import { UploadCard } from '@/features/cv-library/components/upload-card'
import type { CvVersionSummary, Phase1Response } from '@/features/cv-library/types'

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
