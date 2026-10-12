/**
 * Supabase persistence helpers for the interview-prep flow.
 * All functions are non-throwing: they log + return null/undefined on failure
 * so a DB outage never breaks the user-facing interview.
 */
import { getSupabase } from '../supabase.js';
import { companySlug } from '../company-slug.js';
import type {
  InterviewContext,
  PersonaId,
  IRSScore,
  FeedbackReport,
} from '../../types/interview-prep.js';

function safeSupabase() {
  try {
    return getSupabase();
  } catch {
    return null;
  }
}

const MAX_ADDITIONAL_URLS_PER_COMPANY = 30;
const MAX_URL_LENGTH = 2048;

// Reject anything that isn't a syntactically valid http(s) URL within length
// limits. The DB has matching CHECK constraints + a trigger for the per-company
// cap, but we filter here too so a single bad row doesn't fail the whole batch.
function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitizeAdditionalUrls(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (!isValidHttpUrl(raw)) continue;
    const trimmed = raw.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_ADDITIONAL_URLS_PER_COMPANY) break;
  }
  return out;
}

interface DbSession {
  id: string;
  companyId: string | null;
  jobTargetId: string | null;
}

interface ActiveCv {
  id: string;
  name: string;
  source_file_path: string | null;
}

// Returns the user's currently-active CV from the CV Library, if any.
// We use this for two things on session start:
//   1) populate candidate_profiles.headline (= cv.name) and .cv_file_path
//   2) record interview_sessions.cv_version_id for traceability
async function getActiveCv(userId: string): Promise<ActiveCv | null> {
  const supabase = safeSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('cv_versions')
    .select('id, name, source_file_path')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[db] getActiveCv error:', error);
    return null;
  }
  return data ?? null;
}

async function createCandidateProfile(
  userId: string,
  activeCv: ActiveCv | null,
): Promise<string | null> {
  const supabase = safeSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('candidate_profiles')
    .insert({
      user_id: userId,
      headline: activeCv?.name ?? null,
      cv_file_path: activeCv?.source_file_path ?? null,
    })
    .select('id')
    .single();
  if (error) {
    console.error('[db] Failed to create candidate profile:', error);
    return null;
  }
  return data.id;
}

async function createInterviewPack(
  jobTargetId: string,
  candidateProfileId: string,
  personaId: PersonaId,
): Promise<string | null> {
  const supabase = safeSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('interview_packs')
    .insert({
      job_target_id: jobTargetId,
      candidate_profile_id: candidateProfileId,
      persona_id: personaId,
    })
    .select('id')
    .single();
  if (error) {
    console.error('[db] Failed to create interview pack:', error);
    return null;
  }
  return data.id;
}

async function getOrCreateCompany(
  companyName: string,
  companyUrl?: string,
): Promise<string | null> {
  const supabase = safeSupabase();
  if (!supabase) return null;

  // Match on `slug`, career-hub's unique key for this table (migration
  // 024_ch0001), NOT on the name. This used to be `.ilike('name', ...)`, which
  // was harmless while the table only held the handful of companies this file
  // created — and became a liability the moment the crawler filled it with
  // thousands: `ilike` has no wildcards here so it is merely case-insensitive,
  // but `.limit(1).single()` on a table with several near-identical names
  // ("Foo Ltd", "Foo Limited") returns an arbitrary one. The slug collapses
  // those to the same key by design.
  const slug = companySlug(companyName);

  const { data: existing } = await supabase
    .from('companies')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('companies')
    .insert({
      name: companyName,
      slug,
      website: companyUrl || null,
    })
    .select('id')
    .single();

  if (error) {
    // 23505 = unique violation on companies_slug_key: the crawler, or another
    // student starting prep for the same company, inserted between our select
    // and our insert. The row we wanted now exists, so read it rather than
    // failing the session. Only this table's new unique index makes the race
    // reachable at all.
    if (error.code === '23505') {
      const { data: raced } = await supabase
        .from('companies')
        .select('id')
        .eq('slug', slug)
        .maybeSingle();
      if (raced) return raced.id;
    }
    console.error('[db] Failed to create company:', error);
    return null;
  }
  return created.id;
}

