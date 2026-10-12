/**
 * Live-vacancy job-search orchestrator (Dream Company).
 *
 * Replaces the single Exa call with a location-routed source strategy:
 *   - UK              → Adzuna (gb) + Reed, merged  (one query per top role)
 *   - Adzuna-covered  → Adzuna (that country)
 *   - uncovered loc   → Exa (date-window filtered)
 *   - flag=exa        → legacy Exa search, byte-identical to the old path (rollback)
 *
 * Freshness (D1/D2): jobs are held to a 7-day window that only widens (→14→30) if too
 * few pass, and NEVER beyond the 30-day hard cap — the old code returned the unfiltered
 * list when few were fresh, which is what surfaced months-old jobs. Structured routes
 * (UK / covered country) do NOT fall back to Exa (D3) — Exa is the source of the dead
 * links and wrong dates this fix removes. Dead links are dropped via a liveness check
 * (D5). It NEVER throws — a broken job source must not take down the roadmap.
 *
 * Output `jobs` stays the unchanged `ExaJobListing[]`; an optional `meta` carries
 * diagnostics (source, window used, sparse, links checked) without touching consumers.
 */
import type { ExaJobListing } from '@advance-academy/contracts/dream-company';
import type { CostBucket } from '../lib/cost-tracker.js';
import { getExaClient, withExaRetry } from '../lib/exa-client.js';
import { searchAdzuna, type AdzunaResult } from '../lib/adzuna-client.js';
import { searchReed, type ReedResult } from '../lib/reed-client.js';
import {
  getJobSourceMode,
  getJobCacheTtlMs,
  getJobFreshnessMaxDays,
  getJobFreshnessHardCapDays,
  getJobMaxRoleQueries,
  isJobLivenessEnabled,
  getJobLivenessTimeoutMs,
  getJobSearchRadiusKm,
  type JobSourceMode,
} from '../config/job-source.js';
import { buildJobCacheKey, withJobCache } from '../lib/job-cache.js';
import { filterLiveJobs } from '../lib/job-liveness.js';
import { resolveLocationWithLlm } from './location-resolver.js';

/** Convert a km radius to whole miles for Reed's distance param (1 km ≈ 0.621371 mi). */
function kmToMiles(km: number): number {
  return Math.round(km * 0.621371);
}

// Kept identical to the previous inline Exa options so `flag=exa` reproduces the old
// behaviour exactly (work order §6 DoD #6).
const EXA_OPTIONS = {
  useAutoprompt: true,
  type: 'fast',
  numResults: 20,
} as const;

/** The distinct failure state when no source could return jobs (AAT-10). */
export const JOBS_UNAVAILABLE_ERROR =
  'Could not load live job listings — the job search service is unavailable. Your roadmap below is still valid.';

/** Notice (NOT an error) for a location we have no live-vacancy coverage for. */
export const REGION_UNSUPPORTED_TEMPLATE =
  "We don't yet have direct live vacancies for {region}. Your roadmap below is still valid.";

export function regionUnsupportedNotice(region: string): string {
  const r = (region ?? '').trim() || 'your region';
  return REGION_UNSUPPORTED_TEMPLATE.replace('{region}', r);
}

/**
 * Notice (NOT an error) for a COVERED region that simply returned no matching vacancies
 * after filtering. Without this, an empty-but-covered result rendered nothing at all —
 * no jobs, no error, no notice — so the user couldn't tell if the search ran (Issue 1).
 */
export const NO_MATCHES_TEMPLATE =
  "We couldn't find live vacancies matching your selected roles in {region} right now. Your roadmap below is still valid.";

export function noMatchesNotice(region: string): string {
  const r = (region ?? '').trim() || 'your area';
  return NO_MATCHES_TEMPLATE.replace('{region}', r);
}

const MAX_JOBS = 20;
const FRESHNESS_MIN_KEEP = 8;
const PER_SOURCE_RESULTS = 15;
// Upper bound on how many candidate URLs we liveness-check (Issue 2). We over-fetch
// (many roles × 2 sources), then check the freshest ~30 so that dropping a few dead
// links still leaves a full page of 20.
const LIVENESS_MAX_CANDIDATES = 30;
// Cap on distinct live titles fed back to the roles-suggestion prompt (Item 3 anchoring).
const MARKET_TITLES_MAX = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface JobSearchInput {
  /** Selected target-role titles, used to build the keyword query. */
  roleTitles: string[];
  /** Free-text location from the user's profile. */
  location: string;
}

