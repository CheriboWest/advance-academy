'use client'

import { useState } from 'react'
import { Check, ChevronDown, ExternalLink, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { EnrichmentCard } from '@advance-academy/contracts/outreach'
import { cn } from '@/shared/utils/cn'

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function scoreBadgeClass(score: number): string {
  if (score >= 80) return 'bg-green-100 text-green-800 border-green-200'
  if (score >= 50) return 'bg-amber-100 text-amber-800 border-amber-200'
  return 'bg-card text-muted-foreground'
}

interface SignalCardProps {
  card: EnrichmentCard
  selected: boolean
  onSelect: () => void
  autoRecommended?: boolean
}

export function SignalCard({ card, selected, onSelect, autoRecommended }: SignalCardProps) {
  const [open, setOpen] = useState(false)
  const hostname = getHostname(card.url)
  const previewSnippet = card.snippet.slice(0, 100)

  return (
    <div
      role="checkbox"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'relative cursor-pointer rounded-xl border bg-background p-4 shadow-sm transition-all',
        'hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring',
        selected ? 'border-primary ring-2 ring-primary/20' : 'border-border',
      )}
    >
      {autoRecommended && (
        <div className="mb-2 inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
          <Sparkles className="h-2.5 w-2.5" />
          AI Recommended
        </div>
      )}

      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        {typeof card.score === 'number' && !autoRecommended && (
          <span
            title={card.reason || 'Claude relevance score'}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
              scoreBadgeClass(card.score),
            )}
          >
            <Sparkles className="h-2.5 w-2.5" />
            {card.score}
          </span>
        )}
        {selected && (
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-3 w-3" />
          </div>
        )}
      </div>

      <h4 className="pr-16 text-sm font-semibold text-primary leading-snug line-clamp-2">
        {card.title}
      </h4>

      <div className="mt-2 flex items-center gap-2">
        <a
          href={card.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          <span className="truncate max-w-[180px]">{hostname}</span>
        </a>
        {card.isBlockedDomain ? (
          <Badge variant="secondary" className="text-[10px]">Via Exa</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">Via Jina</Badge>
        )}
      </div>

      {card.reason && (
        <div className={cn(
          'mt-2 rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed',
          autoRecommended
            ? 'bg-primary/5 text-primary border border-primary/10'
            : 'text-muted-foreground italic',
        )}>
          <Sparkles className="inline h-3 w-3 mr-1 text-primary/60" />
          {card.reason}
        </div>
      )}

      {previewSnippet && (
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{previewSnippet}{card.snippet.length > 100 ? '…' : ''}</p>
      )}

      {card.exaText && (
        <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
          <CollapsibleTrigger
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-primary"
          >
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', open && 'rotate-180')}
            />
            {open ? 'Hide full text' : 'View full text'}
          </CollapsibleTrigger>
          <CollapsibleContent
            onClick={(e) => e.stopPropagation()}
            className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-border bg-card p-3 text-[11px] text-foreground leading-relaxed whitespace-pre-wrap"
          >
            {card.exaText}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

export function SignalCardSkeleton() {
  return (
    <div className="rounded-xl border bg-background p-4 shadow-sm animate-pulse">
      <div className="h-4 w-3/4 rounded bg-muted" />
      <div className="mt-3 h-3 w-1/2 rounded bg-card" />
      <div className="mt-3 h-3 w-full rounded bg-card" />
      <div className="mt-2 h-3 w-5/6 rounded bg-card" />
    </div>
  )
}
