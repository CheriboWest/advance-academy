'use client'

import { useCallback, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import type {
  EnrichmentCard,
  EnrichmentRequest,
  EnrichmentResponse,
  ManualContext,
  OutreachRequest,
  OutreachResult,
} from '@advance-academy/contracts/outreach'
import type { OutreachFormData } from '@/features/outreach/types'
import { HttpClientError } from '@/shared/api/http-client'
import {
  submitOutreachEnrichment,
  submitOutreachGeneration,
} from '@/features/outreach/api/frontend-client'

const INITIAL_FORM: OutreachFormData = {
  cvText: '',
  portfolioUrl: '',
  portfolioText: '',
  targetCompany: '',
  targetCountry: '',
  targetPersonName: '',
  targetRole: '',
  experienceLevel: 'mid',
  intent: 'direct_application',
  userLocation: '',
  jdText: '',
  jdUrl: '',
  jdValidating: false,
  jdValidationError: '',
  manualContexts: [],
  selectedInsightCards: [],
  outputs: { email: true, linkedIn: true },
  enrichmentResults: null,
}

function packManualContexts(form: OutreachFormData): ManualContext[] | undefined {
  const packed = form.manualContexts
    .filter((c) => c.status === 'success' && c.extractedText.trim().length > 0)
    .map((c) => ({
      title: c.title.trim() || 'Untitled context',
      url: c.url.trim(),
      content: c.extractedText.trim(),
    }))
  return packed.length > 0 ? packed : undefined
}

function buildGenerateRequest(form: OutreachFormData): OutreachRequest {
  return {
    cvText: form.cvText,
    portfolioText: form.portfolioText.trim() ? form.portfolioText : undefined,
    targetCompany: form.targetCompany,
    targetCountry: form.targetCountry.trim() || undefined,
    targetPersonName: form.targetPersonName.trim() ? form.targetPersonName : undefined,
    targetRole: form.targetRole,
    experienceLevel: form.experienceLevel,
    intent: form.intent,
    userLocation: form.userLocation.trim() || undefined,
    manualContexts: packManualContexts(form),
    jdText: form.jdText.trim() || undefined,
    insightSignals: form.selectedInsightCards.length > 0
      ? form.selectedInsightCards.map((c) => ({ url: c.url, exaText: c.exaText }))
      : undefined,
    outputs: form.outputs,
  }
}

function buildEnrichRequest(form: OutreachFormData): EnrichmentRequest {
  return {
    companyName: form.targetCompany.trim(),
    targetCountry: form.targetCountry.trim() || undefined,
    targetRole: form.targetRole.trim(),
    experienceLevel: form.experienceLevel,
    personName: form.targetPersonName.trim() || undefined,
    intent: form.intent,
    userLocation: form.userLocation.trim() || undefined,
    manualContexts: packManualContexts(form),
    jdText: form.jdText.trim() || undefined,
  }
}

export function useOutreach() {
  // `?company=&person=` comes from a contact's "Write outreach" on /companies/[slug].
  const params = useSearchParams()
  const [form, setForm] = useState<OutreachFormData>(() => ({
    ...INITIAL_FORM,
    targetCompany: params?.get('company') ?? '',
    targetPersonName: params?.get('person') ?? '',
  }))
  const [results, setResults] = useState<OutreachResult | null>(null)

  const generateMutation = useMutation<OutreachResult, HttpClientError, OutreachRequest>({
    mutationFn: submitOutreachGeneration,
    onSuccess: (data) => {
      setResults(data)
    },
  })

  const enrichMutation = useMutation<EnrichmentResponse, HttpClientError, EnrichmentRequest>({
    mutationFn: submitOutreachEnrichment,
    onSuccess: (data) => {
      setForm((prev) => ({
        ...prev,
        enrichmentResults: data,
        selectedInsightCards: data.insightResults.slice(0, 3),
      }))
    },
  })

  const updateForm = useCallback(
    (updates: Partial<OutreachFormData> | ((prev: OutreachFormData) => Partial<OutreachFormData>)) => {
      setForm((previous) => {
        const next = typeof updates === 'function' ? updates(previous) : updates
        return { ...previous, ...next }
      })
    },
    [],
  )

  const toggleInsightCard = useCallback((card: EnrichmentCard) => {
    setForm((prev) => {
      const isSelected = prev.selectedInsightCards.some((c) => c.url === card.url)
      return {
        ...prev,
        selectedInsightCards: isSelected
          ? prev.selectedInsightCards.filter((c) => c.url !== card.url)
          : [...prev.selectedInsightCards, card],
      }
    })
  }, [])

  const enrich = useCallback(() => {
    if (!form.targetCompany.trim() || !form.targetRole.trim()) return
    enrichMutation.mutate(buildEnrichRequest(form))
  }, [form, enrichMutation])

  const generate = useCallback(() => {
    generateMutation.mutate(buildGenerateRequest(form))
  }, [form, generateMutation])

  const reset = useCallback(() => {
    setResults(null)
    generateMutation.reset()
  }, [generateMutation])

  return {
    form,
    updateForm,
    toggleInsightCard,
    results,
    setResults,
    loading: generateMutation.isPending,
    error: generateMutation.error?.payload?.message ?? generateMutation.error?.message ?? null,
    generate,
    reset,
    enrich,
    enriching: enrichMutation.isPending,
    enrichError: enrichMutation.error?.payload?.message ?? enrichMutation.error?.message ?? null,
  }
}
