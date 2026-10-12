/**
 * Gamification v2 (migration 047, docs/GAMIFICATION_V2.md): XP for verified
 * actions, streaks with rest days, daily quests, a weekly challenge,
 * achievements and Career Coins. Coins are earn-only — a score, never credits.
 *
 * The rules and amounts live in the database (`gamification_config`); this file
 * only describes what the API returns, plus the copy shown for each key.
 */

export type GoalIntensity = 'light' | 'active' | 'intensive'
export type GoalType = 'graduate_scheme' | 'internship' | 'first_role' | 'career_change' | 'experienced' | 'visa_sponsored'
export type GoalTimeline = 'asap' | '1_3_months' | '3_6_months' | 'exploring'

export const GOAL_INTENSITIES: readonly GoalIntensity[] = ['light', 'active', 'intensive']
export const GOAL_TYPES: readonly GoalType[] = [
  'graduate_scheme', 'internship', 'first_role', 'career_change', 'experienced', 'visa_sponsored',
]
export const GOAL_TIMELINES: readonly GoalTimeline[] = ['asap', '1_3_months', '3_6_months', 'exploring']

/** Copy for the daily quests, by `quest_key`. Unknown keys fall back to the key. */
export const QUEST_COPY: Readonly<Record<string, { title: string; href: string }>> = {
  save_jobs: { title: 'Save 2 jobs worth applying for', href: '/search' },
  tailor_cv: { title: 'Tailor your CV to a saved job', href: '/cv-optimizer' },
  practice_answer: { title: 'Practise an interview answer', href: '/?view=interview' },
}

/** Copy for achievements, by `achievement_key`. */
export const ACHIEVEMENT_COPY: Readonly<Record<string, { title: string; description: string }>> = {
  first_shot: { title: 'First shot', description: 'Sent your first tracked application.' },
  first_mock: { title: 'First mock', description: 'Finished a mock interview.' },
  on_a_roll: { title: 'On a roll', description: 'Seven active days in a row.' },
  interview_unlocked: { title: 'Interview unlocked', description: 'Landed your first interview.' },
  ten_quality: { title: 'Ten quality applications', description: 'Ten applications backed by a tailored CV.' },
  quality_over_quantity: { title: 'Quality over quantity', description: 'Five Power applications: tailored CV, letter and follow-up.' },
  interview_ready: { title: 'Interview ready', description: 'Five mock interviews finished.' },
  you_did_it: { title: 'You did it', description: 'Got an offer.' },
}

export interface GamificationQuest {
  key: string
  kind: string
  target: number
  progress: number
  done: boolean
}

export interface GamificationAchievement {
  key: string
  earnedAt: string
  /** null until the student has seen the "earned" moment. */
  seenAt: string | null
}

export interface GamificationGoals {
  timezone: string
  intensity: GoalIntensity
  goalType: GoalType | null
  timeline: GoalTimeline | null
  /** When the timezone may next change (it can change once per 24 hours); null = now. */
  timezoneChangeableAt: string | null
}

/** Cards on the board per stage — the journey map. */
export interface GamificationJourney {
  saved: number
  preparing: number
  applied: number
  interview: number
  offer: number
}

/** GET /api/gamification when the backend runs without GAMIFICATION_V2_ENABLED. */
export interface GamificationDisabled {
  enabled: false
}

/** GET /api/gamification */
export interface GamificationSummary {
  enabled: true
  /** The student's local day, `YYYY-MM-DD`, in their timezone. */
  today: string
  xp: { total: number; thisWeek: number; weeklyTarget: number }
  streak: { current: number; activeToday: boolean; restDaysLeftThisMonth: number; upcomingRestDays: string[] }
  coins: number
  quests: GamificationQuest[]
  achievements: GamificationAchievement[]
  goals: GamificationGoals
  journey: GamificationJourney
  /** Rewards still waiting to be judged (a retry is backing off, or one is stuck). */
  pendingRewards: number
}

export type GamificationResponse = GamificationDisabled | GamificationSummary

/** PATCH /api/gamification/goals — every field optional. */
export interface UpdateGamificationGoalsRequest {
  timezone?: string
  intensity?: GoalIntensity
  goalType?: GoalType | null
  timeline?: GoalTimeline | null
}

/** POST /api/gamification/rest-days */
export interface BookRestDayRequest {
  /** `YYYY-MM-DD`, today or up to 31 days ahead in the student's timezone. */
  day: string
}

export interface BookRestDayResponse {
  restDaysLeftThisMonth: number
}

/** POST /api/gamification/achievements/seen */
export interface MarkAchievementsSeenRequest {
  keys: string[]
}

export interface CoinTransaction {
  delta: number
  reason: string
  reference: string
  balanceAfter: number
  createdAt: string
}

/** GET /api/gamification/coins */
export interface CoinHistoryResponse {
  balance: number
  transactions: CoinTransaction[]
}

/** GET /api/admin/gamification/stuck */
export interface StuckRewardIntent {
  seq: number
  userId: string
  kind: string
  attempts: number
  lastError: string | null
  capturedAt: string
}

/** POST /api/admin/gamification/intents/:seq/skip */
export interface SkipRewardIntentRequest {
  reason: string
}
