"use client";

import * as React from "react";
import {
  BadgeCheck,
  CircleHelp,
  Clock,
  Loader2,
  RefreshCw,
  ShieldQuestion,
  TriangleAlert,
} from "lucide-react";

import type { CompanySponsorshipStatus } from "@/features/career-hub/lib/types";
import { recheckSponsorshipViaApi } from "@/features/career-hub/lib/sponsorship-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface SponsorshipCardProps {
  companyId: string;
  /** Server-rendered on page load. `null` covers both "check unavailable" and
   *  a genuine backend `status: "error"` — this card renders them the same
   *  way, since neither is a raw error a coach can act on. */
  initialStatus: CompanySponsorshipStatus | null;
}

const DISCLAIMER =
  "A sponsor licence does not guarantee sponsorship for a specific vacancy.";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

/** Coach-facing sponsorship status for one company. Read-only plus a manual
 * recheck — no candidate-review workflow yet (a later milestone). */
export function SponsorshipCard({
  companyId,
  initialStatus,
}: SponsorshipCardProps) {
  const [status, setStatus] = React.useState(initialStatus);
  const [rechecking, setRechecking] = React.useState(false);
  const [recheckError, setRecheckError] = React.useState<string | null>(null);

  async function handleRecheck() {
    setRechecking(true);
    setRecheckError(null);
    try {
      const fresh = await recheckSponsorshipViaApi(companyId);
      setStatus(fresh);
    } catch {
      // Generic by design — the backend detail may name an internal failure
      // mode a coach cannot act on; the recheck action itself is retryable.
      setRecheckError("Recheck failed. Try again in a moment.");
    } finally {
      setRechecking(false);
    }
  }

  const recheckButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={handleRecheck}
      disabled={rechecking}
    >
      {rechecking ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <RefreshCw className="size-4" />
      )}
      Recheck sponsorship
    </Button>
  );

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="label-caps text-muted-foreground">Visa sponsorship</p>
          <Body status={status} />
        </div>
        {recheckButton}
      </div>
      {recheckError && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-destructive">
          <TriangleAlert className="size-4" />
          {recheckError}
        </p>
      )}
    </section>
  );
}

function Body({ status }: { status: CompanySponsorshipStatus | null }) {
  if (status === null || status.status === "error") {
    return (
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg">
          <TriangleAlert className="size-5 text-muted-foreground" />
          Check unavailable
        </h3>
        <p className="text-sm text-muted-foreground">
          We couldn&apos;t load the sponsorship check for this company right
          now.
        </p>
      </div>
    );
  }

  switch (status.status) {
    case "licensed":
      return <Licensed status={status} />;
    case "ambiguous":
      return <Ambiguous status={status} />;
    case "no_match":
      return <NoMatch />;
    case "not_checked":
      return <NotChecked status={status} />;
    default:
      return null;
  }
}

/** Also rendered read-only on the public company page, without confidence. */
export function Licensed({
  status,
  showConfidence = true,
}: {
  status: CompanySponsorshipStatus;
  showConfidence?: boolean;
}) {
  const match = status.match;
  if (!match) return null;
  const confidencePct = Math.round(match.confidence * 100);

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-lg">
        <BadgeCheck className="size-5 text-primary" />
        Licensed Sponsor
      </h3>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Legal entity</dt>
        <dd>{match.organisation_name}</dd>

        {match.routes.length > 0 && (
          <>
            <dt className="text-muted-foreground">Routes</dt>
            <dd>{match.routes.join(", ")}</dd>
          </>
        )}

        {match.type_rating && (
          <>
            <dt className="text-muted-foreground">Licence</dt>
            <dd>{match.type_rating}</dd>
          </>
        )}

        {match.town_city && (
          <>
            <dt className="text-muted-foreground">Register location</dt>
            <dd>{match.town_city}</dd>
          </>
        )}

        {showConfidence && (
          <>
            <dt className="text-muted-foreground">Match confidence</dt>
            <dd>{confidencePct}%</dd>
          </>
        )}

        <dt className="text-muted-foreground">Checked</dt>
        <dd>{formatDate(status.checked_at)}</dd>
      </dl>

      <p className="text-xs text-muted-foreground">
        Source: UK Government Register of Licensed Sponsors
      </p>
      <p className="text-xs text-muted-foreground">{DISCLAIMER}</p>
    </div>
  );
}

function Ambiguous({ status }: { status: CompanySponsorshipStatus }) {
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-lg">
        <ShieldQuestion className="size-5 text-muted-foreground" />
        Possible sponsor match
      </h3>
      <p className="max-w-prose text-sm text-muted-foreground">
        We found possible entries in the UK sponsor register but could not
        confidently identify this company.
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {status.candidate_count !== null && (
          <Badge variant="outline">
            {status.candidate_count}{" "}
            {status.candidate_count === 1 ? "candidate" : "candidates"} found
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          Checked {formatDate(status.checked_at)}
        </span>
      </div>
    </div>
  );
}

function NoMatch() {
  return (
    <div className="space-y-1.5">
      <h3 className="flex items-center gap-2 text-lg">
        <CircleHelp className="size-5 text-muted-foreground" />
        No confirmed sponsor licence found
      </h3>
      <p className="max-w-prose text-sm text-muted-foreground">
        CareerHub could not confidently match this company to a current entry
        in the UK sponsor register.
      </p>
    </div>
  );
}

function NotChecked({ status }: { status: CompanySponsorshipStatus }) {
  return (
    <div className="space-y-1.5">
      <h3 className="flex items-center gap-2 text-lg">
        <Clock className="size-5 text-muted-foreground" />
        Not checked yet
      </h3>
      {status.stale && status.checked_at && (
        <p className="text-xs text-muted-foreground">
          Last checked {formatDate(status.checked_at)}, against a previous
          register update. Recheck for the current one.
        </p>
      )}
    </div>
  );
}
