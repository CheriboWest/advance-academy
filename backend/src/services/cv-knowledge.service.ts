/**
 * CV Knowledge Base service.
 * Pure functions; no HTTP. Orchestrates Anthropic + Supabase + Voyage.
 *
 * Key design: cv_bullets belong to a USER (bullet pool), not a CV version.
 * The junction table cv_version_bullets links versions to their bullets.
 * This allows the same bullet (with its gaps + artifacts) to be shared
 * across multiple CV versions.
 */
import { extractTextFromFile } from './outreach-extractor.service.js';
import { assertLlmConfigured, createAnthropicClient, getFeatureModel } from '../lib/llm-anthropic.js';
import { getSupabase, isMissingColumnError } from '../lib/supabase.js';
import { embedText, embedTexts, isVoyageConfigured } from '../lib/voyage.js';
import {
  buildBulletExtractionPrompt,
  buildGapPrompt,
  buildArtifactSummaryPrompt,
} from '../lib/cv-knowledge/prompts.js';
import type {
  ArtifactSummary,
  BulletArtifactRow,
  BulletWithGaps,
  CvVersionRow,
  CvVersionSummary,
  DetectedField,
  SimilarBulletCandidate,
  ParsedBulletWithCandidates,
  CvUploadPhase1Response,
  BulletResolution,
  CvFinalizeResponse,
} from '../types/cv-knowledge.js';

const MAX_GAPS = 5;

function cleanJson(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '').trim();
}

async function llmJson<T = unknown>(systemOrUser: string, userMaybe?: string): Promise<T> {
  assertLlmConfigured('interviewPrep');
  const anthropic = createAnthropicClient('interviewPrep');
  const model = getFeatureModel('interviewPrep');
  const isPair = userMaybe !== undefined;
  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: isPair ? systemOrUser : 'You return only valid JSON.',
    messages: [{ role: 'user', content: isPair ? userMaybe! : systemOrUser }],
  });
  const block = response.content[0];
  if (!block || block.type !== 'text') {
    throw Object.assign(new Error('LLM returned no text'), { statusCode: 502 });
  }
  try {
    return JSON.parse(cleanJson(block.text)) as T;
  } catch {
    throw Object.assign(new Error('Failed to parse LLM JSON'), { statusCode: 502 });
  }
}

// ── Phase 1: Parse CV → return bullets + similarity candidates ──────────────

export async function parseCvVersion(args: {
  name: string;
  rawText: string;
  userId: string;
  sourceFilePath?: string | null;
}): Promise<CvUploadPhase1Response> {
  const supabase = getSupabase();

  // Insert the cv_version row
  const { data: inserted, error } = await supabase
    .from('cv_versions')
    .insert({
      user_id: args.userId,
      name: args.name,
      raw_text: args.rawText,
      source_file_path: args.sourceFilePath ?? null,
      is_active: false,
    })
    .select('id')
    .single();
  if (error || !inserted) {
    throw Object.assign(new Error(`Failed to create cv_version: ${error?.message}`), { statusCode: 500 });
  }
  const cvVersionId = inserted.id as string;

  // Extract bullets + detect field via LLM
  const parsed = await llmJson<{
    detected_field: DetectedField;
    bullets: Array<{ section_path: string | null; bullet_text: string }>;
  }>(buildBulletExtractionPrompt(args.rawText));

  const bullets = (parsed.bullets ?? []).filter((b) => b.bullet_text?.trim());
  const detectedField = parsed.detected_field ?? null;

  if (detectedField) {
    await supabase.from('cv_versions').update({ detected_field: detectedField }).eq('id', cvVersionId);
  }

  // For each parsed bullet, find similar existing bullets in the user's pool
  const parsedBullets: ParsedBulletWithCandidates[] = [];
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    const tempId = `temp_${i}`;
    let candidates: SimilarBulletCandidate[] = [];
    try {
      candidates = await findSimilarBullets(args.userId, b.bullet_text.trim(), 5);
    } catch (err) {
      console.error('[cv-knowledge] similarity search failed for bullet', i, err);
    }
    parsedBullets.push({
      tempId,
      bulletText: b.bullet_text.trim(),
      sectionPath: b.section_path ?? null,
      candidates,
    });
  }

  return { cvVersionId, detectedField, parsedBullets };
}

