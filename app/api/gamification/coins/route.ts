import { forwardGamification } from '../forward'

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit'))
  return forwardGamification(request, Number.isInteger(limit) && limit > 0 ? `/coins?limit=${limit}` : '/coins', 'GET')
}
