'use client'

import { ArrowRight, ArrowLeft, Mic, Loader2 } from 'lucide-react'
import type { PersonaId } from '@/features/interview-prep/types'
import { PERSONAS } from '@/features/interview-prep/data/personas'
import type { InterviewMode } from '@/features/interview-prep/hooks/use-interview'

export function PersonaStep({
  selectedPersona,
  onSelect,
  mode,
  onSelectMode,
  onBack,
  onStart,
  loading,
}: {
  selectedPersona: PersonaId | null
  onSelect: (id: PersonaId) => void
  mode: InterviewMode
  onSelectMode: (mode: InterviewMode) => void
  onBack: () => void
  onStart: () => void
  loading: boolean
}) {
  return (
    <div>
      <p className="text-muted-foreground mb-6 text-center">
        Choose your interviewer persona. Each has a unique style and evaluation approach.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {PERSONAS.map((persona) => (
          <button
            key={persona.id}
            onClick={() => onSelect(persona.id)}
            className={`p-5 rounded-xl border-2 text-left transition-all ${
              selectedPersona === persona.id
                ? 'border-primary bg-primary/5 shadow-md'
                : 'hover:border-border hover:shadow-sm'
            }`}
          >
            <div className="flex items-center gap-3 mb-3">
              <span className="text-3xl">{persona.avatar}</span>
              <div>
                <h3 className="font-semibold text-primary">{persona.name}</h3>
                <p className="text-xs text-muted-foreground">{persona.title}</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mb-3">{persona.description}</p>
            <div className="flex flex-wrap gap-1.5">
              {persona.style.split(' · ').map((tag) => (
                <span key={tag} className="px-2 py-0.5 bg-card text-muted-foreground text-xs rounded-full">
                  {tag}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>

      <div className="bg-primary/5 rounded-xl p-4 mb-8 flex items-center gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onSelectMode('text')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              mode === 'text'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-foreground hover:bg-muted'
            }`}
          >
            Text Mode
          </button>
          <button
            type="button"
            onClick={() => onSelectMode('voice')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
              mode === 'voice'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-foreground hover:bg-muted'
            }`}
          >
            <Mic className="w-3.5 h-3.5" /> Voice Mode
          </button>
        </div>
        <p className="text-xs text-muted-foreground ml-auto">
          {mode === 'voice'
            ? 'Speak your answers — we transcribe them for you.'
            : 'Type your answers in the chat box.'}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <button
          onClick={onStart}
          disabled={!selectedPersona || loading}
          className="flex items-center gap-2 px-6 py-3 bg-secondary text-primary rounded-xl font-semibold hover:bg-secondary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Starting Interview...
            </>
          ) : (
            <>
              Start Interview <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    </div>
  )
}
