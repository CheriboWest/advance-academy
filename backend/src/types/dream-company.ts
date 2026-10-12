export interface DreamCompanyInput {
  degree: string;
  workExperience: string;
  skills: string;
  interests: string;
  targetSalary: string;
  location: string;
}

export interface ProfileAnalysis {
  marketLevel: 'entry' | 'junior' | 'mid' | 'senior' | 'lead' | 'executive';
  marketLevelRationale: string;
  salaryRange: { min: number; max: number; currency: string; note: string };
  coreStrengths: { strength: string; evidence: string }[];
  criticalGaps: { gap: string; impact: string; urgency: 'high' | 'medium' | 'low' }[];
  uniqueValueProposition: string;
  readinessScore: number;
  readinessNote: string;
}

export interface TargetRole {
  title: string;
  level: string;
  fitScore: number;
  fitReason: string;
  demandLevel: 'high' | 'medium' | 'low';
  avgSalary: string;
}

export interface ExaJobListing {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  /**
   * Structured copies of what `snippet` flattens, so a listing can be saved to
   * the job tracker with real columns. Adzuna and Reed supply them; the Exa
   * fallback usually cannot. All optional so older stored results still parse.
   */
  company?: string;
  location?: string;
  salaryText?: string;
}

export interface RoadmapResponse {
  jobs: ExaJobListing[];
  roadmap: CareerRoadmap;
  /**
   * Set when the live job search failed (outage, bad key, timeout). Distinct from
   * a genuine empty result, where `jobs` is `[]` and `jobsError` is `null` (AAT-10).
   */
  jobsError: string | null;
  /**
   * Benign informational message — NOT an error. Set when the request succeeded but there
   * is nothing to show for a benign reason (e.g. the location is outside our live-vacancy
   * coverage). The FE renders this gently, separate from `jobsError`.
   */
  jobsNotice: string | null;
  /**
   * True when the client sent more selected roles than the backend searches
   * (JOB_MAX_ROLE_QUERIES). Job search covered the first N; the FE should say so rather
   * than let the extra roles silently return nothing. Normally false (the FE caps first).
   */
  jobsTruncated: boolean;
}

export interface FutureYou {
  personTheyWillBecome: string;
  achievementSummary: string;
}

export interface RoadmapPhase {
  phase: number;
  duration: string;
  goal: string;
  actions: string[];
  skills: string[];
  milestone: string;
}

export interface CareerRoadmap {
  futureYou: FutureYou;
  phases: RoadmapPhase[];
}
