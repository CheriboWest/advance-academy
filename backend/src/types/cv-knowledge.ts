export type DetectedField = 'tech' | 'business' | 'marketing' | null;

export interface CvVersionRow {
  id: string;
  user_id: string;
  name: string;
  source_file_path: string | null;
  raw_text: string;
  detected_field: DetectedField;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CvVersionSummary {
  id: string;
  name: string;
  detectedField: DetectedField;
  isActive: boolean;
  bulletCount: number;
  openGapCount: number;
  createdAt: string;
  sourceFilePath: string | null;
}

export interface BulletArtifactRow {
  id: string;
  gap_id: string;
  source_type: 'text' | 'file' | 'url' | 'jit_clarification';
  content_text: string | null;
  source_url: string | null;
  source_file_path: string | null;
  summary_json: ArtifactSummary | null;
  created_at: string;
}

export interface ArtifactSummary {
  overview: string;
  my_contribution: string;
  concrete_facts: string[];
  metrics: string[];
}

export interface BulletWithGaps {
  id: string;
  sectionPath: string | null;
  bulletText: string;
  ordinal: number;
  gaps: Array<{
    id: string;
    question: string;
    rationale: string | null;
    ordinal: number;
    status: 'open' | 'answered' | 'skipped';
    artifacts: Array<{
      id: string;
      sourceType: BulletArtifactRow['source_type'];
      contentText: string | null;
      sourceUrl: string | null;
      summary: ArtifactSummary | null;
      createdAt: string;
    }>;
  }>;
}

// ── Two-phase upload types ───────────────────────────────────────────────────

export interface SimilarBulletCandidate {
  bulletId: string;
  bulletText: string;
  sectionPath: string | null;
  similarity: number;
  gapCount: number;
  answeredGapCount: number;
}

export interface ParsedBulletWithCandidates {
  tempId: string;
  bulletText: string;
  sectionPath: string | null;
  candidates: SimilarBulletCandidate[];
}

export interface CvUploadPhase1Response {
  cvVersionId: string;
  detectedField: DetectedField;
  parsedBullets: ParsedBulletWithCandidates[];
}

export interface BulletResolution {
  tempId: string;
  action: 'merge' | 'new';
  existingBulletId?: string;
}

export interface CvFinalizeResponse {
  bulletCount: number;
  newBulletCount: number;
  mergedBulletCount: number;
  gapCount: number;
}

// ── Coach-answer (two-phase: preview → generate) ────────────────────────────

export interface CoachPreviewRequest {
  question: string;
}

// Same as BulletWithGaps but only the fields the preview UI needs, plus
// similarity. Carries RAW artifact content_text so the user can read it
// directly in the modal (raw text is intentionally NOT sent to the LLM).
export interface CoachPreviewBullet {
  id: string;
  bulletText: string;
  sectionPath: string | null;
  similarity: number;
  gaps: Array<{
    id: string;
    question: string;
    status: 'open' | 'answered' | 'skipped';
    artifacts: Array<{
      id: string;
      sourceType: BulletArtifactRow['source_type'];
      contentText: string | null;
      sourceUrl: string | null;
      createdAt: string;
    }>;
  }>;
}

export interface UserBulletSummaryDto {
  id: string;
  bulletText: string;
  sectionPath: string | null;
  gapCount: number;
  answeredGapCount: number;
}

export interface CoachPreviewResponse {
  // bulletIds the embedding step preselected (in similarity order, highest first)
  selectedBulletIds: string[];
  bullets: CoachPreviewBullet[];
  // Lightweight pool of every user bullet — used by the picker to add bullets
  // outside the auto-selected set. Gaps + raw artifacts for picker-added
  // bullets are loaded on demand via GET /api/cv-library/bullets/:id/details.
  allBullets: UserBulletSummaryDto[];
  threshold: number;
}

export interface CoachGenerateRequest {
  question: string;
  answer: string;
  context: {
    jobTitle: string;
    jobDescription: string;
    companyName: string;
  };
  // The user-edited bullet selection (may include picker-added bullets that
  // weren't in the embedding-preselected set).
  selectedBulletIds: string[];
  // Most recent conversation turns from the active session (capped on the
  // server). Sent as-is so the LLM can stay coherent across the interview.
  conversationHistory: Array<{ role: 'interviewer' | 'candidate'; content: string }>;
  // Optional — present once the candidate answer has been IRS-scored.
  // assessmentId is sufficient: the server pulls the rationale from
  // answer_assessments.rationale_json itself.
  irsScore?: {
    integrity: number;
    relevance: number;
    substance: number;
    overall: number;
  };
  // Optional — when present, the generated coaching is persisted to
  // answer_coaching so it can be re-rendered later in Interview History.
  assessmentId?: string;
}

export interface MissingEvidencePrompt {
  bulletId: string | null;
  bulletText: string | null;
  question: string;
}

export interface CoachAnswerResponse {
  critique: string;
  improvedAnswer: string;
  missingEvidencePrompts: MissingEvidencePrompt[];
}
