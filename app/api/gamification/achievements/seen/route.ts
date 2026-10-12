import { forwardGamification, invalid, readJsonObject } from '../../forward'

export async function POST(request: Request) {
  const body = await readJsonObject(request)
  const keys = body?.keys
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string')) {
    return invalid('keys must be a list of achievement keys.')
  }
  return forwardGamification(request, '/achievements/seen', 'POST', { keys })
}
