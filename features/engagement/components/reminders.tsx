'use client'

import Link from 'next/link'
import { CalendarClock } from 'lucide-react'
import { useJobBoardSummary, useSavedJobs } from '@/features/job-tracking/hooks/use-job-tracking'
import { useEngagement, useSetEmailReminders } from '../hooks/use-engagement'

/**
 * Under the progress panel: follow-ups due today and the reminder-email switch.
 * Weekly goals and points moved to gamification (047).
 */
export function Reminders() {
  const { data } = useEngagement()
  const { data: jobs } = useSavedJobs()
  const { followUpsDue } = useJobBoardSummary(jobs?.jobs)
  const setReminders = useSetEmailReminders()

  return (
    <div className="mt-4 space-y-3">
      {followUpsDue.length > 0 ? (
        <Link
          href="/jobs"
          className="flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-900 hover:bg-orange-100"
        >
          <CalendarClock className="h-4 w-4 shrink-0" />
          {followUpsDue.length === 1
            ? `Follow up on ${followUpsDue[0].title} today`
            : `${followUpsDue.length} follow-ups due`}
        </Link>
      ) : null}

      {data ? (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={data.emailReminders}
            disabled={setReminders.isPending}
            onChange={(e) => setReminders.mutate(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Email me on the day a follow-up is due
        </label>
      ) : null}
    </div>
  )
}
