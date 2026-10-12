"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

import {
  ALL,
  DEFAULT_MODE,
  DEFAULT_SORT,
  LOCATION_OPTIONS,
  SECTOR_OPTIONS,
  SORT_OPTIONS,
  type SearchFiltersState,
  type SearchMode,
  type SortOption,
} from "@/features/career-hub/lib/filters";
import { cn } from "@/shared/utils/cn";
import { PageContainer } from "@/features/career-hub/components/page-container";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SearchFiltersProps = Omit<SearchFiltersState, "page">;

/**
 * Small client component that reflects the current filters and writes changes
 * back to the URL. The server component reads those params and fetches data —
 * there is no client-side data fetching.
 */
const MODE_OPTIONS: ReadonlyArray<{ value: SearchMode; label: string }> = [
  { value: "company", label: "By company" },
  { value: "role", label: "By job role" },
];

export function SearchFilters({
  q,
  location,
  sector,
  sort,
  mode,
  hiringOnly,
}: SearchFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = React.useTransition();

  // Local mirror of the text input; committed to the URL on submit.
  const [query, setQuery] = React.useState(q);
  React.useEffect(() => setQuery(q), [q]);

  const commit = React.useCallback(
    (patch: Partial<SearchFiltersState>) => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("page"); // a new filter starts from the first page

      const setOrDelete = (key: string, value: string, isDefault: boolean) => {
        if (!value || isDefault) params.delete(key);
        else params.set(key, value);
      };

      if (patch.q !== undefined) setOrDelete("q", patch.q.trim(), false);
      if (patch.location !== undefined)
        setOrDelete("location", patch.location, patch.location === ALL);
      if (patch.sector !== undefined)
        setOrDelete("sector", patch.sector, patch.sector === ALL);
      if (patch.sort !== undefined)
        setOrDelete("sort", patch.sort, patch.sort === DEFAULT_SORT);
      if (patch.mode !== undefined)
        setOrDelete("mode", patch.mode, patch.mode === DEFAULT_MODE);
      if (patch.hiringOnly !== undefined)
        setOrDelete("all", "1", patch.hiringOnly);

      const qs = params.toString();
      startTransition(() => {
        router.push(qs ? `/search?${qs}` : "/search", { scroll: false });
      });
    },
    [router, searchParams]
  );

  // Active filters, surfaced as one-click-removable chips.
  const chips: Array<{ label: string; clear: () => void }> = [];
  if (q.trim())
    chips.push({ label: `“${q.trim()}”`, clear: () => commit({ q: "" }) });
  if (location !== ALL)
    chips.push({ label: location, clear: () => commit({ location: ALL }) });
  if (sector !== ALL)
    chips.push({ label: sector, clear: () => commit({ sector: ALL }) });

  return (
    <div className="sticky top-0 z-30 border-b border-border bg-card">
      {/* Navigation is a transition, not a spinner — show it as a hairline. */}
      <div
        aria-hidden
        className={cn(
          "h-0.5 origin-left bg-highlight transition-transform duration-500",
          isPending ? "scale-x-100" : "scale-x-0"
        )}
      />

      <PageContainer className="py-3" aria-busy={isPending}>
        {/* Search-by mode toggle — chips, matching the nav. */}
        <div className="flex gap-2" role="group" aria-label="Search by">
          {MODE_OPTIONS.map((option) => {
            const active = option.value === mode;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => commit({ mode: option.value })}
                className={cn(
                  "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "border-primary/30 bg-secondary text-primary"
                    : "border-transparent text-muted-foreground hover:bg-accent hover:text-primary"
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            commit({ q: query });
          }}
          className="mt-3 grid gap-3 lg:grid-cols-[1fr_auto]"
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder={
                mode === "role"
                  ? "Search by job title (e.g. Marketing Executive)"
                  : "Search companies by name"
              }
              aria-label={
                mode === "role"
                  ? "Search companies by job title"
                  : "Search companies by name"
              }
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-11 pl-9"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:flex lg:items-center">
            <Select
              value={location}
              onValueChange={(next) => commit({ location: next })}
            >
              <SelectTrigger
                aria-label="Filter by location"
                className="h-11 w-full lg:w-40"
              >
                <SelectValue placeholder="Location" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All locations</SelectItem>
                {LOCATION_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={sector}
              onValueChange={(next) => commit({ sector: next })}
            >
              <SelectTrigger
                aria-label="Filter by sector"
                className="h-11 w-full lg:w-40"
              >
                <SelectValue placeholder="Sector" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All sectors</SelectItem>
                {SECTOR_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={sort}
              onValueChange={(next) => commit({ sort: next as SortOption })}
            >
              <SelectTrigger
                aria-label="Sort results"
                className="col-span-2 h-11 w-full sm:col-span-1 lg:w-56"
              >
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="submit"
              variant="highlight"
              className="col-span-2 h-11 sm:col-span-3 lg:col-span-1 lg:w-auto lg:px-6"
            >
              <Search className="size-4" />
              Search
            </Button>
          </div>
        </form>

        {mode === "company" && (
          <label className="mt-3 inline-flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={!hiringOnly}
              onChange={(event) => commit({ hiringOnly: !event.target.checked })}
              className="size-4 accent-primary"
            />
            Include companies with no open jobs
          </label>
        )}

        {chips.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="label-caps">Filtered by</span>
            {chips.map((chip) => (
              <button
                key={chip.label}
                type="button"
                onClick={chip.clear}
                className="group inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm transition-colors hover:border-destructive hover:text-destructive"
              >
                {chip.label}
                <X className="size-3.5 opacity-60 group-hover:opacity-100" />
                <span className="sr-only">Remove filter</span>
              </button>
            ))}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
