import { createHash } from 'node:crypto';
import { getSupabase } from './supabase.js';

/**
 * Links a CV that some tool was handed to the one place CVs are meant to live —
 * `cv_versions` (migration 018, sprint Coaching Tool T0).
 *
 * CV Optimizer and Dream Company both accept a CV, use it, and drop it. That
 * leaves the Coaching tool with an analysis it cannot trace back to a CV, and
 * leaves the student with a CV the rest of the app can't see. This helper is the
 * cheap fix: store the text once, hand back an id, reuse the row next time the
 * same text shows up.
 *
 * Deliberately NOT the CV Library upload (`parseCvVersion` + `finalizeCvBullets`): that
 * runs an LLM bullet extraction plus embeddings per bullet. Paying for that on
 * every CV Optimizer run would be absurd. Rows minted here carry raw text only —
 * bullets get extracted later, on demand, by whoever actually needs them.
 *
 * Every failure path returns null. A history/context nicety must never be the
 * reason a tool run the user already paid for reports an error.
 */

/** Rows above this are not a CV. Guards against a pathological paste. */
const MAX_CV_CHARS = 200_000;

/**
 * Which surface put this CV in the pool. Only `library` rows are real Library
 * uploads with bullets and gaps; the rest are raw text captured in passing, and
 * the Library screen filters them out so a student is never shown a CV they
 * don't remember adding.
 */
export type CvVersionOrigin =
  | 'library'
  | 'cv_optimizer'
  | 'dream_company'
  | 'interview_lab'
  | 'coaching';

/**
 * Stable identity for "the same CV". Whitespace and case are normalised away so
 * a re-paste with different line wrapping reuses the existing row rather than
 * minting a twin.
 */
export function hashCvText(rawText: string): string {
  const normalised = rawText.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalised).digest('hex');
}

export interface EnsureCvVersionArgs {
  userId: string | undefined;
  rawText: string;
  /** Shown in pickers, e.g. "CV Optimiser · Data Analyst". */
  name: string;
  origin: CvVersionOrigin;
  /** Original filename when the CV arrived as an upload. Metadata, not a path. */
  sourceFilePath?: string | null;
}

/**
 * Returns the id of the `cv_versions` row holding this text, creating it if this
 * is the first time we've seen it. Null when the CV can't be stored — callers
 * treat that as "no link", never as an error.
 */
export async function ensureCvVersion(args: EnsureCvVersionArgs): Promise<string | null> {
  const { userId, rawText, name, origin, sourceFilePath } = args;
  const text = rawText?.trim();
  if (!userId || !text || text.length > MAX_CV_CHARS) return null;

  const textHash = hashCvText(text);

  try {
    const supabase = getSupabase();

    const { data: existing } = await supabase
      .from('cv_versions')
      .select('id')
      .eq('user_id', userId)
      .eq('text_hash', textHash)
      .maybeSingle();
    if (existing?.id) return existing.id as string;

    // Rows written before migration 018 — and every Library upload, which
    // deliberately leaves `text_hash` null so a real upload can never collide
    // with an auto-captured copy — have no hash to match on. Fall back to exact
    // text, and backfill the hash so the cheap path works from now on. Without
    // this, a student who uploads to the Library and then runs CV Optimizer
    // ends up with the same CV stored twice and listed twice in the picker.
    const { data: byText } = await supabase
      .from('cv_versions')
      .select('id')
      .eq('user_id', userId)
      .eq('raw_text', text)
      .is('text_hash', null)
      .limit(1)
      .maybeSingle();
    if (byText?.id) {
      await supabase.from('cv_versions').update({ text_hash: textHash }).eq('id', byText.id);
      return byText.id as string;
    }

    const { data: inserted, error } = await supabase
      .from('cv_versions')
      .insert({
        user_id: userId,
        name: name.slice(0, 200),
        raw_text: text,
        text_hash: textHash,
        origin,
        source_file_path: sourceFilePath ?? null,
        // Never auto-activate. "Active" is the CV the student chose to work on
        // in the Library; a tool run is not that choice to make on their behalf.
        is_active: false,
      })
      .select('id')
      .single();

    if (error) {
      // Two concurrent runs of the same CV race the unique index. The loser
      // re-reads instead of failing — the row it wanted now exists.
      if (error.code === '23505') {
        const { data: raced } = await supabase
          .from('cv_versions')
          .select('id')
          .eq('user_id', userId)
          .eq('text_hash', textHash)
          .maybeSingle();
        return (raced?.id as string) ?? null;
      }
      console.error(`[cv-version-link] insert failed for ${userId} (${origin}):`, error.message);
      return null;
    }

    return (inserted?.id as string) ?? null;
  } catch (err) {
    console.error(`[cv-version-link] could not link CV for ${userId} (${origin}):`, err);
    return null;
  }
}
