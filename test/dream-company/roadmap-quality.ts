/**
 * User-level roadmap quality check. Runs the REAL Dream Company pipeline:
 *   CV profile → LLM generates roles → pick top-3 by fit (simulates user selection)
 *   → generateRoadmapWithJobs → the final roadmap.jobs (what the user actually sees).
 * Then we can crawl those exact links.  Uses real LLM + Adzuna/Reed keys.
 *   npx tsx test/dream-company/roadmap-quality.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  generateProfileAnalysis,
  generateTargetRoles,
  generateRoadmapWithJobs,
} from '../../backend/src/services/dream-company.service.js';
import type { DreamCompanyInput } from '@advance-academy/contracts/dream-company';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const raw = readFileSync(resolve(REPO_ROOT, 'backend/.env'), 'utf8');
for (const line of raw.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.DREAM_JOB_SOURCE = 'hybrid';
process.env.JOB_LIVENESS_ENABLED = 'true';

const PROFILES: Array<{ name: string; profile: DreamCompanyInput }> = [
  {
    name: 'Marketing pro — London',
    profile: {
      degree: 'BA in Marketing',
      workExperience:
        '5 years in digital marketing and brand management for consumer brands. Led multi-channel campaigns, managed social media, SEO and content strategy, ran paid media budgets.',
      skills: 'Digital marketing, SEO, content strategy, social media, Google Analytics, brand management, paid media',
      interests: 'Brand strategy, growth marketing, creative campaigns',
      targetSalary: '£45,000–£60,000',
      location: 'London, United Kingdom',
    },
  },
  {
    name: 'Data analyst — Manchester',
    profile: {
      degree: 'BSc Computer Science',
      workExperience:
        '3 years as a data analyst. Built Power BI dashboards, wrote SQL and Python for reporting, supported stakeholders with insight and analysis.',
      skills: 'SQL, Python, Power BI, data visualization, statistics, ETL, reporting',
      interests: 'Data analytics, business intelligence',
      targetSalary: '£35,000–£50,000',
      location: 'Manchester, United Kingdom',
    },
  },
];

async function main(): Promise<void> {
  const out: unknown[] = [];
  for (const { name, profile } of PROFILES) {
    console.log(`\n===== ${name} =====`);
    const analysis = await generateProfileAnalysis(profile);
    const roles = await generateTargetRoles(profile, analysis);
    const selected = [...roles].sort((a, b) => b.fitScore - a.fitScore).slice(0, 3);
    console.log('LLM-selected roles:', selected.map((r) => `${r.title} (fit ${r.fitScore})`).join(' | '));
    const { jobs, jobsError } = await generateRoadmapWithJobs(profile, analysis, selected);
    console.log(`roadmap.jobs = ${jobs.length}${jobsError ? ` (error: ${jobsError})` : ''}`);
    jobs.forEach((j, i) => {
      const age = j.publishedDate ? `${((Date.now() - Date.parse(j.publishedDate)) / 86400000).toFixed(1)}d` : 'no-date';
      console.log(`${String(i + 1).padStart(2)}. [${age}] ${j.title}`);
    });
    out.push({
      name,
      location: profile.location,
      selectedRoles: selected.map((r) => ({ title: r.title, fit: r.fitScore })),
      jobs: jobs.map((j) => ({ title: j.title, url: j.url, publishedDate: j.publishedDate })),
      jobsError,
    });
  }
  writeFileSync(resolve(__dirname, 'roadmap-quality.json'), JSON.stringify(out, null, 2));
  console.log('\nwrote roadmap-quality.json');
}
main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