// Best-effort: persist the user-provided "Additional Links" into the
// company_additional_url table. Skips invalid/duplicate entries and
// respects the 30-per-company cap (also enforced by a trigger DB-side).
async function insertCompanyAdditionalUrls(
  companyId: string,
  rawUrls: unknown,
): Promise<void> {
  const supabase = safeSupabase();
  if (!supabase) return;
  const cleaned = sanitizeAdditionalUrls(rawUrls);
  if (cleaned.length === 0) return;

  const { data: existingRows } = await supabase
    .from('company_additional_url')
    .select('url')
    .eq('company_id', companyId);
  const existingSet = new Set((existingRows ?? []).map((r) => r.url as string));
  const slotsLeft = MAX_ADDITIONAL_URLS_PER_COMPANY - existingSet.size;
  if (slotsLeft <= 0) return;

  const baseOrdinal = existingSet.size;
  const toInsert = cleaned
    .filter((u) => !existingSet.has(u))
    .slice(0, slotsLeft)
    .map((url, idx) => ({ company_id: companyId, url, ordinal: baseOrdinal + idx }));
  if (toInsert.length === 0) return;

  const { error } = await supabase
    .from('company_additional_url')
    .insert(toInsert);
  if (error) console.error('[db] Failed to insert company additional URLs:', error);
}

async function createJobTarget(userId: string, 
  companyId: string | null,
  context: InterviewContext,
): Promise<string | null> {
  const supabase = safeSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('job_targets')
    .insert({
      user_id: userId,
      company_id: companyId,
      title: context.jobTitle,
      jd_text: context.jobDescription,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[db] Failed to create job target:', error);
    return null;
  }
  return data.id;
}

export async function dbStartSession(userId: string,
  personaId: PersonaId,
  context: InterviewContext,
): Promise<DbSession | null> {
  const supabase = safeSupabase();
  if (!supabase) return null;
  try {
    // Each helper is best-effort and returns null on failure — a single sub-step
    // failing must not block session creation. The FKs we can't fill stay null.
    const [activeCv, companyId] = await Promise.all([
      getActiveCv(userId),
      getOrCreateCompany(context.companyName, context.companyUrl),
    ]);
    const additionalUrlsPromise = companyId
      ? insertCompanyAdditionalUrls(companyId, context.extraLinks)
      : Promise.resolve();
    const [jobTargetId, candidateProfileId] = await Promise.all([
      createJobTarget(userId, companyId, context),
      createCandidateProfile(userId, activeCv),
      additionalUrlsPromise,
    ]);
    const interviewPackId =
      jobTargetId && candidateProfileId
        ? await createInterviewPack(jobTargetId, candidateProfileId, personaId)
        : null;

    const { data, error } = await supabase
      .from('interview_sessions')
      .insert({
        user_id: userId,
        persona_id: personaId,
        job_target_id: jobTargetId,
        candidate_profile_id: candidateProfileId,
        interview_pack_id: interviewPackId,
        cv_version_id: activeCv?.id ?? null,
        mode: 'live_ai',
        status: 'active',
        context_json: {
          cvText: context.cvText,
          jobTitle: context.jobTitle,
          jobDescription: context.jobDescription,
          companyName: context.companyName,
          companyUrl: context.companyUrl || null,
          extraLinks: context.extraLinks?.length ? context.extraLinks : null,
        },
      })
      .select('id')
      .single();

    if (error) {
      console.error('[db] Failed to create session:', error);
      return null;
    }
    return { id: data.id, companyId, jobTargetId };
  } catch (err) {
    console.error('[db] dbStartSession error:', err);
    return null;
  }
}

export async function dbStoreQuestion(
  sessionId: string,
  questionText: string,
): Promise<{ id: string } | null> {
  const supabase = safeSupabase();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('interview_questions')
      .insert({
        session_id: sessionId,
        question_text: questionText,
        question_type: 'behavioral',
        source: 'generated',
      })
      .select('id')
      .single();
    if (error) {
      console.error('[db] Failed to store question:', error);
      return null;
    }
    return { id: data.id };
  } catch (err) {
    console.error('[db] dbStoreQuestion error:', err);
    return null;
  }
}

/**
 * True only when the session exists and is this user's. Every write keyed by a
 * client-supplied dbSessionId goes through this first: the tables are
 * service-role only, so without it any student who learns a session id could
 * write answers into, or complete, someone else's mock (and 047 rewards both).
 * A failed lookup reads as "not yours" — fail closed.
 */
export async function dbSessionBelongsToUser(sessionId: string, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const supabase = safeSupabase();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase
      .from('interview_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('[db] Failed to check session owner:', error);
      return false;
    }
    return Boolean(data);
  } catch (err) {
    console.error('[db] dbSessionBelongsToUser error:', err);
    return false;
  }
}

