import { forwardGamification } from './forward'

// Progress summary: streak, quests, XP, coins.
export async function GET(request: Request) {
  return forwardGamification(request, '', 'GET')
}
