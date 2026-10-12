'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import type {
  DreamCompanyInput,
  ProfileAnalysis,
  TargetRole,
  ExaJobListing,
  CareerRoadmap,
} from '@advance-academy/contracts/dream-company'
import { analyzeProfileStream, generateRolesStream, generateRoadmapStream, parseCV, getDreamCompanyConfig } from '@/features/dream-company/api/frontend-client'

// Fallback used only until the backend config loads; the backend value is authoritative.
const DEFAULT_MAX_ROLES = 6

// Rough per-step output sizes (chars of streamed JSON) used to turn the live token stream into
// a progress %. Approximate on purpose — the bar follows a saturating curve toward a per-run
// ceiling (randomised each step, see `beginStep`) and only snaps away on completion.
const EXPECTED_CHARS = { analyze: 2200, roles: 2600, roadmap: 3200 } as const

export type DreamCompanyStep =
  | 'idle'
  | 'analyzing'
  | 'generating-roles'
  | 'picking'
  | 'building-roadmap'
  | 'done'

export const STEP_LABELS: Record<DreamCompanyStep, string> = {
  idle: '',
  analyzing: 'Analyzing your profile...',
  'generating-roles': 'Finding matching roles...',
  picking: 'Select roles to continue',
  'building-roadmap': 'Searching jobs & building roadmap...',
  done: 'Complete!',
}

