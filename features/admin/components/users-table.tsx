'use client'

import { useMemo, useState } from 'react'
import { relativeDay } from '@advance-academy/contracts/admin-person'
import { useAdminUsers, useUpdateAdminUser } from '../hooks/use-admin-users'
import { PersonDrawer } from './person-drawer'
import { HttpClientError } from '@/shared/api/http-client'
import type { AdminUserPatch, AdminUserRow } from '@advance-academy/contracts/admin'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/** One explanation for both engagement columns — they answer the same question. */
const ENGAGEMENT_HELP =
  'Tool runs, interview sessions and coaching bookings combined. Hover a date for the exact time and the all-time total.'

const TIER_FILTERS = ['', 'trial', 'membership'] as const
const STATUS_FILTERS = ['', 'pending', 'approved', 'rejected'] as const

const STATUS_VARIANT = {
  pending: 'outline',
  approved: 'secondary',
  rejected: 'destructive',
} as const

const selectClass =
  'h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring'

/** Quick top-up buttons — the amounts an admin actually reaches for. */
const CREDIT_STEPS = [1, 5, 10] as const

function CreditControls({
  user,
  onPatch,
  busy,
}: {
  user: AdminUserRow
  onPatch: (patch: AdminUserPatch) => void
  busy: boolean
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2"
        disabled={busy || user.credit_balance === 0}
        onClick={() => onPatch({ creditDelta: -1 })}
        title="Remove one credit"
      >
        −1
      </Button>
      {CREDIT_STEPS.map((n) => (
        <Button
          key={n}
          variant="outline"
          size="sm"
          className="h-7 px-2"
          disabled={busy}
          onClick={() => onPatch({ creditDelta: n })}
          title={`Add ${n} credit${n === 1 ? '' : 's'}`}
        >
          +{n}
        </Button>
      ))}
    </div>
  )
}

/**
 * Coaching sessions left — a quota of its own, not part of the wallet above.
 * Steps of one because that is the unit: one booking, one hour of the coach's
 * time. Admins are unlimited server-side, so the buttons would be a no-op.
 */
function CoachingControls({
  user,
  onPatch,
  busy,
}: {
  user: AdminUserRow
  onPatch: (patch: AdminUserPatch) => void
  busy: boolean
}) {
  // `?? 0` because a backend running ahead of migration 019 omits the column.
  const held = user.coaching_credits ?? 0
  return (
    <div className="flex items-center justify-center gap-1">
      <span className="w-5 text-right tabular-nums">{user.is_admin ? '∞' : held}</span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2"
        disabled={busy || user.is_admin || held === 0}
        onClick={() => onPatch({ coachingDelta: -1 })}
        title="Remove one coaching session"
      >
        −1
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2"
        disabled={busy || user.is_admin}
        onClick={() => onPatch({ coachingDelta: 1 })}
        title="Grant one coaching session"
      >
        +1
      </Button>
    </div>
  )
}

