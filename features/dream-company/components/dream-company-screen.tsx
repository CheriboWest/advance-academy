'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Briefcase,
  ChevronRight,
  Target,
  ExternalLink,
  Sparkles,
  Check,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Progress } from '@/components/ui/progress'
import { ProgressBar } from '@/shared/hooks/progress-bar'
import { useDreamCompany, STEP_LABELS } from '@/features/dream-company/hooks/use-dream-company'
import { SaveJobButton } from '@/features/job-tracking/components/save-job-button'

// Turn a job's ISO publishedDate into a short "Posted 3d ago" label. Live-vacancy
// sources (Adzuna/Reed) always supply this; the Exa fallback usually does. Returns
// null when the date is missing or unparseable so the card simply omits the line.
function formatPostedDate(iso?: string): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const days = Math.floor((Date.now() - t) / 86_400_000)
  if (days <= 0) return 'Posted today'
  if (days === 1) return 'Posted 1 day ago'
  if (days < 30) return `Posted ${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? 'Posted 1 month ago' : `Posted ${months} months ago`
}

// Honest time expectations shown while a step streams (M2.3). Kept truthful to the measured
// ~1–2 min total so the wait reads as "worth it" rather than "stuck".
const STEP_TIME_HINT: Record<string, string> = {
  analyzing: 'Reading your profile in depth — usually 20–40 seconds.',
  'generating-roles': 'Matching you to the best-fit roles — usually 20–30 seconds.',
  'building-roadmap':
    'Searching live jobs and writing your personalised roadmap — this can take 1–2 minutes for the most accurate plan.',
}

// Rotating sub-status lines shown under the progress bar so a long stream reads as active work
// instead of a frozen label. For `building-roadmap` the first/last lines mirror the real
// Exa-search-then-write sequence; analyze/roles are single LLM calls, so their lines stay
// deliberately vague/plausible rather than claiming sub-steps that don't happen.
const STEP_PHASES: Record<string, string[]> = {
  analyzing: [
    'Analyzing your profile...',
    'Assessing your experience...',
    'Benchmarking against the market...',
    'Identifying your strengths...',
  ],
  'generating-roles': [
    'Finding matching roles...',
    'Scanning role families...',
    'Ranking roles by fit...',
    'Shortlisting the best matches...',
  ],
  'building-roadmap': [
    'Searching live job openings...',
    'Analyzing market demand...',
    'Mapping your milestones...',
    'Writing your personalised roadmap...',
  ],
}

// Cycle STEP_PHASES[step] every ~2.8s while a step is streaming; falls back to `fallback`
// (the static STEP_LABELS text) for steps without a rotation set.
function useRotatingPhase(step: string, active: boolean, fallback: string): string {
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    setIdx(0)
    const phases = STEP_PHASES[step]
    if (!active || !phases || phases.length < 2) return
    const id = setInterval(() => setIdx((i) => (i + 1) % phases.length), 2800)
    return () => clearInterval(id)
  }, [step, active])
  return STEP_PHASES[step]?.[idx] ?? fallback
}
import type {
  DreamCompanyInput,
  ProfileAnalysis,
  TargetRole,
  ExaJobListing,
  CareerRoadmap,
} from '@advance-academy/contracts/dream-company'

// ─── Constants ───────────────────────────────────────────────

const EMPTY_FORM: DreamCompanyInput = {
  degree: '',
  workExperience: '',
  skills: '',
  interests: '',
  targetSalary: '',
  location: '',
}

const MARKET_LEVEL_COLORS: Record<string, string> = {
  entry: 'bg-card text-foreground',
  junior: 'bg-primary/10 text-primary',
  mid: 'bg-green-100 text-green-800',
  senior: 'bg-purple-100 text-purple-800',
  lead: 'bg-orange-100 text-orange-800',
  executive: 'bg-secondary/15 text-highlight-ink',
}

const URGENCY_COLORS: Record<string, string> = {
  high: 'text-red-600 bg-red-50 border-red-200',
  medium: 'text-amber-600 bg-amber-50 border-amber-200',
  low: 'text-primary bg-primary/5 border-primary/20',
}

const DEMAND_COLORS: Record<string, string> = {
  high: 'bg-green-100 text-green-800',
  medium: 'bg-secondary/15 text-highlight-ink',
  low: 'bg-card text-foreground',
}

// ─── Main Screen Component ──────────────────────────────────

export function DreamCompanyScreen() {
  const [inputMode, setInputMode] = useState<'upload' | 'manual'>('manual')
  const [form, setForm] = useState<DreamCompanyInput>(EMPTY_FORM)
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null)
  const [cvParsing, setCvParsing] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const {
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
  } = useDreamCompany()

  const rotatingPhase = useRotatingPhase(currentStep, loading, STEP_LABELS[currentStep])

  const updateField = useCallback((field: keyof DreamCompanyInput, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }, [])

  const handleFileSelect = useCallback(
    async (file: File) => {
      const name = file.name.toLowerCase()
      if (!name.endsWith('.pdf') && !name.endsWith('.docx')) return

      setUploadedFileName(file.name)
      setCvParsing(true)

      const parsed = await uploadCV(file)
      setCvParsing(false)

      if (parsed) {
        setForm(parsed)
        setInputMode('manual')
      }
    },
    [uploadCV],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFileSelect(file)
    },
    [handleFileSelect],
  )

  const handleSubmit = useCallback(() => {
    generateFromProfile(form)
  }, [form, generateFromProfile])

  const handleReset = useCallback(() => {
    reset()
    setForm(EMPTY_FORM)
    setUploadedFileName(null)
    setInputMode('manual')
  }, [reset])

  const hasResults = analysis !== null
  const canSubmit = form.degree && form.workExperience && form.skills && form.location

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-serif font-bold text-primary mb-3">
          Dream Company Finder
        </h1>
        <p className="text-lg text-muted-foreground">
          Input your career profile, discover your ideal roles, and find real job opportunities.
        </p>
      </div>

      <div className={`grid gap-8 ${hasResults ? 'lg:grid-cols-[400px_1fr]' : 'max-w-2xl'}`}>
        {/* ─── LEFT PANEL — Input Form ─── */}
        <div className="space-y-6">
          {/* Mode Toggle */}
          <div className="flex gap-2">
            <Button
              variant={inputMode === 'upload' ? 'default' : 'outline'}
              onClick={() => setInputMode('upload')}
              className="flex-1"
            >
              <Upload className="w-4 h-4 mr-2" />
              Upload CV
            </Button>
            <Button
              variant={inputMode === 'manual' ? 'default' : 'outline'}
              onClick={() => setInputMode('manual')}
              className="flex-1"
            >
              <FileText className="w-4 h-4 mr-2" />
              Fill Manually
            </Button>
          </div>

          {/* Upload CV Mode */}
          {inputMode === 'upload' && (
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragOver(true)
              }}
              onDragEnter={(e) => {
                e.preventDefault()
                setIsDragOver(true)
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
                isDragOver
                  ? 'border-secondary bg-secondary/10'
                  : 'border-border hover:border-border bg-card'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFileSelect(file)
                }}
              />
              {cvParsing ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="w-10 h-10 text-highlight-ink animate-spin" />
                  <p className="text-sm text-muted-foreground">Parsing {uploadedFileName}...</p>
                </div>
              ) : uploadedFileName ? (
                <div className="flex flex-col items-center gap-3">
                  <CheckCircle2 className="w-10 h-10 text-green-500" />
                  <p className="text-sm font-medium text-foreground">{uploadedFileName}</p>
                  <p className="text-xs text-muted-foreground">Click or drop to replace</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Upload className="w-10 h-10 text-subtle-foreground" />
                  <p className="text-sm font-medium text-foreground">
                    Drag & drop your CV here, or click to browse
                  </p>
                  <p className="text-xs text-muted-foreground">Supports PDF and DOCX</p>
                </div>
              )}
            </div>
          )}

          {/* Manual Form */}
          {inputMode === 'manual' && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="degree">Degree *</Label>
                <Input
                  id="degree"
                  placeholder="e.g., Bachelor of Computer Science"
                  value={form.degree}
                  onChange={(e) => updateField('degree', e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="workExperience">Work Experience *</Label>
                <Textarea
                  id="workExperience"
                  placeholder="Describe your work experience, roles, and key achievements..."
                  rows={4}
                  value={form.workExperience}
                  onChange={(e) => updateField('workExperience', e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="skills">Skills *</Label>
                <Input
                  id="skills"
                  placeholder="e.g., React, TypeScript, Node.js, Python, Leadership"
                  value={form.skills}
                  onChange={(e) => updateField('skills', e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">Separate skills with commas</p>
              </div>
              <div>
                <Label htmlFor="interests">Interests</Label>
                <Input
                  id="interests"
                  placeholder="e.g., AI/ML, FinTech, Healthcare, Sustainability"
                  value={form.interests}
                  onChange={(e) => updateField('interests', e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="targetSalary">Target Salary</Label>
                <Input
                  id="targetSalary"
                  placeholder="e.g., $120,000 - $150,000"
                  value={form.targetSalary}
                  onChange={(e) => updateField('targetSalary', e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="location">Location *</Label>
                <Input
                  id="location"
                  placeholder="e.g., San Francisco, CA"
                  value={form.location}
                  onChange={(e) => updateField('location', e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-red-50 border border-red-200">
              <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Submit / Picking / Loading / Reset */}
          {currentStep === 'done' ? (
            <div className="space-y-2">
              <Button onClick={editRoles} className="w-full bg-secondary hover:bg-secondary/90 text-primary font-semibold">
                Adjust roles &amp; regenerate
              </Button>
              <Button onClick={handleReset} variant="outline" className="w-full">
                Start New Search
              </Button>
            </div>
          ) : currentStep === 'picking' ? (
            <Button
              onClick={buildRoadmap}
              disabled={loading || selectedRoles.length === 0}
              className="w-full bg-secondary hover:bg-secondary/90 text-primary font-semibold h-12 text-base"
            >
              Build My Roadmap ({selectedRoles.length} selected)
            </Button>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={!canSubmit || loading}
              className="w-full bg-secondary hover:bg-secondary/90 text-primary font-semibold h-12 text-base"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {STEP_LABELS[currentStep]}
                </span>
              ) : (
                'Find My Dream Roles'
              )}
            </Button>
          )}

          {/* Live streaming progress + time expectation (M2.1 / M2.3) */}
          {loading && STEP_TIME_HINT[currentStep] && (
            <div className="rounded-lg bg-primary/5 border border-primary/10 p-3">
              <ProgressBar progress={progress} phase={rotatingPhase} />
              <p className="mt-2 text-xs text-primary/60">{STEP_TIME_HINT[currentStep]}</p>
            </div>
          )}

          {/* Step Progress */}
          {(loading || currentStep === 'picking') && (
            <div className="space-y-3">
              <StepIndicator step="analyzing" current={currentStep} label="Analyzing profile" />
              <StepIndicator step="generating-roles" current={currentStep} label="Finding matching roles" />
              <StepIndicator step="building-roadmap" current={currentStep} label="Searching jobs & building roadmap" />
            </div>
          )}
        </div>

        {/* ─── RIGHT PANEL — Results ─── */}
        {hasResults && (
          <ResultsPanel
            analysis={analysis}
            roles={roles}
            selectedRoles={selectedRoles}
            jobs={jobs}
            jobsError={jobsError}
            jobsNotice={jobsNotice}
            jobsTruncated={jobsTruncated}
            maxRoles={maxRoles}
            roadmap={roadmap}
            currentStep={currentStep}
            onToggleRole={toggleRole}
          />
        )}
      </div>
    </div>
  )
}

// ─── Step Indicator ──────────────────────────────────────────

function StepIndicator({ step, current, label }: { step: string; current: string; label: string }) {
  const steps = ['analyzing', 'generating-roles', 'building-roadmap']
  const stepIdx = steps.indexOf(step)
  const currentIdx = steps.indexOf(current)
  const effectiveCurrentIdx =
    current === 'picking' ? steps.indexOf('generating-roles') + 0.5
    : current === 'done' ? steps.length
    : currentIdx

  const isComplete = effectiveCurrentIdx > stepIdx
  const isActive = current === step

  return (
    <div className="flex items-center gap-3">
      <div
        className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium shrink-0 ${
          isComplete
            ? 'bg-green-500 text-primary-foreground'
            : isActive
              ? 'bg-secondary text-primary'
              : 'bg-muted text-muted-foreground'
        }`}
      >
        {isComplete ? <CheckCircle2 className="w-4 h-4" /> : stepIdx + 1}
      </div>
      <span
        className={`text-sm ${
          isActive ? 'text-primary font-medium' : isComplete ? 'text-green-700' : 'text-subtle-foreground'
        }`}
      >
        {label}
        {isActive && <Loader2 className="w-3 h-3 inline ml-2 animate-spin" />}
      </span>
    </div>
  )
}

