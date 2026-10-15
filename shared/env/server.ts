const DEFAULT_BACKEND_URL = 'http://localhost:4000'

export function getServerEnv() {
  const raw = process.env.BACKEND_URL?.trim() || DEFAULT_BACKEND_URL
  return {
    // Strip any trailing slash(es) so proxy paths don't become "//api/...".
    backendUrl: raw.replace(/\/+$/, ''),
  }
}

/**
 * TEMPORARY: shows the read-only diagnostics panel on /coach/contacts (the
 * 37-vs-148 investigation). Off unless CONTACTS_DEBUG_PANEL is exactly "1".
 * Read per request, so on a server it takes effect on restart, not rebuild.
 */
export function contactsDebugPanelEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CONTACTS_DEBUG_PANEL === '1'
}