export async function parseCvVersionFromFile(
  name: string,
  fileBuffer: Buffer,
  fileName: string,
  userId: string,
): Promise<CvUploadPhase1Response> {
  const rawText = await extractTextFromFile(fileBuffer, fileName.toLowerCase());
  return parseCvVersion({ name, rawText, userId, sourceFilePath: fileName });
}

// ── Phase 2: Finalize — user has resolved each bullet (merge or new) ────────

export async function finalizeCvBullets(userId: string, 
  cvVersionId: string,
  parsedBullets: ParsedBulletWithCandidates[],
  resolutions: BulletResolution[],
): Promise<CvFinalizeResponse> {
  const supabase = getSupabase();

  // Look up detected field for gap generation prompts
  const { data: cvRow } = await supabase
    .from('cv_versions')
    .select('detected_field')
    .eq('id', cvVersionId)
    .single();
  const detectedField = (cvRow?.detected_field as DetectedField) ?? null;

  const resMap = new Map(resolutions.map((r) => [r.tempId, r]));
  let newBulletCount = 0;
  let mergedBulletCount = 0;
  let totalGaps = 0;

  // Batch embed all "new" bullets at once to minimize Voyage calls
  const newBullets = parsedBullets.filter((b) => {
    const res = resMap.get(b.tempId);
    return !res || res.action === 'new';
  });
  let embeddings: number[][] = [];
  if (newBullets.length > 0 && isVoyageConfigured()) {
    try {
      embeddings = await embedTexts(
        newBullets.map((b) => b.bulletText),
        'document',
      );
    } catch (err) {
      console.error('[cv-knowledge] batch embed failed', err);
    }
  }
  let embedIdx = 0;

  for (let i = 0; i < parsedBullets.length; i++) {
    const pb = parsedBullets[i];
    const res = resMap.get(pb.tempId);
    const action = res?.action ?? 'new';

    if (action === 'merge' && res?.existingBulletId) {
      // Link existing bullet to this CV version
      await supabase.from('cv_version_bullets').upsert(
        {
          cv_version_id: cvVersionId,
          bullet_id: res.existingBulletId,
          ordinal: i,
          section_path: pb.sectionPath,
        },
        { onConflict: 'cv_version_id,bullet_id' },
      );
      mergedBulletCount++;
    } else {
      // Create a new bullet in the user's pool
      const embedding = embeddings[embedIdx] ?? null;
      embedIdx++;

      const { data: newBullet, error: bulletErr } = await supabase
        .from('cv_bullets')
        .insert({
          user_id: userId,
          cv_version_id: cvVersionId,
          section_path: pb.sectionPath,
          bullet_text: pb.bulletText,
          ordinal: i,
          bullet_embedding: embedding ? `[${embedding.join(',')}]` : null,
        })
        .select('id')
        .single();
      if (bulletErr || !newBullet) {
        console.error('[cv-knowledge] failed to insert bullet', bulletErr);
        continue;
      }
      newBulletCount++;

      // Junction row
      await supabase.from('cv_version_bullets').insert({
        cv_version_id: cvVersionId,
        bullet_id: newBullet.id,
        ordinal: i,
        section_path: pb.sectionPath,
      });

      // Generate gaps for new bullet
      try {
        const gapResp = await llmJson<{
          gaps: Array<{ question: string; rationale?: string }>;
        }>(buildGapPrompt(pb.bulletText, pb.sectionPath, detectedField));
        const gapItems = (gapResp.gaps ?? []).slice(0, MAX_GAPS);
        if (gapItems.length > 0) {
          const { error: gapErr } = await supabase.from('bullet_gaps').insert(
            gapItems.map((g, gi) => ({
              bullet_id: newBullet.id,
              question: g.question,
              rationale: g.rationale ?? null,
              ordinal: gi + 1,
              status: 'open',
            })),
          );
          if (!gapErr) totalGaps += gapItems.length;
        }
      } catch (err) {
        console.error('[cv-knowledge] gap gen failed for bullet', newBullet.id, err);
      }
    }
  }

  return {
    bulletCount: parsedBullets.length,
    newBulletCount,
    mergedBulletCount,
    gapCount: totalGaps,
  };
}

