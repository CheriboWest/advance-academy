'use client'

import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Link as LinkIcon,
  Loader,
  Upload,
  FileText,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { useOutreach } from '@/features/outreach/hooks/use-outreach'
import type { ManualContextLink, OutreachFormData } from '@/features/outreach/types'
import type { EnrichmentCard, ExperienceLevel, OutreachIntent } from '@advance-academy/contracts/outreach'
import { extractOutreachSource, validateJdUrl } from '@/features/outreach/api/frontend-client'
import { EnrichmentPanel } from './enrichment-panel'
import { ManualContextManager } from './manual-context-manager'

const inputClass =
  'w-full px-4 py-2.5 rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-ring text-sm'
const textareaClass = `${inputClass} min-h-24 resize-y`

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-sm font-semibold text-primary mb-1.5 flex justify-between items-center">
        <span>
          {label} {required && <span className="text-red-500 ml-0.5">*</span>}
        </span>
      </label>
      {children}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <button
      onClick={handleCopy}
      className="px-4 py-2 bg-secondary text-primary rounded-lg font-medium hover:bg-secondary/90 transition-colors flex items-center gap-2 text-sm shadow-sm"
    >
      {copied ? (
        <>
          <CheckCircle2 className="w-4 h-4" /> Copied
        </>
      ) : (
        <>
          <Copy className="w-4 h-4" /> Copy
        </>
      )}
    </button>
  )
}

