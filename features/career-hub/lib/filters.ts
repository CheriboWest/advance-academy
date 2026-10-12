/**
 * Public search filter definitions — options, defaults, and URL parsing.
 *
 * These are UI presets (not company data), so they live here rather than in any
 * mock-data module. Filters are driven entirely by URL search params so the
 * search page can render on the server for the initial load.
 */

// Major cities first, then the big university / international-student towns.
// Matched as a substring of the company's hq_location/region (queries.ts), so a
// city only returns companies once the crawler has been run for it.
export const LOCATION_OPTIONS = [
  "London",
  "Manchester",
  "Birmingham",
  "Leeds",
  "Glasgow",
  "Edinburgh",
  "Liverpool",
  "Bristol",
  "Sheffield",
  "Newcastle",
  "Nottingham",
  "Leicester",
  "Coventry",
  "Cardiff",
  "Belfast",
  "Southampton",
  "Cambridge",
  "Oxford",
  "Reading",
  "Brighton",
  "York",
  "Bath",
  "Exeter",
  "Lancaster",
  "Durham",
  "Aberdeen",
  "Dundee",
  "Swansea",
  "Norwich",
  "Portsmouth",
  "Plymouth",
  "Loughborough",
  "Guildford",
  "Canterbury",
  "Milton Keynes",
  "Remote",
] as const;

// Keep in sync with SECTORS in backend-python/app/companies/sector.py — that
// classifier is the only writer of companies.sector, and the filter is an exact match.
export const SECTOR_OPTIONS = [
  "Technology",
  "Finance & Banking",
  "Insurance",
  "Accounting & Professional Services",
  "Consulting",
  "Legal",
  "Healthcare",
  "Pharma & Life Sciences",
  "Education",
  "Retail & E-commerce",
  "Hospitality & Leisure",
  "Media, Marketing & Advertising",
  "Engineering & Manufacturing",
  "Construction & Property",
  "Energy & Utilities",
  "Logistics & Transport",
  "Public Sector",
  "Charity & Non-profit",
  "Telecoms",
  "Recruitment & HR",
] as const;

/** Whether the text query searches company names or job roles/titles. */
export type SearchMode = "company" | "role";

export const DEFAULT_MODE: SearchMode = "company";

export type SortOption = "score_desc" | "jobs_desc" | "name_asc";

export const SORT_OPTIONS: ReadonlyArray<{ value: SortOption; label: string }> =
  [
    // Ordered by lead score, which stays a coach-only number (see company-card.tsx).
    { value: "score_desc", label: "Most actively hiring" },
    { value: "jobs_desc", label: "Most open jobs" },
    { value: "name_asc", label: "Company name (A–Z)" },
  ];

export const DEFAULT_SORT: SortOption = "score_desc";

const SORT_VALUES = SORT_OPTIONS.map((option) => option.value);

/** Sentinel used for "no filter" in the URL and select components. */
export const ALL = "all";

export interface SearchFiltersState {
  q: string;
  location: string; // a LOCATION_OPTIONS value or ALL
  sector: string; // a SECTOR_OPTIONS value or ALL
  sort: SortOption;
  mode: SearchMode; // "company" (name search) or "role" (job-title search)
  page: number; // 1-based, company mode only
}

type RawSearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Parse Next.js `searchParams` into a normalised, validated filter state. */
export function parseSearchFilters(params: RawSearchParams): SearchFiltersState {
  const q = (firstValue(params.q) ?? "").toString();
  // Only known options: location is interpolated into a PostgREST or() filter,
  // so a free-form value could add filters of its own.
  const rawLocation = firstValue(params.location) ?? ALL;
  const location = (LOCATION_OPTIONS as readonly string[]).includes(rawLocation) ? rawLocation : ALL;
  const rawSector = firstValue(params.sector) ?? ALL;
  const sector = (SECTOR_OPTIONS as readonly string[]).includes(rawSector) ? rawSector : ALL;

  const rawSort = (firstValue(params.sort) ?? DEFAULT_SORT).toString();
  const sort = (
    SORT_VALUES.includes(rawSort as SortOption) ? rawSort : DEFAULT_SORT
  ) as SortOption;

  const mode: SearchMode =
    firstValue(params.mode) === "role" ? "role" : DEFAULT_MODE;

  const page = Math.max(1, Math.floor(Number(firstValue(params.page))) || 1);

  return { q, location, sector, sort, mode, page };
}
