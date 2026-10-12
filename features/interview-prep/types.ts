// Interview-prep feature types.
// (ViewName / NavItem live in @/shared/types/navigation)

export type InterviewStep = 'setup' | 'persona' | 'interview' | 'report'

export type PersonaId =
  | 'skeptic'
  | 'mentor'
  | 'executive'
  | 'technical'
  | 'culture'

export interface InterviewerPersona {
  id: PersonaId
  name: string
  title: string
  description: string
  style: string
  avatar: string
  systemPrompt: string
}

export interface InterviewContext {
  cvText: string
  jobTitle: string
  jobDescription: string
  companyName: string
  companyUrl: string
  extraLinks: string[]
  /**
   * Optional questions the interviewer draws from first (sprint F6b). Sent with
   * every turn, not just at start — see the backend type for why.
   */
  questionBank?: string[]
  /**
   * Set when the mock was launched from an approved coaching pack (ticket T7).
   * Travels with every turn and reaches the evaluation, which is what ties the
   * result back to the session the coach reads it against.
   */
  coachingSessionId?: string
}

export interface IRSScorePart {
  score: number
  rationale: string
}

export interface IRSScore {
  integrity: IRSScorePart
  relevance: IRSScorePart
  substance: IRSScorePart
  overall: number
}

export interface MissingEvidencePrompt {
  bulletId: string | null
  bulletText: string | null
  question: string
}

export interface CoachResult {
  critique: string
  improvedAnswer: string
  missingEvidencePrompts: MissingEvidencePrompt[]
}

// Coach preview — shown to the user BEFORE the LLM rewriter runs, so they can
// edit which bullets / evidence is sent. Carries RAW artifact text (not the
// summary) for the user; the LLM only ever sees summaries.
export interface CoachPreviewBullet {
  id: string
  bulletText: string
  sectionPath: string | null
  similarity: number
  gaps: Array<{
    id: string
    question: string
    status: 'open' | 'answered' | 'skipped'
    artifacts: Array<{
      id: string
      sourceType: 'text' | 'file' | 'url' | 'jit_clarification'
      contentText: string | null
      sourceUrl: string | null
      createdAt: string
    }>
  }>
}

export interface UserBulletSummaryDto {
  id: string
  bulletText: string
  sectionPath: string | null
  gapCount: number
  answeredGapCount: number
}

export interface CoachPreview {
  selectedBulletIds: string[]
  bullets: CoachPreviewBullet[]
  allBullets: UserBulletSummaryDto[]
  threshold: number
}

export interface InterviewMessage {
  id: string
  role: 'interviewer' | 'candidate'
  content: string
  timestamp: number
  irsScore?: IRSScore
  questionAsked?: string
  coach?: CoachResult
  // The retrieval/preview pane the user sees before generating. Persisted
  // on the message so toggling the panel doesn't refetch.
  coachPreview?: CoachPreview
  // DB id of the persisted answer_assessments row — needed so a follow-up
  // coach-answer call can be linked to it for storage in answer_coaching.
  assessmentId?: string
}

export interface FeedbackItem {
  title: string
  detail: string
}

export interface FeedbackReport {
  sessionId: string
  overallIRS: IRSScore
  strengths: FeedbackItem[]
  improvements: FeedbackItem[]
  summary: string
  generatedAt: number
}

export interface InterviewSession {
  id: string
  personaId: PersonaId
  status: 'active' | 'evaluating' | 'complete'
  startedAt: number
  endedAt?: number
  messages: InterviewMessage[]
  context: InterviewContext
  finalReport?: FeedbackReport
}

// History view DTOs

export interface SessionListItem {
  id: string
  persona_id: string
  mode: string
  status: string
  started_at: string
  ended_at: string | null
  final_score_json: {
    integrity?: number
    relevance?: number
    substance?: number
    overall?: number
  } | null
  context_json: {
    jobTitle?: string
    companyName?: string
  } | null
}

export interface SessionExchangeCoach {
  critique: string
  improved_answer: string
  missing_evidence_prompts: MissingEvidencePrompt[]
  created_at: string
}

export interface SessionExchange {
  question_text: string
  candidate_answer: string
  integrity_score: number
  relevance_score: number
  substance_score: number
  overall_score: number
  integrity_rationale: string | null
  relevance_rationale: string | null
  substance_rationale: string | null
  asked_at: string
  /** All stored coach generations for this answer, newest first. Empty if none. */
  coaches: SessionExchangeCoach[]
}

export interface SessionDetail extends SessionListItem {
  user_id: string | null
  candidate_profile_id: string | null
  job_target_id: string | null
  interview_pack_id: string | null
  final_report_json: {
    summary?: string
    strengths?: FeedbackItem[]
    improvements?: FeedbackItem[]
    generatedAt?: number
  } | null
  created_at: string
  context_json:
    | (SessionListItem['context_json'] & {
        cvText?: string
        jobDescription?: string
        companyUrl?: string | null
        // Older sessions stored a newline-separated string; newer ones store an
        // array. Reading code must handle both.
        extraLinks?: string | string[] | null
      })
    | null
  exchanges: SessionExchange[]
}
