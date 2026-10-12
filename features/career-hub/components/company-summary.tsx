import { cn } from "@/shared/utils/cn";

interface CompanySummaryProps {
  /** From `public_company_summary.ai_summary` — generated at write time
   *  (company creation / crawl enrichment / manual refresh), never on
   *  render. See backend-python/app/companies/summarizer.py. `null` until first
   *  generated. */
  summary: string | null;
  className?: string;
}

/**
 * Short, factual company summary shown identically on the public/student
 * company page and the coach Sponsored Company page — both read the same
 * stored `ai_summary` column through `public_company_summary`, so this one
 * component is the only place either renders it.
 *
 * Renders nothing when a summary hasn't been generated yet (e.g. a company
 * created before this feature existed, or the post-crawl sweep hasn't run):
 * omitting the section is safer than inventing filler text client-side —
 * the anti-hallucination fallback lives entirely in the backend template
 * (see `fallback_summary` in summarizer.py), which always produces *some*
 * text once generation has actually run.
 */
export function CompanySummary({ summary, className }: CompanySummaryProps) {
  if (!summary) return null;

  return (
    <p className={cn("max-w-prose text-sm leading-relaxed text-muted-foreground", className)}>
      {summary}
    </p>
  );
}
