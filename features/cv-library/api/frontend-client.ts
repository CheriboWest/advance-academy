// CV Library + Coach Understanding endpoints. Each returns the raw Response:
// callers read their own error bodies, and CV upload/finalise must not inherit
// fetchJson's 15s timeout.
import { authedFetch } from '@/shared/auth/authed-fetch'

const sendJson = (path: string, body: unknown, method = 'POST') =>
  authedFetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const listCvVersions = () => authedFetch('/api/cv-library/versions')
export const uploadCvVersion = (form: FormData) =>
  authedFetch('/api/cv-library/versions', { method: 'POST', body: form })
export const getCvVersion = (id: string) => authedFetch(`/api/cv-library/versions/${id}`)
export const deleteCvVersion = (id: string) =>
  authedFetch(`/api/cv-library/versions/${id}`, { method: 'DELETE' })
export const activateCvVersion = (id: string) =>
  authedFetch(`/api/cv-library/versions/${id}/activate`, { method: 'POST' })
export const finalizeCvVersion = (id: string, body: unknown) =>
  sendJson(`/api/cv-library/versions/${id}/finalize`, body)
export const getCvVersionBullets = (id: string) => authedFetch(`/api/cv-library/versions/${id}/bullets`)

export const findSimilarBullets = (bulletId: string) =>
  authedFetch(`/api/cv-library/bullets/${bulletId}/similar`, { method: 'POST' })
export const mergeBullets = (body: { sourceBulletId: string; targetBulletId: string }) =>
  sendJson('/api/cv-library/bullets/merge', body)
export const getBulletDetails = (bulletId: string) => authedFetch(`/api/cv-library/bullets/${bulletId}/details`)

export const updateArtifact = (artifactId: string, body: { text: string }) =>
  sendJson(`/api/cv-library/artifacts/${artifactId}`, body, 'PATCH')
export const addGapArtifact = (gapId: string, body: { text: string }) =>
  sendJson(`/api/cv-library/gaps/${gapId}/artifacts`, body)
export const skipGap = (gapId: string) => authedFetch(`/api/cv-library/gaps/${gapId}/skip`, { method: 'POST' })
export const postJitClarification = (body: unknown) => sendJson('/api/cv-library/jit-clarification', body)

export const listCoachReports = () => authedFetch('/api/coach-understanding/reports')
export const generateCoachReport = (body: { cvVersionId?: string }) =>
  sendJson('/api/coach-understanding/generate', body)
export const getCoachReport = (id: string) => authedFetch(`/api/coach-understanding/reports/${id}`)
