import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GamificationSummary } from '@advance-academy/contracts/gamification'

import { JobsProgressStrip, ProgressPanel } from '@/features/gamification/components/progress-panel'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const account: { data: { isAdmin: boolean } | undefined; isLoading: boolean } = { data: undefined, isLoading: false }
vi.mock('@/features/engagement/components/reminders', () => ({ Reminders: () => null }))
vi.mock('@/shared/hooks/use-account', () => ({ useAccount: () => account }))

const state: { data: GamificationSummary | undefined; isLoading: boolean } = { data: undefined, isLoading: false }
const markSeen = vi.fn()
const bookRest = vi.fn()
const setGoals = vi.fn()

vi.mock('@/features/gamification/hooks/use-gamification', () => ({
  useGamification: () => state,
  useMarkAchievementsSeen: () => ({ mutate: markSeen, isPending: false, error: null }),
  useBookRestDay: () => ({ mutate: bookRest, isPending: false, error: null }),
  useUpdateGoals: () => ({ mutate: setGoals, isPending: false, error: null }),
}))

function summary(overrides: Partial<GamificationSummary> = {}): GamificationSummary {
  return {
    today: '2026-10-11',
    xp: { total: 47, thisWeek: 40, weeklyTarget: 80 },
    streak: { current: 3, activeToday: false, restDaysLeftThisMonth: 2, upcomingRestDays: [] },
    coins: 10,
    quests: [
      { key: 'practice_answer', kind: 'answer_practice', target: 1, progress: 1, done: true },
      { key: 'save_jobs', kind: 'job_saved', target: 2, progress: 1, done: false },
      { key: 'tailor_cv', kind: 'cv_tailor', target: 1, progress: 0, done: false },
    ],
    achievements: [
      { key: 'first_shot', earnedAt: '2026-10-11T09:00:00Z', seenAt: null },
      { key: 'first_mock', earnedAt: '2026-10-10T09:00:00Z', seenAt: '2026-10-10T10:00:00Z' },
    ],
    goals: { timezone: 'Europe/London', intensity: 'active', goalType: null, timeline: null, timezoneChangeableAt: null },
    journey: { saved: 4, preparing: 1, applied: 2, interview: 0, offer: 0 },
    pendingRewards: 0,
    ...overrides,
  }
}

beforeEach(() => {
  state.data = undefined
  state.isLoading = false
  account.data = { isAdmin: false }
  account.isLoading = false
  markSeen.mockReset()
  bookRest.mockReset()
  setGoals.mockReset()
})
afterEach(cleanup)

describe('ProgressPanel', () => {
  it('renders nothing when the summary cannot load', () => {
    state.data = undefined
    const { container } = render(<ProgressPanel />)
    expect(container.textContent).toBe('')
  })

  it('renders nothing for a coach (admin)', () => {
    state.data = summary()
    account.data = { isAdmin: true }
    const { container } = render(<ProgressPanel />)
    expect(container.textContent).toBe('')
  })

  it('shows the progress panel for a student', () => {
    state.data = summary()
    render(<ProgressPanel />)
    expect(screen.getByText('Your progress')).toBeTruthy()
    expect(screen.getByText('3-day streak')).toBeTruthy()
    expect(screen.getByText('10 Career Coins')).toBeTruthy()
    expect(screen.getByText('40 / 80 XP this week')).toBeTruthy()
    expect(screen.getByText('1 of 3 daily quests done. Everything here ticks off from what you actually do.')).toBeTruthy()
  })

  it('links open quests to where they are done; done quests are struck through', () => {
    state.data = summary()
    render(<ProgressPanel />)
    expect(screen.getByText('Save 2 jobs worth applying for').closest('a')?.getAttribute('href')).toBe('/search')
    expect(screen.getByText('Tailor your CV to a saved job').closest('a')?.getAttribute('href')).toBe('/cv-optimizer')
    expect(screen.getByText('Practise an interview answer').closest('a')).toBeNull()
  })

  it('announces only unseen achievements, and marks them seen on acknowledgement', () => {
    state.data = summary()
    render(<ProgressPanel />)
    expect(screen.getByText('New: First shot')).toBeTruthy()
    expect(screen.queryByText('New: First mock')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Nice' }))
    expect(markSeen).toHaveBeenCalledWith(['first_shot'])
  })

  it('offers a rest day only when today is not already active', () => {
    state.data = summary()
    const { unmount } = render(<ProgressPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Take today off \(2 rest days left\)/ }))
    expect(bookRest).toHaveBeenCalledWith('2026-10-11')
    unmount()

    state.data = summary({ streak: { current: 4, activeToday: true, restDaysLeftThisMonth: 2, upcomingRestDays: [] } })
    render(<ProgressPanel />)
    expect(screen.queryByRole('button', { name: /Take today off/ })).toBeNull()
  })

  it('changes pace through the goals endpoint', () => {
    state.data = summary()
    render(<ProgressPanel />)
    fireEvent.change(screen.getByLabelText('Pace'), { target: { value: 'intensive' } })
    expect(setGoals).toHaveBeenCalledWith({ intensity: 'intensive' })
  })
})

describe('JobsProgressStrip', () => {
  it('renders nothing for a coach (admin)', () => {
    state.data = summary()
    account.data = { isAdmin: true }
    const { container } = render(<JobsProgressStrip />)
    expect(container.textContent).toBe('')
  })

  it('shows streak, weekly XP and coins', () => {
    state.data = summary()
    render(<JobsProgressStrip />)
    expect(screen.getByText('3-day streak')).toBeTruthy()
    expect(screen.getByText('40 / 80 XP this week')).toBeTruthy()
    expect(screen.getByText('10 Career Coins')).toBeTruthy()
  })
})
