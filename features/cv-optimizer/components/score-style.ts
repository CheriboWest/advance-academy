// ─── Score helpers ────────────────────────────────────────────────────────────

export function scoreColor(score: number): string {
  if (score >= 75) return 'text-green-600'
  if (score >= 50) return 'text-amber-500'
  return 'text-red-500'
}

export function scoreBg(score: number): string {
  if (score >= 75) return 'bg-green-50 border-green-200'
  if (score >= 50) return 'bg-amber-50 border-amber-200'
  return 'bg-red-50 border-red-200'
}

export function scoreBar(score: number): string {
  if (score >= 75) return 'bg-green-500'
  if (score >= 50) return 'bg-amber-400'
  return 'bg-red-400'
}

export function scoreLabel(score: number): string {
  if (score >= 75) return 'Strong'
  if (score >= 50) return 'Moderate'
  return 'Weak'
}

export function impactColor(score: number): string {
  if (score >= 7) return 'text-green-600'
  if (score >= 4) return 'text-amber-500'
  return 'text-red-500'
}

export function bulletBorder(score: number): string {
  if (score >= 7) return 'border-green-200 bg-green-50'
  if (score >= 5) return 'border-amber-200 bg-amber-50'
  return 'border-red-200 bg-red-50'
}
