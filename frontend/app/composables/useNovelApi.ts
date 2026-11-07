import { api, API_BASE } from './useApi'

export interface NovelListParams {
  keyword?: string
  status?: string
  page?: number
  pageSize?: number
}

function query(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const novelAPI = {
  list: (params: NovelListParams = {}) => api.get(`/novels${query({
    keyword: params.keyword,
    status: params.status,
    page: params.page,
    page_size: params.pageSize,
  })}`),
  get: (id: number) => api.get(`/novels/${id}`),
  create: (data: Record<string, unknown>) => api.post('/novels', data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/novels/${id}`, data),
  remove: (id: number) => api.del(`/novels/${id}`),
  exportUrl: (id: number, format: 'txt' | 'md') => `${API_BASE}/novels/${id}/export?format=${format}`,
  previewImport: (id: number, data: Record<string, unknown>) => api.post(`/novels/${id}/imports/preview`, data),
  contextPackPreview: (id: number, data: Record<string, unknown>) => api.post(`/novels/${id}/context-pack/preview`, data),
  imports: (id: number) => api.get(`/novels/${id}/imports`),
  importToDrama: (id: number, data: Record<string, unknown>) => api.post(`/novels/${id}/imports`, data),
  previewSync: (id: number, importId: number) => api.get(`/novels/${id}/imports/${importId}/preview`),
  sync: (id: number, importId: number, data: Record<string, unknown>) =>
    api.post(`/novels/${id}/imports/${importId}/sync`, data),
  deleteImport: (id: number, importId: number) => api.del(`/novels/${id}/imports/${importId}`),
  graph: (id: number) => api.get(`/novels/${id}/graph`),
  saveGraph: (id: number, data: Record<string, unknown>) => api.put(`/novels/${id}/graph`, data),
  startGraphBase: (id: number) => api.post(`/novels/${id}/graph/base`, {}),
  startGraphSnapshots: (id: number) => api.post(`/novels/${id}/graph/snapshots`, {}),
  startGraphAudit: (id: number) => api.post(`/novels/${id}/graph/audit`, {}),
  startGraphChapter: (id: number, chapterNo: number) =>
    api.post(`/novels/${id}/graph/chapters/${chapterNo}`, {}),
  workbench: (id: number) => api.get(`/novels/${id}/workbench`),
  annotations: (id: number, params: { chapterNo?: number; status?: string | string[] } = {}) =>
    api.get(`/novels/${id}/annotations${query({
      chapter_no: params.chapterNo,
      status: Array.isArray(params.status) ? params.status.join(',') : params.status,
    })}`),
  createAnnotation: (id: number, data: Record<string, unknown>) =>
    api.post(`/novels/${id}/annotations`, data),
  updateAnnotation: (id: number, annotationId: number, data: Record<string, unknown>) =>
    api.put(`/novels/${id}/annotations/${annotationId}`, data),
  deleteAnnotation: (id: number, annotationId: number) =>
    api.del(`/novels/${id}/annotations/${annotationId}`),
  foreshadows: (id: number, params: { chapterNo?: number; status?: string | string[] } = {}) =>
    api.get(`/novels/${id}/foreshadows${query({
      chapter_no: params.chapterNo,
      status: Array.isArray(params.status) ? params.status.join(',') : params.status,
    })}`),
  foreshadowCandidates: (id: number) => api.get(`/novels/${id}/foreshadows/candidates`),
  createForeshadow: (id: number, data: Record<string, unknown>) =>
    api.post(`/novels/${id}/foreshadows`, data),
  updateForeshadow: (id: number, foreshadowId: number, data: Record<string, unknown>) =>
    api.put(`/novels/${id}/foreshadows/${foreshadowId}`, data),
  deleteForeshadow: (id: number, foreshadowId: number) =>
    api.del(`/novels/${id}/foreshadows/${foreshadowId}`),
  chapters: (id: number) => api.get(`/novels/${id}/chapters`),
  saveChapter: (id: number, chapterNo: number, data: Record<string, unknown>) =>
    api.put(`/novels/${id}/chapters/${chapterNo}`, data),
  jobs: (id: number, status?: string) =>
    api.get(`/novels/${id}/jobs${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  saveStoryAtlas: (id: number, payload: Record<string, unknown>) => api.put(`/novels/${id}/story-atlas`, payload),
  updateBlueprintNarration: (id: number, chapterNo: number, narration: string) =>
    api.patch(`/novels/${id}/blueprint/chapters/${chapterNo}`, { narration }),
  startStoryAtlas: (id: number, force = false) =>
    api.post(`/novels/${id}/story-atlas/generate`, { force }),
  startArchitecture: (id: number, force = false) =>
    api.post(`/novels/${id}/architecture/generate`, { force }),
  startBlueprint: (id: number) =>
    api.post(`/novels/${id}/blueprint/generate`, {}),
  startChapter: (id: number, chapterNo: number, opts: { force?: boolean; content?: string } = {}) =>
    api.post(`/novels/${id}/chapters/${chapterNo}/generate`, opts),
  finalizeChapter: (id: number, chapterNo: number, content?: string) =>
    api.post(`/novels/${id}/chapters/${chapterNo}/finalize`, content ? { content } : {}),
  enrichChapter: (id: number, chapterNo: number, opts: { content?: string; wordNumber?: number } = {}) =>
    api.post(`/novels/${id}/chapters/${chapterNo}/enrich`, {
      content: opts.content,
      word_number: opts.wordNumber,
    }),
  job: (jobId: number) => api.get(`/novel-jobs/${jobId}`),
  cancelJob: (jobId: number) => api.post(`/novel-jobs/${jobId}/cancel`),
  settings: () => api.get('/settings/novel'),
  saveSettings: (data: Record<string, unknown>) => api.put('/settings/novel', data),
}
