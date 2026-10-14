'use client'

import { ArrowRight, Download, Loader } from 'lucide-react'
import type { AnalyzeCvResult, RewriteSuggestion } from '@advance-academy/contracts'

interface RewriteTabProps {
  results: AnalyzeCvResult
  cvFile: File | null
  onDownload: () => void
  downloading: boolean
  downloadError: string | null
  downloadNotice: string | null
}

export function RewriteTab({ results, cvFile, onDownload, downloading, downloadError, downloadNotice }: RewriteTabProps) {
  if (results.rewriteSuggestions.length === 0) {
    return <p className="text-muted-foreground text-sm">No rewrite suggestions returned.</p>
  }

  const isDocx = cvFile ? cvFile.name.toLowerCase().endsWith('.docx') : false

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 px-5 py-4">
        <div>
          <p className="text-sm font-semibold text-primary">Download your improved CV</p>
          <p className="text-xs text-primary mt-0.5">
            {cvFile
              ? isDocx
                ? `We'll apply these rewrites to ${cvFile.name}, preserving its original formatting.`
                : 'PDF in-place editing isn\'t supported. Re-upload your CV as a .docx file to download an improved version.'
              : 'Re-upload your CV as a file to enable download (text-only inputs can\'t be rewritten in place).'}
          </p>
        </div>
        <button
          onClick={onDownload}
          disabled={!cvFile || !isDocx || downloading}
          className="flex-shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2 bg-secondary text-primary rounded-lg font-semibold hover:bg-secondary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {downloading ? <Loader className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {downloading ? 'Generating...' : 'Download Rewritten CV'}
        </button>
      </div>
      {downloadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{downloadError}</div>
      )}
      {downloadNotice && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{downloadNotice}</div>
      )}
      {results.rewriteSuggestions.map((suggestion: RewriteSuggestion, idx: number) => (
        <div key={idx} className="rounded-xl border overflow-hidden">
          <div className="bg-card px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {suggestion.section}
          </div>
          <div className="grid sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-border">
            <div className="p-5 bg-red-50">
              <p className="text-xs font-semibold text-red-600 mb-2 uppercase tracking-wide">Current</p>
              <p className="text-sm text-foreground leading-relaxed">{suggestion.current}</p>
            </div>
            <div className="p-5 bg-green-50 relative">
              <div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 hidden sm:flex w-7 h-7 bg-background border rounded-full items-center justify-center shadow-sm">
                <ArrowRight className="w-3 h-3 text-subtle-foreground" />
              </div>
              <p className="text-xs font-semibold text-green-600 mb-2 uppercase tracking-wide">Suggested</p>
              <p className="text-sm text-foreground leading-relaxed">{suggestion.suggested}</p>
            </div>
          </div>
          <div className="px-4 py-2 bg-card border-t">
            <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Why: </span>{suggestion.reason}</p>
          </div>
        </div>
      ))}
    </div>
  )
}
