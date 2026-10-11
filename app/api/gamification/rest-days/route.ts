import { forwardGamification, invalid, readJsonObject } from '../forward'

export async function POST(request: Request) {
  const body = await readJsonObject(request)
  if (!body || typeof body.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)) return invalid('day must be YYYY-MM-DD.')
  return forwardGamification(request, '/rest-days', 'POST', { day: body.day })
}
