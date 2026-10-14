// Interview Prep types the frontend and backend share. Each side keeps its own
// InterviewMessage / InterviewSession, because the frontend's carry UI state
// (coach preview, coach result) the backend never sees.

export type PersonaId = 'skeptic' | 'mentor' | 'executive' | 'technical' | 'culture'

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
   * Optional questions the interviewer should draw from first (sprint F6b).
   *
   * Lives on the context rather than on the start body so it travels with
   * every turn and is persisted in `context_json` — the per-turn system prompt
   * is rebuilt from this object, so a field that only existed at start time
   * would both be forgotten after turn 1 and change the cached prefix, costing
   * a prompt-cache miss on every subsequent turn.
   */
  questionBank?: string[]
  /**
   * The coaching session this mock was launched from (ticket T7).
   *
   * Deliberately NOT read by `buildContextPreamble` — it is a link, not prompt
   * material, and putting it in the preamble would change the cached prefix for
   * no benefit. It rides on the context purely so it survives every turn and
   * reaches the evaluation, which is where the mock gets tied back to the
   * session the coach will read it against.
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

/** What `POST /api/interview-prep/extract-job-from-url` returns. */
export interface ExtractedJob {
  jobTitle: string
  jobDescription: string
  companyName: string
  companyUrl: string
  extraLinks: string[]
}
