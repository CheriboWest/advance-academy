"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/features/career-hub/components/empty-state";

/**
 * Any coach page that throws renders this inside the workspace layout, so the
 * sidebar and header stay and the coach can move to another page or retry.
 * Without it a single failing read (the dashboard, when migration 048 made
 * public_company_summary unreadable) showed Next's bare server-error screen in
 * place of the whole workspace.
 */
export default function CoachWorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="This page couldn't load"
      description="Something went wrong loading this page. The rest of the coach workspace still works: pick another page from the menu, or try again."
      action={
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
