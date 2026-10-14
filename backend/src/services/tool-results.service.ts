import { getSupabase, isMissingColumnError } from '../lib/supabase.js';

/**
 * Tool run history (sprint F5, migration 017).
 *
 * Every successful run of a credit-charging tool drops one row here, so the user
 * can reopen the output later without spending credits or triggering an LLM
 * call. Reads are always scoped by `user_id` — the table is service-role only,
 * and the service layer never trusts an id on its own.
 *
 * CV Optimizer is intentionally absent: its results already live in
 * `cv_analysis_jobs` (migration 005).
 *
 * Since migration 018 a row also keeps the run's INPUT (`input_json`) and, when
 * the run saw a CV, a pointer into `cv_versions`. The Coaching tool reads these
 * rows as context about a student, and an output with no record of what produced
 * it is close to useless there: a Dream Company roadmap says what was suggested,
 * but only the stored `ProfileAnalysis` says where the student actually stands.
 */

import type { ToolName, ToolResultDetail, ToolResultSummary } from '@advance-academy/contracts/tool-results';
export type { ToolName, ToolResultDetail, ToolResultSummary };

/**
 * Rows above this serialise to more than we want to keep per run. A Dream
 * Company roadmap with a long job list is the realistic worst case; anything
 * beyond this is a bug or an abusive payload, and silently storing megabytes per
 * run would make the history table the biggest thing in the database.
 */
const MAX_RESULT_BYTES = 512 * 1024;

/**
 * The input blob is capped well below the result blob. Inputs are small by
 * nature (a profile, a JD reference, a session context); anything approaching
 * this size means a caller is passing raw CV or transcript text, which belongs
 * in `cv_versions` / `transcript_turns`, not duplicated here.
 */
const MAX_INPUT_BYTES = 64 * 1024;

export interface RecordToolResultOptions {
  /**
   * What produced this output. For Dream Company that is `{ profile, analysis,
   * selectedRoles }` — note `analysis` is a step-1 output but a step-3 input,
   * and storing it here is what stops it being lost.
   */
  input?: unknown;
  /** `cv_versions` row this run was based on, when there was one. */
  cvVersionId?: string | null;
}

/**
 * Record one successful run. Best-effort by design: history is a convenience,
 * so a write failure is logged and swallowed rather than turning a successful
 * (already paid for) tool run into an error the user sees.
 */
export async function recordToolResult(
  userId: string | undefined,
  tool: ToolName,
  inputSummary: string | null,
  result: unknown,
  opts: RecordToolResultOptions = {},
): Promise<void> {
  if (!userId || result === undefined || result === null) return;

  try {
    const size = Buffer.byteLength(JSON.stringify(result) ?? '', 'utf8');
    if (size > MAX_RESULT_BYTES) {
      console.warn(`[tool-results] skipped ${tool} for ${userId}: ${size} bytes over the cap`);
      return;
    }

    // An oversized input drops the input, not the row — the output is the part
    // the user paid for and it still replays fine on its own.
    let input: unknown = opts.input ?? null;
    if (input !== null && input !== undefined) {
      const inputSize = Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8');
      if (inputSize > MAX_INPUT_BYTES) {
        console.warn(`[tool-results] dropped ${tool} input for ${userId}: ${inputSize} bytes over the cap`);
        input = null;
      }
    }

    const supabase = getSupabase();
    const base = {
      user_id: userId,
      tool,
      input_summary: inputSummary?.slice(0, 200) ?? null,
      result,
    };

    let { error } = await supabase.from('tool_results').insert({
      ...base,
      input_json: input ?? null,
      cv_version_id: opts.cvVersionId ?? null,
    });

    // Code can reach production before its hand-applied migration does. Without
    // this retry a lagging 018 would stop history being recorded at all — and
    // because every failure here is swallowed by design, nobody would notice
    // until a student asked where their runs went.
    if (error && isMissingColumnError(error)) {
      console.error('[tool-results] input_json/cv_version_id are missing — run migration 018.');
      ({ error } = await supabase.from('tool_results').insert(base));
    }

    if (error) console.error(`[tool-results] insert failed for ${userId} (${tool}):`, error);
  } catch (err) {
    console.error(`[tool-results] could not record ${tool} for ${userId}:`, err);
  }
}

export async function listToolResults(
  userId: string,
  opts: { tool?: string; limit?: number } = {},
): Promise<ToolResultSummary[]> {
  const supabase = getSupabase();
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);

  let query = supabase
    .from('tool_results')
    .select('id, tool, input_summary, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (opts.tool) query = query.eq('tool', opts.tool);

  const { data, error } = await query;
  if (error) {
    throw Object.assign(new Error('Could not load your history'), { statusCode: 500, cause: error });
  }
  return (data ?? []) as ToolResultSummary[];
}

/**
 * One stored run, including its payload. Scoped by `user_id` as well as `id`, so
 * a guessed id from another account simply returns nothing.
 */
export async function getToolResult(userId: string, id: string): Promise<ToolResultDetail | null> {
  const supabase = getSupabase();
  const read = (columns: string) =>
    supabase.from('tool_results').select(columns).eq('user_id', userId).eq('id', id).maybeSingle();

  let { data, error } = await read('id, tool, input_summary, created_at, result, input_json, cv_version_id');
  // Reading is a stricter test than writing: a missing column fails the select
  // outright, which would take the whole History detail view down until
  // migration 018 is applied. Fall back to the pre-018 column list.
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await read('id, tool, input_summary, created_at, result'));
  }
  if (error) {
    throw Object.assign(new Error('Could not load that result'), { statusCode: 500, cause: error });
  }
  return (data as ToolResultDetail | null) ?? null;
}