/** Diagnostic metadata for UI honesty + QA assertions (D6). Never affects `jobs` shape. */
export interface JobSearchMeta {
  source: 'uk' | 'adzuna' | 'exa' | 'unsupported' | 'none';
  /** The freshness window (days) actually used after any widening. */
  windowDaysUsed: number | null;
  /** True when the window had to widen / too few fresh jobs were found. */
  sparse: boolean;
  /** How many URLs were liveness-checked (0 if disabled). */
  checkedLinks: number;
}

export interface JobSearchResult {
  jobs: ExaJobListing[];
  /** Set on a genuine outage (job source unavailable). The roadmap is still valid. */
  error: string | null;
  /**
   * Informational message — distinct from `error`. Set when the request succeeded but
   * there is nothing to show for a benign reason (e.g. region outside live coverage).
   * The FE renders this gently, not as an error.
   */
  notice?: string | null;
  meta?: JobSearchMeta;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface JobRoute {
  kind: 'uk' | 'adzuna' | 'exa' | 'unsupported';
  /** Adzuna country code for 'uk' ('gb') and 'adzuna' routes. */
  country?: string;
  /**
   * Canonical city/area to search, when resolved by the gazetteer or the LLM fallback.
   * When unset, fetchers derive the `where` from the raw location via extractCity().
   */
  where?: string;
}

const UK_REGEX =
  /\b(uk|u\.k\.|united kingdom|great britain|britain|england|scotland|wales|northern ireland|london|manchester|birmingham|leeds|glasgow|edinburgh|bristol|liverpool|cardiff|belfast|sheffield|nottingham)\b/i;

// Major-city gazetteer (Issue 2, static fast-path). Maps well-known cities to their
// country code so common locations route WITHOUT an LLM call — e.g. "San Francisco, CA"
// or "Berlin" that carry no country name. Not exhaustive by design: anything not here
// falls through to the LLM resolver. UK cities use 'gb' and route to the combined UK
// source; every other code routes to Adzuna for that country.
const CITY_GAZETTEER: Record<string, string[]> = {
  gb: ['oxford', 'cambridge', 'newcastle', 'reading', 'brighton', 'coventry', 'leicester', 'southampton', 'aberdeen', 'dundee'],
  us: ['new york', 'san francisco', 'los angeles', 'chicago', 'boston', 'seattle', 'austin', 'dallas', 'houston', 'atlanta', 'denver', 'miami', 'washington', 'san jose', 'san diego', 'philadelphia', 'portland', 'phoenix', 'nashville'],
  ca: ['toronto', 'vancouver', 'montreal', 'calgary', 'ottawa', 'edmonton', 'winnipeg'],
  au: ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra'],
  de: ['berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln', 'stuttgart', 'düsseldorf', 'dusseldorf'],
  fr: ['paris', 'lyon', 'marseille', 'toulouse', 'lille', 'bordeaux', 'nice', 'nantes'],
  in: ['bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'chennai', 'pune', 'kolkata', 'gurgaon', 'gurugram', 'noida'],
  nl: ['amsterdam', 'rotterdam', 'the hague', 'den haag', 'utrecht', 'eindhoven'],
  nz: ['auckland', 'wellington', 'christchurch'],
  es: ['madrid', 'barcelona', 'valencia', 'seville', 'sevilla', 'malaga', 'málaga'],
  it: ['rome', 'roma', 'milan', 'milano', 'turin', 'torino', 'naples', 'napoli', 'bologna'],
  pl: ['warsaw', 'warszawa', 'krakow', 'kraków', 'wroclaw', 'wrocław', 'gdansk', 'gdańsk', 'poznan', 'poznań'],
  br: ['sao paulo', 'são paulo', 'rio de janeiro', 'brasilia', 'brasília', 'belo horizonte'],
  za: ['johannesburg', 'cape town', 'durban', 'pretoria'],
  ch: ['zurich', 'zürich', 'geneva', 'genève', 'basel', 'bern', 'lausanne'],
  at: ['vienna', 'wien', 'graz', 'salzburg', 'linz'],
  be: ['brussels', 'bruxelles', 'antwerp', 'antwerpen', 'ghent', 'gent'],
  mx: ['mexico city', 'ciudad de méxico', 'guadalajara', 'monterrey'],
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Precompiled once at module load: [{ re, code }] for every gazetteer city.
const GAZETTEER_ENTRIES: Array<{ re: RegExp; code: string }> = Object.entries(CITY_GAZETTEER).flatMap(
  ([code, cities]) => cities.map((city) => ({ re: new RegExp(`\\b${escapeRegex(city)}\\b`, 'i'), code })),
);

/** Map an Adzuna country code to a route ('gb' → combined UK source; else Adzuna). */
function codeToRoute(code: string): JobRoute {
  return code === 'gb' ? { kind: 'uk', country: 'gb' } : { kind: 'adzuna', country: code };
}

// Location keyword → Adzuna country code (the countries Adzuna's API covers).
const ADZUNA_COUNTRY_MAP: Array<{ re: RegExp; code: string }> = [
  { re: /\b(united states|u\.s\.a?\.?|usa|america)\b/i, code: 'us' },
  { re: /\b(australia)\b/i, code: 'au' },
  { re: /\b(canada)\b/i, code: 'ca' },
  { re: /\b(germany|deutschland)\b/i, code: 'de' },
  { re: /\b(france)\b/i, code: 'fr' },
  { re: /\b(india)\b/i, code: 'in' },
  { re: /\b(netherlands|holland)\b/i, code: 'nl' },
  { re: /\b(singapore)\b/i, code: 'sg' },
  { re: /\b(new zealand)\b/i, code: 'nz' },
  { re: /\b(spain|españa)\b/i, code: 'es' },
  { re: /\b(italy|italia)\b/i, code: 'it' },
  { re: /\b(poland|polska)\b/i, code: 'pl' },
  { re: /\b(brazil|brasil)\b/i, code: 'br' },
  { re: /\b(south africa)\b/i, code: 'za' },
  { re: /\b(switzerland|schweiz)\b/i, code: 'ch' },
  { re: /\b(austria|österreich)\b/i, code: 'at' },
  { re: /\b(belgium|belgië|belgique)\b/i, code: 'be' },
  { re: /\b(mexico|méxico)\b/i, code: 'mx' },
  // "US" as a bare token last, so it doesn't shadow words like "Australia".
  { re: /(^|[\s,])us([\s,]|$)/i, code: 'us' },
];

/**
 * Decide which source to use for a location. `mode='exa'` forces the legacy Exa path
 * (debug/rollback only); otherwise UK → uk, a covered country → adzuna, and anything
 * else → `unsupported` (Issue 1). We deliberately no longer fall back to Exa for
 * uncovered regions — Exa is the source of wrong-location / dead / LinkedIn results, so
 * an honest "no coverage" notice beats a full list of wrong jobs. This supersedes the
 * earlier D3 "uncovered → Exa fallback" decision.
 */
export function routeLocation(location: string, mode: JobSourceMode): JobRoute {
  if (mode === 'exa') return { kind: 'exa' };
  const loc = location ?? '';
  if (UK_REGEX.test(loc)) return { kind: 'uk', country: 'gb' };
  for (const { re, code } of ADZUNA_COUNTRY_MAP) {
    if (re.test(loc)) return codeToRoute(code);
  }
  // Gazetteer fast-path: a well-known city with no country name (e.g. "Berlin",
  // "San Francisco, CA") still routes to a real source without an LLM call.
  for (const { re, code } of GAZETTEER_ENTRIES) {
    if (re.test(loc)) return codeToRoute(code);
  }
  return { kind: 'unsupported' };
}

/**
 * Resolve a location to a route, hybrid (Issue 2): the static routeLocation first, and
 * ONLY when it returns 'unsupported' do we spend one cheap LLM call to place misspelled /
 * unlisted / free-text locations. The LLM can only widen coverage to a supported country
 * — an uncovered country (or any failure) stays 'unsupported', so the honest "no coverage"
 * notice is preserved and we still never fall back to Exa. `mode='exa'` short-circuits.
 */
export async function resolveRoute(
  location: string,
  mode: JobSourceMode,
  costBucket?: CostBucket,
): Promise<JobRoute> {
  const staticRoute = routeLocation(location, mode);
  if (staticRoute.kind !== 'unsupported') return staticRoute;

  const resolved = await resolveLocationWithLlm(location, costBucket);
  if (!resolved.countryCode) return staticRoute; // uncovered / unresolved → stays unsupported
  const route = codeToRoute(resolved.countryCode);
  console.log(`[job-search] llm-resolved location="${location}" → ${resolved.countryCode} city="${resolved.city ?? ''}"`);
  return { ...route, where: resolved.city ?? undefined };
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

/** Format the salary/company/description prefix shared by both providers. */
function buildSnippet(
  salaryMin: number | null | undefined,
  salaryMax: number | null | undefined,
  company: string | undefined,
  description: string | undefined,
): string {
  const parts: string[] = [];
  const salary = formatSalary(salaryMin, salaryMax);
  if (salary) parts.push(salary);
  if (company) parts.push(company);
  const head = parts.join(' · ');
  const desc = (description ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (head && desc) return `${head} — ${desc}`;
  return head || desc;
}

function formatSalary(min: number | null | undefined, max: number | null | undefined): string {
  const lo = typeof min === 'number' && min > 0 ? min : undefined;
  const hi = typeof max === 'number' && max > 0 ? max : undefined;
  if (lo && hi) return `£${fmtK(lo)}–${fmtK(hi)}`;
  if (lo) return `£${fmtK(lo)}+`;
  if (hi) return `up to £${fmtK(hi)}`;
  return '';
}

function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

export function normalizeAdzuna(result: AdzunaResult): ExaJobListing {
  return {
    title: result.title ?? result.redirect_url ?? 'Untitled role',
    url: result.redirect_url ?? '',
    snippet: buildSnippet(result.salary_min, result.salary_max, result.company?.display_name, result.description),
    publishedDate: result.created || undefined,
    company: result.company?.display_name?.trim() || undefined,
    location: result.location?.display_name?.trim() || undefined,
    salaryText: formatSalary(result.salary_min, result.salary_max) || undefined,
  };
}

export function normalizeReed(result: ReedResult): ExaJobListing {
  return {
    title: result.jobTitle ?? result.jobUrl ?? 'Untitled role',
    url: result.jobUrl ?? '',
    snippet: buildSnippet(result.minimumSalary, result.maximumSalary, result.employerName, result.jobDescription),
    publishedDate: reedDateToIso(result.date),
    company: result.employerName?.trim() || undefined,
    location: result.locationName?.trim() || undefined,
    salaryText: formatSalary(result.minimumSalary, result.maximumSalary) || undefined,
  };
}

/** Convert Reed's DD/MM/YYYY to an ISO date string; undefined if unparseable. */
export function reedDateToIso(ddmmyyyy: string | undefined): string | undefined {
  if (!ddmmyyyy) return undefined;
  const m = ddmmyyyy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const [, dd, mm, yyyy] = m;
  const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

/** True when a Reed vacancy has no expiry or its expiry is today-or-later. */
export function reedNotExpired(result: ReedResult, now: Date): boolean {
  const iso = reedDateToIso(result.expirationDate);
  if (!iso) return true; // no/invalid expiry → keep
  return Date.parse(iso) >= startOfDay(now);
}

function startOfDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ---------------------------------------------------------------------------
// Relevance filter (Cách A) — deterministic, no LLM, no extra latency
// ---------------------------------------------------------------------------

// Seniority / structural tokens stripped before matching so "Senior Data Analyst"
// still matches the role "Data Analyst".
const RELEVANCE_NOISE = new Set([
  'senior', 'junior', 'lead', 'principal', 'head', 'of', 'graduate', 'trainee',
  'staff', 'mid', 'sr', 'jr', 'i', 'ii', 'iii',
]);

/** Lowercase, strip punctuation, drop seniority/noise tokens. */
export function normalizeTitleTokens(title: string): string[] {
  return (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0 && !RELEVANCE_NOISE.has(t));
}

/**
 * A job matches a role when the role's HEAD token (its final meaningful word, e.g.
 * "analyst" in "Data Analyst") is in the job title AND — for multi-word roles — at
 * least one other role token is too. Single-word roles need only the head token.
 */
function jobMatchesRole(jobTokens: Set<string>, roleTokens: string[]): boolean {
  if (roleTokens.length === 0) return false;
  const head = roleTokens[roleTokens.length - 1];
  if (!jobTokens.has(head)) return false;
  if (roleTokens.length === 1) return true;
  return roleTokens.slice(0, -1).some((t) => jobTokens.has(t));
}

/**
 * Keep only jobs whose title genuinely matches one of the selected roles (Cách A).
 * Deterministic backstop to Adzuna's `title_only` (and Reed's only relevance guard).
 * Strict by design — precision over recall — so adjacent roles (e.g. "Data Engineer"
 * for a "Data Analyst" search) are also dropped; the sparse flag covers thin results
 * rather than back-filling off-topic jobs. Empty/whitespace role list → no-op.
 */
export function filterByRoleRelevance(jobs: ExaJobListing[], roleTitles: string[]): ExaJobListing[] {
  const roleTokenSets = roleTitles.map(normalizeTitleTokens).filter((t) => t.length > 0);
  if (roleTokenSets.length === 0) return jobs;
  return jobs.filter((job) => {
    const jt = new Set(normalizeTitleTokens(job.title));
    return roleTokenSets.some((role) => jobMatchesRole(jt, role));
  });
}

// ---------------------------------------------------------------------------
// Freshness filter (D1 + D2)
// ---------------------------------------------------------------------------

export interface FreshnessResult {
  jobs: ExaJobListing[];
  /** Window (days) whose result was returned. */
  windowDaysUsed: number;
  /** True when even the widest window couldn't reach minKeep. */
  sparse: boolean;
}

/**
 * Keep only jobs within a freshness window, widening the window step-by-step
 * (maxDays → 14 → hardCap) ONLY until `minKeep` jobs pass. Key guarantees (D1/D2):
 *   - We NEVER return the unfiltered list. The old code returned all jobs (incl.
 *     months-old ones) when too few were fresh — that was the "months ago" bug.
 *   - Nothing older than the hard cap is ever returned, full stop.
 *   - Undated / unparseable-date jobs are dropped when `dropUndated` (default true),
 *     so we never display a blank/guessed date (D4).
 * Returns the chosen set plus which window was used and whether it's sparse.
 */
export function applyFreshness(
  jobs: ExaJobListing[],
  opts: { now: Date; maxDays?: number; hardCapDays?: number; minKeep?: number; dropUndated?: boolean },
): FreshnessResult {
  const maxDays = opts.maxDays ?? getJobFreshnessMaxDays();
  const hardCapDays = opts.hardCapDays ?? getJobFreshnessHardCapDays();
  const minKeep = opts.minKeep ?? FRESHNESS_MIN_KEEP;
  const dropUndated = opts.dropUndated ?? true;

  // Candidate pool: dated jobs always eligible; undated kept only when not dropping.
  const pool = jobs.filter((j) => {
    const t = j.publishedDate ? Date.parse(j.publishedDate) : NaN;
    return Number.isNaN(t) ? !dropUndated : true;
  });

  // Windows to try, ascending, unique, never beyond the hard cap.
  const windows = [...new Set([maxDays, 14, hardCapDays].filter((d) => d <= hardCapDays))].sort(
    (a, b) => a - b,
  );

  let last: { jobs: ExaJobListing[]; windowDaysUsed: number } = { jobs: [], windowDaysUsed: hardCapDays };
  for (const w of windows) {
    const cutoff = opts.now.getTime() - w * DAY_MS;
    const fresh = pool.filter((j) => {
      const t = j.publishedDate ? Date.parse(j.publishedDate) : NaN;
      return Number.isNaN(t) ? true : t >= cutoff; // undated (if kept) always passes
    });
    if (fresh.length >= minKeep) return { jobs: fresh, windowDaysUsed: w, sparse: false };
    last = { jobs: fresh, windowDaysUsed: w };
  }
  // Never hit minKeep even at the hard cap → return the hard-cap set (may be small/empty),
  // flagged sparse. Crucially still bounded by hardCap — never the raw unfiltered list.
  return { ...last, sparse: true };
}

// ---------------------------------------------------------------------------
// Merge / finalize
// ---------------------------------------------------------------------------

/**
 * Personal-profile / social URLs that are never a real vacancy — e.g. a
 * linkedin.com/in/... profile Exa sometimes returns as a "job". Dropped from every
 * path so a networking profile can't masquerade as a live listing. Mirrors
 * outreach-extractor's BLOCKED_DOMAINS. (A dedicated "suggest LinkedIn contacts"
 * feature would be separate surface, not a job listing.)
 */
const BLOCKED_JOB_DOMAINS = ['linkedin.com', 'facebook.com'];

export function isBlockedJobUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return BLOCKED_JOB_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** Dedupe (by URL host+path) and sort newest-first (undated last). No cap. */
export function dedupeAndSort(jobs: ExaJobListing[]): ExaJobListing[] {
  const deduped = dedupeJobs(jobs.filter((j) => j.url && !isBlockedJobUrl(j.url)));
  return [...deduped].sort((a, b) => publishedMs(b) - publishedMs(a));
}

/** Dedupe + sort + cap. (Cap AFTER liveness in the live pipeline; this stays for reuse.) */
export function finalizeJobs(jobs: ExaJobListing[], cap: number = MAX_JOBS): ExaJobListing[] {
  return dedupeAndSort(jobs).slice(0, cap);
}

/**
 * Remove duplicate postings keyed by URL host+path (case-insensitive, query/hash and
 * trailing slash ignored). We intentionally do NOT collapse by title alone — two
 * distinct employers routinely post an identically-titled role ("Data Analyst"), and
 * merging them would hide a real vacancy. Same-URL dupes (e.g. an Adzuna redirect seen
 * twice, or the same posting across pages) are the safe, unambiguous case to drop.
 */
export function dedupeJobs(jobs: ExaJobListing[]): ExaJobListing[] {
  const seen = new Set<string>();
  const out: ExaJobListing[] = [];
  for (const job of jobs) {
    const key = urlDedupeKey(job.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(job);
  }
  return out;
}

function urlDedupeKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.host.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function publishedMs(j: ExaJobListing): number {
  if (!j.publishedDate) return 0;
  const t = Date.parse(j.publishedDate);
  return Number.isNaN(t) ? 0 : t;
}

// ---------------------------------------------------------------------------
// Exa (legacy) — kept byte-identical to the previous inline implementation
// ---------------------------------------------------------------------------

async function searchExa(input: JobSearchInput, costBucket?: CostBucket): Promise<ExaJobListing[]> {
  const exa = getExaClient();
  const roleTitles = input.roleTitles.join(' OR ');
  const query = `${roleTitles} hiring ${input.location}`;
  const searchResponse = await withExaRetry(() => exa.searchAndContents(query, EXA_OPTIONS));
  costBucket?.exa('exa.search.jobs', 1);
  return searchResponse.results.map(
    (result: { title: string | null; url: string; text?: string; publishedDate?: string }) => ({
      title: result.title ?? result.url,
      url: result.url,
      snippet: (result.text ?? '').slice(0, 200),
      publishedDate: result.publishedDate ?? undefined,
    }),
  );
}

// ---------------------------------------------------------------------------
// Source fetchers (Adzuna / Reed / UK-combined)
// ---------------------------------------------------------------------------

/**
 * The top N role titles to actually search (D0). The previous code joined ALL selected
 * titles into ONE keyword string, which Adzuna/Reed treat as "must contain every word"
 * → 0 results in production → silent Exa fallback. We instead run ONE query per top
 * role and merge, so each role's real vacancies come back.
 */
export function topRoles(roleTitles: string[]): string[] {
  return roleTitles
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .slice(0, getJobMaxRoleQueries());
}

/**
 * Reduce a free-text location to a city/keyword the job APIs geocode well (D0). Adzuna's
 * `where` and Reed's `locationName` handle "London" far better than "London, United
 * Kingdom". Take the first comma-segment; if that's a bare country name, keep the whole
 * string (nationwide search).
 */
export function extractCity(location: string): string {
  const first = (location ?? '').split(',')[0].trim();
  const bareCountry = /^(uk|u\.k\.|united kingdom|great britain|britain|england|scotland|wales|usa|united states|america)$/i;
  if (!first || bareCountry.test(first)) return (location ?? '').trim();
  return first;
}

/**
 * Run one search per top role via `fn` and merge. If EVERY role query rejects (e.g. a
 * missing/invalid key), rethrow so the caller can treat the source as down. If at least
 * one resolves, return the merged results (an empty array is a valid "no vacancies").
 */
async function gatherRoles<T>(roles: string[], fn: (role: string) => Promise<T[]>): Promise<T[]> {
  if (roles.length === 0) return [];
  const settled = await Promise.allSettled(roles.map(fn));
  if (settled.every((s) => s.status === 'rejected')) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

async function fetchAdzuna(country: string, input: JobSearchInput, costBucket?: CostBucket, whereOverride?: string): Promise<ExaJobListing[]> {
  const roles = topRoles(input.roleTitles);
  const where = whereOverride ?? extractCity(input.location);
  const distanceKm = getJobSearchRadiusKm();
  const results = await gatherRoles(roles, (what) =>
    searchAdzuna({ country, what, where, resultsPerPage: PER_SOURCE_RESULTS, titleOnly: true, distanceKm }),
  );
  logSourceCall(costBucket, 'adzuna', roles.length, results.length);
  return results.map(normalizeAdzuna);
}

async function fetchReed(input: JobSearchInput, now: Date, costBucket?: CostBucket, whereOverride?: string): Promise<ExaJobListing[]> {
  const roles = topRoles(input.roleTitles);
  const locationName = whereOverride ?? extractCity(input.location);
  const distanceFromLocationMiles = kmToMiles(getJobSearchRadiusKm());
  const results = await gatherRoles(roles, (keywords) =>
    searchReed({ keywords, locationName, resultsToTake: PER_SOURCE_RESULTS, distanceFromLocationMiles }),
  );
  logSourceCall(costBucket, 'reed', roles.length, results.length);
  return results.filter((r) => reedNotExpired(r, now)).map(normalizeReed);
}

/**
 * UK route: query Adzuna (gb) and Reed concurrently. Each source is independently
 * tolerant — one failing still returns the other's jobs. Only when BOTH fail do we
 * signal failure (by returning null) so the caller can fall through to Exa.
 */
async function fetchUk(input: JobSearchInput, now: Date, costBucket?: CostBucket, whereOverride?: string): Promise<ExaJobListing[] | null> {
  const [adz, reed] = await Promise.allSettled([
    fetchAdzuna('gb', input, costBucket, whereOverride),
    fetchReed(input, now, costBucket, whereOverride),
  ]);
  if (adz.status === 'rejected') logSourceError('adzuna', adz.reason);
  if (reed.status === 'rejected') logSourceError('reed', reed.reason);
  if (adz.status === 'rejected' && reed.status === 'rejected') return null;
  const jobs = [
    ...(adz.status === 'fulfilled' ? adz.value : []),
    ...(reed.status === 'fulfilled' ? reed.value : []),
  ];
  return jobs;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Search for live vacancies for the given roles/location. Never throws: on total
 * failure returns `{ jobs: [], error: JOBS_UNAVAILABLE_ERROR }`. Results are cached
 * in-memory per (mode|location|roles) for JOB_CACHE_TTL_MS; only successful lookups
 * (error === null) are cached so an outage isn't pinned for the whole TTL.
 */
export async function searchLiveJobs(input: JobSearchInput, costBucket?: CostBucket): Promise<JobSearchResult> {
  const mode = getJobSourceMode();
  const cacheKey = buildJobCacheKey(mode, input.location, input.roleTitles);
  const { value, hit } = await withJobCache<JobSearchResult>(
    cacheKey,
    getJobCacheTtlMs(),
    () => runSearch(input, mode, costBucket),
    { shouldCache: (r) => r.error === null },
  );
  console.log(`[job-search] cache=${hit ? 'hit' : 'miss'} key="${cacheKey}"`);
  return value;
}

/**
 * Broad market search returning DISTINCT live job titles for a set of keyword queries
 * (skills/field — NOT role titles). Anchors the "suggested roles" step to real demand
 * (Item 3): the roles step has no titles yet, so we search Adzuna/Reed on the user's
 * skills and feed back the titles actually being advertised near them.
 *
 * Deliberately SKIPS filterByRoleRelevance — the keywords aren't role titles, so its
 * strict head-token match would drop everything. Results are freshness- and blocked-domain
 * filtered (via dedupeAndSort) and deduped by title. Never throws: any failure → []. The
 * legacy `exa` mode returns [] (anchoring is a hybrid/adzuna_reed feature only).
 */
export async function searchMarketTitles(
  keywords: string[],
  location: string,
  costBucket?: CostBucket,
): Promise<string[]> {
  const kw = keywords.map((k) => k.trim()).filter((k) => k.length > 0).slice(0, getJobMaxRoleQueries());
  if (kw.length === 0) return [];
  const mode = getJobSourceMode();
  if (mode === 'exa') return [];
  const now = new Date();
  try {
    const route = await resolveRoute(location, mode, costBucket);
    if (route.kind === 'unsupported' || route.kind === 'exa') return [];
    const input: JobSearchInput = { roleTitles: kw, location };
    const raw =
      route.kind === 'uk'
        ? await fetchUk(input, now, costBucket, route.where)
        : await fetchAdzuna(route.country ?? 'gb', input, costBucket, route.where);
    if (!raw) return [];
    const fresh = applyFreshness(raw, { now });
    // dedupeAndSort drops blocked-domain URLs and same-URL dupes; the Set collapses the
    // many employers posting an identically-titled role down to one title.
    const titles = dedupeAndSort(fresh.jobs).map((j) => j.title.trim()).filter((t) => t.length > 0);
    const distinct = [...new Set(titles)].slice(0, MARKET_TITLES_MAX);
    console.log(`[job-search] market-titles keywords=${kw.length} route=${route.kind} titles=${distinct.length}`);
    return distinct;
  } catch (err) {
    logSourceError('market-titles', err);
    return [];
  }
}

/** The uncached search: routing → structured sources (no Exa fallback) or Exa-for-uncovered. */
async function runSearch(input: JobSearchInput, mode: JobSourceMode, costBucket?: CostBucket): Promise<JobSearchResult> {
  const now = new Date();
  const route = await resolveRoute(input.location, mode, costBucket);

  // --- Exa route: ONLY via DREAM_JOB_SOURCE=exa (legacy/debug). Byte-identical old path.
  if (route.kind === 'exa') {
    return runExaRaw(input, costBucket);
  }

  // --- Unsupported region (Issue 1): no live-vacancy coverage → honest empty + notice.
  // NOT an Exa fallback (that produced wrong-location/dead jobs) and NOT an error
  // (the roadmap is still generated normally).
  if (route.kind === 'unsupported') {
    console.log(`[job-search] route=unsupported region="${input.location}"`);
    return {
      jobs: [],
      error: null,
      notice: regionUnsupportedNotice(input.location),
      meta: { source: 'unsupported', windowDaysUsed: null, sparse: false, checkedLinks: 0 },
    };
  }

  // --- Structured route (UK = Adzuna+Reed, or a covered country = Adzuna).
  // D3: structured routes NEVER fall back to Exa — Exa is the source of dead links and
  // wrong dates that this whole fix exists to eliminate.
  let primary: ExaJobListing[] | null;
  try {
    primary =
      route.kind === 'uk'
        ? await fetchUk(input, now, costBucket, route.where)
        : await fetchAdzuna(route.country ?? 'gb', input, costBucket, route.where);
  } catch (err) {
    logSourceError(route.kind, err);
    primary = null;
  }

  // Source genuinely down (e.g. missing keys) → AAT-10. Still no Exa.
  if (primary === null) {
    return { jobs: [], error: JOBS_UNAVAILABLE_ERROR, meta: { source: route.kind, windowDaysUsed: null, sparse: true, checkedLinks: 0 } };
  }

  // Relevance filter (Cách A) — runs right after normalize, before freshness. Cheap,
  // deterministic, no LLM. Drops off-topic titles Adzuna/Reed returned despite title_only.
  const relevant = filterByRoleRelevance(primary, input.roleTitles);
  const relevanceDropped = primary.length - relevant.length;

  const fresh = applyFreshness(relevant, { now }); // dropUndated=true (structured always dated)
  // Issue 2 order: dedupe+sort → liveness-check the freshest ~30 → cap 20 AFTER, so
  // dropping dead links doesn't leave a short page.
  const ordered = dedupeAndSort(fresh.jobs);
  const candidates = ordered.slice(0, LIVENESS_MAX_CANDIDATES);
  const live = await maybeLiveness(candidates);
  const jobs = live.jobs.slice(0, MAX_JOBS);
  console.log(
    `[job-search] source=${route.kind} relevance_dropped=${relevanceDropped} window=${fresh.windowDaysUsed}d sparse=${fresh.sparse} checked=${live.checked} dead_dropped=${candidates.length - live.jobs.length} jobs=${jobs.length}`,
  );
  return {
    jobs,
    error: null, // a genuine empty result is not an error (AAT-10 rule)
    // Covered region but nothing matched → gentle notice so the UI never goes silent (Issue 1).
    notice: jobs.length === 0 ? noMatchesNotice(input.location) : null,
    meta: {
      source: route.kind,
      windowDaysUsed: fresh.windowDaysUsed,
      sparse: fresh.sparse || jobs.length < FRESHNESS_MIN_KEEP,
      checkedLinks: live.checked,
    },
  };
}

/**
 * Exa in explicit rollback mode (DREAM_JOB_SOURCE=exa) — byte-identical to the original
 * behaviour: no freshness filter, no liveness, no meta. Do NOT change this path.
 */
async function runExaRaw(input: JobSearchInput, costBucket?: CostBucket): Promise<JobSearchResult> {
  try {
    // Drop linkedin/facebook profile URLs even in legacy Exa mode — this raw path is
    // exactly where a personal profile leaked in as a "job listing" before.
    const jobs = (await searchExa(input, costBucket)).filter((j) => !isBlockedJobUrl(j.url));
    console.log(`[job-search] source=exa(raw) jobs=${jobs.length}`);
    return { jobs, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[job-search] Exa job search failed:', message);
    return { jobs: [], error: JOBS_UNAVAILABLE_ERROR };
  }
}

/**
 * Run the liveness check when enabled; otherwise pass jobs through untouched. All checks
 * run in ONE parallel wave (concurrency = candidate count, bounded to ≤30) so the added
 * latency is at most one timeout (~1.5s) no matter how many links or how slow the board —
 * this is the AC8 guarantee. Adzuna URLs are skipped inside filterLiveJobs.
 */
async function maybeLiveness(jobs: ExaJobListing[]): Promise<{ jobs: ExaJobListing[]; checked: number }> {
  if (!isJobLivenessEnabled() || jobs.length === 0) return { jobs, checked: 0 };
  const res = await filterLiveJobs(jobs, { timeoutMs: getJobLivenessTimeoutMs(), concurrency: jobs.length });
  if (res.dropped > 0) console.log(`[job-search] liveness dropped ${res.dropped}/${res.checked} dead link(s)`);
  return { jobs: res.live, checked: res.checked };
}

// ---------------------------------------------------------------------------
// Logging (cost hooks wired in JS-6)
// ---------------------------------------------------------------------------

function logSourceCall(costBucket: CostBucket | undefined, source: 'adzuna' | 'reed', calls: number, count: number): void {
  const label = `${source}.search (${count} results, ${calls} calls)`;
  if (source === 'adzuna') costBucket?.adzuna(label, calls);
  else costBucket?.reed(label, calls);
}

function logSourceError(source: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[job-search] source=${source} failed: ${message}`);
}
