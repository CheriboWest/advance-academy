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
  jobs: [] as Array<{ id: string; title: string; companyName: string | null; status: string }>,
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
    state.jobs = [{ id: JOB_ID, title: 'Data Analyst', companyName: 'Acme', status: 'saved' }]
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
