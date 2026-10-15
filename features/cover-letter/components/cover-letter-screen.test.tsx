// The Cover Letter screen when the job description can't be used: the backend's
// message is shown, the cursor goes to where the fix is (the Job description
// box), a tracked job gets a box to paste into without losing the card, and a
// letter written from the pasted text instead of the link says so.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HttpClientError } from '@/shared/api/http-client'

const CV_ID = '11111111-1111-1111-1111-111111111111'
const JOB_ID = '22222222-2222-2222-2222-222222222222'

const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  jobs: [] as Array<{ id: string; title: string; companyName: string | null; status: string; jobUrl?: string | null }>,
  mutateAsync: vi.fn(),
  data: undefined as undefined | { coverLetter: string; savedJobId: string | null; notice?: string | null },
}))

vi.mock('next/navigation', () => ({ useSearchParams: () => state.params }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/features/cv-library/components/cv-picker', () => ({
  CvPicker: ({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) => (
    <select id={id} aria-label="Your CV" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Pick</option>
      <option value={CV_ID}>My CV</option>
    </select>
  ),
}))
vi.mock('@/features/job-tracking/hooks/use-job-tracking', () => ({
  useSavedJobs: () => ({ data: { jobs: state.jobs }, isLoading: false }),
}))
vi.mock('../hooks/use-cover-letter', () => ({
  useGenerateCoverLetter: () => ({
    mutateAsync: state.mutateAsync,
    get data() {
      return state.data
    },
  }),
}))

import { CoverLetterScreen } from './cover-letter-screen'

const jdError = (code: string, message: string, status = 422) => new HttpClientError(status, { code, message })

beforeEach(() => {
  state.params = new URLSearchParams()
  state.jobs = []
  state.data = undefined
  state.mutateAsync = vi.fn()
})
afterEach(cleanup)

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Write my cover letter|Write it again/ }))
  })
}

describe('CoverLetterScreen — unusable job description', () => {
  it('pasted job: shows the reason and puts the cursor in the Job description box', async () => {
    state.params = new URLSearchParams({ cv: CV_ID, url: 'https://www.linkedin.com/jobs/view/1', title: 'Data Analyst' })
    state.mutateAsync.mockRejectedValue(
      jdError('JD_URL_SIGN_IN', 'LinkedIn job pages need a sign-in, so we can’t read them. Open the job, copy the full description…'),
    )
    render(<CoverLetterScreen />)
    await submit()

    expect(screen.getByRole('alert').textContent).toMatch(/LinkedIn job pages need a sign-in/)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Job description')))
  })

  it('tracked job: reveals a Job description box, then sends the pasted text with the card id', async () => {
    state.params = new URLSearchParams({ cv: CV_ID, savedJob: JOB_ID })
    state.jobs = [{ id: JOB_ID, title: 'Data Analyst', companyName: 'Acme', status: 'saved', jobUrl: 'https://jobs.example.com/acme/1' }]
    state.mutateAsync.mockRejectedValueOnce(jdError('JD_URL_INACCESSIBLE', 'We couldn’t open that job link: the page was not found…'))
    render(<CoverLetterScreen />)
    expect(screen.queryByLabelText('Job description')).toBeNull()

    await submit()
    const box = screen.getByLabelText('Job description')
    await waitFor(() => expect(document.activeElement).toBe(box))

    state.mutateAsync.mockResolvedValueOnce({ coverLetter: 'Dear Hiring Manager,', savedJobId: JOB_ID, jobTitle: 'Data Analyst', companyName: 'Acme' })
    fireEvent.change(box, { target: { value: '  Responsibilities: SQL reports…  ' } })
    await submit()
    expect(state.mutateAsync).toHaveBeenLastCalledWith({
      cvVersionId: CV_ID,
      savedJobId: JOB_ID,
      jobDescription: 'Responsibilities: SQL reports…',
    })
  })

  it('tracked job with no pasted text sends no jobDescription (the card’s own is used)', async () => {
    state.params = new URLSearchParams({ cv: CV_ID, savedJob: JOB_ID })
    state.jobs = [{ id: JOB_ID, title: 'Data Analyst', companyName: 'Acme', status: 'saved' }]
    state.mutateAsync.mockResolvedValue({ coverLetter: 'Dear Hiring Manager,', savedJobId: JOB_ID, jobTitle: 'Data Analyst', companyName: 'Acme' })
    render(<CoverLetterScreen />)
    await submit()
    expect(state.mutateAsync).toHaveBeenCalledWith({ cvVersionId: CV_ID, savedJobId: JOB_ID, jobDescription: undefined })
  })

  it('a browser-side timeout says why and how to recover, not just "timed out"', async () => {
    state.params = new URLSearchParams({ cv: CV_ID, url: 'https://slow.example.com/job', title: 'Data Analyst' })
    state.mutateAsync.mockRejectedValue(new HttpClientError(504, { code: 'TIMEOUT', message: 'The request timed out.' }))
    render(<CoverLetterScreen />)
    await submit()
    expect(screen.getByRole('alert').textContent).toMatch(/took too long.*Paste the job description/)
  })

  it('other failures (e.g. out of credits) do not move the cursor', async () => {
    state.params = new URLSearchParams({ cv: CV_ID, url: 'https://jobs.example.com/1', title: 'Data Analyst' })
    state.mutateAsync.mockRejectedValue(new HttpClientError(429, { code: 'CREDIT_EXHAUSTED', message: 'You are out of credits.' }))
    render(<CoverLetterScreen />)
    await submit()
    expect(screen.getByRole('alert').textContent).toBe('You are out of credits.')
    expect(document.activeElement).not.toBe(screen.getByLabelText('Job description'))
  })
})

