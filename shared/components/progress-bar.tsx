'use client'

interface ProgressBarProps {
  progress: number
  phase: string
  /** Full Tailwind class for the filled bar, e.g. "bg-blue-900". */
  barClass?: string
  /** Full Tailwind class for the empty track, e.g. "bg-blue-100". */
  trackClass?: string
  /** Full Tailwind class for the label text, e.g. "text-blue-900/70". */
  labelClass?: string
}

export function ProgressBar({
  progress,
  phase,
  barClass = 'bg-blue-900',
  trackClass = 'bg-blue-100',
  labelClass = 'text-blue-900/70',
}: ProgressBarProps) {
  return (
    <div className="mt-3" aria-live="polite">
      <div
        className={`h-2 w-full ${trackClass} rounded-full overflow-hidden`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div
          className={`h-full ${barClass} transition-[width] duration-200 ease-out`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className={`mt-1.5 flex items-center justify-between text-xs ${labelClass}`}>
        <span>{phase}</span>
        <span className="tabular-nums">{Math.round(progress)}%</span>
      </div>
    </div>
  )
}