// ── Similarity search ───────────────────────────────────────────────────────

// Bullet-merge similarity threshold. 0.40 drops bullets that aren't plausibly
// describing the same achievement, so the merge UI never invites the user to
// merge unrelated work. Used by both:
//   - the CV-Library "Merge" button on a saved bullet
//   - the CV-upload phase-1 merge-candidate detection
// Coach-answer retrieval uses its own threshold (0.50) via
// findRelevantBulletsForCoach below.
export const MERGE_SIMILARITY_THRESHOLD = 0.4;

export async function findSimilarBullets(
  userId: string,
  bulletText: string,
  limit: number = 5,
): Promise<SimilarBulletCandidate[]> {
  return findSimilarBulletsByEmbedding(userId, bulletText, MERGE_SIMILARITY_THRESHOLD, limit);
}

async function findSimilarBulletsByEmbedding(
  userId: string,
  text: string,
  threshold: number,
  limit: number,
): Promise<SimilarBulletCandidate[]> {
  const embedding = await embedText(text, 'query');
  if (!embedding) return [];

  const supabase = getSupabase();
  const embeddingStr = `[${embedding.join(',')}]`;

  const { data, error } = await supabase.rpc('match_bullets', {
    query_embedding: embeddingStr,
    match_user_id: userId,
    match_threshold: threshold,
    match_count: limit,
  });

  if (error) {
    console.error('[cv-knowledge] match_bullets RPC failed, falling back to direct query', error);
    return findSimilarBulletsDirect(userId, limit);
  }

  return (data ?? []).map((row: any) => ({
    bulletId: row.id,
    bulletText: row.bullet_text,
    sectionPath: row.section_path ?? null,
    similarity: row.similarity ?? 0,
    gapCount: row.gap_count ?? 0,
    answeredGapCount: row.answered_gap_count ?? 0,
  }));
}

// Coach-answer retrieval: top-K bullets above a similarity threshold.
// Threshold filters out obviously-unrelated bullets so the LLM evidence pool
// stays grounded; cap at `limit` (typically 5) to keep prompt size predictable.
export async function findRelevantBulletsForCoach(
  userId: string,
  question: string,
  threshold: number,
  limit: number,
): Promise<SimilarBulletCandidate[]> {
  return findSimilarBulletsByEmbedding(userId, question, threshold, limit);
}

async function findSimilarBulletsDirect(
  userId: string,
  limit: number,
): Promise<SimilarBulletCandidate[]> {
  const supabase = getSupabase();

  // Direct query: filter by user, order by cosine similarity
  const { data: bullets } = await supabase
    .from('cv_bullets')
    .select('id, bullet_text, section_path')
    .eq('user_id', userId)
    .not('bullet_embedding', 'is', null)
    .limit(200);

  if (!bullets || bullets.length === 0) return [];

  // Without RPC we can't do ORDER BY <=> in the supabase-js client.
  // Return all user bullets and let the caller pick. For MVP scale (<500) this is fine.
  // Enrich with gap counts.
  const result: SimilarBulletCandidate[] = [];
  for (const b of bullets.slice(0, limit * 2)) {
    const { count: gapCount } = await supabase
      .from('bullet_gaps')
      .select('id', { count: 'exact', head: true })
      .eq('bullet_id', b.id);
    const { count: answeredCount } = await supabase
      .from('bullet_gaps')
      .select('id', { count: 'exact', head: true })
      .eq('bullet_id', b.id)
      .eq('status', 'answered');
    result.push({
      bulletId: b.id,
      bulletText: b.bullet_text,
      sectionPath: b.section_path ?? null,
      similarity: 0, // can't compute without RPC
      gapCount: gapCount ?? 0,
      answeredGapCount: answeredCount ?? 0,
    });
  }
  return result.slice(0, limit);
}