describe('CoverLetterScreen — letter written from the pasted text', () => {
  it('shows the notice above the letter', async () => {
    state.params = new URLSearchParams({ cv: CV_ID, url: 'https://jobs.example.com/1', title: 'Data Analyst' })
    const notice = "We couldn't read the job link, so this letter is based on the description you gave."
    state.mutateAsync.mockImplementation(async () => {
      state.data = { coverLetter: 'Dear Hiring Manager,', savedJobId: null, notice }
      return state.data
    })
    render(<CoverLetterScreen />)
    await submit()
    expect(screen.getByRole('status').textContent).toBe(notice)
    expect((screen.getByLabelText('Cover letter text') as HTMLTextAreaElement).value).toBe('Dear Hiring Manager,')
  })
})

describe('CoverLetterScreen — JD recovery panel', () => {
  const PASTED = 'Responsibilities: build SQL reports for finance. Requirements: SQL, Python, stakeholder communication. '.repeat(3)

  it('failed URL extraction shows why, a link to the posting in a new tab, and how to paste', async () => {
    state.params = new URLSearchParams({ cv: CV_ID, url: 'https://careers.example.com/jobs/42?ref=hub', title: 'Data Analyst' })
    state.mutateAsync.mockRejectedValue(jdError('JD_URL_UNREADABLE', 'We opened that link but found no job description on the page.'))
    render(<CoverLetterScreen />)
    await submit()

    const panel = screen.getByRole('alert')
    expect(panel.textContent).toMatch(/couldn't read the job description automatically/)
    expect(panel.textContent).toMatch(/found no job description on the page/)
    expect(panel.textContent).toMatch(/Copy the full job description/)
    expect(panel.textContent).toMatch(/Paste it into the Job description box below/)
    const link = screen.getByRole('link', { name: /Open the job posting/ })
    expect(link.getAttribute('href')).toBe('https://careers.example.com/jobs/42?ref=hub')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.getAttribute('rel')).toContain('noreferrer')
    expect(panel.textContent).toMatch(/on careers\.example\.com/)
    expect(panel.textContent).toMatch(/0 of at least 200 characters pasted/)
  })

  it('never links a non-web address (e.g. javascript:) — it says where to look instead', async () => {
    state.params = new URLSearchParams({ cv: CV_ID, url: 'javascript:alert(1)', title: 'Data Analyst' })
    state.mutateAsync.mockRejectedValue(jdError('JD_URL_UNREACHABLE', 'We couldn’t reach that link.', 502))
    render(<CoverLetterScreen />)
    await submit()
    expect(screen.queryByRole('link', { name: /Open the job posting/ })).toBeNull()
    expect(screen.getByRole('alert').textContent).toMatch(/Open the job posting where you found it/)
  })

  it('retrying with a pasted JD keeps every other input and sends it all again', async () => {
    state.params = new URLSearchParams({ cv: CV_ID, url: 'https://jobs.example.com/9', title: 'Data Analyst', company: 'Acme' })
    state.mutateAsync.mockRejectedValueOnce(jdError('JD_URL_TIMEOUT', 'The job page took too long to load.', 504))
    render(<CoverLetterScreen />)
    await submit()

    // Nothing the student typed is lost.
    expect((screen.getByLabelText('Job title *') as HTMLInputElement).value).toBe('Data Analyst')
    expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('Acme')
    expect((screen.getByLabelText('Job link') as HTMLInputElement).value).toBe('https://jobs.example.com/9')
    expect((screen.getByLabelText('Your CV') as HTMLSelectElement).value).toBe(CV_ID)

    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: PASTED } })
    expect(screen.getByRole('alert').textContent).toMatch(/characters pasted — ready to try again/)

    state.mutateAsync.mockResolvedValueOnce({ coverLetter: 'Dear Hiring Manager,', savedJobId: null, jobTitle: 'Data Analyst', companyName: 'Acme' })
    await submit()
    expect(state.mutateAsync).toHaveBeenLastCalledWith({
      cvVersionId: CV_ID,
      jobTitle: 'Data Analyst',
      companyName: 'Acme',
      jobUrl: 'https://jobs.example.com/9',
      jobDescription: PASTED.trim(),
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByLabelText('Cover letter text') as HTMLTextAreaElement).value).toBe('Dear Hiring Manager,')
  })

  it('tracked job: links the posting and the original card, retries against the same card, and links the card after', async () => {
    state.params = new URLSearchParams({ cv: CV_ID, savedJob: JOB_ID })
    state.jobs = [{ id: JOB_ID, title: 'Data Analyst', companyName: 'Acme', status: 'saved', jobUrl: 'https://www.linkedin.com/jobs/view/7' }]
    state.mutateAsync.mockRejectedValueOnce(jdError('JD_URL_SIGN_IN', 'LinkedIn job pages need a sign-in, so we can’t read them.'))
    render(<CoverLetterScreen />)
    await submit()

    expect(screen.getByRole('link', { name: /Open the job posting/ }).getAttribute('href')).toBe('https://www.linkedin.com/jobs/view/7')
    const card = screen.getByRole('link', { name: 'Data Analyst — Acme' })
    expect(card.getAttribute('href')).toBe(`/jobs/${JOB_ID}/apply`)
    expect(screen.getByRole('alert').textContent).toMatch(/still be saved to your tracked job/)
    expect((screen.getByLabelText('Saved job') as HTMLSelectElement).value).toBe(JOB_ID)

    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: PASTED } })
    state.mutateAsync.mockImplementationOnce(async () => {
      state.data = { coverLetter: 'Dear Hiring Manager,', savedJobId: JOB_ID }
      return { ...state.data, jobTitle: 'Data Analyst', companyName: 'Acme' }
    })
    await submit()
    expect(state.mutateAsync).toHaveBeenLastCalledWith({ cvVersionId: CV_ID, savedJobId: JOB_ID, jobDescription: PASTED.trim() })
    expect(screen.getByRole('link', { name: 'this job in your tracker' }).getAttribute('href')).toBe(`/jobs/${JOB_ID}/apply`)
  })

  it('picking another tracked job clears the panel and the pasted text (they were for the old job)', async () => {
    const OTHER = '33333333-3333-3333-3333-333333333333'
    state.params = new URLSearchParams({ cv: CV_ID, savedJob: JOB_ID })
    state.jobs = [
      { id: JOB_ID, title: 'Data Analyst', companyName: 'Acme', status: 'saved', jobUrl: 'https://jobs.example.com/1' },
      { id: OTHER, title: 'BI Analyst', companyName: 'Beta', status: 'saved', jobUrl: 'https://jobs.example.com/2' },
    ]
    state.mutateAsync.mockRejectedValueOnce(jdError('JD_URL_INACCESSIBLE', 'We couldn’t open that job link.'))
    render(<CoverLetterScreen />)
    await submit()
    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: PASTED } })
    fireEvent.change(screen.getByLabelText('Saved job'), { target: { value: OTHER } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByLabelText('Job description')).toBeNull()
  })
})