export async function dbQuestionBelongsToSession(
  sessionId: string,
  questionId: string,
): Promise<boolean | null> {
  const supabase = safeSupabase();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('interview_questions')
      .select('id')
      .eq('id', questionId)
      .eq('session_id', sessionId)
      .maybeSingle();
    if (error) {
      console.error('[db] Failed to validate question:', error);
      return null;
    }
    return Boolean(data);
  } catch (err) {
    console.error('[db] dbQuestionBelongsToSession error:', err);
    return null;
  }
}

export async function dbStoreAssessment(
  sessionId: string,
  questionId: string,
  candidateAnswer: string,
  irsScore: IRSScore,
): Promise<{ id: string } | null> {
  const supabase = safeSupabase();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('answer_assessments')
      .insert({
        session_id: sessionId,
        question_id: questionId,
        candidate_answer: candidateAnswer,
        integrity_score: irsScore.integrity.score,
        relevance_score: irsScore.relevance.score,
        substance_score: irsScore.substance.score,
        overall_score:
          irsScore.overall ??
          Math.round(
            (irsScore.integrity.score * 0.3 +
              irsScore.relevance.score * 0.3 +
              irsScore.substance.score * 0.4) *
              10,
          ) / 10,
        rationale_json: {
          integrity: irsScore.integrity.rationale,
          relevance: irsScore.relevance.rationale,
          substance: irsScore.substance.rationale,
        },
      })
      .select('id')
      .single();
    if (error) {
      console.error('[db] Failed to store assessment:', error);
      return null;
    }
    return { id: data.id };
  } catch (err) {
    console.error('[db] dbStoreAssessment error:', err);
    return null;
  }
}

export async function dbCompleteSession(
  sessionId: string,
  overallIRS: IRSScore,
  report: FeedbackReport,
): Promise<void> {
  const supabase = safeSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from('interview_sessions')
      .update({
        status: 'complete',
        ended_at: new Date().toISOString(),
        final_score_json: {
          integrity: overallIRS.integrity.score,
          relevance: overallIRS.relevance.score,
          substance: overallIRS.substance.score,
          overall: overallIRS.overall,
        },
        final_report_json: {
          strengths: report.strengths,
          improvements: report.improvements,
          summary: report.summary,
          generatedAt: report.generatedAt,
        },
      })
      .eq('id', sessionId);
    if (error) console.error('[db] Failed to complete session:', error);
  } catch (err) {
    console.error('[db] dbCompleteSession error:', err);
  }
}

export async function dbUpdateSessionStatus(sessionId: string, status: string): Promise<void> {
  const supabase = safeSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from('interview_sessions')
      .update({ status })
      .eq('id', sessionId);
    if (error) console.error('[db] Failed to update session status:', error);
  } catch (err) {
    console.error('[db] dbUpdateSessionStatus error:', err);
  }
}

export async function dbListSessions(
  userId: string,
  cursor?: string,
  pageSize = 20,
): Promise<{ sessions: unknown[]; nextCursor: string | null }> {
  const supabase = safeSupabase();
  if (!supabase) return { sessions: [], nextCursor: null };
  const boundedPageSize = Math.min(50, Math.max(1, pageSize));
  let query = supabase
    .from('interview_sessions')
    .select(
      'id, persona_id, mode, status, started_at, ended_at, final_score_json, job_title:context_json->>jobTitle, company_name:context_json->>companyName',
    )
    .eq('user_id', userId)
    .order('started_at', { ascending: false })
    .limit(boundedPageSize + 1);
  if (cursor) query = query.lt('started_at', cursor);
  const { data, error } = await query;
  if (error) {
    console.error('[db] dbListSessions error:', error);
    return { sessions: [], nextCursor: null };
  }
  const rows = data ?? [];
  const hasNextPage = rows.length > boundedPageSize;
  const page = rows.slice(0, boundedPageSize);
  const sessions = page.map((row) => {
    const summary = row as Record<string, unknown>;
    const { job_title: jobTitle, company_name: companyName, ...session } = summary;
    return {
      ...session,
      context_json: {
        jobTitle: typeof jobTitle === 'string' ? jobTitle : undefined,
        companyName: typeof companyName === 'string' ? companyName : undefined,
      },
    };
  });
  const last = page.at(-1) as Record<string, unknown> | undefined;
  return {
    sessions,
    nextCursor: hasNextPage && typeof last?.started_at === 'string' ? last.started_at : null,
  };
}

interface MissingEvidencePromptRow {
  bulletId: string | null;
  bulletText: string | null;
  question: string;
}

interface SessionExchangeCoach {
  critique: string;
  improved_answer: string;
  missing_evidence_prompts: MissingEvidencePromptRow[];
  created_at: string;
}