// ── Merge bullets ───────────────────────────────────────────────────────────

export async function mergeBullets(sourceBulletId: string, targetBulletId: string, userId: string): Promise<void> {
  const supabase = getSupabase();

  // Verify both belong to the same user
  const { data: src } = await supabase
    .from('cv_bullets')
    .select('id, user_id')
    .eq('id', sourceBulletId)
    .eq('user_id', userId)
    .single();
  const { data: tgt } = await supabase
    .from('cv_bullets')
    .select('id, user_id')
    .eq('id', targetBulletId)
    .eq('user_id', userId)
    .single();
  if (!src || !tgt) {
    throw Object.assign(new Error('Bullet not found or not owned by user'), { statusCode: 404 });
  }

  // Find the max ordinal on the target bullet's gaps so we can avoid conflicts
  const { data: maxRow } = await supabase
    .from('bullet_gaps')
    .select('ordinal')
    .eq('bullet_id', targetBulletId)
    .order('ordinal', { ascending: false })
    .limit(1)
    .maybeSingle();
  let nextOrdinal = (maxRow?.ordinal ?? 0) + 1;

  // Get source gaps and re-parent them
  const { data: sourceGaps } = await supabase
    .from('bullet_gaps')
    .select('id')
    .eq('bullet_id', sourceBulletId)
    .order('ordinal', { ascending: true });

  for (const gap of sourceGaps ?? []) {
    await supabase
      .from('bullet_gaps')
      .update({ bullet_id: targetBulletId, ordinal: nextOrdinal })
      .eq('id', gap.id);
    nextOrdinal++;
  }

  // Re-parent junction rows
  const { data: junctions } = await supabase
    .from('cv_version_bullets')
    .select('id, cv_version_id')
    .eq('bullet_id', sourceBulletId);

  for (const j of junctions ?? []) {
    // Check if target already linked to this version
    const { data: existing } = await supabase
      .from('cv_version_bullets')
      .select('id')
      .eq('cv_version_id', j.cv_version_id)
      .eq('bullet_id', targetBulletId)
      .maybeSingle();
    if (existing) {
      // Already linked — just delete the source junction
      await supabase.from('cv_version_bullets').delete().eq('id', j.id);
    } else {
      await supabase
        .from('cv_version_bullets')
        .update({ bullet_id: targetBulletId })
        .eq('id', j.id);
    }
  }

  // Delete the source bullet (now orphaned — no gaps, no junctions)
  await supabase.from('cv_bullets').delete().eq('id', sourceBulletId);
}

// ── Backfill embeddings ─────────────────────────────────────────────────────

export async function backfillEmbeddings(): Promise<{ updated: number }> {
  if (!isVoyageConfigured()) return { updated: 0 };
  const supabase = getSupabase();
  const { data: bullets } = await supabase
    .from('cv_bullets')
    .select('id, bullet_text')
    .is('bullet_embedding', null)
    .limit(128);
  if (!bullets || bullets.length === 0) return { updated: 0 };

  const texts = bullets.map((b) => b.bullet_text);
  const embeddings = await embedTexts(texts, 'document');

  let updated = 0;
  for (let i = 0; i < bullets.length; i++) {
    if (!embeddings[i]) continue;
    const { error } = await supabase
      .from('cv_bullets')
      .update({ bullet_embedding: `[${embeddings[i].join(',')}]` })
      .eq('id', bullets[i].id);
    if (!error) updated++;
  }
  return { updated };
}

// ── List + activate + delete ────────────────────────────────────────────────

/**
 * The Library's own CVs — deliberately not every row in `cv_versions`.
 *
 * Since migration 018 other tools park the CV they were handed in the same table
 * so the Coaching context picker can find it. Those rows are raw text with no
 * bullets and no gaps; listing them here would show a student "CVs" they never
 * knowingly uploaded, each reporting 0 bullets. `origin='library'` is the line
 * between "I added this" and "the app kept a copy". Rows predating 018 default
 * to 'library', so nothing existing disappears.
 */