function FileExtractor({
  onExtract,
  placeholder = 'Upload PDF/DOCX or Paste Text below',
}: {
  onExtract: (text: string) => void
  placeholder?: string
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setLoading(true)
    setError('')
    try {
      const res = await extractOutreachSource(file)
      onExtract(res.text)
    } catch (err: any) {
      setError(err.message || 'Extract failed')
    } finally {
      setLoading(false)
      if (e.target) e.target.value = ''
    }
  }

  return (
    <div className="mb-2">
      <div className="flex items-center gap-3">
        <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 bg-primary/5 text-primary rounded-lg text-sm font-semibold hover:bg-primary/10 transition-colors">
          <Upload className="w-4 h-4" />
          {loading ? 'Extracting...' : 'Upload File'}
          <input type="file" accept=".pdf,.docx" className="hidden" onChange={handleFile} disabled={loading} />
        </label>
        <span className="text-xs text-subtle-foreground">{placeholder}</span>
      </div>
      {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
    </div>
  )
}

function UrlExtractor({
  onExtract,
  placeholder = 'https://...',
}: {
  onExtract: (text: string) => void
  placeholder?: string
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')

  async function handleExtract() {
    if (!url.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await extractOutreachSource(url.trim())
      onExtract(res.text)
      setUrl('')
    } catch (err: any) {
      setError(err.message || 'Extract failed. Please try saving as PDF instead.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={placeholder}
          className="flex-1 px-3 py-2 rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-ring text-sm"
        />
        <button
          onClick={handleExtract}
          disabled={loading || !url.trim()}
          className="px-4 py-2 bg-card text-foreground rounded-lg text-sm font-semibold hover:bg-muted disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? <Loader className="w-4 h-4 animate-spin" /> : <LinkIcon className="w-4 h-4" />}
          Extract URL
        </button>
      </div>
      {error && (
        <p className="text-red-500 text-xs mt-1 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> {error}
        </p>
      )}
    </div>
  )
}

function JdInput({
  jdText,
  jdUrl,
  jdValidating,
  jdValidationError,
  onJdTextChange,
  onJdUrlChange,
  onJdValidated,
  onJdValidationError,
  onJdValidating,
}: {
  jdText: string
  jdUrl: string
  jdValidating: boolean
  jdValidationError: string
  onJdTextChange: (text: string) => void
  onJdUrlChange: (url: string) => void
  onJdValidated: (text: string) => void
  onJdValidationError: (err: string) => void
  onJdValidating: (loading: boolean) => void
}) {
  const [activeTab, setActiveTab] = useState<'url' | 'paste'>('url')

  async function handleValidate() {
    if (!jdUrl.trim()) return
    onJdValidating(true)
    onJdValidationError('')
    try {
      const result = await validateJdUrl(jdUrl.trim())
      if (result.valid && result.jdText) {
        onJdValidated(result.jdText)
      } else {
        onJdValidationError(result.reason || 'This link does not appear to be a valid job description.')
      }
    } catch (err: any) {
      onJdValidationError(err.message || 'Failed to validate URL.')
    } finally {
      onJdValidating(false)
    }
  }

  return (
    <div>
      <div className="flex gap-2 mb-3">
        <button
          type="button"
          onClick={() => setActiveTab('url')}
          className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
            activeTab === 'url'
              ? 'bg-primary text-primary-foreground'
              : 'bg-card text-muted-foreground hover:bg-muted'
          }`}
        >
          Paste Link
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('paste')}
          className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
            activeTab === 'paste'
              ? 'bg-primary text-primary-foreground'
              : 'bg-card text-muted-foreground hover:bg-muted'
          }`}
        >
          Paste Text
        </button>
      </div>

      {activeTab === 'url' && (
        <div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={jdUrl}
              onChange={(e) => onJdUrlChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleValidate()}
              placeholder="https://company.com/jobs/role or LinkedIn job URL"
              className="flex-1 px-3 py-2 rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-ring text-sm"
            />
            <button
              type="button"
              onClick={handleValidate}
              disabled={jdValidating || !jdUrl.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2 whitespace-nowrap"
            >
              {jdValidating ? (
                <><Loader className="w-4 h-4 animate-spin" /> Validating…</>
              ) : (
                <><FileText className="w-4 h-4" /> Fetch JD</>
              )}
            </button>
          </div>
          {jdValidationError && (
            <p className="mt-2 text-sm text-red-600 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {jdValidationError}
            </p>
          )}
          {jdText && !jdValidationError && (
            <p className="mt-2 text-sm text-green-600 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              JD extracted successfully — {jdText.length.toLocaleString()} characters
            </p>
          )}
        </div>
      )}

      {activeTab === 'paste' && (
        <textarea
          value={jdText}
          onChange={(e) => onJdTextChange(e.target.value)}
          placeholder="Paste the full job description here…"
          className={`${textareaClass} h-40`}
        />
      )}

      {activeTab === 'url' && jdText && (
        <details className="mt-3">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-primary font-semibold">
            View / edit extracted JD text
          </summary>
          <textarea
            value={jdText}
            onChange={(e) => onJdTextChange(e.target.value)}
            className={`${textareaClass} h-40 mt-2 text-xs`}
          />
        </details>
      )}
    </div>
  )
}

const INTENT_OPTIONS: { value: OutreachIntent; label: string }[] = [
  { value: 'direct_application', label: '🎯 Direct Application (Hard Pitch)' },
  { value: 'referral_request', label: '🤝 Referral Request (Soft Ask to Employee)' },
  { value: 'informational_interview', label: '☕ Informational Interview (Networking)' },
  { value: 'agency_recruiter', label: '👔 Agency Recruiter (Headhunter Pitch)' },
]

interface OutreachFormProps {
  form: OutreachFormData
  updateForm: (
    updates: Partial<OutreachFormData> | ((prev: OutreachFormData) => Partial<OutreachFormData>),
  ) => void
  toggleInsightCard: (card: EnrichmentCard) => void
  loading: boolean
  error: string | null
  onGenerate: () => void
  onEnrich: () => void
  enriching: boolean
  enrichError: string | null
}

function OutreachForm({
  form,
  updateForm,
  toggleInsightCard,
  loading,
  error,
  onGenerate,
  onEnrich,
  enriching,
  enrichError,
}: OutreachFormProps) {
  const atLeastOneOutput = form.outputs.email || form.outputs.linkedIn
  const canSubmit =
    !loading &&
    form.cvText.trim().length > 0 &&
    form.targetCompany.trim().length > 0 &&
    form.targetRole.trim().length > 0 &&
    atLeastOneOutput

  const canSearch = form.targetCompany.trim().length > 0 && form.targetRole.trim().length > 0

  return (
    <div className="space-y-8">
      {/* Section 1 — Identity */}
      <div className="p-8 bg-background border rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
        <h3 className="text-xl font-serif font-bold text-primary mb-6 flex items-center gap-2">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary text-sm">1</span>
          Who are you? (Identity Context)
        </h3>

        <div className="space-y-6">
          <Field label="Your CV Content" required>
            <FileExtractor onExtract={(t) => updateForm({ cvText: t })} />
            <textarea
              value={form.cvText}
              onChange={(e) => updateForm({ cvText: e.target.value })}
              placeholder="Review or paste your resume content here..."
              className={`${textareaClass} h-40 focus:ring-ring`}
            />
          </Field>

          <div className="border-t border-border pt-6">
            <Field label="Portfolio / Additional Context (Optional)">
              <p className="text-xs text-muted-foreground mb-2">
                Add a portfolio URL, case study, or project page. We&apos;ll extract the readable text via Jina.
              </p>
              <UrlExtractor
                placeholder="https://your-portfolio.com or case study link"
                onExtract={(t) =>
                  updateForm({
                    portfolioText: t,
                    portfolioUrl: '',
                  })
                }
              />
              {form.portfolioText && (
                <textarea
                  value={form.portfolioText}
                  onChange={(e) => updateForm({ portfolioText: e.target.value })}
                  placeholder="Extracted portfolio text…"
                  className={`${textareaClass} h-24 focus:ring-ring text-xs`}
                />
              )}
            </Field>
          </div>
        </div>
      </div>

      {/* Section 2 — Target + JD */}
      <div className="p-8 bg-background border rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
        <h3 className="text-xl font-serif font-bold text-primary mb-6 flex items-center gap-2">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary text-sm">2</span>
          The Role & Target
        </h3>
        <div className="space-y-6">
          {/* JD input — first and prominent */}
          <Field label="Job Description">
            <p className="text-xs text-muted-foreground mb-3">
              Paste a link to the JD (we&apos;ll validate it) or paste the text directly. Used to match your CV and generate smarter company insights.
            </p>
            <JdInput
              jdText={form.jdText}
              jdUrl={form.jdUrl}
              jdValidating={form.jdValidating}
              jdValidationError={form.jdValidationError}
              onJdTextChange={(text) => updateForm({ jdText: text })}
              onJdUrlChange={(url) => updateForm({ jdUrl: url })}
              onJdValidated={(text) => updateForm({ jdText: text, jdValidationError: '' })}
              onJdValidationError={(err) => updateForm({ jdValidationError: err, jdText: '' })}
              onJdValidating={(loading) => updateForm({ jdValidating: loading })}
            />
          </Field>

          <div className="border-t border-border pt-6 grid md:grid-cols-2 gap-6">
            <Field label="Target Company" required>
              <input
                value={form.targetCompany}
                onChange={(e) => updateForm({ targetCompany: e.target.value })}
                placeholder="e.g. OpenAI"
                className={inputClass}
              />
            </Field>
            <Field label="Target Role" required>
              <input
                value={form.targetRole}
                onChange={(e) => updateForm({ targetRole: e.target.value })}
                placeholder="e.g. HR Manager, Head of Sales"
                className={inputClass}
              />
            </Field>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <Field label="Target Country (Optional)">
              <input
                value={form.targetCountry}
                onChange={(e) => updateForm({ targetCountry: e.target.value })}
                placeholder="e.g. Vietnam, United States, Singapore"
                className={inputClass}
              />
            </Field>
            <Field label="Your Location (Optional)">
              <input
                value={form.userLocation}
                onChange={(e) => updateForm({ userLocation: e.target.value })}
                placeholder="e.g. Vietnam, Ho Chi Minh City"
                className={inputClass}
              />
            </Field>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <Field label="Target Person Name (Optional)">
              <input
                value={form.targetPersonName}
                onChange={(e) => updateForm({ targetPersonName: e.target.value })}
                placeholder="e.g. Sam Altman"
                className={inputClass}
              />
            </Field>
            <Field label="Outreach Intent" required>
              <select
                value={form.intent}
                onChange={(e) => updateForm({ intent: e.target.value as OutreachIntent })}
                className={`${inputClass} bg-card`}
              >
                {INTENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Additional Enrichment Links (Optional)">
            <p className="text-xs text-muted-foreground mb-3">
              Add labeled URLs for extra context (company blog, mutual project, news article, etc.).
              We&apos;ll extract the content and pass it to the AI alongside your JD.
            </p>
            <ManualContextManager
              contexts={form.manualContexts}
              onUpdate={(updater: (prev: ManualContextLink[]) => ManualContextLink[]) =>
                updateForm((prev: OutreachFormData) => ({
                  manualContexts: updater(prev.manualContexts),
                }))
              }
            />
          </Field>
        </div>
      </div>

      {/* Section 3 — Company Insights (Exa) */}
      <EnrichmentPanel
        experienceLevel={form.experienceLevel}
        onChangeExperienceLevel={(level: ExperienceLevel) => updateForm({ experienceLevel: level })}
        enrichmentResults={form.enrichmentResults}
        selectedInsightCards={form.selectedInsightCards}
        onToggleInsight={toggleInsightCard}
        onSearch={onEnrich}
        loading={enriching}
        error={enrichError}
        canSearch={canSearch}
        hasJd={form.jdText.trim().length > 0}
      />

      {/* Section 4 — Output preferences */}
      <div className="p-8 bg-background border rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
        <h3 className="text-xl font-serif font-bold text-primary mb-4 flex items-center gap-2">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary text-sm">4</span>
          What to generate
        </h3>
        <p className="ml-10 mb-4 text-sm text-muted-foreground">
          Pick which messages you want. Unselected ones are skipped to save tokens.
        </p>
        <div className="ml-10 flex flex-wrap gap-6">
          <label className="flex items-center gap-3 cursor-pointer">
            <Checkbox
              checked={form.outputs.email}
              onCheckedChange={(checked) =>
                updateForm({
                  outputs: { ...form.outputs, email: checked === true },
                })
              }
            />
            <span className="text-sm font-semibold text-primary">📧 Email</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <Checkbox
              checked={form.outputs.linkedIn}
              onCheckedChange={(checked) =>
                updateForm({
                  outputs: { ...form.outputs, linkedIn: checked === true },
                })
              }
            />
            <span className="text-sm font-semibold text-primary">💼 LinkedIn message</span>
          </label>
        </div>
        {!atLeastOneOutput && (
          <p className="ml-10 mt-3 text-xs text-red-500">Select at least one output.</p>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-6 py-4 text-sm text-red-700 flex items-center gap-3 shadow-sm">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          {error}
        </div>
      )}

      <button
        onClick={onGenerate}
        disabled={!canSubmit}
        className="w-full px-6 py-5 bg-gradient-to-r from-secondary to-secondary/85 text-primary rounded-2xl text-lg font-bold hover:from-secondary/90 hover:to-secondary/75 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3 transform hover:-translate-y-0.5"
      >
        {loading ? (
          <>
            <Loader className="w-6 h-6 animate-spin" /> Generating Magic...
          </>
        ) : (
          <>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Generate Messages
          </>
        )}
      </button>
    </div>
  )
}

export function OutreachScreen() {
  const {
    form,
    updateForm,
    toggleInsightCard,
    results,
    setResults,
    loading,
    error,
    generate,
    enrich,
    enriching,
    enrichError,
  } = useOutreach()

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="text-center mb-12">
        <h1 className="text-4xl sm:text-5xl font-serif font-extrabold text-primary mb-4 tracking-tight">
          Recruitment Outreach Generator
        </h1>
        <p className="text-muted-foreground text-lg sm:text-xl max-w-2xl mx-auto">
          Generate highly personalised outreach from your JD, CV, and real company insights — powered by Exa search and Claude AI.
        </p>
      </div>

      {!results ? (
        <OutreachForm
          form={form}
          updateForm={updateForm}
          toggleInsightCard={toggleInsightCard}
          loading={loading}
          error={error}
          onGenerate={generate}
          onEnrich={enrich}
          enriching={enriching}
          enrichError={enrichError}
        />
      ) : (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="mb-8 flex items-center justify-between bg-background p-4 rounded-xl border border-border shadow-sm">
            <button
              onClick={() => setResults(null)}
              className="px-4 py-2 text-highlight-ink font-semibold hover:bg-secondary/10 rounded-lg flex items-center gap-2 transition-colors"
            >
              &larr; Create Another
            </button>
            <div className="flex items-center gap-2 text-sm font-semibold text-primary-foreground bg-gradient-to-r from-primary to-primary px-4 py-1.5 rounded-full shadow-inner">
              <CheckCircle2 className="h-4 w-4" />
              {results.intent
                .split('_')
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' ')}
            </div>
          </div>

          <div className="space-y-8">
            {results.linkedInMessage !== undefined && (
              <div className="bg-background rounded-2xl p-8 border shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden">
                <div className="absolute top-0 left-0 w-1 h-full bg-primary" />
                <h3 className="text-xl font-serif font-bold text-primary mb-6 flex items-center gap-2">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-primary"
                  >
                    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"></path>
                    <rect x="2" y="9" width="4" height="12"></rect>
                    <circle cx="4" cy="4" r="2"></circle>
                  </svg>
                  LinkedIn Connection Note
                </h3>
                <div className="bg-card rounded-xl p-6 border border-border mb-6 text-base text-foreground leading-relaxed min-h-[100px]">
                  {results.linkedInMessage}
                </div>
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs font-bold px-3 py-1 rounded-full ${
                      results.linkedInMessage.length > 300
                        ? 'bg-red-100 text-red-600'
                        : 'bg-green-100 text-green-700'
                    }`}
                  >
                    {results.linkedInMessage.length}/300 characters
                  </span>
                  <CopyButton text={results.linkedInMessage} />
                </div>
              </div>
            )}

            {results.email && (
              <div className="bg-background rounded-2xl p-8 border shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden">
                <div className="absolute top-0 left-0 w-1 h-full bg-secondary" />
                <h3 className="text-xl font-serif font-bold text-primary mb-6 flex items-center gap-2">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-highlight-ink"
                  >
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                    <polyline points="22,6 12,13 2,6"></polyline>
                  </svg>
                  Email Version
                </h3>

                <div className="mb-8">
                  <p className="text-sm font-bold text-muted-foreground uppercase tracking-wider mb-3">Subject Line</p>
                  <div className="bg-card rounded-xl px-5 py-4 border border-border flex items-center justify-between gap-4">
                    <span className="text-base text-foreground font-semibold">{results.email.subject}</span>
                    <CopyButton text={results.email.subject} />
                  </div>
                </div>

                <div>
                  <p className="text-sm font-bold text-muted-foreground uppercase tracking-wider mb-3">Email Body</p>
                  <div className="bg-card rounded-xl p-6 border border-border mb-6 text-base text-foreground whitespace-pre-wrap leading-relaxed min-h-[200px]">
                    {results.email.body}
                  </div>
                  <div className="flex justify-end">
                    <CopyButton text={results.email.body} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