interface SessionExchangeRow {
  question_text: string;
  candidate_answer: string;
  integrity_score: number;
  relevance_score: number;
  substance_score: number;
  overall_score: number;
  integrity_rationale: string | null;
  relevance_rationale: string | null;
  substance_rationale: string | null;
  asked_at: string;
  coaches: SessionExchangeCoach[];
}

interface RawCoachRow {
  critique_json: {
    critique?: string;
    missingEvidencePrompts?: MissingEvidencePromptRow[];
  } | null;
  improved_answer: string | null;
  created_at: string;
}

interface RawAssessmentRow {
  candidate_answer: string | null;
  integrity_score: number;
  relevance_score: number;
  substance_score: number;
  overall_score: number;
  rationale_json: { integrity?: string; relevance?: string; substance?: string } | null;
  created_at: string;
  interview_questions: { question_text: string; asked_at: string } | null;
  answer_coaching: RawCoachRow[] | null;
}

export async function dbGetSession(
  id: string,
  userId: string | undefined,
): Promise<(Record<string, unknown> & { exchanges: SessionExchangeRow[] }) | null> {
  const supabase = safeSupabase();
  if (!supabase || !userId) return null;

  // Scoped by owner: another student's session id reads as not found.
  const { data: sessionRow, error: sessionErr } = await supabase
    .from('interview_sessions')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .single();
  if (sessionErr || !sessionRow) {
    console.error('[db] dbGetSession error:', sessionErr);
    return null;
  }

  // Reconstruct the conversation by joining assessments → questions.
  // We anchor on answer_assessments because dbStoreQuestion is called twice per
  // interviewer turn (once when generated, once when the candidate's next turn
  // re-stores it as `lastQuestion`); the assessment is linked to the second row,
  // which gives us a natural dedupe.
  const { data: rawAssessments, error: exErr } = await supabase
    .from('answer_assessments')
    .select(
      'candidate_answer, integrity_score, relevance_score, substance_score, overall_score, rationale_json, created_at, interview_questions ( question_text, asked_at ), answer_coaching ( critique_json, improved_answer, created_at )',
    )
    .eq('session_id', id)
    .order('created_at', { ascending: true });

  if (exErr) {
    console.error('[db] dbGetSession exchanges error:', exErr);
    return { ...sessionRow, exchanges: [] };
  }

  const exchanges: SessionExchangeRow[] = ((rawAssessments ?? []) as unknown as RawAssessmentRow[])
    .filter((row) => row.interview_questions != null)
    .map((row) => ({
      question_text: row.interview_questions!.question_text,
      candidate_answer: row.candidate_answer ?? '',
      integrity_score: Number(row.integrity_score),
      relevance_score: Number(row.relevance_score),
      substance_score: Number(row.substance_score),
      overall_score: Number(row.overall_score),
      integrity_rationale: row.rationale_json?.integrity ?? null,
      relevance_rationale: row.rationale_json?.relevance ?? null,
      substance_rationale: row.rationale_json?.substance ?? null,
      asked_at: row.interview_questions!.asked_at,
      coaches: mapAllCoaches(row.answer_coaching),
    }));

  return { ...sessionRow, exchanges };
}

// Multiple coach generations are allowed per assessment (re-coach after JIT
// clarifications). Return them all, newest first, dropping rows with no
// improved_answer payload.
function mapAllCoaches(rows: RawCoachRow[] | null): SessionExchangeCoach[] {
  if (!rows || rows.length === 0) return [];
  return [...rows]
    .filter((r) => Boolean(r.improved_answer))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((r) => ({
      critique: r.critique_json?.critique ?? '',
      improved_answer: r.improved_answer!,
      missing_evidence_prompts: r.critique_json?.missingEvidencePrompts ?? [],
      created_at: r.created_at,
    }));
}

export async function dbStoreCoaching(
  assessmentId: string,
  originalAnswer: string,
  critique: string,
  improvedAnswer: string,
  missingEvidencePrompts: MissingEvidencePromptRow[],
): Promise<{ id: string } | null> {
  const supabase = safeSupabase();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('answer_coaching')
      .insert({
        assessment_id: assessmentId,
        original_answer: originalAnswer,
        critique_json: {
          critique,
          missingEvidencePrompts,
        },
        improved_answer: improvedAnswer,
      })
      .select('id')
      .single();
    if (error) {
      console.error('[db] Failed to store coaching:', error);
      return null;
    }
    return { id: data.id };
  } catch (err) {
    console.error('[db] dbStoreCoaching error:', err);
    return null;
  }
}
