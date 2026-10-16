import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))

import { JD_MIN_CHARS, JdRecovery, safeJobLink } from './jd-recovery'

afterEach(cleanup)

describe('safeJobLink', () => {
  it('keeps http(s) links and refuses anything else', () => {
    expect(safeJobLink(' https://jobs.example.com/1?x=y ')).toBe('https://jobs.example.com/1?x=y')
    expect(safeJobLink('http://jobs.example.com/1')).toBe('http://jobs.example.com/1')
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.example.com/a', 'not a url', '', null, undefined]) {
      expect(safeJobLink(bad)).toBeNull()
    }
  })
})

describe('JdRecovery', () => {
  it('without a tracked card, says nothing about the tracker', () => {
    render(<JdRecovery message="Reason." jobUrl="https://jobs.example.com/1" card={null} pastedChars={0} />)
    expect(screen.queryByText(/tracked job/)).toBeNull()
  })

  it('counts towards the minimum the backend enforces', () => {
    const { rerender } = render(<JdRecovery message="Reason." jobUrl={null} card={null} pastedChars={JD_MIN_CHARS - 1} />)
    expect(screen.getByText(`${JD_MIN_CHARS - 1} of at least ${JD_MIN_CHARS} characters pasted.`)).toBeTruthy()
    rerender(<JdRecovery message="Reason." jobUrl={null} card={null} pastedChars={JD_MIN_CHARS} />)
    expect(screen.getByText(/ready to try again/)).toBeTruthy()
  })

  it('tells screen readers the posting opens in a new tab', () => {
    render(<JdRecovery message="Reason." jobUrl="https://jobs.example.com/1" card={null} pastedChars={0} />)
    expect(screen.getByRole('link', { name: /Open the job posting.*opens in a new tab/ })).toBeTruthy()
  })
})