export function useDreamCompany() {
  const [analysis, setAnalysis] = useState<ProfileAnalysis | null>(null)
  const [roles, setRoles] = useState<TargetRole[] | null>(null)
  const [selectedRoles, setSelectedRoles] = useState<TargetRole[]>([])
  const [jobs, setJobs] = useState<ExaJobListing[] | null>(null)
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [jobsNotice, setJobsNotice] = useState<string | null>(null)
  const [jobsTruncated, setJobsTruncated] = useState(false)
  const [maxRoles, setMaxRoles] = useState<number>(DEFAULT_MAX_ROLES)
  const [roadmap, setRoadmap] = useState<CareerRoadmap | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentStep, setCurrentStep] = useState<DreamCompanyStep>('idle')
  const [progress, setProgress] = useState(0)

  const profileRef = useRef<DreamCompanyInput | null>(null)
  const charsRef = useRef(0)
  const ceilingRef = useRef(96)
  // Run-id guard (C1): each run bumps this; a stale run (superseded by a newer one) sees a
  // mismatched id and skips all setState so a late-resolving old stream can't clobber fresh
  // state. abortRef cancels the previous in-flight stream so it stops reading immediately.
  const runIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  // Load the role-selection cap from the backend (single source of truth). If it fails we
  // keep the sensible default — never block the flow on this.
  useEffect(() => {
    let cancelled = false
    getDreamCompanyConfig()
      .then((cfg) => {
        if (!cancelled && typeof cfg?.maxRoles === 'number' && cfg.maxRoles > 0) setMaxRoles(cfg.maxRoles)
      })
      .catch(() => { /* keep DEFAULT_MAX_ROLES */ })
    return () => {
      cancelled = true
    }
  }, [])

  // Begin a streamed step: reset the bar and return an onDelta that advances it as tokens arrive.
  // Instead of a hard 96% cap that freezes on the same number every run, the bar follows the real
  // streamed volume through a saturating curve `ceiling * (1 - e^(-k·ratio))` toward a per-run
  // ceiling randomised to 93–98%. It keeps inching (never flat-lines) and lands on a different
  // final number each time, then the next step / completion clears it.
  const beginStep = useCallback((expected: number) => {
    charsRef.current = 0
    ceilingRef.current = 93 + Math.floor(Math.random() * 6) // 93..98, varies each run
    setProgress(0)
    return (text: string) => {
      charsRef.current += text.length
      const ratio = charsRef.current / expected
      setProgress(Math.round(ceilingRef.current * (1 - Math.exp(-1.8 * ratio))))
    }
  }, [])

  const generateFromProfile = useCallback(
    async (profile: DreamCompanyInput): Promise<void> => {
      profileRef.current = profile
      const runId = ++runIdRef.current
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      // Ignore token deltas from a superseded run so the progress bar can't be corrupted.
      const guard = (fn: (t: string) => void) => (t: string) => { if (runId === runIdRef.current) fn(t) }

      setLoading(true)
      setError(null)
      setAnalysis(null)
      setRoles(null)
      setSelectedRoles([])
      setJobs(null)
      setRoadmap(null)
      setCurrentStep('analyzing')

      try {
        // Step 1: Profile Analysis (streamed)
        const analysisResult = await analyzeProfileStream(profile, guard(beginStep(EXPECTED_CHARS.analyze)), { signal: ac.signal })
        if (runId !== runIdRef.current) return
        setAnalysis(analysisResult)
        setCurrentStep('generating-roles')

        // Step 2: Target Roles (streamed)
        const rolesResult = await generateRolesStream(profile, analysisResult, guard(beginStep(EXPECTED_CHARS.roles)), { signal: ac.signal })
        if (runId !== runIdRef.current) return
        setRoles(rolesResult)
        setCurrentStep('picking')
      } catch (err) {
        if (runId !== runIdRef.current) return // stale/aborted run — don't clobber fresh state
        setError(err instanceof Error ? err.message : 'An unknown error occurred')
        setCurrentStep('idle')
      } finally {
        if (runId === runIdRef.current) {
          setProgress(0)
          setLoading(false)
        }
      }
    },
    [beginStep],
  )

  const toggleRole = useCallback((role: TargetRole) => {
    setSelectedRoles((prev) => {
      const exists = prev.some((r) => r.title === role.title && r.level === role.level)
      if (exists) return prev.filter((r) => !(r.title === role.title && r.level === role.level))
      if (prev.length >= maxRoles) return prev // cap reached — ignore adds (AC1 guard)
      return [...prev, role]
    })
  }, [maxRoles])

  const buildRoadmap = useCallback(
    async (): Promise<void> => {
      const profile = profileRef.current
      if (!profile || !analysis || selectedRoles.length === 0) return

      const runId = ++runIdRef.current
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      const guard = (fn: (t: string) => void) => (t: string) => { if (runId === runIdRef.current) fn(t) }

      setLoading(true)
      setError(null)
      setJobsError(null)
      setJobsNotice(null)
      setJobsTruncated(false)
      setCurrentStep('building-roadmap')

      try {
        // Step 3: live job search + Roadmap (streamed)
        const result = await generateRoadmapStream(profile, analysis, selectedRoles, guard(beginStep(EXPECTED_CHARS.roadmap)), { signal: ac.signal })
        if (runId !== runIdRef.current) return
        setJobs(result.jobs)
        setJobsError(result.jobsError)
        setJobsNotice(result.jobsNotice)
        setJobsTruncated(result.jobsTruncated)
        setRoadmap(result.roadmap)
        setCurrentStep('done')
      } catch (err) {
        if (runId !== runIdRef.current) return // stale/aborted run — don't clobber fresh state
        setError(err instanceof Error ? err.message : 'An unknown error occurred')
        setCurrentStep('picking')
      } finally {
        if (runId === runIdRef.current) {
          setProgress(0)
          setLoading(false)
        }
      }
    },
    [analysis, selectedRoles, beginStep],
  )

  const uploadCV = useCallback(async (file: File): Promise<DreamCompanyInput | null> => {
    setError(null)

    try {
      const parsed = await parseCV(file)
      return {
        degree: parsed.degree || '',
        workExperience: parsed.workExperience || '',
        skills: parsed.skills || '',
        interests: parsed.interests || '',
        targetSalary: parsed.targetSalary || '',
        location: parsed.location || '',
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CV upload failed')
      return null
    }
  }, [])

  // Regenerate flow (AC5): go back to role selection keeping analysis/roles/picks, so the
  // user can adjust their picks and Build again. Same picks+location → cache hit (no API).
  const editRoles = useCallback(() => {
    setCurrentStep('picking')
  }, [])

  const reset = useCallback(() => {
    runIdRef.current++ // invalidate any in-flight run so its late resolve is ignored
    abortRef.current?.abort()
    profileRef.current = null
    setAnalysis(null)
    setRoles(null)
    setSelectedRoles([])
    setJobs(null)
    setJobsError(null)
    setJobsNotice(null)
    setJobsTruncated(false)
    setRoadmap(null)
    setLoading(false)
    setError(null)
    setCurrentStep('idle')
    setProgress(0)
  }, [])

  return {
    analysis,
    roles,
    selectedRoles,
    jobs,
    jobsError,
    jobsNotice,
    jobsTruncated,
    maxRoles,
    roadmap,
    loading,
    error,
    currentStep,
    progress,
    generateFromProfile,
    toggleRole,
    buildRoadmap,
    editRoles,
    uploadCV,
    reset,
  }
}