export async function listCvVersions(userId: string): Promise<CvVersionSummary[]> {
  const supabase = getSupabase();
  const read = (libraryOnly: boolean) => {
    const q = supabase
      .from('cv_versions')
      .select('id, name, detected_field, is_active, created_at, source_file_path')
      .eq('user_id', userId);
    return (libraryOnly ? q.eq('origin', 'library') : q).order('created_at', { ascending: false });
  };

  let { data, error } = await read(true);
  // Before migration 018 lands there is no `origin` column, and filtering on it
  // would 500 the entire CV Library screen. Unfiltered is exactly the old
  // behaviour, and pre-018 there are no auto-captured rows to hide anyway.
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await read(false));
  }
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });

  const versions = data ?? [];
  if (versions.length === 0) return [];

  const versionIds = versions.map((v) => v.id);

  const { data: junctions, error: jErr } = await supabase
    .from('cv_version_bullets')
    .select('cv_version_id, bullet_id')
    .in('cv_version_id', versionIds);
  if (jErr) throw Object.assign(new Error(jErr.message), { statusCode: 500 });

  const bulletsByVersion = new Map<string, string[]>();
  for (const j of junctions ?? []) {
    const list = bulletsByVersion.get(j.cv_version_id) ?? [];
    list.push(j.bullet_id);
    bulletsByVersion.set(j.cv_version_id, list);
  }

  const allBulletIds = (junctions ?? []).map((j) => j.bullet_id);
  const openGapsByBullet = new Map<string, number>();
  if (allBulletIds.length > 0) {
    const { data: openGaps, error: gErr } = await supabase
      .from('bullet_gaps')
      .select('bullet_id')
      .in('bullet_id', allBulletIds)
      .eq('status', 'open');
    if (gErr) throw Object.assign(new Error(gErr.message), { statusCode: 500 });
    for (const g of openGaps ?? []) {
      openGapsByBullet.set(g.bullet_id, (openGapsByBullet.get(g.bullet_id) ?? 0) + 1);
    }
  }

  return versions.map((row) => {
    const bulletIds = bulletsByVersion.get(row.id) ?? [];
    const openGapCount = bulletIds.reduce((sum, id) => sum + (openGapsByBullet.get(id) ?? 0), 0);
    return {
      id: row.id,
      name: row.name,
      detectedField: row.detected_field ?? null,
      isActive: row.is_active,
      bulletCount: bulletIds.length,
      openGapCount,
      createdAt: row.created_at,
      sourceFilePath: row.source_file_path ?? null,
    };
  });
}

export async function activateCvVersion(cvVersionId: string, userId: string): Promise<void> {
  const supabase = getSupabase();
  const { error: clearErr } = await supabase
    .from('cv_versions')
    .update({ is_active: false })
    .eq('user_id', userId)
    .eq('is_active', true);
  if (clearErr) throw Object.assign(new Error(clearErr.message), { statusCode: 500 });
  const { error } = await supabase
    .from('cv_versions')
    .update({ is_active: true })
    .eq('id', cvVersionId)
    .eq('user_id', userId);
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
}

export async function deleteCvVersion(cvVersionId: string, userId: string): Promise<void> {
  const supabase = getSupabase();
  // Deleting the version cascades to cv_version_bullets junction rows only.
  // The actual bullets (and their gaps/artifacts) survive if linked to other versions.
  const { error } = await supabase
    .from('cv_versions')
    .delete()
    .eq('id', cvVersionId)
    .eq('user_id', userId);
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
}

export async function getCvVersion(id: string, userId: string): Promise<CvVersionRow | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('cv_versions')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as CvVersionRow | null) ?? null;
}

// ── Bullets + gaps + artifacts (read for UI) — now via junction ──────────────

