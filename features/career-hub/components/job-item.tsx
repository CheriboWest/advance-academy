import Link from "next/link";
import { ArrowUpRight, Banknote, Bookmark, CalendarDays, FileSignature, MapPin } from "lucide-react";

import type { Job } from "@/features/career-hub/lib/types";

interface JobItemProps {
  job: Job;
  /**
   * Set on the student page: shows Save and Cover letter, and carries the name
   * into both so the student doesn't retype it. Coach views omit it.
   */
  companyName?: string;
}

/** Format an ISO date as a UK-style `11 Aug 2026` label. */
function formatPostedDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Format a GBP amount without decimals, e.g. `£38,000`. */
function formatGbp(amount: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Build a salary label from an optional min/max pair. */
function formatSalary(
  min: number | null,
  max: number | null
): string | null {
  if (min != null && max != null) return `${formatGbp(min)} – ${formatGbp(max)}`;
  if (min != null) return `${formatGbp(min)}+`;
  if (max != null) return `Up to ${formatGbp(max)}`;
  return null;
}

function JobBody({ job }: { job: Job }) {
  const location = job.location_raw ?? job.city ?? "—";
  const salary = formatSalary(job.salary_min, job.salary_max);

  return (
    <div className="min-w-0 space-y-1.5">
      <h3 className="text-lg">{job.title}</h3>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <MapPin className="size-4" />
          {location}
        </span>
        {salary && (
          <span className="flex items-center gap-1.5 tabular-nums">
            <Banknote className="size-4" />
            {salary}
          </span>
        )}
        {job.posted_at && (
          <span className="flex items-center gap-1.5">
            <CalendarDays className="size-4" />
            Posted {formatPostedDate(job.posted_at)}
          </span>
        )}
      </div>
    </div>
  );
}

const ACTION =
  "inline-flex items-center gap-1.5 font-medium text-highlight-ink underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none";

/**
 * One open role. Three actions rather than one big link: open the posting,
 * save it to the tracker, or go straight to a cover letter for it. Save and
 * Cover letter need an account — a signed-out visitor goes through /login and
 * comes back to the same pre-filled form (middleware keeps `next`).
 */
export function JobItem({ job, companyName }: JobItemProps) {
  const href = job.source_url ?? null;
  const location = job.location_raw ?? job.city ?? null;
  const salary = formatSalary(job.salary_min, job.salary_max);

  const save = new URLSearchParams({ title: job.title, company: companyName ?? "", source: "career_hub" });
  if (href) save.set("add", href);
  if (location) save.set("location", location);
  if (salary) save.set("salary", salary);

  const letter = new URLSearchParams({ title: job.title, company: companyName ?? "" });
  if (href) letter.set("url", href);

  return (
    <div className="card-surface flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <JobBody job={job} />
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer" className={ACTION}>
            View job
            <ArrowUpRight className="size-4" />
          </a>
        )}
        {companyName !== undefined && (
          <>
            <Link href={`/jobs?${save}`} className={ACTION}>
              <Bookmark className="size-4" />
              Save
            </Link>
            <Link href={`/cover-letter?${letter}`} className={ACTION}>
              <FileSignature className="size-4" />
              Cover letter
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
