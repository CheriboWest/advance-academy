'use client'

import { useMemo, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { useLeads } from '../hooks/use-leads'
import { PersonDrawer } from './person-drawer'
import { HttpClientError } from '@/shared/api/http-client'
// Subpath, not the package root: the root barrel re-exports with NodeNext-style
// `.js` specifiers that Turbopack cannot resolve. Type-only imports from the
// root are erased before the bundler sees them and so get away with it — these
// two are values, and would not.
import { houseLabel, leadsToCsv } from '@advance-academy/contracts/leads'
import type { Contactability, LeadRow } from '@advance-academy/contracts/leads'
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

const SOURCES = ['', 'quiz'] as const
const STATUSES = ['', 'new', 'confirmed', 'unsub'] as const

/**
 * What each column actually means.
 *
 * The previous set had nine columns and no way to reach anyone: Source only ever
 * held 'quiz' (it is a filter, not information), and Consent and Confirmed were
 * two tick-boxes that the legend itself had to explain were different — while
 * Confirmed was in fact *structurally always empty*, because a consenting quiz
 * lead is sent a magic login link instead of a double-opt-in confirm email.
 *
 * Those three are now one Contactable verdict, and the space bought back holds
 * the WhatsApp number and career archetype the quiz has been collecting all
 * along inside `result`.
 */
const COLUMN_HELP = {
  WhatsApp: 'Phone number from the quiz form — click to open the chat.',
  House: 'Career archetype the quiz assigned. Tells you what kind of support they need.',
  Channel: 'Acquisition channel from the ?utm_source link, e.g. fb_group, share.',
  Status: 'new = captured · confirmed = clicked the email link · unsub = opted out.',
  Contactable: 'Whether we may lawfully email them marketing, and why. Hover a cell for the reason.',
  Account: 'An account exists with this email — the lead converted to a signup.',
} as const

function ColumnLegend() {
  return (
    <dl className="grid gap-x-6 gap-y-1 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
      {Object.entries(COLUMN_HELP).map(([label, help]) => (
        <div key={label} className="flex gap-1.5">
          <dt className="shrink-0 font-medium text-foreground">{label}</dt>
          <dd>{help}</dd>
        </div>
      ))}
    </dl>
  )
}

function downloadCsv(rows: LeadRow[]) {
  // Same builder the backend's ?format=csv path uses — see packages/contracts.
  const blob = new Blob([leadsToCsv(rows)], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'candidate_leads.csv'
  a.click()
  URL.revokeObjectURL(url)
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'confirmed') return 'default'
  if (status === 'unsub') return 'destructive'
  return 'secondary'
}

const CONTACT_STYLE: Record<Contactability, string> = {
  yes: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending: 'bg-amber-50 text-amber-800 border-amber-200',
  no: 'bg-card text-muted-foreground',
}

const CONTACT_LABEL: Record<Contactability, string> = {
  yes: 'Can email',
  pending: 'Unverified',
  no: 'Do not email',
}

/** The verdict plus its reason on hover — the reason is what makes it actionable. */
function ContactBadge({ row }: { row: LeadRow }) {
  return (
    <span
      title={row.contact_reason}
      className={`inline-flex cursor-help rounded-full border px-2 py-0.5 text-xs font-medium ${CONTACT_STYLE[row.contactable]}`}
    >
      {CONTACT_LABEL[row.contactable]}
    </span>
  )
}

/**
 * The number, linked to WhatsApp.
 *
 * The raw text is shown rather than the normalised digits because that is what a
 * coach reads out loud, and because a number the quiz accepted but we could not
 * normalise (no usable digit count) is still worth showing — it just does not
 * get a link.
 */
function WhatsAppCell({ row }: { row: LeadRow }) {
  if (!row.whatsapp) return <span className="text-muted-foreground">—</span>
  if (!row.whatsapp_digits) {
    return (
      <span className="text-muted-foreground" title="Not a usable phone number">
        {row.whatsapp}
      </span>
    )
  }
  return (
    <a
      href={`https://wa.me/${row.whatsapp_digits}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-emerald-700 transition-colors duration-150 hover:text-emerald-900 hover:underline"
    >
      <MessageCircle className="h-3.5 w-3.5" />
      {row.whatsapp}
    </a>
  )
}

const selectClass =
  'h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring'

export function LeadsTable() {
  const [source, setSource] = useState('')
  const [status, setStatus] = useState('')
  const [channel, setChannel] = useState('')
  const [openPersonId, setOpenPersonId] = useState<string | null>(null)

  const filters = useMemo(
    () => ({
      source: source || undefined,
      status: status || undefined,
      utmSource: channel.trim() || undefined,
    }),
    [source, status, channel],
  )
  const { data, isLoading, isFetching, error, refetch } = useLeads(filters)

  const rows = data?.leads ?? []
  const forbidden = error instanceof HttpClientError && error.status === 403

  // Funnel conversion for the rows currently on screen: how many of these leads
  // went on to create an account. Reflects the active filters, so it answers
  // "how well does THIS channel convert?", not just the overall rate.
  const converted = rows.filter((r) => r.has_account).length
  const conversionPct = rows.length > 0 ? Math.round((converted / rows.length) * 100) : 0
  // The number that decides whether a campaign is possible at all.
  const emailable = rows.filter((r) => r.contactable === 'yes').length
  const reachable = rows.filter((r) => r.whatsapp_digits).length

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Source
          <select
            className={selectClass}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s === '' ? 'All sources' : s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Status
          <select
            className={selectClass}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === '' ? 'All statuses' : s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Channel (utm_source)
          <input
            className={selectClass}
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            placeholder="e.g. fb_group"
          />
        </label>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button size="sm" onClick={() => downloadCsv(rows)} disabled={rows.length === 0}>
            Download CSV
          </Button>
        </div>
      </div>

      {/* States */}
      {forbidden ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
          You don&apos;t have admin access to view leads. Ask an administrator to add your
          account to <code>ADMIN_USER_IDS</code>.
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
          Failed to load leads: {(error as Error).message}
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
            {rows.length} lead{rows.length === 1 ? '' : 's'}
            {rows.length > 0 ? (
              <>
                {' · '}
                <span className="font-medium text-foreground">
                  {converted} signed up ({conversionPct}%)
                </span>
                {' · '}
                {emailable} emailable · {reachable} with a phone number
              </>
            ) : null}
            {isFetching ? ' · updating…' : ''}
          </p>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead title={COLUMN_HELP.WhatsApp}>WhatsApp</TableHead>
                  <TableHead title={COLUMN_HELP.House}>House</TableHead>
                  <TableHead title={COLUMN_HELP.Channel}>Channel</TableHead>
                  <TableHead title={COLUMN_HELP.Status}>Status</TableHead>
                  <TableHead title={COLUMN_HELP.Contactable}>Contactable</TableHead>
                  <TableHead className="text-center" title={COLUMN_HELP.Account}>
                    Account
                  </TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                      No leads match these filters yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        {/*
                          The email opens the drawer rather than the whole row:
                          the row already holds a WhatsApp link, and a row-wide
                          click target would swallow it.
                        */}
                        <button
                          onClick={() => setOpenPersonId(r.id)}
                          className="text-left text-primary transition-colors duration-150 hover:underline"
                        >
                          {r.email}
                        </button>
                      </TableCell>
                      <TableCell>{r.name ?? '—'}</TableCell>
                      <TableCell>
                        <WhatsAppCell row={r} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.house ? (
                          <span title={r.score_breakdown ?? undefined}>{houseLabel(r.house)}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>{r.utm_source ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <ContactBadge row={r} />
                      </TableCell>
                      <TableCell className="text-center">
                        {r.has_account ? (
                          <Badge variant="default">signed up</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {new Date(r.created_at).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <ColumnLegend />
        </>
      )}

      <PersonDrawer id={openPersonId} onClose={() => setOpenPersonId(null)} />
    </div>
  )
}