export async function listBulletsWithGaps(cvVersionId: string): Promise<BulletWithGaps[]> {
  const supabase = getSupabase();

  const { data: junctions, error } = await supabase
    .from('cv_version_bullets')
    .select('bullet_id, ordinal, section_path')
    .eq('cv_version_id', cvVersionId)
    .order('ordinal', { ascending: true });
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
  if (!junctions || junctions.length === 0) return [];

  const bulletIds = junctions.map((j) => j.bullet_id);

  const [bulletsRes, gapsRes] = await Promise.all([
    supabase.from('cv_bullets').select('id, bullet_text').in('id', bulletIds),
    supabase
      .from('bullet_gaps')
      .select('id, bullet_id, question, rationale, ordinal, status')
      .in('bullet_id', bulletIds)
      .order('ordinal', { ascending: true }),
  ]);
  if (bulletsRes.error) throw Object.assign(new Error(bulletsRes.error.message), { statusCode: 500 });
  if (gapsRes.error) throw Object.assign(new Error(gapsRes.error.message), { statusCode: 500 });

  const bulletById = new Map((bulletsRes.data ?? []).map((b) => [b.id, b]));
  const gaps = gapsRes.data ?? [];
  const gapIds = gaps.map((g) => g.id);

  const artifactsByGapId = new Map<string, BulletArtifactRow[]>();
  if (gapIds.length > 0) {
    const { data: artifacts, error: artErr } = await supabase
      .from('bullet_artifacts')
      .select('id, gap_id, source_type, content_text, source_url, summary_json, created_at')
      .in('gap_id', gapIds)
      .order('created_at', { ascending: true });
    if (artErr) throw Object.assign(new Error(artErr.message), { statusCode: 500 });
    for (const a of (artifacts ?? []) as BulletArtifactRow[]) {
      const list = artifactsByGapId.get(a.gap_id) ?? [];
      list.push(a);
      artifactsByGapId.set(a.gap_id, list);
    }
  }

  const gapsByBulletId = new Map<string, typeof gaps>();
  for (const g of gaps) {
    const list = gapsByBulletId.get(g.bullet_id) ?? [];
    list.push(g);
    gapsByBulletId.set(g.bullet_id, list);
  }

  const result: BulletWithGaps[] = [];
  for (const j of junctions) {
    const bullet = bulletById.get(j.bullet_id);
    if (!bullet) continue;
    const bulletGaps = gapsByBulletId.get(bullet.id) ?? [];
    result.push({
      id: bullet.id,
      sectionPath: j.section_path,
      bulletText: bullet.bullet_text,
      ordinal: j.ordinal,
      gaps: bulletGaps.map((g) => ({
        id: g.id,
        question: g.question,
        rationale: g.rationale,
        ordinal: g.ordinal,
        status: g.status,
        artifacts: (artifactsByGapId.get(g.id) ?? []).map((a) => ({
          id: a.id,
          sourceType: a.source_type,
          contentText: a.content_text,
          sourceUrl: a.source_url,
          summary: a.summary_json,
          createdAt: a.created_at,
        })),
      })),
    });
  }
  return result;
}

