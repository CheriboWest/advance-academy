/**
 * Cover Letter Generator (App 1, step "Prepare Application").
 *
 * The student picks a CV from their CV Library and a job, and gets back a plain
 * text letter to copy into their own email or application form — nothing is
 * sent from here. A job is either a tracked card (`savedJobId`) or typed in; in
 * both cases a thin description plus a link means the backend fetches the JD
 * from the link first.
 */

/** POST /api/cover-letter/generate */
export interface GenerateCoverLetterRequest {
  /** `cv_versions` row from the student's CV Library. */
  cvVersionId: string
  /**
   * A tracked job. When set, the job fields below are ignored and the letter is
   * saved onto the card — except `jobDescription`, which, when given, replaces
   * the card's description (for when the card's link can't be read).
   */
  savedJobId?: string
  jobTitle?: string
  companyName?: string
  jobDescription?: string
  jobUrl?: string
}

export interface GenerateCoverLetterResponse {
  coverLetter: string
  jobTitle: string
  companyName: string | null
  /** The card the letter was saved to, when the request named one. */
  savedJobId: string | null
  /** Set when the job link couldn't be read and the letter used the description the student gave instead. */
  notice?: string | null
}

/**
 * Error `code`s for "there is no usable job description" — each comes with a
 * `message` that says how to recover (usually: paste the description). No
 * letter is written and no credit is spent.
 */
export const COVER_LETTER_JD_ERROR_CODES = [
  'JD_MISSING', // nothing given
  'JD_TOO_SHORT', // given, but too short to tailor to
  'JD_URL_UNSUPPORTED', // the link is an image, archive, spreadsheet…
  'JD_URL_SIGN_IN', // LinkedIn / Facebook: sign-in only
  'JD_URL_INACCESSIBLE', // the site refused (401/403) or the page is gone (404/410)
  'JD_URL_UNREADABLE', // opened, but no job description on the page
  'JD_URL_TIMEOUT', // the page took too long
  'JD_URL_UNREACHABLE', // network failure, or the page reader is down
  'JD_EXTRACTION_FAILED', // the AI step that picks the JD out of the page failed
] as const

export type CoverLetterJdErrorCode = (typeof COVER_LETTER_JD_ERROR_CODES)[number]

export function isCoverLetterJdErrorCode(code: unknown): code is CoverLetterJdErrorCode {
  return typeof code === 'string' && (COVER_LETTER_JD_ERROR_CODES as readonly string[]).includes(code)
}
