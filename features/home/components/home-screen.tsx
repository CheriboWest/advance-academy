'use client'

import { useRouter } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { OrnamentalDivider } from '@/components/ornamental-divider'
import { ProgressPanel } from '@/features/gamification/components/progress-panel'
import { TOOL_GROUPS } from '@/shared/config/navigation'
import type { NavItem, ViewName } from '@/shared/types/navigation'

interface HomeScreenProps {
  onNavigate: (view: ViewName) => void
}

/**
 * One tool card.
 *
 * A `<button>` rather than the `<div onClick>` this used to be: a div with a
 * click handler is invisible to the keyboard and to screen readers, so six of
 * the app's main entry points simply did not exist without a mouse. The hover
 * moves border, shadow and background together — a shadow alone on a grey card
 * is too quiet to register as a response.
 */
function ToolCard({ item, onNavigate }: { item: NavItem; onNavigate: (view: ViewName) => void }) {
  const router = useRouter()
  const Icon = item.icon
  return (
    <button
      onClick={() => (item.href ? router.push(item.href) : onNavigate(item.view))}
      className="group flex h-full w-full flex-col items-start rounded-xl border bg-background p-6 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-secondary hover:bg-secondary/5 hover:shadow-lg"
    >
      <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-secondary transition-colors duration-150 group-hover:bg-primary/90">
        <Icon className="h-5 w-5 text-primary transition-colors duration-150 group-hover:text-highlight-ink" />
      </span>
      <h3 className="mb-2 font-serif text-xl font-semibold text-primary">{item.label}</h3>
      <p className="mb-4 text-sm leading-relaxed text-muted-foreground">{item.description}</p>
      <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-highlight-ink">
        Open
        <ChevronRight className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5" />
      </span>
    </button>
  )
}

export function HomeScreen({ onNavigate }: HomeScreenProps) {
  return (
    <>
      {/* The dashboard part: what to do this week. The tool grid below is the map. */}
      <div className="mx-auto max-w-7xl px-4 pt-8 sm:px-6 lg:px-8">
        <ProgressPanel />
      </div>

      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-24 lg:px-8">
        <div className="mb-16 text-center">
          <h1 className="mb-6 text-balance font-serif text-5xl font-bold text-primary md:text-6xl">
            Accelerate Your Career
          </h1>
          <p className="mx-auto max-w-2xl text-balance text-xl text-muted-foreground">
            Powered by AI-driven tools designed to help you land your dream job. From discovering
            perfect companies to mastering interviews.
          </p>
        </div>

        <OrnamentalDivider />

        {/*
         * One column per stage of the search, left to right, rendered from the
         * same config as the top-bar menu. The grid used to list four tools
         * while the bar listed eight, so CV Library and Coaching had no entry
         * point here at all.
         */}
        <div className="mb-16 grid gap-x-6 gap-y-10 md:grid-cols-3">
          {TOOL_GROUPS.map((group, index) => (
            <section key={group.label} className="flex flex-col gap-4">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs font-semibold text-highlight-ink">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-primary">
                  {group.label}
                </h2>
              </div>
              {group.items.map((item) => (
                <ToolCard key={item.view} item={item} onNavigate={onNavigate} />
              ))}
            </section>
          ))}
        </div>

        <OrnamentalDivider />

        <div className="rounded-xl bg-gradient-to-r from-primary to-primary/85 p-12 text-center text-primary-foreground">
          <h2 className="mb-4 font-serif text-3xl font-bold">Ready to advance your career?</h2>
          <p className="mb-6 text-lg opacity-90">
            Start with finding your dream company or optimizing your CV.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <button
              onClick={() => onNavigate('companies')}
              className="rounded-lg bg-secondary px-6 py-3 font-semibold text-primary transition-colors duration-150 hover:bg-secondary/90"
            >
              Find Dream Companies
            </button>
            <button
              onClick={() => onNavigate('cv')}
              className="rounded-lg bg-background/20 px-6 py-3 font-semibold transition-colors duration-150 hover:bg-background/35"
            >
              Optimize Your CV
            </button>
          </div>
        </div>
      </div>

      <footer className="mt-16 bg-primary py-8 text-primary-foreground">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <p className="text-sm opacity-75">
            &copy; {new Date().getFullYear()} Advance Academy. Your path to career success.
          </p>
        </div>
      </footer>
    </>
  )
}
