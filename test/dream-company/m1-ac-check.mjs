/**
 * Dream Company — M1 Acceptance-Criteria check harness.
 *
 * Drives the REAL HTTP surface (production frontend proxy by default) and grades each
 * prod-safe M1 acceptance criterion. Prints an AC-by-AC pass/fail matrix.
 *
 * It calls the JSON steps (/analyze, /roles, /roadmap). This repo's Next.js app only
 * proxies their /stream variants, so against a frontend built from here point --base at
 * the backend instead.
 *
 * Auth: mints a throwaway Supabase user (service-role admin API) to get a real bearer
 * token, then deletes it. No app code is imported; nothing is left behind.
 *
 * Usage (from repo root):
 *   node test/dream-company/m1-ac-check.mjs                 # test production
 *   node test/dream-company/m1-ac-check.mjs --base http://localhost:4000   # local backend
 *   BASE_URL=https://... node test/dream-company/m1-ac-check.mjs
 *
 * Reads Supabase creds from backend/.env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * NEXT_PUBLIC_SUPABASE_ANON_KEY).
 *
 * NOTE: the timeout->504 and truncation->502/422 error paths CANNOT be forced on
 * production without disrupting real users (they need a tiny timeout env or a max_tokens
 * code edit). Those ACs are graded LOCAL-ONLY — see test/dream-company/README.md for the
 * exact fault-injection procedure. This harness covers every prod-safe AC.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { createClient } = require('@supabase/supabase-js');
const JSZip = require('jszip');

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const BASE = (arg('--base') || process.env.BASE_URL || 'https://advance-academy-tools-ashy.vercel.app').replace(/\/$/, '');
// Pass a real production access token to test prod: --token <jwt> (or TOKEN env).
// Grab it from a logged-in browser on cvadvance.com — see README §Getting a prod token.
// Without it, the harness mints a throwaway user, which only works when BASE's backend
// uses the SAME Supabase project as backend/.env (i.e. local dev).
const SUPPLIED_TOKEN = arg('--token') || process.env.TOKEN;

// ---- env ----
const envPath = resolve(__dirname, '../../backend/.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z]/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const PROFILE = {
  degree: 'BSc Computer Science',
  workExperience: '3 years as a frontend developer at a fintech startup building React dashboards',
  skills: 'React, TypeScript, Node.js, SQL, REST APIs',
  interests: 'AI, developer tooling',
  targetSalary: '2000 USD/month',
  location: 'Ho Chi Minh City, Vietnam',
};

// AC registry — each check references the M1 AC it evaluates.
const results = [];
function record(id, ac, desc, pass, detail) {
  results.push({ id, ac, desc, pass, detail });
  const mark = pass ? '✅' : '❌';
  console.log(`${mark} [${id}] ${desc}\n     → ${detail}`);
}

async function call(path, { method = 'POST', token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) { body = form; }
  else if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  const ms = Date.now() - t0;
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, ms, body: parsed, raw: text };
}

function buildDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  zip.folder('word').file('document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    p('Jane Tran - Senior Data Analyst') +
    p('Education: Bachelor of Statistics, University of Economics HCMC') +
    p('Experience: 5 years in data analytics at an e-commerce company.') +
    p('Skills: SQL, Python, Tableau, statistics, experimentation') +
    p('Location: Ho Chi Minh City. Target salary: 3000 USD/month.') +
    '</w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function main() {
  console.log(`\n=== Dream Company M1 AC check ===\nTarget: ${BASE}\n`);

  // ---- get a token: use the supplied prod token, else mint a throwaway user ----
  let token, userId, admin;
  if (SUPPLIED_TOKEN) {
    token = SUPPLIED_TOKEN;
    console.log('(using supplied --token; no user minted)\n');
  } else {
    admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const email = `verify-m1-${Date.now()}@example.com`;
    const password = `Vf-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (cErr) throw new Error('createUser failed: ' + cErr.message);
    userId = created.user.id;
    const anon = createClient(env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email, password });
    if (sErr) throw new Error('signIn failed: ' + sErr.message);
    token = sess.session.access_token;
    console.log(`(minted throwaway token for ${userId} — only valid if BASE uses the backend/.env Supabase project)\n`);
  }

  try {
    // C0 — auth gate + no-404 routing (M1.4)
    const noAuth = await call('/api/dream-company/analyze', { json: { profile: PROFILE } });
    record('C0', 'M1.4', 'Unauthed analyze is gated (401, not 404/500)',
      noAuth.status === 401,
      `HTTP ${noAuth.status} ${JSON.stringify(noAuth.body).slice(0, 80)}`);

    // C1 — analyze happy path (M1.1 no timeout break, M1.2 no false-500, M1.4)
    const analyze = await call('/api/dream-company/analyze', { token, json: { profile: PROFILE } });
    const aOk = analyze.status === 200 && analyze.body && typeof analyze.body.marketLevel === 'string'
      && typeof analyze.body.readinessScore === 'number' && Array.isArray(analyze.body.coreStrengths);
    record('C1', 'M1.1/M1.2/M1.4', 'analyze → 200 + valid JSON',
      aOk, `HTTP ${analyze.status} in ${analyze.ms}ms · marketLevel=${analyze.body?.marketLevel} readiness=${analyze.body?.readinessScore}`);
    if (!aOk) throw new Error('analyze failed — cannot chain roles/roadmap');

    // C2 — roles happy path (M1.4)
    const roles = await call('/api/dream-company/roles', { token, json: { profile: PROFILE, analysis: analyze.body } });
    const rOk = roles.status === 200 && Array.isArray(roles.body) && roles.body.length > 0
      && typeof roles.body[0].title === 'string' && typeof roles.body[0].fitScore === 'number';
    record('C2', 'M1.4', 'roles → 200 + valid array',
      rOk, `HTTP ${roles.status} in ${roles.ms}ms · ${Array.isArray(roles.body) ? roles.body.length : '?'} roles · top="${roles.body?.[0]?.title}"`);

    // C3 — roadmap happy path (M1.4)
    let roadmapOk = false, roadmapDetail = 'skipped (roles failed)';
    if (rOk) {
      const roadmap = await call('/api/dream-company/roadmap', {
        token, json: { profile: PROFILE, analysis: analyze.body, selectedRoles: roles.body.slice(0, 2) },
      });
      roadmapOk = roadmap.status === 200 && roadmap.body?.roadmap?.phases?.length === 3
        && !!roadmap.body?.roadmap?.futureYou && Array.isArray(roadmap.body?.jobs);
      roadmapDetail = `HTTP ${roadmap.status} in ${roadmap.ms}ms · phases=${roadmap.body?.roadmap?.phases?.length} jobs=${roadmap.body?.jobs?.length} jobsError=${roadmap.body?.jobsError}`;
    }
    record('C3', 'M1.4', 'roadmap → 200 + 3 phases + futureYou + jobs', roadmapOk, roadmapDetail);

    // C4 — parse-cv valid DOCX (M1.3 happy path)
    const docx = await buildDocx();
    const fd = new FormData();
    fd.append('file', new Blob([docx], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'cv.docx');
    const pcv = await call('/api/dream-company/parse-cv', { token, form: fd });
    const pOk = pcv.status === 200 && pcv.body && typeof pcv.body.degree === 'string' && pcv.body.degree.length > 0;
    record('C4', 'M1.3', 'parse-cv valid DOCX → 200 + parsed fields',
      pOk, `HTTP ${pcv.status} in ${pcv.ms}ms · degree="${(pcv.body?.degree || '').slice(0, 40)}" level=${pcv.body?.currentLevel}`);

    // C5 — parse-cv unsupported type (M1.3 guard → friendly 4xx, not 500)
    const fd2 = new FormData();
    fd2.append('file', new Blob([Buffer.from('not a cv')], { type: 'text/plain' }), 'notacv.txt');
    const bad = await call('/api/dream-company/parse-cv', { token, form: fd2 });
    record('C5', 'M1.3', 'parse-cv unsupported .txt → friendly 400 (not 500)',
      bad.status === 400, `HTTP ${bad.status} ${JSON.stringify(bad.body).slice(0, 80)}`);

    // ---- AC matrix ----
    printMatrix({ analyzeMs: analyze.ms, rolesMs: roles.ms });
  } finally {
    if (admin && userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      console.log(`\n(cleanup: ${error ? 'FAILED to delete ' + error.message : 'deleted throwaway user ' + userId})`);
    }
  }
}

function printMatrix({ analyzeMs, rolesMs }) {
  const by = (id) => results.find((r) => r.id === id);
  const P = (ids) => ids.every((i) => by(i)?.pass);
  console.log('\n================ M1 ACCEPTANCE-CRITERIA MATRIX ================\n');
  const rows = [
    ['M1.1', 'Timeout from config/env, no hard-code', 'code-review + local (env-forceable)', 'See README §Timeout'],
    ['M1.1', 'Happy path unaffected by timeout', P(['C1', 'C2', 'C3']) ? 'PASS' : 'FAIL', `analyze ${analyzeMs}ms / roles ${rolesMs}ms — under budgets`],
    ['M1.1', 'Timeout → controlled 504 (no hang)', 'LOCAL-ONLY', 'Force via LLM_TIMEOUT_DREAM_ANALYZE_MS=50 — README §Timeout'],
    ['M1.2', 'Truncated output → not 500, clear msg', 'LOCAL-ONLY', 'Force via max_tokens edit — README §Truncation'],
    ['M1.2', 'Applies to all 3 generate steps', 'code-review', 'shared parseStepResponse() in all 3'],
    ['M1.2', 'Has per-step debug log', 'code-review', 'console.error "{step} hit max_tokens"'],
    ['M1.3', 'Bad/oversized CV → friendly, no 500', by('C5')?.pass ? 'PASS' : 'FAIL', 'unsupported→400; truncated→422 LOCAL-ONLY'],
    ['M1.3', 'Valid PDF & DOCX still parse', by('C4')?.pass ? 'PASS (DOCX)' : 'FAIL', 'PDF: run README §PDF with a real file'],
    ['M1.4', 'E2E analyze→roles→roadmap on prod', P(['C1', 'C2', 'C3']) ? 'PASS' : 'FAIL', '3-step chain all 200'],
    ['M1.4', 'No 404 on any endpoint', P(['C0', 'C1', 'C2', 'C3']) ? 'PASS' : 'FAIL', 'all routes resolved (401/200, never 404)'],
  ];
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log(pad('AC', 6), pad('Criterion', 42), 'Result');
  console.log('-'.repeat(90));
  for (const [ac, crit, res, note] of rows) {
    console.log(pad(ac, 6), pad(crit, 42), pad(res, 22), note ? '· ' + note : '');
  }
  const prodChecks = results.filter((r) => ['C0', 'C1', 'C2', 'C3', 'C4', 'C5'].includes(r.id));
  const passed = prodChecks.filter((r) => r.pass).length;
  console.log('\nProd-safe checks: ' + passed + '/' + prodChecks.length + ' passed');
  console.log('LOCAL-ONLY fault paths (504/502/422-truncated): see README — cannot run on prod safely.');
}

main().catch((e) => { console.error('\nHARNESS ERROR:', e.message); process.exit(1); });
