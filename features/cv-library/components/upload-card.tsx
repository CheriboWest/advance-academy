'use client'

import { useState } from 'react'
import { uploadCvVersion } from '@/features/cv-library/api/frontend-client'
import { useFakeProgress } from '@/shared/hooks/use-fake-progress'
import { ProgressBar } from '@/shared/components/progress-bar'
import { Loader2, Upload, AlertCircle } from 'lucide-react'
import type { Phase1Response } from '@/features/cv-library/types'

// ── Upload card (Phase 1) ───────────────────────────────────────────────────

function uploadPhaseLabel(elapsedMs: number): string {
  if (elapsedMs < 2_500) return 'Reading your file…'
  if (elapsedMs < 8_000) return 'Analysing your CV with AI…'
  if (elapsedMs < 25_000) return 'Extracting your bullet points…'
  return 'Finding similar bullets from your past CVs…'
}

export function UploadCard({ onParsed }: { onParsed: (data: Phase1Response) => void }) {
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
