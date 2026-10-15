import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticationError } from '@anthropic-ai/sdk';
import { JD_MIN_CHARS, JdError, resolveJobDescription, type JdDeps } from './jd.js';

const FULL_JD = 'Responsibilities: build SQL reports for the finance team. Requirements: SQL, Python, stakeholder communication. '.repeat(5);
const PAGE = `# Data Analyst\n\n${FULL_JD}`;

function deps(overrides: Partial<JdDeps> = {}) {
  const calls = { read: 0, extract: 0, logs: [] as Array<{ host: string; code: string }> };
  const d: JdDeps = {
    read: async () => {
      calls.read++;
      return { content: PAGE, targetStatus: null };
    },
    extract: async () => {
      calls.extract++;
      return { jobTitle: 'Data Analyst', jobDescription: FULL_JD, companyName: 'Acme' };
    },
    log: (event) => calls.logs.push(event),
    ...overrides,
  };
  return { d, calls };
}

const readFails = (fields: Record<string, unknown>) => async () => {
  throw Object.assign(new Error('Failed to extract URL: boom'), { statusCode: 500, ...fields });
};

async function rejectsWith(promise: Promise<unknown>, code: string, status: number, message?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof JdError, `expected a JdError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.statusCode, status);
    if (message) assert.match(err.message, message);
    return true;
  });
}

// ── Success ─────────────────────────────────────────────────────────────────

test('a full pasted description is used as is, without reading the link', async () => {
  const { d, calls } = deps();
  const out = await resolveJobDescription({ description: FULL_JD, url: 'https://jobs.example.com/1' }, d);
  assert.equal(out.description, FULL_JD.trim());
  assert.equal(out.notice, null);
  assert.equal(calls.read, 0);
});

test('a thin description with a link reads the posting and returns its title and company', async () => {
  const { d, calls } = deps();
  const out = await resolveJobDescription({ description: 'Data Analyst, London', url: 'https://jobs.example.com/1' }, d);
  assert.equal(out.description, FULL_JD.trim());
  assert.deepEqual(out.fetched, { jobTitle: 'Data Analyst', companyName: 'Acme' });
  assert.equal(calls.read, 1);
  assert.equal(calls.extract, 1);
});

test('a LinkedIn page that does read is used (sign-in sites are not refused up front)', async () => {
  const { d } = deps();
  const out = await resolveJobDescription({ description: '', url: 'https://www.linkedin.com/jobs/view/1/' }, d);
  assert.equal(out.description, FULL_JD.trim());
});

// ── Missing or short, no link ───────────────────────────────────────────────

test('nothing given is JD_MISSING', async () => {
  const { d } = deps();
  await rejectsWith(resolveJobDescription({ description: '  ', url: null }, d), 'JD_MISSING', 400, /paste it into the Job description box/);
});

test('a short description with no link is JD_TOO_SHORT, with the count — never written from', async () => {
  const { d } = deps();
  const text = 'Data Analyst at Acme in London. Good with numbers.';
  await rejectsWith(
    resolveJobDescription({ description: text, url: null }, d),
    'JD_TOO_SHORT',
    400,
    new RegExp(`\\(${text.length} characters; at least ${JD_MIN_CHARS} needed\\)`),
  );
});

// ── The link fails ──────────────────────────────────────────────────────────

test('the site answers 404 (via the reader warning) → JD_URL_INACCESSIBLE, job may have closed', async () => {
  const { d, calls } = deps({ read: async () => ({ content: 'Not Found', targetStatus: 404 }) });
  await rejectsWith(resolveJobDescription({ description: '', url: 'https://jobs.example.com/1' }, d), 'JD_URL_INACCESSIBLE', 422, /not found.*closed/);
  assert.equal(calls.extract, 0);
});

test('the site refuses (403) → JD_URL_INACCESSIBLE, may need a sign-in', async () => {
  const { d } = deps({ read: readFails({ reason: 'http', status: 422, targetStatus: 403 }) });
  await rejectsWith(resolveJobDescription({ description: '', url: 'https://jobs.example.com/1' }, d), 'JD_URL_INACCESSIBLE', 422, /refused access.*sign-in/);
});

test('the reader cannot load the page (its own 4xx) → JD_URL_INACCESSIBLE', async () => {
  const { d } = deps({ read: readFails({ reason: 'http', status: 422, targetStatus: null }) });
  await rejectsWith(resolveJobDescription({ description: '', url: 'https://jobs.example.com/1' }, d), 'JD_URL_INACCESSIBLE', 422);
});

test('a timeout → JD_URL_TIMEOUT (504), telling them to paste instead', async () => {
  const { d } = deps({ read: readFails({ reason: 'timeout' }) });
  await rejectsWith(resolveJobDescription({ description: '', url: 'https://jobs.example.com/1' }, d), 'JD_URL_TIMEOUT', 504, /took too long.*Paste/);
});

test('a network failure or a struggling reader (5xx/429) → JD_URL_UNREACHABLE', async () => {
  for (const fields of [{ reason: 'network' }, { reason: 'http', status: 503 }, { reason: 'http', status: 429 }]) {
    const { d } = deps({ read: readFails(fields) });
    await rejectsWith(resolveJobDescription({ description: '', url: 'https://jobs.example.com/1' }, d), 'JD_URL_UNREACHABLE', 502, /opens in your browser/);
  }
});

test('a page with almost no text → JD_URL_UNREADABLE, without paying for extraction', async () => {
  const { d, calls } = deps({ read: async () => ({ content: 'Sign in to continue', targetStatus: null }) });
  await rejectsWith(resolveJobDescription({ description: '', url: 'https://jobs.example.com/1' }, d), 'JD_URL_UNREADABLE', 422, /no job description on the page/);
  assert.equal(calls.extract, 0);
});

test('extraction finds no description on the page → JD_URL_UNREADABLE', async () => {
  const { d } = deps({ extract: async () => ({ jobTitle: '', jobDescription: '', companyName: '' }) });
  await rejectsWith(resolveJobDescription({ description: '', url: 'https://jobs.example.com/1' }, d), 'JD_URL_UNREADABLE', 422);
});

test('the extraction AI step fails → JD_EXTRACTION_FAILED (502)', async () => {
  const { d } = deps({
    extract: async () => {
      throw Object.assign(new Error('Failed to parse LLM response'), { statusCode: 502 });
    },
  });
  await rejectsWith(resolveJobDescription({ description: '', url: 'https://jobs.example.com/1' }, d), 'JD_EXTRACTION_FAILED', 502, /paste it into the Job description box/);
});

test('a rejected AI key is not dressed up as a page problem', async () => {
  const authError = Object.create(AuthenticationError.prototype) as Error;
  const { d } = deps({
    extract: async () => {
      throw authError;
    },
  });
  await assert.rejects(resolveJobDescription({ description: '', url: 'https://jobs.example.com/1' }, d), (err) => err === authError);
});

test('LinkedIn that cannot be read → JD_URL_SIGN_IN, naming LinkedIn', async () => {
  const { d } = deps({ read: async () => ({ content: 'Sign in', targetStatus: null }) });
  await rejectsWith(
    resolveJobDescription({ description: '', url: 'https://uk.linkedin.com/jobs/view/123?trk=abc' }, d),
    'JD_URL_SIGN_IN',
    422,
    /^LinkedIn job pages need a sign-in/,
  );
});

test('an image or spreadsheet link → JD_URL_UNSUPPORTED, without fetching it', async () => {
  for (const [url, kind] of [
    ['https://cdn.example.com/jobs/advert.PNG', /an image file/],
    ['https://example.com/roles.xlsx', /a spreadsheet file/],
  ] as const) {
    const { d, calls } = deps();
    await rejectsWith(resolveJobDescription({ description: '', url }, d), 'JD_URL_UNSUPPORTED', 422, kind);
    assert.equal(calls.read, 0);
  }
});

test('a PDF link is still read (the reader handles PDFs)', async () => {
  const { d, calls } = deps();
  await resolveJobDescription({ description: '', url: 'https://example.com/jd.pdf' }, d);
  assert.equal(calls.read, 1);
});

// ── Falling back to the student's own text ──────────────────────────────────

test('a failed link with a usable pasted description uses it, and says so', async () => {
  const pasted = 'x'.repeat(JD_MIN_CHARS + 50); // usable, but thin enough to try the link
  const { d } = deps({ read: readFails({ reason: 'timeout' }) });
  const out = await resolveJobDescription({ description: pasted, url: 'https://jobs.example.com/1' }, d);
  assert.equal(out.description, pasted);
  assert.equal(out.fetched, null);
  assert.match(out.notice ?? '', /couldn't read the job link.*description you gave/);
});

test('a failed link with too little pasted text is an error, never a letter from the scraps', async () => {
  const { d } = deps({ read: readFails({ reason: 'network' }) });
  await rejectsWith(
    resolveJobDescription({ description: 'Data Analyst, London — great team, apply now!', url: 'https://jobs.example.com/1' }, d),
    'JD_URL_UNREACHABLE',
    502,
  );
});

test('a fetched description shorter than the pasted one keeps the pasted one', async () => {
  const pasted = 'y'.repeat(399);
  const { d } = deps({ extract: async () => ({ jobTitle: 'T', jobDescription: 'z'.repeat(JD_MIN_CHARS), companyName: '' }) });
  const out = await resolveJobDescription({ description: pasted, url: 'https://jobs.example.com/1' }, d);
  assert.equal(out.description, pasted);
  assert.equal(out.fetched, null);
});

// ── Privacy ─────────────────────────────────────────────────────────────────

test('logs carry the site and the outcome only — no path, query or JD text', async () => {
  const { d, calls } = deps({ read: readFails({ reason: 'timeout' }) });
  await resolveJobDescription({ description: 'q'.repeat(300), url: 'https://www.jobs.example.com/apply/987?email=jane%40x.com' }, d);
  assert.deepEqual(calls.logs, [{ host: 'jobs.example.com', code: 'JD_URL_TIMEOUT' }]);
});
