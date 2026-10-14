'use client'

import { useRef, useState } from 'react'
import { FileText, Loader, Upload, X } from 'lucide-react'

// ─── Sub-components ───────────────────────────────────────────────────────────

interface FileUploadZoneProps {
  label: string
  fileName: string | null
  parsing: boolean
  onFile: (file: File) => void
  onClear: () => void
}

export function FileUploadZone({ label, fileName, parsing, onFile, onClear }: FileUploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }

  return (
    <div>
      <p className="text-sm font-medium text-foreground mb-1">{label}</p>
      {fileName ? (
        <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
          <FileText className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="text-sm text-primary truncate flex-1">{fileName}</span>
          {parsing ? (
            <Loader className="w-4 h-4 text-primary animate-spin flex-shrink-0" />
          ) : (
            <button onClick={onClear} className="text-primary/60 hover:text-primary">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      ) : (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors ${
            isDragOver ? 'border-secondary bg-secondary/10' : 'border-border hover:border-secondary'
          }`}
        >
          <Upload className="w-6 h-6 text-subtle-foreground mx-auto mb-1" />
          <p className="text-sm text-muted-foreground">Drop a file or <span className="text-highlight-ink font-medium">browse</span></p>
          <p className="text-xs text-subtle-foreground mt-0.5">PDF or DOCX</p>
        </div>
      )}
      <input ref={inputRef} type="file" accept=".pdf,.docx" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
    </div>
  )
}
