'use client'

import { useState } from 'react'
import { useToolResult, useToolResults } from '../hooks/use-tool-results'
import { TOOL_LABELS, type ToolName } from '@advance-academy/contracts/tool-results'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Download, FileJson } from 'lucide-react'

const TOOL_FILTERS = ['', 'dream', 'interview', 'cv', 'cover_letter'] as const

const selectClass =
  'h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring'

function toolLabel(tool: ToolName): string {
  return TOOL_LABELS[tool] ?? tool
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Detail pane for one stored run. Fetched lazily — the list carries no payload. */
function ResultDetail({ id }: { id: string }) {
  const { data, isLoading, error } = useToolResult(id)

  if (isLoading) return <Skeleton className="h-64 w-full" />
  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        Could not load this result: {(error as Error).message}
      </div>
    )
  }
  if (!data) return null

  const { result, tool, input_summary, created_at } = data.result
  const filename = `${tool}-${new Date(created_at).toISOString().slice(0, 10)}.json`

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{input_summary ?? toolLabel(tool)}</p>
          <p className="text-xs text-muted-foreground">
            {toolLabel(tool)} · {new Date(created_at).toLocaleString()}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => downloadJson(filename, result)}>
          <Download className="mr-1.5 h-4 w-4" />
          Download JSON
        </Button>
      </div>
      <pre className="max-h-[28rem] overflow-auto rounded-md border bg-muted/40 p-4 text-xs leading-relaxed">
        {JSON.stringify(result, null, 2)}
      </pre>
    </div>
  )
}

/**
 * Every credit-charging run this user has made, newest first. Opening one costs
 * nothing — the stored output is replayed from Postgres, never regenerated.
 */
export function ToolRunsPanel() {
  const [tool, setTool] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const { data, isLoading, isFetching, error, refetch } = useToolResults({
    tool: tool || undefined,
  })
  const rows = data?.results ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Tool
          <select className={selectClass} value={tool} onChange={(e) => setTool(e.target.value)}>
            {TOOL_FILTERS.map((t) => (
              <option key={t} value={t}>
                {t === '' ? 'All tools' : toolLabel(t as ToolName)}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
          Could not load your history: {(error as Error).message}
        </div>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          <FileJson className="mx-auto mb-3 h-8 w-8 opacity-40" />
          Nothing here yet. Runs of Dream Company and the Interview Lab show up
          automatically, and reopening one never costs a credit.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const open = openId === r.id
            return (
              <li key={r.id} className="rounded-md border">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : r.id)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                >
                  <Badge variant="secondary">{toolLabel(r.tool)}</Badge>
                  <span className="flex-1 truncate text-sm font-medium">
                    {r.input_summary ?? '—'}
                  </span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleDateString()}
                  </span>
                </button>
                {open ? (
                  <div className="border-t p-4">
                    <ResultDetail id={r.id} />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
