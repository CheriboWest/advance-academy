'use client'

import Link from 'next/link'
import { ExternalLink, TriangleAlert } from 'lucide-react'
import { COVER_LETTER_JD_MIN_CHARS } from '@advance-academy/contracts/cover-letter'

/** The backend's floor (backend/src/lib/cover-letter/jd.ts), from the shared contract. */
export const JD_MIN_CHARS = COVER_LETTER_JD_MIN_CHARS

/**
 * The posting's address, only when it is a real web link — never a `javascript:`
 * or other scheme from a typed-in or stored URL.
 */
export function safeJobLink(url: string | null | undefined): string | null {
  const trimmed = url?.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '')
}

export interface JdRecoveryProps {
  /** The backend's reason (a JdError message) — says what went wrong. */
  message: string
  /** The job's original posting, when there is one. */
  jobUrl: string | null
  /** The tracked job the letter is for, when it came from the tracker. */
  card: { id: string; title: string; companyName: string | null } | null
  /** How much has been pasted so far, for the counter. */
  pastedChars: number
}

/**
 * Shown in place of the plain error when the job description couldn't be read
 * automatically: why, a link to the posting (new tab), and how to paste the
 * description into the box below. Every other input stays as it was, and a
 * tracked job stays the one the letter is saved to.
 */
export function JdRecovery({ message, jobUrl, card, pastedChars }: JdRecoveryProps) {
  const link = safeJobLink(jobUrl)
  return (
    <div
      role="alert"
      aria-labelledby="jd-recovery-title"
      className="space-y-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
    >
      <p id="jd-recovery-title" className="flex items-start gap-2 font-medium">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        We couldn&apos;t read the job description automatically
      </p>
      <p>{message}</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          {link ? (
            <>
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary underline"
              >
                Open the job posting
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>{' '}
              <span className="text-amber-900/80">on {hostOf(link)}</span>
            </>
          ) : (
            'Open the job posting where you found it.'
          )}
        </li>
        <li>Copy the full job description: the responsibilities and the requirements.</li>
        <li>
          Paste it into the <strong>Job description</strong> box below, then press <strong>Write my cover letter</strong>.
          Everything else you entered is kept.
        </li>
      </ol>
      <p className="text-xs text-amber-900/80" aria-live="polite">
        {pastedChars >= JD_MIN_CHARS
          ? `${pastedChars.toLocaleString('en-GB')} characters pasted — ready to try again.`
          : `${pastedChars.toLocaleString('en-GB')} of at least ${JD_MIN_CHARS} characters pasted.`}
      </p>
      {card ? (
        <p className="text-xs">
          The letter will still be saved to your tracked job{' '}
          <Link href={`/jobs/${card.id}/apply`} className="font-medium text-primary underline">
            {card.title}
            {card.companyName ? ` — ${card.companyName}` : ''}
          </Link>
          .
        </p>
      ) : null}
    </div>
  )
}
