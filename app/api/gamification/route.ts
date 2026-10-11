import { forwardGamification } from './forward'

// Progress summary (gamification v2), or `{ enabled: false }` while it is off.
export async function GET(request: Request) {
  return forwardGamification(request, '', 'GET')
}
