# features/gamification — streaks, quests, XP, Career Coins

- The home page renders `components/progress-panel.tsx`: the v2 panel when
  `GET /api/gamification` says `enabled`, otherwise the older weekly-tasks `ThisWeek`.
  `/jobs` shows a one-line streak/XP strip only when v2 is on.
- Rewards are decided in the database (see `supabase/CLAUDE.md`), never in the UI —
  the client only reads the summary and posts goals, rest days and "achievement seen".
- Any mutation that can earn a reward must invalidate the `['gamification']` query
  (job-tracking mutations already do).
- Career Coins are earn-only and are **not** credits.
- Proxies live in `app/api/gamification/` (`forward.ts` is their shared forwarder).
