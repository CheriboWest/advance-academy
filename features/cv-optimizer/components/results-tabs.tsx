'use client'

import { AlertCircle, CheckCircle2, Target, XCircle } from 'lucide-react'
import type {
  ActionPlan,
  ActionPlanItem,
  AnalyzeCvResult,
  AtsExtractedKeyword,
  AtsKeywordCategory,
} from '@advance-academy/contracts'
import {
  impactColor,
  scoreBar,
  scoreBg,
  scoreColor,
  scoreLabel,
} from '@/features/cv-optimizer/components/score-style'

const KEYWORD_CATEGORY_LABEL: Record<AtsKeywordCategory, string> = {
  job_title: 'Job Title',
  tool_or_technical_skill: 'Tool/Tech',
  hard_skill: 'Hard Skill',
  industry_term: 'Industry Term',
  certification: 'Certification',
  seniority_indicator: 'Seniority',
  mandatory_requirement: 'Mandatory',
}

const KEYWORD_CATEGORY_COLOR: Record<AtsKeywordCategory, string> = {
  job_title: 'bg-purple-100 text-purple-700 border-purple-200',
  tool_or_technical_skill: 'bg-primary/10 text-primary border-primary/20',
  hard_skill: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  industry_term: 'bg-teal-100 text-teal-700 border-teal-200',
  certification: 'bg-amber-100 text-amber-700 border-amber-200',
  seniority_indicator: 'bg-card text-foreground',
  mandatory_requirement: 'bg-red-100 text-red-700 border-red-200',
}

export function ScoreBar({ score }: { score: number }) {
  return (
    <div className="w-full bg-muted rounded-full h-2 mt-2">
      <div className={`h-2 rounded-full transition-all ${scoreBar(score)}`} style={{ width: `${score}%` }} />
    </div>
  )
}

// ─── Results tabs ─────────────────────────────────────────────────────────────

