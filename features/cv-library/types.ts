export interface CvVersionSummary {
  id: string
  name: string
  detectedField: 'tech' | 'business' | 'marketing' | null
  isActive: boolean
  bulletCount: number
  openGapCount: number
  createdAt: string
  sourceFilePath: string | null
}

export interface BulletWithGaps {
  id: string
  sectionPath: string | null
  bulletText: string
  ordinal: number
  gaps: Array<{
    id: string
    question: string
    rationale: string | null
    ordinal: number
    status: 'open' | 'answered' | 'skipped'
    artifacts: Array<{
      id: string
      sourceType: 'text' | 'file' | 'url' | 'jit_clarification'
      contentText: string | null
      sourceUrl: string | null
      summary: unknown
      createdAt: string
    }>
  }>
}

export interface SimilarCandidate {
  bulletId: string
  bulletText: string
  sectionPath: string | null
  similarity: number
  gapCount: number
  answeredGapCount: number
}

export interface ParsedBullet {
  tempId: string
  bulletText: string
  sectionPath: string | null
  candidates: SimilarCandidate[]
}

export interface Phase1Response {
  cvVersionId: string
  detectedField: string | null
  parsedBullets: ParsedBullet[]
}
