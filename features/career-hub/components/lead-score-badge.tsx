import { cn } from "@/shared/utils/cn";

interface LeadScoreBadgeProps {
  score: number;
  className?: string;
}

/**
 * Numeric score shown as an editorial statistic — caption above, figure below.
 *
 * Deliberately shows ONLY the numerical score — no tier label, reasoning, or
 * signal breakdown. The value is produced by the backend hiring-signal score
 * and exposed as `company.lead_score`.
 */
export function LeadScoreBadge({ score, className }: LeadScoreBadgeProps) {
  return (
    <span
      className={cn("flex flex-col items-end leading-none", className)}
      title={`Hiring signal score: ${score}`}
    >
      <span className="label-caps">Score</span>
      <span className="mt-1 font-display text-2xl tabular-nums text-foreground">{score}</span>
    </span>
  );
}