export function CvOverviewTab({ results }: { results: AnalyzeCvResult }) {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-5 py-4">
        <p className="text-sm text-primary">
          <span className="font-semibold">CV Overview</span> contributes <span className="font-semibold">25%</span> of your overall score. It measures how your CV reads across four core dimensions — skills, experience, role alignment, and writing impact.
        </p>
      </div>
      {results.sections.map((section, idx) => (
        <div key={`${section.title}-${idx}`} className={`rounded-xl border p-6 ${scoreBg(section.score)}`}>
          <div className="flex items-center justify-between mb-1">
            <h4 className="font-semibold text-primary">{section.title}</h4>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium ${scoreColor(section.score)}`}>{scoreLabel(section.score)}</span>
              <span className={`text-2xl font-bold ${scoreColor(section.score)}`}>{section.score}</span>
            </div>
          </div>
          <ScoreBar score={section.score} />
          <p className="text-foreground text-sm mt-3">{section.feedback}</p>
        </div>
      ))}
    </div>
  )
}

function AtsKeywordChip({ kw }: { kw: AtsExtractedKeyword }) {
  const baseColor = kw.foundInCv
    ? 'bg-green-100 text-green-700 border-green-200'
    : KEYWORD_CATEGORY_COLOR[kw.category]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${baseColor}`}>
      {kw.foundInCv ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {kw.keyword}
      <span className="opacity-60 text-[10px]">{KEYWORD_CATEGORY_LABEL[kw.category]}</span>
      {kw.mandatory && <span className="text-[10px] font-bold text-red-600">★</span>}
    </span>
  )
}

export function AtsIntelligenceTab({ results }: { results: AnalyzeCvResult }) {
  const keywords = results.atsCheck.extractedKeywords
  const mandatoryMissing = keywords.filter((k) => k.mandatory && !k.foundInCv)
  const foundCount = keywords.filter((k) => k.foundInCv).length
  const totalCount = keywords.length

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-5 py-4">
        <p className="text-sm text-primary">
          <span className="font-semibold">ATS Compatibility</span> is <span className="font-semibold">40%</span> of your overall score — the single largest dimension. It measures how well your CV would perform against an applicant tracking system that screens for specific requirements, technologies, and qualifications extracted from the job description.
        </p>
      </div>

      <div className={`rounded-xl border p-6 ${scoreBg(results.atsCheck.score)}`}>
        <div className="flex items-center justify-between mb-1">
          <div>
            <h4 className="font-semibold text-primary">ATS Compatibility Score</h4>
            <p className="text-xs text-muted-foreground mt-0.5">Recruitment-grade scoring across mandatory requirements, keyword coverage, and relevance signals</p>
          </div>
          <span className={`text-3xl font-bold ${scoreColor(results.atsCheck.score)}`}>
            {results.atsCheck.score}
          </span>
        </div>
        <ScoreBar score={results.atsCheck.score} />
      </div>

      {mandatoryMissing.length > 0 && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4">
          <p className="text-xs font-semibold text-red-700 mb-2 uppercase tracking-wide">Missing Mandatory Requirements</p>
          <div className="flex flex-wrap gap-2">
            {mandatoryMissing.map((k, idx) => (
              <AtsKeywordChip key={`mand-${idx}`} kw={k} />
            ))}
          </div>
          <p className="mt-2 text-xs text-red-600">Mandatory items are binary — missing any one of these is an immediate disqualifier for most ATS filters.</p>
        </div>
      )}

      {keywords.length > 0 && (
        <div>
          <h4 className="font-semibold text-primary mb-2">Extracted Keywords</h4>
          <p className="text-xs text-muted-foreground mb-3">
            Every requirement, tool, and qualification the employer is screening for — mapped against your CV. {foundCount}/{totalCount} found.
          </p>
          <div className="flex flex-wrap gap-2">
            {keywords.map((kw, idx) => <AtsKeywordChip key={idx} kw={kw} />)}
          </div>
        </div>
      )}

      {results.atsCheck.relevanceSignals.length > 0 && (
        <div>
          <h4 className="font-semibold text-primary mb-3">Relevance Signals</h4>
          <div className="space-y-2">
            {results.atsCheck.relevanceSignals.map((s, idx) => (
              <div key={idx} className={`rounded-lg border p-4 ${s.score >= 7 ? 'bg-green-50 border-green-200' : s.score >= 5 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-primary">
                    {s.signal.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                  </span>
                  <span className={`text-lg font-bold ${impactColor(s.score)}`}>{s.score}<span className="text-xs text-subtle-foreground">/10</span></span>
                </div>
                <p className="text-xs text-foreground">{s.reasoning}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        {results.atsCheck.passed.length > 0 && (
          <div className="rounded-lg bg-green-50 border border-green-200 p-4">
            <p className="text-xs font-semibold text-green-700 mb-2 uppercase tracking-wide">Passed</p>
            <ul className="space-y-1.5">
              {results.atsCheck.passed.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2 text-sm text-green-800">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" /> {item}
                </li>
              ))}
            </ul>
          </div>
        )}
        {results.atsCheck.issues.length > 0 && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4">
            <p className="text-xs font-semibold text-red-700 mb-2 uppercase tracking-wide">Issues</p>
            <ul className="space-y-1.5">
              {results.atsCheck.issues.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2 text-sm text-red-800">
                  <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {(results.jdAlignment.matchedRequirements.length > 0 || results.jdAlignment.missingRequirements.length > 0) && (
        <div>
          <h4 className="font-semibold text-primary mb-3">JD Requirement Alignment</h4>
          {results.jdAlignment.alignmentSummary && (
            <p className="text-sm text-foreground mb-4 leading-relaxed">{results.jdAlignment.alignmentSummary}</p>
          )}
          <div className="grid sm:grid-cols-2 gap-4">
            {results.jdAlignment.matchedRequirements.length > 0 && (
              <div className="rounded-lg bg-green-50 border border-green-200 p-4">
                <p className="text-xs font-semibold text-green-700 mb-2 uppercase tracking-wide">Evidenced in CV</p>
                <ul className="space-y-1">
                  {results.jdAlignment.matchedRequirements.map((req, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-sm text-green-800">
                      <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" /> {req}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {results.jdAlignment.missingRequirements.length > 0 && (
              <div className="rounded-lg bg-red-50 border border-red-200 p-4">
                <p className="text-xs font-semibold text-red-700 mb-2 uppercase tracking-wide">Not Evidenced</p>
                <ul className="space-y-1">
                  {results.jdAlignment.missingRequirements.map((req, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-sm text-red-800">
                      <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {req}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {(results.formatCheck.issues.length > 0 || results.formatCheck.suggestions.length > 0) && (
        <div>
          <h4 className="font-semibold text-primary mb-3">Format & Consistency Check</h4>
          <div className="space-y-2">
            {results.formatCheck.issues.map((issue, idx) => (
              <div key={idx} className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-500" /> {issue}
              </div>
            ))}
            {results.formatCheck.suggestions.map((s, idx) => (
              <div key={idx} className="flex items-start gap-2 rounded-lg bg-primary/5 border border-primary/20 px-4 py-3 text-sm text-primary">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-primary/60" /> {s}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ActionPlanSection({ title, icon, items, emptyMessage }: {
  title: string
  icon: React.ReactNode
  items: ActionPlanItem[]
  emptyMessage?: string
}) {
  if (items.length === 0) {
    if (!emptyMessage) return null
    return (
      <div>
        <h4 className="font-semibold text-primary mb-2 flex items-center gap-2">{icon}{title}</h4>
        <p className="text-sm text-muted-foreground italic">{emptyMessage}</p>
      </div>
    )
  }
  return (
    <div>
      <h4 className="font-semibold text-primary mb-3 flex items-center gap-2">{icon}{title}</h4>
      <div className="space-y-2">
        {items.map((item, idx) => (
          <div key={idx} className="rounded-lg border bg-background px-4 py-3">
            <p className="text-sm font-semibold text-primary">{item.title}</p>
            {item.description && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{item.description}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

export function ActionPlanTab({ plan }: { plan: ActionPlan }) {
  const hasAnything =
    plan.summary.trim().length > 0 ||
    plan.projectsToBuild.length > 0 ||
    plan.skillsToLearn.length > 0 ||
    plan.certifications.length > 0 ||
    plan.intermediateRoles.length > 0

  if (!hasAnything) {
    return <p className="text-muted-foreground text-sm">No action plan returned.</p>
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-5 py-4">
        <p className="text-sm text-primary">
          Concrete next steps tailored to your gaps — specific projects to build, skills to acquire, certifications to pursue, and roles to target in the interim.
        </p>
      </div>
      {plan.summary && (
        <div className="bg-primary rounded-xl p-6 text-primary-foreground">
          <p className="text-xs font-semibold text-highlight-ink mb-2 uppercase tracking-wide flex items-center gap-2">
            <Target className="w-4 h-4" /> Strategic Summary
          </p>
          <p className="text-primary-foreground/80 text-base leading-relaxed">{plan.summary}</p>
        </div>
      )}
      <ActionPlanSection
        title="Projects to Build"
        icon={<span className="text-highlight-ink font-bold">1.</span>}
        items={plan.projectsToBuild}
        emptyMessage="No portfolio gaps identified."
      />
      <ActionPlanSection
        title="Skills to Learn"
        icon={<span className="text-highlight-ink font-bold">2.</span>}
        items={plan.skillsToLearn}
      />
      <ActionPlanSection
        title="Certifications"
        icon={<span className="text-highlight-ink font-bold">3.</span>}
        items={plan.certifications}
        emptyMessage="No certifications are strictly required for this role."
      />
      <ActionPlanSection
        title="Intermediate Roles to Target"
        icon={<span className="text-highlight-ink font-bold">4.</span>}
        items={plan.intermediateRoles}
        emptyMessage="No seniority gap detected — you can apply directly to the target role."
      />
    </div>
  )
}
