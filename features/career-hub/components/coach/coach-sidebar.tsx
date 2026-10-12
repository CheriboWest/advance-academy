"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Target } from "lucide-react";

import { cn } from "@/shared/utils/cn";
import { coachNavItems } from "@/features/career-hub/components/coach/coach-nav";

/** Desktop-only vertical navigation rail for the coach workspace. */
export function CoachSidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 border-r border-border md:block">
      {/* top-0, not top-16: that offset was reserving room for the main nav bar,
          which these pages never render. */}
      <div className="sticky top-0 py-8 pr-6">
        <Link href="/coach/dashboard" className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-full bg-primary text-highlight">
            <Target className="size-5" />
          </span>
          <span>
            <span className="label-caps block">Workspace</span>
            <span className="block font-display text-xl leading-tight text-primary">
              Coach
            </span>
          </span>
        </Link>

        <nav className="mt-8 flex flex-col gap-1">
          {coachNavItems.map(({ href, label, icon: Icon }) => {
            const active =
              pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2.5 text-sm transition-colors",
                  active
                    ? "border-border bg-secondary font-medium text-primary"
                    : "border-transparent text-muted-foreground hover:bg-accent hover:text-primary"
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
