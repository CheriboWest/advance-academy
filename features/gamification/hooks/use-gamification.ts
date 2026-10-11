'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UpdateGamificationGoalsRequest } from '@advance-academy/contracts/gamification'
import { bookRestDay, getGamification, markAchievementsSeen, updateGamificationGoals } from '../api/frontend-client'

export const GAMIFICATION_KEY = ['gamification'] as const

/** `{ enabled: false }` while the backend runs without GAMIFICATION_V2_ENABLED. */
export function useGamification() {
  return useQuery({ queryKey: GAMIFICATION_KEY, queryFn: getGamification, retry: false, staleTime: 30_000 })
}

function useGamificationMutation<T>(fn: (vars: T) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: GAMIFICATION_KEY }),
    retry: false,
  })
}

export function useUpdateGoals() {
  return useGamificationMutation((body: UpdateGamificationGoalsRequest) => updateGamificationGoals(body))
}

export function useBookRestDay() {
  return useGamificationMutation((day: string) => bookRestDay(day))
}

export function useMarkAchievementsSeen() {
  return useGamificationMutation((keys: string[]) => markAchievementsSeen(keys))
}
