'use client'

import Link from 'next/link'
import { Flame, Sparkles } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { ThisWeek } from '@/features/engagement/components/this-week'
import { useGamification } from '../hooks/use-gamification'
import { GamificationPanel } from './gamification-panel'

/**
 * Home dashboard block. The backend decides: with GAMIFICATION_V2_ENABLED it
 * answers a progress summary and this shows the v2 panel; otherwise (or if the
 * summary can't load) it is the existing weekly-tasks block, unchanged.
 */
export function ProgressPanel() {
  const { data, isLoading } = useGamification()
  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl" />
  if (data?.enabled) return <GamificationPanel data={data} />
  return <ThisWeek />
}

/** /jobs: a one-line streak/XP strip, only when v2 is on — /jobs has no panel otherwise. */
export function JobsProgressStrip() {
  const { data } = useGamification()
  if (!data?.enabled) return null
  return (
    <Link
      href="/"
      className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-background px-4 py-2 text-sm text-muted-foreground hover:bg-muted/40"
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-orange-900">
        <Flame className="h-4 w-4" aria-hidden />
        {data.streak.current}-day streak
      </span>
      <span>
        {data.xp.thisWeek} / {data.xp.weeklyTarget} XP this week
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Sparkles className="h-4 w-4 text-highlight-ink" aria-hidden />
        {data.coins} Career Coins
      </span>
      <span className="text-xs">Tailored CV + cover letter + follow-up date = a Power application.</span>
    </Link>
  )
}