// ─── Results Panel ───────────────────────────────────────────

function ResultsPanel({
  analysis,
  roles,
  selectedRoles,
  jobs,
  jobsError,
  jobsNotice,
  jobsTruncated,
  maxRoles,
  roadmap,
  currentStep,
  onToggleRole,
}: {
  analysis: ProfileAnalysis
  roles: TargetRole[] | null
  selectedRoles: TargetRole[]
  jobs: ExaJobListing[] | null
  jobsError: string | null
  jobsNotice: string | null
  jobsTruncated: boolean
  maxRoles: number
  roadmap: CareerRoadmap | null
  currentStep: string
  onToggleRole: (role: TargetRole) => void
}) {
  const hasRoadmap = roadmap !== null

  return (
    <Tabs defaultValue="analysis" className="min-w-0">
      <TabsList className={`w-full grid ${hasRoadmap ? 'grid-cols-3' : roles ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <TabsTrigger value="analysis">Profile</TabsTrigger>
        {roles && <TabsTrigger value="roles">Roles</TabsTrigger>}
        {hasRoadmap && <TabsTrigger value="roadmap">Roadmap & Jobs</TabsTrigger>}
      </TabsList>

      <TabsContent value="analysis">
        <ProfileAnalysisTab analysis={analysis} />
      </TabsContent>
      {roles && (
        <TabsContent value="roles">
          <RolesTab
            roles={roles}
            selectedRoles={selectedRoles}
            currentStep={currentStep}
            onToggleRole={onToggleRole}
            maxRoles={maxRoles}
          />
        </TabsContent>
      )}
      {hasRoadmap && (
        <TabsContent value="roadmap">
          <RoadmapAndJobsTab roadmap={roadmap} jobs={jobs} jobsError={jobsError} jobsNotice={jobsNotice} jobsTruncated={jobsTruncated} />
        </TabsContent>
      )}
    </Tabs>
  )
}

// ─── Profile Analysis Tab ────────────────────────────────────

function ProfileAnalysisTab({ analysis }: { analysis: ProfileAnalysis }) {
  return (
    <div className="space-y-6 mt-4">
      <div className="flex flex-wrap items-center gap-4">
        <Badge className={MARKET_LEVEL_COLORS[analysis.marketLevel] || 'bg-card text-foreground'}>
          {analysis.marketLevel.toUpperCase()}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {analysis.salaryRange.currency} {analysis.salaryRange.min.toLocaleString()} -{' '}
          {analysis.salaryRange.max.toLocaleString()}
        </span>
      </div>

      <div className="flex items-center gap-6">
        <ReadinessRing score={analysis.readinessScore} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">Readiness Score</p>
          <p className="text-sm text-muted-foreground mt-1">{analysis.readinessNote}</p>
        </div>
      </div>

      <div className="border-l-4 border-secondary bg-secondary/10 rounded-r-lg p-4">
        <p className="text-sm font-medium text-foreground mb-1">Unique Value Proposition</p>
        <p className="text-sm text-foreground italic">{analysis.uniqueValueProposition}</p>
      </div>

      <div>
        <p className="text-sm font-medium text-foreground mb-1">Market Level Rationale</p>
        <p className="text-sm text-muted-foreground">{analysis.marketLevelRationale}</p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Core Strengths</h3>
        <div className="space-y-3">
          {analysis.coreStrengths.map((s, i) => (
            <div key={i} className="flex gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-foreground">{s.strength}</p>
                <p className="text-xs text-muted-foreground">{s.evidence}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Critical Gaps</h3>
        <div className="space-y-3">
          {analysis.criticalGaps.map((g, i) => (
            <div key={i} className={`flex gap-3 p-3 rounded-lg border ${URGENCY_COLORS[g.urgency]}`}>
              <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{g.gap}</p>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">{g.urgency}</Badge>
                </div>
                <p className="text-xs mt-1 opacity-80">{g.impact}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Readiness Ring ──────────────────────────────────────────

function ReadinessRing({ score }: { score: number }) {
  const radius = 36
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference
  const color = score >= 75 ? '#22c55e' : score >= 50 ? '#eab308' : '#ef4444'

  return (
    <div className="relative w-24 h-24 shrink-0">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 80 80">
        <circle cx="40" cy="40" r={radius} fill="none" stroke="#e5e7eb" strokeWidth="6" />
        <circle cx="40" cy="40" r={radius} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} className="transition-all duration-1000" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xl font-bold text-foreground">{score}</span>
      </div>
    </div>
  )
}

// ─── Roles Tab (Multi-Select) ───────────────────────────────

function RolesTab({
  roles,
  selectedRoles,
  currentStep,
  onToggleRole,
  maxRoles,
}: {
  roles: TargetRole[]
  selectedRoles: TargetRole[]
  currentStep: string
  onToggleRole: (role: TargetRole) => void
  maxRoles: number
}) {
  const isPicking = currentStep === 'picking'
  const atCap = selectedRoles.length >= maxRoles

  return (
    <div className="space-y-6 mt-4">
      {isPicking && (
        <div className="flex items-start gap-3 p-4 rounded-lg bg-primary/5 border border-primary/20">
          <Briefcase className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <p className="text-sm text-primary">
            {`Choose up to ${maxRoles} target roles - a focused set gives you a sharper roadmap and fresher live jobs. Then click "Build My Roadmap". (${selectedRoles.length}/${maxRoles} selected)`}
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {roles.map((role, i) => {
          const isSelected = selectedRoles.some((r) => r.title === role.title && r.level === role.level)
          const disabled = isPicking && !isSelected && atCap // cap reached — can't add more

          return (
            <Card
              key={i}
              aria-disabled={disabled}
              className={`transition-all ${
                isPicking && !disabled ? 'cursor-pointer' : ''
              } ${isSelected ? 'ring-2 ring-secondary bg-secondary/10' : isPicking && !disabled ? 'hover:border-border' : ''} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              onClick={() => isPicking && !disabled && onToggleRole(role)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{role.title}</CardTitle>
                  <div className="flex items-center gap-2 shrink-0">
                    {isSelected && (
                      <div className="w-5 h-5 rounded-full bg-secondary flex items-center justify-center">
                        <Check className="w-3 h-3 text-primary" />
                      </div>
                    )}
                    <Badge variant="outline">{role.level}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-foreground">Fit Score</span>
                    <span className="text-xs font-bold text-primary">{role.fitScore}%</span>
                  </div>
                  <Progress value={role.fitScore} className="h-2" />
                </div>
                <p className="text-sm text-muted-foreground">{role.fitReason}</p>
                <div className="flex items-center justify-between">
                  <Badge className={DEMAND_COLORS[role.demandLevel]}>{role.demandLevel} demand</Badge>
                  <span className="text-sm font-medium text-foreground">{role.avgSalary}</span>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

// ─── Roadmap & Jobs Tab ─────────────────────────────────────

function RoadmapAndJobsTab({ roadmap, jobs, jobsError, jobsNotice, jobsTruncated }: { roadmap: CareerRoadmap; jobs: ExaJobListing[] | null; jobsError: string | null; jobsNotice: string | null; jobsTruncated: boolean }) {
  return (
    <div className="space-y-8 mt-4">
      {/* Future You Card */}
      <Card className="border-2 border-secondary/40 bg-gradient-to-br from-secondary to-amber-50">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-highlight-ink" />
            <CardTitle className="text-lg font-serif text-primary">The Person You Will Become</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-foreground leading-relaxed">{roadmap.futureYou.personTheyWillBecome}</p>
          <div className="border-t border-secondary/40 pt-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">What You Will Achieve</p>
            <p className="text-sm text-foreground leading-relaxed">{roadmap.futureYou.achievementSummary}</p>
          </div>
        </CardContent>
      </Card>

      {/* Job search failed — distinct from a genuine empty result (AAT-10) */}
      {jobsError && (
        <div className="flex items-start gap-2 p-4 rounded-lg border border-amber-300 bg-amber-50">
          <Briefcase className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-800">{jobsError}</p>
        </div>
      )}

      {/* Benign notice (e.g. region outside live coverage) — softer than an error */}
      {jobsNotice && !jobsError && (
        <div className="flex items-start gap-2 p-4 rounded-lg border border-primary/20 bg-primary/5">
          <Briefcase className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <p className="text-sm text-primary">{jobsNotice}</p>
        </div>
      )}

      {/* Job search covered only the first N selected roles (client bypassed the FE cap) */}
      {jobsTruncated && (
        <div className="flex items-start gap-2 p-4 rounded-lg border border-primary/20 bg-primary/5">
          <Briefcase className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <p className="text-sm text-primary">
            Job search covered your top roles. Want to explore other roles? Adjust your picks and regenerate your roadmap.
          </p>
        </div>
      )}

      {/* Currently Hiring */}
      {jobs && jobs.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-primary mb-4 flex items-center gap-2">
            <Briefcase className="w-5 h-5" />
            Currently Hiring
          </h3>
          <div className="grid gap-3">
            {jobs.map((job, i) => (
              // A div, not an <a>: the card holds both the outbound link and the
              // Save button, and a button inside an anchor is invalid HTML.
              <div
                key={job.url || i}
                className="flex items-start justify-between gap-3 p-4 rounded-lg border hover:border-primary/40 transition-colors"
              >
                <a
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 group"
                >
                  <p className="text-sm font-medium text-primary truncate group-hover:underline inline-flex items-center gap-1.5 max-w-full">
                    <span className="truncate">{job.title}</span>
                    <ExternalLink className="w-3.5 h-3.5 text-subtle-foreground shrink-0" />
                  </p>
                  {job.snippet && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{job.snippet}</p>}
                  {formatPostedDate(job.publishedDate) && (
                    <p className="text-xs text-subtle-foreground mt-1">{formatPostedDate(job.publishedDate)}</p>
                  )}
                </a>
                <SaveJobButton
                  className="shrink-0"
                  job={{
                    title: job.title,
                    jobUrl: job.url || null,
                    companyName: job.company ?? null,
                    location: job.location ?? null,
                    salaryText: job.salaryText ?? null,
                    description: job.snippet || null,
                    source: 'dream_company',
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Career Roadmap Phases */}
      <div className="relative">
        <h3 className="text-lg font-semibold text-primary mb-6 flex items-center gap-2">
          <Target className="w-5 h-5" />
          Career Roadmap
        </h3>

        <div className="absolute left-5 top-14 bottom-0 w-0.5 bg-muted" />

        <div className="space-y-8">
          {roadmap.phases.map((phase, i) => (
            <div key={i} className="relative pl-14">
              <div className="absolute left-2.5 w-5 h-5 rounded-full bg-primary border-4 border-white shadow" />
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3 mb-1">
                    <Badge className="bg-primary text-primary-foreground">Phase {phase.phase}</Badge>
                    <span className="text-sm text-muted-foreground">{phase.duration}</span>
                  </div>
                  <CardTitle className="text-lg">{phase.goal}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Actions</p>
                    <ul className="space-y-2">
                      {phase.actions.map((action, j) => (
                        <li key={j} className="flex items-start gap-2 text-sm text-foreground">
                          <ChevronRight className="w-4 h-4 text-highlight-ink mt-0.5 shrink-0" />
                          {action}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Skills to Build</p>
                    {/* These "skills" are long descriptive phrases ("Category (detail, detail…)"),
                        not short tags — a nowrap Badge overflowed the card. Render each as a
                        wrapping row: bold category + muted parenthetical detail. */}
                    <ul className="space-y-2">
                      {phase.skills.map((skill, j) => {
                        const m = skill.match(/^([^(]+?)\s*\((.+)\)\s*$/)
                        const title = m ? m[1] : skill
                        const detail = m ? m[2] : null
                        return (
                          <li
                            key={j}
                            className="rounded-lg border border-secondary/40 bg-secondary/10 px-3 py-2 min-w-0"
                          >
                            <p className="text-sm font-medium text-highlight-ink break-words">{title}</p>
                            {detail && (
                              <p className="text-xs text-highlight-ink/80 mt-0.5 break-words">{detail}</p>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-green-50 border border-green-200">
                    <Target className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs font-semibold text-green-800">Milestone</p>
                      <p className="text-sm text-green-700">{phase.milestone}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
