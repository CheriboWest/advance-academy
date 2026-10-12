import { forwardGamification, invalid, readJsonObject } from '../forward'

const FIELDS = ['timezone', 'intensity', 'goalType', 'timeline'] as const

export async function PATCH(request: Request) {
  const body = await readJsonObject(request)
  if (!body) return invalid('Invalid request body.')
  // Only the known fields travel on; the backend checks their values.
  const patch = Object.fromEntries(FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]))
  if (Object.keys(patch).length === 0) return invalid('Nothing to update.')
  return forwardGamification(request, '/goals', 'PATCH', patch)
}