// Same shape as listBulletsWithGaps but takes a set of bullet ids directly,
// scoped by user. Used by coach-answer preview to fetch the auto-selected
// bullets' gaps + RAW artifacts in one go.
export async function getBulletsWithGapsByIds(
  userId: string,
  bulletIds: string[],
): Promise<BulletWithGaps[]> {
  if (bulletIds.length === 0) return [];
  const supabase = getSupabase();

  const { data: bullets, error: bErr } = await supabase
    .from('cv_bullets')
    .select('id, bullet_text, section_path, ordinal')
    .in('id', bulletIds)
    .eq('user_id', userId);
  if (bErr) throw Object.assign(new Error(bErr.message), { statusCode: 500 });
  if (!bullets || bullets.length === 0) return [];

  const validIds = bullets.map((b) => b.id);

  const { data: gaps, error: gErr } = await supabase
    .from('bullet_gaps')
    .select('id, bullet_id, question, rationale, ordinal, status')
    .in('bullet_id', validIds)
    .order('ordinal', { ascending: true });
  if (gErr) throw Object.assign(new Error(gErr.message), { statusCode: 500 });

  const gapList = gaps ?? [];
  const gapIds = gapList.map((g) => g.id);

  const artifactsByGapId = new Map<string, BulletArtifactRow[]>();
  if (gapIds.length > 0) {
    const { data: artifacts, error: artErr } = await supabase
      .from('bullet_artifacts')
      .select('id, gap_id, source_type, content_text, source_url, summary_json, created_at')
      .in('gap_id', gapIds)
      .order('created_at', { ascending: true });
    if (artErr) throw Object.assign(new Error(artErr.message), { statusCode: 500 });
    for (const a of (artifacts ?? []) as BulletArtifactRow[]) {
      const list = artifactsByGapId.get(a.gap_id) ?? [];
      list.push(a);
      artifactsByGapId.set(a.gap_id, list);
    }
  }

  const gapsByBulletId = new Map<string, typeof gapList>();
  for (const g of gapList) {
    const list = gapsByBulletId.get(g.bullet_id) ?? [];
    list.push(g);
    gapsByBulletId.set(g.bullet_id, list);
  }

  // Preserve the order callers passed (so coach-answer can keep similarity ordering).
  const order = new Map(bulletIds.map((id, i) => [id, i]));
  const sorted = [...bullets].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return sorted.map((b) => ({
    id: b.id,
    sectionPath: b.section_path,
    bulletText: b.bullet_text,
    ordinal: b.ordinal ?? 0,
    gaps: (gapsByBulletId.get(b.id) ?? []).map((g) => ({
      id: g.id,
      question: g.question,
      rationale: g.rationale,
      ordinal: g.ordinal,
      status: g.status,
      artifacts: (artifactsByGapId.get(g.id) ?? []).map((a) => ({
        id: a.id,
        sourceType: a.source_type,
        contentText: a.content_text,
        sourceUrl: a.source_url,
        summary: a.summary_json,
        createdAt: a.created_at,
      })),
    })),
  }));
}

// Lightweight list of every bullet in the user's pool — for the coach-answer
// "add bullet" picker. Carries gap counts so the UI can show "X/Y gaps filled"
// without a follow-up query.
export interface UserBulletSummary {
  id: string;
  bulletText: string;
  sectionPath: string | null;
  gapCount: number;
  answeredGapCount: number;
}

export async function listUserBulletSummaries(userId: string): Promise<UserBulletSummary[]> {
  const supabase = getSupabase();

  const { data: bullets, error } = await supabase
    .from('cv_bullets')
    .select('id, bullet_text, section_path')
    .eq('user_id', userId)
    .order('ordinal', { ascending: true });
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
  if (!bullets || bullets.length === 0) return [];

  const ids = bullets.map((b) => b.id);
  const { data: gapRows, error: gErr } = await supabase
    .from('bullet_gaps')
    .select('bullet_id, status')
    .in('bullet_id', ids);
  if (gErr) throw Object.assign(new Error(gErr.message), { statusCode: 500 });

  const totals = new Map<string, { total: number; answered: number }>();
  for (const g of gapRows ?? []) {
    const t = totals.get(g.bullet_id) ?? { total: 0, answered: 0 };
    t.total++;
    if (g.status === 'answered') t.answered++;
    totals.set(g.bullet_id, t);
  }

  return bullets.map((b) => {
    const t = totals.get(b.id) ?? { total: 0, answered: 0 };
    return {
      id: b.id,
      bulletText: b.bullet_text,
      sectionPath: b.section_path,
      gapCount: t.total,
      answeredGapCount: t.answered,
    };
  });
}

// ── Add an artifact to a gap (text only) ────────────────────────────────────

// Re-summarise an artifact's raw text. Short blurbs skip the LLM and use a
// trivial stub so we don't burn tokens on near-empty answers.
async function summarizeArtifactText(rawText: string, gapQuestion: string): Promise<ArtifactSummary | null> {
  if (rawText.length <= 80) {
    return { overview: rawText, my_contribution: '', concrete_facts: [rawText], metrics: [] };
  }
  try {
    return await llmJson<ArtifactSummary>(buildArtifactSummaryPrompt(rawText, gapQuestion));
  } catch (err) {
    console.error('[cv-knowledge] summary failed', err);
    return null;
  }
}