export function UsersTable() {
  const [search, setSearch] = useState('')
  const [tier, setTier] = useState('')
  const [status, setStatus] = useState('')
  const [openPersonId, setOpenPersonId] = useState<string | null>(null)

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      tier: tier || undefined,
      status: status || undefined,
    }),
    [search, tier, status],
  )
  const { data, isLoading, isFetching, error, refetch } = useAdminUsers(filters)
  const update = useUpdateAdminUser()

  const rows = data?.users ?? []
  const forbidden = error instanceof HttpClientError && error.status === 403
  // Which row is mid-request — used to disable just that row's buttons.
  const pendingId = update.isPending ? update.variables?.userId : undefined

  const patch = (userId: string, p: AdminUserPatch) => update.mutate({ userId, patch: p })

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Email
          <input
            className={selectClass}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search by email"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Tier
          <select className={selectClass} value={tier} onChange={(e) => setTier(e.target.value)}>
            {TIER_FILTERS.map((t) => (
              <option key={t} value={t}>
                {t === '' ? 'All tiers' : t}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Approval
          <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === '' ? 'All statuses' : s}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {update.error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {(update.error as Error).message}
        </div>
      ) : null}

      {/* States */}
      {forbidden ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
          You don&apos;t have admin access. Ask an administrator to switch on{' '}
          <code>is_admin</code> for your account, or add your user id to{' '}
          <code>ADMIN_USER_IDS</code>.
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
          Failed to load users: {(error as Error).message}
        </div>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {rows.length} account{rows.length === 1 ? '' : 's'}
            {isFetching ? ' · updating…' : ''}
          </p>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Approval</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                  <TableHead>Adjust</TableHead>
                  <TableHead className="text-center">Coaching</TableHead>
                  <TableHead className="text-center">Referrals</TableHead>
                  {/*
                    These two replace a single "Used a tool ✓/—" column. The tick
                    could not tell an account that signed up months ago and ran
                    one thing from one that ran a dozen this week — which is the
                    only distinction that matters when deciding who to spend a
                    coach's hour on.
                  */}
                  <TableHead title={ENGAGEMENT_HELP}>Last active</TableHead>
                  <TableHead className="text-center" title={ENGAGEMENT_HELP}>
                    Runs (30d)
                  </TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                      No accounts match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((u) => {
                    const busy = pendingId === u.id
                    return (
                      <TableRow key={u.id} className={busy ? 'opacity-60' : undefined}>
                        <TableCell className="font-medium">
                          {/*
                            The email is the way in. The rest of the row holds
                            credit and approval buttons, so a row-wide click
                            target would fire the drawer on every adjustment.
                          */}
                          <button
                            onClick={() => setOpenPersonId(u.id)}
                            className="text-left text-primary transition-colors duration-150 hover:underline"
                          >
                            {u.email ?? '(no email)'}
                          </button>
                          {u.is_admin ? (
                            <Badge variant="destructive" className="ml-2">
                              admin
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[u.status] ?? 'outline'}>{u.status}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={u.tier === 'membership' ? 'default' : 'secondary'}>
                            {u.tier}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {u.is_admin ? '∞' : u.credit_balance}
                        </TableCell>
                        <TableCell>
                          <CreditControls
                            user={u}
                            busy={busy}
                            onPatch={(p) => patch(u.id, p)}
                          />
                        </TableCell>
                        <TableCell>
                          <CoachingControls
                            user={u}
                            busy={busy}
                            onPatch={(p) => patch(u.id, p)}
                          />
                        </TableCell>
                        <TableCell className="text-center tabular-nums">
                          {u.referral_count}
                        </TableCell>
                        <TableCell
                          className={`whitespace-nowrap ${
                            u.last_active_at ? '' : 'text-muted-foreground'
                          }`}
                          // The exact moment stays available on hover; the cell
                          // itself carries the word you scan a column for.
                          title={
                            u.last_active_at
                              ? `${new Date(u.last_active_at).toLocaleString()} · ${u.total_events} all time`
                              : 'No tool run, interview or coaching booking'
                          }
                        >
                          {relativeDay(u.last_active_at)}
                        </TableCell>
                        <TableCell
                          className={`text-center tabular-nums ${
                            u.events_30d > 0 ? 'font-medium' : 'text-muted-foreground'
                          }`}
                        >
                          {u.events_30d}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {new Date(u.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            {u.status !== 'approved' ? (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => patch(u.id, { status: 'approved' })}
                              >
                                Approve
                              </Button>
                            ) : null}
                            {u.status !== 'rejected' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => patch(u.id, { status: 'rejected' })}
                              >
                                Reject
                              </Button>
                            ) : null}
                            {u.tier === 'trial' ? (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => patch(u.id, { tier: 'membership' })}
                              >
                                Upgrade
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => patch(u.id, { tier: 'trial' })}
                              >
                                Downgrade
                              </Button>
                            )}
                            {/*
                              No admin toggle here on purpose. `is_admin` is the
                              highest privilege in the product — it opens this very
                              screen, the coaching console and every user's data —
                              and it sat one click away from Approve, with no
                              confirmation. Granting it is rare and deliberate, so it
                              belongs in the SQL editor (or ADMIN_USER_IDS), not in a
                              row of one-click buttons. The badge beside the email
                              still shows who holds it.
                            */}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <PersonDrawer id={openPersonId} onClose={() => setOpenPersonId(null)} />
    </div>
  )
}
