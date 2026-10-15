/**
 * Cover Letter: is there a job description to write from, and if not, why not?
 *
 * The letter is only as good as the JD it is matched against, so this never
 * hands back missing or unusable text. Each failure is a `JdError` with a code
 * the screen can act on and a message that tells the student how to recover —
 * almost always "paste the description". Before, every link failure was
 * swallowed (and the full URL logged), and anything over 60 characters was
 * written from, so a failed link plus a pasted title-and-location produced a
 * generic letter with no warning.
 *
 * Pure apart from the injected `read`/`extract`, so every path is testable.
 */
import { AuthenticationError } from '@anthropic-ai/sdk';
import { COVER_LETTER_JD_MIN_CHARS, type CoverLetterJdErrorCode } from '@advance-academy/contracts/cover-letter';
import { isBlockedDomain, type UrlReadResult } from '../../services/outreach-extractor.service.js';
import { shouldFetchJd } from './prompts.js';

/** Below this there is nothing to tailor a letter to: about 30 words, i.e. a title and a line. */
export const JD_MIN_CHARS = COVER_LETTER_JD_MIN_CHARS;

const HTTP_STATUS = { badRequest: 400, unprocessable: 422, badGateway: 502, timeout: 504 } as const;

const STATUS_BY_CODE: Record<CoverLetterJdErrorCode, number> = {
  JD_MISSING: HTTP_STATUS.badRequest,
  JD_TOO_SHORT: HTTP_STATUS.badRequest,
  JD_URL_UNSUPPORTED: HTTP_STATUS.unprocessable,
  JD_URL_SIGN_IN: HTTP_STATUS.unprocessable,
  JD_URL_INACCESSIBLE: HTTP_STATUS.unprocessable,
  JD_URL_UNREADABLE: HTTP_STATUS.unprocessable,
  JD_URL_TIMEOUT: HTTP_STATUS.timeout,
  JD_URL_UNREACHABLE: HTTP_STATUS.badGateway,
  JD_EXTRACTION_FAILED: HTTP_STATUS.badGateway,
};

const PASTE = 'Open the job, copy the full description (responsibilities and requirements) and paste it into the Job description box.';

/** A JD problem the student can fix. `expose`: the route sends `message` as-is, whatever the status. */
export class JdError extends Error {
  readonly code: CoverLetterJdErrorCode;
  readonly statusCode: number;
  readonly expose = true;

  constructor(code: CoverLetterJdErrorCode, message: string) {
    super(message);
    this.name = 'JdError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
  }
}

/** File types a link can point at that hold no readable job description. PDFs and Word files are left to the reader. */
const UNSUPPORTED_EXTENSIONS: Array<[RegExp, string]> = [
  [/\.(png|jpe?g|gif|webp|svg|bmp|heic|tiff?)$/i, 'an image'],
  [/\.(zip|rar|7z|gz|tar)$/i, 'a compressed (zip)'],
  [/\.(xlsx?|csv|ods)$/i, 'a spreadsheet'],
  [/\.(pptx?|odp|key)$/i, 'a presentation'],
  [/\.(mp3|mp4|mov|m4a|wav|avi|webm)$/i, 'an audio or video'],
];

export function unsupportedLinkKind(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    return UNSUPPORTED_EXTENSIONS.find(([re]) => re.test(path))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The site's name for logs and messages — never the path or query, which can carry tracking ids. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'that site';
  }
}

function signInSiteName(url: string): string {
  return linkHost(url).includes('linkedin') ? 'LinkedIn' : linkHost(url).includes('facebook') ? 'Facebook' : linkHost(url);
}

function inaccessible(status: number | null): JdError {
  const why =
    status === 404 || status === 410
      ? 'the page was not found, so the job may have closed'
      : status === 401 || status === 403
        ? 'the site refused access, it may need a sign-in'
        : status
          ? `the site answered with error ${status}`
          : 'the page could not be opened';
  return new JdError('JD_URL_INACCESSIBLE', `We couldn't open that job link: ${why}. ${PASTE}`);
}

function unreadable(): JdError {
  return new JdError(
    'JD_URL_UNREADABLE',
    `We opened that link but found no job description on the page (it may be a search results page, a sign-in page or an expired job). ${PASTE}`,
  );
}