export async function addArtifactToGap(
  gapId: string,
  payload:
    | { sourceType: 'text'; text: string }
    | { sourceType: 'jit_clarification'; text: string },
): Promise<void> {
  const supabase = getSupabase();
  const { data: gap, error: gapErr } = await supabase
    .from('bullet_gaps')
    .select('id, question')
    .eq('id', gapId)
    .single();
  if (gapErr || !gap) {
    throw Object.assign(new Error('Gap not found'), { statusCode: 404 });
  }

  const rawText = payload.text.trim();
  if (!rawText) throw Object.assign(new Error('Empty artifact text'), { statusCode: 400 });

  const summary = await summarizeArtifactText(rawText, gap.question);

  const { error: insertErr } = await supabase.from('bullet_artifacts').insert({
    gap_id: gapId,
    source_type: payload.sourceType,
    content_text: rawText.slice(0, 20000),
    source_url: null,
    source_file_path: null,
    summary_json: summary,
  });
  if (insertErr) throw Object.assign(new Error(insertErr.message), { statusCode: 500 });

  await supabase
    .from('bullet_gaps')
    .update({ status: 'answered', updated_at: new Date().toISOString() })
    .eq('id', gapId);
}

// ── Edit an existing artifact's text (re-summarises) ────────────────────────

export async function updateArtifactText(artifactId: string, newText: string): Promise<void> {
  const supabase = getSupabase();
  const trimmed = newText.trim();
  if (!trimmed) throw Object.assign(new Error('Empty artifact text'), { statusCode: 400 });

  const { data: artifact, error: artErr } = await supabase
    .from('bullet_artifacts')
    .select('id, gap_id')
    .eq('id', artifactId)
    .single();
  if (artErr || !artifact) {
    throw Object.assign(new Error('Artifact not found'), { statusCode: 404 });
  }

  const { data: gap, error: gapErr } = await supabase
    .from('bullet_gaps')
    .select('id, question')
    .eq('id', artifact.gap_id)
    .single();
  if (gapErr || !gap) {
    throw Object.assign(new Error('Gap not found'), { statusCode: 404 });
  }

  const summary = await summarizeArtifactText(trimmed, gap.question);

  const { error: updateErr } = await supabase
    .from('bullet_artifacts')
    .update({
      content_text: trimmed.slice(0, 20000),
      summary_json: summary,
    })
    .eq('id', artifactId);
  if (updateErr) throw Object.assign(new Error(updateErr.message), { statusCode: 500 });
}

export async function skipGap(gapId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('bullet_gaps')
    .update({ status: 'skipped', updated_at: new Date().toISOString() })
    .eq('id', gapId);
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
}

// ── JIT clarification writeback ─────────────────────────────────────────────

export async function recordJitClarification(args: {
  bulletId: string | null;
  question: string;
  answer: string;
}): Promise<void> {
  const supabase = getSupabase();
  if (!args.bulletId || args.bulletId === 'none') return;

  const { data: existing } = await supabase
    .from('bullet_gaps')
    .select('id, ordinal')
    .eq('bullet_id', args.bulletId)
    .eq('question', args.question)
    .maybeSingle();

  let gapId: string;
  if (existing) {
    gapId = existing.id as string;
  } else {
    const { data: maxRow } = await supabase
      .from('bullet_gaps')
      .select('ordinal')
      .eq('bullet_id', args.bulletId)
      .order('ordinal', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextOrdinal = (maxRow?.ordinal ?? 0) + 1;
    const { data: created, error } = await supabase
      .from('bullet_gaps')
      .insert({
        bullet_id: args.bulletId,
        question: args.question,
        ordinal: nextOrdinal,
        status: 'open',
      })
      .select('id')
      .single();
    if (error || !created) {
      throw Object.assign(new Error(error?.message ?? 'Failed to create gap'), { statusCode: 500 });
    }
    gapId = created.id as string;
  }

  await addArtifactToGap(gapId, { sourceType: 'jit_clarification', text: args.answer });
}

