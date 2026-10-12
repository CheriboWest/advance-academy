'use client'

import { AlertTriangle, Lightbulb, Loader, Search } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { EnrichmentCard, EnrichmentResponse, ExperienceLevel } from '@advance-academy/contracts/outreach'
import { SignalCard, SignalCardSkeleton } from './signal-card'

const EXPERIENCE_LEVELS: { value: ExperienceLevel; label: string }[] = [
  { value: 'senior', label: 'Senior' },
  { value: 'mid', label: 'Mid-level' },
  { value: 'fresher', label: 'Fresher' },
  { value: 'intern', label: 'Intern' },
]

interface EnrichmentPanelProps {
  experienceLevel: ExperienceLevel
  onChangeExperienceLevel: (level: ExperienceLevel) => void
  enrichmentResults: EnrichmentResponse | null
  selectedInsightCards: EnrichmentCard[]
  onToggleInsight: (card: EnrichmentCard) => void
  onSearch: () => void
  loading: boolean
  error: string | null
  canSearch: boolean
  hasJd: boolean
}

export function EnrichmentPanel({
  experienceLevel,
  onChangeExperienceLevel,
  enrichmentResults,
  selectedInsightCards,
  onToggleInsight,
  onSearch,
  loading,
  error,
  canSearch,
  hasJd,
}: EnrichmentPanelProps) {
  const showSkeletons = loading
  const hasResults = !loading && enrichmentResults !== null
  const selectedCount = selectedInsightCards.length

  return (
    <div className="p-8 bg-background border rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
      <div className="mb-6">
        <h3 className="text-xl font-serif font-bold text-primary flex items-center gap-2">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary text-sm">3</span>
          Company Insights
        </h3>
        <p className="mt-1 ml-10 text-sm text-muted-foreground">
          {hasJd
            ? 'AI will generate targeted search queries from your JD to find relevant company insights.'
            : 'Add a JD above to get smarter, role-specific search queries.'}
        </p>
      </div>

      <div className="mb-6 ml-10">
        <label className="block text-sm font-semibold text-primary mb-2">
          Experience Level <span className="text-red-500">*</span>
        </label>
        <ToggleGroup
          type="single"
          value={experienceLevel}
          onValueChange={(v) => v && onChangeExperienceLevel(v as ExperienceLevel)}
          variant="outline"
          className="flex flex-wrap gap-0"
        >
          {EXPERIENCE_LEVELS.map((opt) => (
            <ToggleGroupItem
              key={opt.value}
              value={opt.value}
              aria-label={opt.label}
              className="px-5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
            >
              {opt.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="ml-10 mb-6 flex items-center gap-4">
        <button
          type="button"
          onClick={onSearch}
          disabled={!canSearch || loading}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (
            <>
              <Loader className="w-4 h-4 animate-spin" /> Searching with Exa…
            </>
          ) : (
            <>
              <Search className="w-4 h-4" /> Search Company Insights
            </>
          )}
        </button>
        {selectedCount > 0 && (
          <span className="text-sm font-semibold text-primary bg-primary/5 px-3 py-1.5 rounded-full border border-primary/20">
            {selectedCount} insight{selectedCount !== 1 ? 's' : ''} selected
          </span>
        )}
        {!canSearch && (
          <p className="text-xs text-subtle-foreground">
            Fill in Target Company and Target Role to enable search.
          </p>
        )}
      </div>

      {error && (
        <div className="ml-10 mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Search failed</p>
            <p className="text-xs mt-0.5">{error}</p>
            <button
              type="button"
              onClick={onSearch}
              className="mt-2 text-xs font-semibold text-red-700 underline hover:text-red-900"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {(showSkeletons || hasResults) && (
        <div className="ml-10">
          <div className="mb-3 flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-highlight-ink" />
            <h4 className="text-sm font-bold text-primary">Company Insights</h4>
            <span className="text-xs text-subtle-foreground">— top 3 auto-selected, adjust as needed</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {showSkeletons &&
              Array.from({ length: 6 }).map((_, i) => <SignalCardSkeleton key={i} />)}
            {hasResults && enrichmentResults!.insightResults.length === 0 && (
              <p className="text-xs text-subtle-foreground italic col-span-2">No results found. Try adjusting the company name or role.</p>
            )}
            {hasResults &&
              enrichmentResults!.insightResults.map((card, index) => (
                <SignalCard
                  key={card.url}
                  card={card}
                  selected={selectedInsightCards.some((c) => c.url === card.url)}
                  onSelect={() => onToggleInsight(card)}
                  autoRecommended={index < 3}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