/** Map a failed page read (outreach-extractor `readUrl`) to what the student is told. */
export function jdErrorFromRead(error: unknown): JdError {
  const e = error as { reason?: string; status?: number; targetStatus?: number | null } | null;
  if (e?.targetStatus && e.targetStatus >= 400) return inaccessible(e.targetStatus);
  switch (e?.reason) {
    case 'timeout':
      return new JdError(
        'JD_URL_TIMEOUT',
        'The job page took too long to load. Paste the job description into the Job description box and try again — it is faster too.',
      );
    case 'http':
      // The reader's own 4xx means the page couldn't be loaded; 429/5xx means the reader is struggling.
      if (typeof e.status === 'number' && e.status >= 400 && e.status < 500 && e.status !== 429) return inaccessible(null);
      return new JdError(
        'JD_URL_UNREACHABLE',
        `We couldn't reach that link just now. Check that it opens in your browser and try again, or paste the description instead. ${PASTE}`,
      );
    case 'network':
      return new JdError(
        'JD_URL_UNREACHABLE',
        `We couldn't reach that link. Check that it opens in your browser and try again, or paste the description instead. ${PASTE}`,
      );
    default:
      return unreadable();
  }
}

export function tooShortOrMissing(text: string): JdError {
  if (!text) {
    return new JdError(
      'JD_MISSING',
      'Add the job description: paste it into the Job description box, or give the link to the job posting.',
    );
  }
  return new JdError(
    'JD_TOO_SHORT',
    `The job description is too short to tailor a letter to (${text.length} characters; at least ${JD_MIN_CHARS} needed). ${PASTE}`,
  );
}

export interface JdDeps {
  read(url: string): Promise<UrlReadResult>;
  extract(markdown: string): Promise<{ jobTitle: string; jobDescription: string; companyName: string }>;
  /** Hostname and outcome code only. */
  log?(event: { host: string; code: CoverLetterJdErrorCode }): void;
}

export interface ResolvedJd {
  description: string;
  /** Set when the description came from the link. */
  fetched: { jobTitle: string; companyName: string } | null;
  /** Shown with the letter when the link failed and the pasted text was used instead. */
  notice: string | null;
}

/**
 * The description to write from. Uses the text the student gave when it is
 * full enough; otherwise reads the link. When the link fails, falls back to the
 * student's own text only if that is usable, and says so; otherwise throws the
 * specific JdError.
 */
export async function resolveJobDescription(
  input: { description: string; url: string | null },
  deps: JdDeps,
): Promise<ResolvedJd> {
  const own = input.description.trim();
  const url = input.url?.trim() || null;

  if (!url || !shouldFetchJd(own, url)) {
    if (own.length < JD_MIN_CHARS) throw tooShortOrMissing(own);
    return { description: own, fetched: null, notice: null };
  }

  let problem: JdError;
  const kind = unsupportedLinkKind(url);
  if (kind) {
    problem = new JdError(
      'JD_URL_UNSUPPORTED',
      `That link points to ${kind} file, which has no job description we can read. Use the link to the job's web page instead, or paste the description into the Job description box.`,
    );
  } else {
    try {
      const page = await deps.read(url);
      if (page.targetStatus && page.targetStatus >= 400) {
        problem = inaccessible(page.targetStatus);
      } else if (page.content.trim().length < JD_MIN_CHARS) {
        problem = unreadable();
      } else {
        try {
          const job = await deps.extract(page.content);
          const fetched = job.jobDescription.trim();
          if (fetched.length >= JD_MIN_CHARS) {
            const useFetched = fetched.length > own.length;
            return {
              description: useFetched ? fetched : own,
              fetched: useFetched ? { jobTitle: job.jobTitle.trim(), companyName: job.companyName.trim() } : null,
              notice: null,
            };
          }
          problem = unreadable();
        } catch (error) {
          // A rejected API key is an outage, not a page problem: let the route report it.
          if (error instanceof AuthenticationError) throw error;
          problem = new JdError(
            'JD_EXTRACTION_FAILED',
            `We loaded the job page but couldn't pick the description out of it. ${PASTE}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof JdError || error instanceof AuthenticationError) throw error;
      problem = jdErrorFromRead(error);
    }
    // Known sign-in-only sites: say so, whatever the read looked like.
    if (isBlockedDomain(url) && problem.code !== 'JD_URL_TIMEOUT') {
      problem = new JdError('JD_URL_SIGN_IN', `${signInSiteName(url)} job pages need a sign-in, so we can't read them. ${PASTE}`);
    }
  }

  deps.log?.({ host: linkHost(url), code: problem.code });

  if (own.length >= JD_MIN_CHARS) {
    return {
      description: own,
      fetched: null,
      notice:
        "We couldn't read the job link, so this letter is based on the description you gave. For a closer match, paste the job's full description and write it again.",
    };
  }
  throw problem;
}
