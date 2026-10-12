export type {
  OutreachIntent,
  ExperienceLevel,
  OutreachOutputs,
  EnrichmentCard,
  EnrichmentResponse,
  ManualContext,
  InsightSignal,
  JdValidationResult,
} from '@advance-academy/contracts/outreach'

export type ManualContextStatus = 'idle' | 'loading' | 'success' | 'error'

export interface ManualContextLink {
  id: string
  title: string
  url: string
  status: ManualContextStatus
  extractedText: string
  errorMessage?: string
}

export interface OutreachFormData {
  cvText: string
  portfolioUrl: string
  portfolioText: string
  targetCompany: string
  targetCountry: string
  targetPersonName: string
  targetRole: string
  experienceLevel: import('@advance-academy/contracts/outreach').ExperienceLevel
  intent: import('@advance-academy/contracts/outreach').OutreachIntent
  userLocation: string
  jdText: string
  jdUrl: string
  jdValidating: boolean
  jdValidationError: string
  manualContexts: ManualContextLink[]
  selectedInsightCards: import('@advance-academy/contracts/outreach').EnrichmentCard[]
  outputs: import('@advance-academy/contracts/outreach').OutreachOutputs
  enrichmentResults: import('@advance-academy/contracts/outreach').EnrichmentResponse | null
}
