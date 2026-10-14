export function irsScoreColor(score: number): string {
  if (score >= 8) return 'text-emerald-500'
  if (score >= 6) return 'text-amber-500'
  return 'text-red-500'
}

export function irsScoreLabel(score: number): string {
  if (score >= 9) return 'Exceptional'
  if (score >= 8) return 'Strong'
  if (score >= 7) return 'Good'
  if (score >= 6) return 'Adequate'
  if (score >= 5) return 'Developing'
  if (score >= 3) return 'Weak'
  return 'Poor'
}
