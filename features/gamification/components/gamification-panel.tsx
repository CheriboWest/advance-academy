'use client'

import Link from 'next/link'
import { CheckCircle2, Circle, Flame, Moon, Sparkles, Star } from 'lucide-react'
import {
  ACHIEVEMENT_COPY,
  GOAL_INTENSITIES,
  QUEST_COPY,
  type GamificationSummary,
  type GoalIntensity,
} from '@advance-academy/contracts/gamification'
import { Button } from '@/components/ui/button'
import { useBookRestDay, useMarkAchievementsSeen, useUpdateGoals } from '../hooks/use-gamification'

/**
 * Gamification v2 dashboard block (migration 047). Everything shown is read
 * from what the student verifiably did — nothing here can award anything.
 * Career Coins use a sparkle, never the credit coin: they are earned, not spent.
 */

const INTENSITY_LABEL: Record<GoalIntensity, string> = { light: 'Light', active: 'Active', intensive: 'Intensive' }
const JOURNEY: Array<{ key: keyof GamificationSummary['journey']; label: string }> = [
  { key: 'saved', label: 'Saved' },
  { key: 'preparing', label: 'Preparing' },
  { key: 'applied', label: 'Applied' },
  { key: 'interview', label: 'Interview' },
  { key: 'offer', label: 'Offer' },
]

function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

export function GamificationPanel({ data }: { data: GamificationSummary }) {
  const setGoals = useUpdateGoals()
  const restDay = useBookRestDay()
  const markSeen = useMarkAchievementsSeen()

  const unseen = data.achievements.filter((a) => !a.seenAt)
  const questsDone = data.quests.filter((q) => q.done).length
  const weekPct = data.xp.weeklyTarget > 0 ? Math.min(100, Math.round((data.xp.thisWeek / data.xp.weeklyTarget) * 100)) : 0
  const tz = browserTimezone()
  // Offer the browser's zone when it differs and a change is allowed (once a day).
  const switchTo = tz && tz !== data.goals.timezone && !data.goals.timezoneChangeableAt ? tz : null
  const canRest = !data.streak.activeToday && data.streak.restDaysLeftThisMonth > 0

  return (
    <section aria-labelledby="your-progress" className="rounded-xl border bg-background p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="your-progress" className="font-serif text-2xl font-semibold text-primary">
            Your progress
          </h2>
          <p className="text-sm text-muted-foreground">
            {questsDone} of {data.quests.length} daily quests done. Everything here ticks off from what you actually do.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-3 py-1.5 text-sm font-medium text-orange-900">
            <Flame className="h-4 w-4" aria-hidden />
            {data.streak.current}-day streak
          </span>
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-secondary/15 px-3 py-1.5 text-sm font-medium text-primary"
            title="Career Coins are earned for milestones. They are not credits and can't be spent on tools."
          >
            <Sparkles className="h-4 w-4 text-highlight-ink" aria-hidden />
            {data.coins} Career Coins
          </span>
        </div>
      </div>

      {unseen.length > 0 ? (
        <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <div className="flex items-start gap-2 text-sm text-amber-900">
            <Star className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div>
              {unseen.map((a) => (
                <p key={a.key}>
                  <span className="font-semibold">New: {ACHIEVEMENT_COPY[a.key]?.title ?? a.key}</span>
                  {ACHIEVEMENT_COPY[a.key] ? ` — ${ACHIEVEMENT_COPY[a.key].description}` : null}
                </p>
              ))}
            </div>
          </div>
          <Button size="sm" variant="outline" disabled={markSeen.isPending} onClick={() => markSeen.mutate(unseen.map((a) => a.key))}>
            Nice
          </Button>
        </div>
      ) : null}

      <div className="mt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="font-medium text-primary">
            {data.xp.thisWeek} / {data.xp.weeklyTarget} XP this week
          </span>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Pace
            <select
              className="rounded-md border bg-background px-2 py-1 text-xs"
              value={data.goals.intensity}
              disabled={setGoals.isPending}
              onChange={(e) => setGoals.mutate({ intensity: e.target.value as GoalIntensity })}
            >
              {GOAL_INTENSITIES.map((i) => (
                <option key={i} value={i}>
                  {INTENSITY_LABEL[i]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div
          className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="XP this week"
          aria-valuemin={0}
          aria-valuemax={data.xp.weeklyTarget}
          aria-valuenow={Math.min(data.xp.thisWeek, data.xp.weeklyTarget)}
        >
          <div className="h-full bg-primary" style={{ width: `${weekPct}%` }} />
        </div>
      </div>

      <h3 className="mt-5 text-sm font-semibold text-primary">Today&apos;s quests</h3>
      <ul className="mt-2 space-y-2">
        {data.quests.map((q) => {
          const copy = QUEST_COPY[q.key]
          return (
            <li key={q.key} className="flex items-center gap-3">
              {q.done ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-green-700" aria-label="Done" />
              ) : (
                <Circle className="h-5 w-5 shrink-0 text-muted-foreground" aria-label="Not done yet" />
              )}
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3">
                {q.done || !copy ? (
                  <span className={`text-sm ${q.done ? 'text-muted-foreground line-through' : ''}`}>{copy?.title ?? q.key}</span>
                ) : (
                  <Link href={copy.href} className="text-sm font-medium text-primary hover:underline">
                    {copy.title}
                  </Link>
                )}
                <span className="text-xs tabular-nums text-muted-foreground">
                  {q.progress}/{q.target}
                </span>
              </div>
            </li>
          )
        })}
      </ul>

      <h3 className="mt-5 text-sm font-semibold text-primary">Your job search</h3>
      <ol className="mt-2 grid grid-cols-5 gap-1 text-center" aria-label="Jobs by stage">
        {JOURNEY.map((stage) => (
          <li key={stage.key} className="rounded-md bg-muted/60 px-1 py-2">
            <p className="text-lg font-semibold tabular-nums text-primary">{data.journey[stage.key]}</p>
            <p className="text-[11px] text-muted-foreground">{stage.label}</p>
          </li>
        ))}
      </ol>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
        {canRest ? (
          <Button size="sm" variant="ghost" disabled={restDay.isPending} onClick={() => restDay.mutate(data.today)}>
            <Moon className="h-4 w-4" aria-hidden />
            Take today off ({data.streak.restDaysLeftThisMonth} rest {data.streak.restDaysLeftThisMonth === 1 ? 'day' : 'days'} left)
          </Button>
        ) : null}
        {restDay.error ? <span className="text-red-700">{restDay.error.message}</span> : null}
        <span>
          Days run on {data.goals.timezone.replace(/_/g, ' ')} time.
          {switchTo ? (
            <>
              {' '}
              <button
                type="button"
                className="font-medium text-primary underline-offset-2 hover:underline"
                disabled={setGoals.isPending}
                onClick={() => setGoals.mutate({ timezone: switchTo })}
              >
                Use {switchTo.replace(/_/g, ' ')}
              </button>
            </>
          ) : null}
        </span>
        {setGoals.error ? <span className="text-red-700">{setGoals.error.message}</span> : null}
        {data.pendingRewards > 0 ? <span>{data.pendingRewards} reward(s) still being tallied.</span> : null}
      </div>
    </section>
  )
}
