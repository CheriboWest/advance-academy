'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/features/auth/context/AuthContext'
import { takeNextPath } from '@/shared/auth/next-path'
import { getSupabaseBrowser } from '@/shared/auth/supabase-browser'

// Magic-link landing (CA-001, P2/2a). Supabase redirects here with the session
// tokens in the URL hash; the browser client (detectSessionInUrl) picks them up
// and writes the session cookies. We just wait for the session to appear, then
// send the user into the app. If it never arrives (expired/reused link), we show
// a recovery message.
//
// This page must stay in middleware's PUBLIC_PATHS: the hash never reaches the
// server, so at request time there is no session yet and middleware would bounce
// it to /login before the client could read the token.
export default function AuthCallbackPage() {
  const { session, loading } = useAuth()
  const router = useRouter()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    // Supabase reports failures as `#error=...` in the hash.
    if (typeof window !== 'undefined' && window.location.hash.includes('error')) {
      setFailed(true)
      return
    }
    // The magic link is minted server-side (passwordless.service.ts), so it uses
    // the implicit flow and lands with `#access_token=…`. Our browser client is
    // PKCE (@supabase/ssr) and refuses to read an implicit hash on its own, so we
    // hand the tokens over ourselves.
    const hash = new URLSearchParams(window.location.hash.slice(1))
    const access_token = hash.get('access_token')
    const refresh_token = hash.get('refresh_token')
    if (!session && access_token && refresh_token) {
      window.history.replaceState(null, '', window.location.pathname)
      void getSupabaseBrowser()
        .auth.setSession({ access_token, refresh_token })
        .then(({ error }) => { if (error) setFailed(true) })
      return
    }
    if (session) {
      // Referral crediting now happens on the invitee's FIRST TOOL USE (see
      // backend lib/credits.ts), not here — logging in alone doesn't earn the
      // inviter a credit. So just enter the app — where the login page was
      // heading, if it parked a path.
      router.replace(takeNextPath() ?? '/')
      return
    }
    // Fallback: no session established within a few seconds.
    const t = setTimeout(() => {
      if (!session) setFailed(true)
    }, 6000)
    return () => clearTimeout(t)
  }, [session, router])

  return (
    <div className="flex min-h-screen items-center justify-center bg-card px-4">
      <div className="w-full max-w-md rounded-2xl bg-background p-8 text-center shadow-xl">
        {failed ? (
          <>
            <h1 className="mb-2 text-xl font-serif font-bold text-primary">Link expired</h1>
            <p className="mb-6 text-sm text-muted-foreground">
              This login link is invalid or has already been used. Please request a new one.
            </p>
            <Link
              href="/login"
              className="inline-block text-sm font-semibold text-primary transition-colors hover:text-highlight-ink"
            >
              Back to sign in
            </Link>
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-t-primary" />
            <h1 className="text-xl font-serif font-bold text-primary">Signing you in…</h1>
            <p className="mt-1 text-sm text-muted-foreground">{loading ? 'Preparing your session.' : 'Almost there.'}</p>
          </>
        )}
      </div>
    </div>
  )
}
