'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { getSupabaseBrowser } from '@/shared/auth/supabase-browser'
import type { UserStatus } from '@advance-academy/contracts/admin'

interface AuthContextValue {
  session: Session | null
  user: User | null
  /** Approval status; null until GET /api/account/me resolves. */
  status: UserStatus | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  // Passwordless: request a magic login link emailed via Resend (CA-001 P2).
  sendMagicLink: (email: string, name?: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [status, setStatus] = useState<UserStatus | null>(null)
  const [loading, setLoading] = useState(true)

  // Duplicates shared/hooks/use-account on cold load. Deliberate: the provider
  // sits above the query client, so pages can read `status` on first render.
  const loadStatus = useCallback(async (accessToken: string | undefined) => {
    if (!accessToken) {
      setStatus(null)
      return
    }
    try {
      const res = await fetch('/api/account/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) return
      const me = (await res.json()) as { status: UserStatus }
      setStatus(me.status)
    } catch {
      // Network hiccup — status stays null and the backend still gates the data.
    }
  }, [])

  useEffect(() => {
    const supabase = getSupabaseBrowser()

    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      await loadStatus(data.session?.access_token)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      void loadStatus(session?.access_token)
    })

    return () => subscription.unsubscribe()
  }, [loadStatus])

  async function signIn(email: string, password: string) {
    const { error } = await getSupabaseBrowser().auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  }

  async function sendMagicLink(email: string, name?: string) {
    try {
      const res = await fetch('/api/auth/passwordless', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string }
        return { error: data.message ?? 'Could not send your login link.' }
      }
      return { error: null }
    } catch {
      return { error: 'Could not send your login link. Please try again.' }
    }
  }

  async function signOut() {
    await getSupabaseBrowser().auth.signOut()
    setStatus(null)
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        status,
        loading,
        signIn,
        sendMagicLink,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
