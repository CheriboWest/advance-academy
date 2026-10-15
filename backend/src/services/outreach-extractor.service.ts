import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const BLOCKED_DOMAINS = ['linkedin.com', 'facebook.com'];
const EXTRACT_MAX_CHARS = 1200;

export function isBlockedDomain(targetUrl: string): boolean {
  try {
    const hostname = new URL(targetUrl).hostname.toLowerCase();
    return BLOCKED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export async function extractContent(targetUrl: string, exaText?: string): Promise<string> {
  if (isBlockedDomain(targetUrl)) {
    return (exaText ?? '').slice(0, EXTRACT_MAX_CHARS);
  }

  try {
    const text = await extractTextFromUrl(targetUrl);
    return text.slice(0, EXTRACT_MAX_CHARS);
  } catch {
    // Fall back to Exa text if Jina fails and we happen to have it
    return (exaText ?? '').slice(0, EXTRACT_MAX_CHARS);
  }
}

export async function extractTextFromFile(buffer: Buffer, fileNameLower: string): Promise<string> {
  const isPdf = fileNameLower.endsWith('.pdf');
  const isDocx = fileNameLower.endsWith('.docx');

  if (!isPdf && !isDocx) {
    throw Object.assign(new Error('Only PDF and DOCX files are supported'), { statusCode: 400 });
  }

  let extractedText: string;

  if (isPdf) {
    const pdfData = await pdfParse(buffer);
    extractedText = pdfData.text;
  } else {
    const result = await mammoth.extractRawText({ buffer });
    extractedText = result.value;
  }

  if (!extractedText.trim()) {
    throw Object.assign(new Error('Could not extract text from the uploaded file'), { statusCode: 422 });
  }

  return extractedText.trim();
}

// Jina fetch tuning. A slow/flaky page must not hang the whole outreach flow (AAT-17).
const JINA_TIMEOUT_MS = Number(process.env.JINA_TIMEOUT_MS) || 15000;
const JINA_MAX_RETRIES = 3;

/**
 * A failure worth retrying: network error, request timeout (AbortError), 429, or any
 * 5xx. A 4xx (other than 429) is a permanent error and is thrown immediately.
 */
function isTransientJinaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ('name' in err && (err as { name?: string }).name === 'AbortError') return true;
  const status = 'status' in err ? (err as { status?: number }).status : undefined;
  if (typeof status === 'number') return status === 429 || status >= 500;
  // undici's fetch surfaces network failures as a TypeError ("fetch failed").
  if (err instanceof TypeError) return true;
  return false;
}

/**
 * Retries fn up to maxRetries times on transient failures, with exponential backoff
 * (1s, 2s, 4s). Mirrors withExaRetry in lib/exa-client.ts (AAT-17).
 */
async function withJinaRetry<T>(fn: () => Promise<T>, maxRetries = JINA_MAX_RETRIES): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isTransientJinaError(err) && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  return fn();
}

/** Why a page could not be read: the reader timed out, answered with an HTTP error,
 *  could not be reached, or returned no text. */
export type UrlReadFailure = 'timeout' | 'http' | 'network' | 'empty';

export interface UrlReadResult {
  content: string;
  /**
   * The status the *job site* answered Jina with, when Jina reports one (e.g. a
   * 403 sign-in wall or a 404 expired posting). Jina still returns 200 with the
   * error page's text in that case, so callers that need a real page check this.
   */
  targetStatus: number | null;
}

const TARGET_STATUS_RE = /returned error (\d{3})/i;

/** Single Jina fetch attempt with an enforced request timeout via AbortController. */
async function fetchJinaContent(
  targetUrl: string,
  headers: Record<string, string>,
  timeoutMs = JINA_TIMEOUT_MS,
): Promise<UrlReadResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      // Jina answers 4xx/5xx itself when it cannot load the page at all; its
      // body may name the site's own status ("…returned error 403").
      const body = await res.text().catch(() => '');
      const target = TARGET_STATUS_RE.exec(body);
      // Attach `status` so isTransientJinaError can decide whether to retry.
      throw Object.assign(new Error(`Jina API failed with status ${res.status}`), {
        status: res.status,
        targetStatus: target ? Number(target[1]) : null,
      });
    }

    // Jina returns a JSON object when requested with Accept: json
    // Format: { data: { title: string, content: string, url: string, warning?: string } }
    const data = await res.json() as any;
    const content = data?.data?.content || data?.text || data?.content;
    const warning = typeof data?.data?.warning === 'string' ? data.data.warning : '';
    const target = TARGET_STATUS_RE.exec(warning);

    if (!content) {
      throw Object.assign(new Error('No content returned from URL'), {
        targetStatus: target ? Number(target[1]) : null,
      });
    }

    return { content: content.trim(), targetStatus: target ? Number(target[1]) : null };
  } finally {
    clearTimeout(timeout);
  }
}

function readFailure(err: unknown): UrlReadFailure {
  const e = err as { name?: string; status?: number; message?: string } | null;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'timeout';
  if (typeof e?.status === 'number') return 'http';
  if (err instanceof TypeError) return 'network';
  return 'empty';
}

function jinaHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const jinaKey = process.env.JINA_API_KEY?.trim();
  if (jinaKey) headers['Authorization'] = `Bearer ${jinaKey}`;
  return headers;
}

/**
 * Read a page as text through Jina Reader, saying why when it can't.
 *
 * `timeoutMs` (per attempt) and `maxRetries` let an interactive caller keep the
 * whole read inside its own deadline: the defaults (15s × 3 with 1s/2s backoff)
 * can spend ~48s on one unresponsive site. Throws an Error carrying
 * `reason: UrlReadFailure`, plus `status` (Jina's) and `targetStatus` (the
 * site's) when known.
 */
export async function readUrl(
  targetUrl: string,
  options: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<UrlReadResult> {
  const headers = jinaHeaders();
  try {
    return await withJinaRetry(
      () => fetchJinaContent(targetUrl, headers, options.timeoutMs),
      options.maxRetries,
    );
  } catch (err) {
    const e = err as { status?: number; targetStatus?: number | null; message?: string };
    throw Object.assign(new Error(`Failed to extract URL: ${e?.message ?? 'unknown error'}`), {
      statusCode: 500,
      reason: readFailure(err),
      status: e?.status,
      targetStatus: e?.targetStatus ?? null,
    });
  }
}

export async function extractTextFromUrl(targetUrl: string): Promise<string> {
  // Unchanged contract for its callers: the page text, or an Error with
  // statusCode 500 (now also carrying readUrl's `reason`).
  return (await readUrl(targetUrl)).content;
}
