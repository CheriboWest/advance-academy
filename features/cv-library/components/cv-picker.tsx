'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { listCvVersions } from '@/features/cv-library/api/frontend-client'

interface CvOption {
  id: string
  name: string
  isActive: boolean
}

interface CvPickerProps {
  id?: string
  value: string
  onChange: (cvVersionId: string) => void
  /** Offer "no CV" and don't pre-select one — for optional fields like "CV used" on a tracked job. */
  optional?: boolean
}

/**
 * The student's CV Library as a native <select>. When `value` is empty and the
 * field isn't optional, it picks the active CV (or the newest) so the common
 * case is zero clicks.
 */
export function CvPicker({ id, value, onChange, optional = false }: CvPickerProps) {
  const [cvs, setCvs] = useState<CvOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listCvVersions()
      .then(async (res) => {
        if (!res.ok) throw new Error('load failed')
        return (await res.json()) as CvOption[]
      })
      .then((data) => {
        if (cancelled) return
        setCvs(data)
        if (!value && !optional) {
          const pick = data.find((c) => c.isActive) ?? data[0]
          if (pick) onChange(pick.id)
        }
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your CVs.')
      })
    return () => {
      cancelled = true
    }
    // Load once; `value`/`onChange` only matter for the initial default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error) return <p className="text-sm text-red-700">{error}</p>
  if (cvs && cvs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No CVs yet.{' '}
        <Link href="/cv-library" className="text-primary underline">
          Upload one to your CV Library
        </Link>{' '}
        first.
      </p>
    )
  }

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={!cvs}
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
    >
      {!cvs ? <option value="">Loading CVs…</option> : null}
      {cvs && optional ? <option value="">No CV linked</option> : null}
      {/* A CV the CV Optimizer linked isn't a Library entry; show it rather than
          silently resetting the select (and the saved value) to "none". */}
      {cvs && value && !cvs.some((cv) => cv.id === value) ? (
        <option value={value}>CV from CV Optimizer</option>
      ) : null}
      {cvs?.map((cv) => (
        <option key={cv.id} value={cv.id}>
          {cv.name}
          {cv.isActive ? ' (active)' : ''}
        </option>
      ))}
    </select>
  )
}
