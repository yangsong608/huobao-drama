export const API_BASE = '/api/v1'
const BASE = API_BASE

async function req<T = any>(method: string, path: string, body?: any): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)

  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', body || '')

  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    const json = await resp.json()
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
      const error = new Error(json.message || `${resp.status}`) as Error & {
        status?: number
        code?: string
        data?: any
      }
      error.status = resp.status || json.code
      error.code = json.code
      error.data = json.data
      throw error
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return json.data ?? json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  patch: <T = any>(p: string, b?: any) => req<T>('PATCH', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
}

export const dramaAPI = {
  list: () => api.get<{ items: any[] }>('/dramas'),
  get: (id: number) => api.get(`/dramas/${id}`),
  create: (data: any) => api.post('/dramas', data),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  del: (id: number) => api.del(`/dramas/${id}`),
  storage: (id: number) => api.get(`/dramas/${id}/storage`),
  setStorage: (id: number, storageDir: string | null) => api.put(`/dramas/${id}/storage`, { storage_dir: storageDir }),
}

export const episodeAPI = {
  get: (id: number) => api.get(`/episodes/${id}`),
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  del: (id: number) => api.del(`/episodes/${id}`),
  rework: (id: number) => api.post(`/episodes/${id}/rework`),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  // scope=all：返回全剧场景/道具并带 in_episode 标记（资产制作页直接展示全剧共享资产）
  scenes: (id: number, opts?: { scope?: 'all' }) => api.get(`/episodes/${id}/scenes${opts?.scope === 'all' ? '?scope=all' : ''}`),
  props: (id: number, opts?: { scope?: 'all' }) => api.get(`/episodes/${id}/props${opts?.scope === 'all' ? '?scope=all' : ''}`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
  extract: (id: number, target: string, model?: string, configId?: number) => api.post(`/episodes/${id}/extract`, { target, model: model || undefined, config_id: configId || undefined }),
  extractStatus: (id: number) => api.get(`/episodes/${id}/extract-status`),
  generateVideoPrompts: (id: number, model?: string, configId?: number, storyboardIds?: number[]) => api.post(`/episodes/${id}/generate-video-prompts`, { model: model || undefined, config_id: configId || undefined, storyboard_ids: storyboardIds?.length ? storyboardIds : undefined }),
  videoPromptsStatus: (id: number) => api.get(`/episodes/${id}/video-prompts-status`),
  comfyWorkflow: (id: number, configId?: number) => api.get(`/episodes/${id}/comfyui/workflow${configId ? `?config_id=${configId}` : ''}`),
  comfyUiSession: (id: number, configId?: number) => api.get(`/episodes/${id}/comfyui/ui-session${configId ? `?config_id=${configId}` : ''}`),
  comfyRun: (id: number, opts?: { configId?: number; forceNew?: boolean }) => api.post(`/episodes/${id}/comfyui/run`, { config_id: opts?.configId, force_new: opts?.forceNew === true }),
}

export const editAPI = {
  get: (episodeId: number, projectId?: number) =>
    api.get(`/episodes/${episodeId}/edit${projectId ? `?project_id=${projectId}` : ''}`),
  projects: (episodeId: number) => api.get(`/episodes/${episodeId}/edit/projects`),
  openProject: (episodeId: number, filmId: number) =>
    api.post(`/episodes/${episodeId}/edit/projects`, { film_id: filmId }),
  media: (episodeId: number) => api.get(`/episodes/${episodeId}/edit/media`),
  saveDraft: (episodeId: number, body: {
    base_version: number
    plan: unknown
    force?: boolean
    project_id?: number
  }) => api.put(`/episodes/${episodeId}/edit/draft`, body),
  discardDraft: (episodeId: number, projectId?: number) =>
    api.del(`/episodes/${episodeId}/edit/draft${projectId ? `?project_id=${projectId}` : ''}`),
  revisions: (episodeId: number, projectId?: number) =>
    api.get(`/episodes/${episodeId}/edit/revisions${projectId ? `?project_id=${projectId}` : ''}`),
  revision: (episodeId: number, revisionId: number, projectId?: number) =>
    api.get(`/episodes/${episodeId}/edit/revisions/${revisionId}${projectId ? `?project_id=${projectId}` : ''}`),
  createRevision: (episodeId: number, body: {
    base_version: number
    note?: string
    plan?: unknown
    update_draft?: boolean
    project_id?: number
  }) => api.post(`/episodes/${episodeId}/edit/revisions`, body),
  restoreRevision: (episodeId: number, revisionId: number, body: { base_version: number; project_id?: number }) =>
    api.post(`/episodes/${episodeId}/edit/revisions/${revisionId}/restore`, body),
  roughCut: (episodeId: number, body: {
    mode: 'replace' | 'append'
    plan: unknown
    create_revision?: boolean
    base_version?: number
    project_id?: number
  }) => api.post(`/episodes/${episodeId}/edit/rough-cut`, body),
  suggestSubtitles: (episodeId: number, body: {
    mode: 'fill' | 'replace'
    plan: unknown
    project_id?: number
  }) => api.post(`/episodes/${episodeId}/edit/subtitles/suggest`, body),
  // 帧操作（Task 19）：抽帧 body 为 { project_id?, clip_id, offset_ms }，返回 { url, width, height, fingerprint }
  extractFrame(episodeId: number, body: {
    project_id?: number
    clip_id: string
    offset_ms: number
  }) {
    return api.post(`/episodes/${episodeId}/edit/frames`, body)
  },
  // 图片素材上传（Task 19，multipart 走既有 uploadForm 封装），返回 { url, width, height, fingerprint }
  uploadImage(episodeId: number, file: File) {
    return uploadForm(`/episodes/${episodeId}/edit/assets/images`, file)
  },
  // 视频素材上传：后端落入项目 edit/assets 并返回可直接插入时间线的 source
  uploadVideo(episodeId: number, file: File) {
    return uploadForm<{ url: string; source: any }>(`/episodes/${episodeId}/edit/assets/videos`, file)
  },
  // 剪辑导出（Task 21）：返回 { export_id }；状态行字段与后端 getEditExportStatus 同构
  render(episodeId: number, body: {
    project_id?: number
    preset: 'vertical-hd' | 'horizontal-hd' | 'vertical-high'
    subtitle_mode: 'burn' | 'soft' | 'none'
    set_current?: boolean
    base_version: number
  }) {
    return api.post(`/episodes/${episodeId}/edit/render`, body)
  },
  renderStatus(episodeId: number, exportId: number) {
    return api.get(`/episodes/${episodeId}/edit/render/${exportId}`)
  },
  // 时间线音频轨波形：按片段源地址查询 4 级 peaks（后端复用全局 peaks 缓存）
  audioPeaks(episodeId: number, url: string) {
    return api.get(`/episodes/${episodeId}/edit/audio-peaks?url=${encodeURIComponent(url)}`)
  },
}

// 全自动流水线：改写 → 提取 → 资产生图 → 分镜 → 视频提示词 → 视频
export const automationAPI = {
  status: (episodeId: number) => api.get(`/episodes/${episodeId}/automation`),
  start: (episodeId: number, opts?: { model?: string; configId?: number }) =>
    api.post(`/episodes/${episodeId}/automation`, { model: opts?.model || undefined, config_id: opts?.configId || undefined }),
  stop: (episodeId: number) => api.post(`/episodes/${episodeId}/automation/stop`),
}

// 流水线任务规则（设置页「流程规则」）
export const pipelineRuleAPI = {
  list: () => api.get('/pipeline-rules'),
  save: (key: string, rule: string) => api.put(`/pipeline-rules/${key}`, { rule }),
  reset: (key: string) => api.post(`/pipeline-rules/${key}/reset`),
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  del: (id: number) => api.del(`/storyboards/${id}`),
}

export const characterAPI = {
  uploadVoice: (id: number, file: File) => uploadReq<CharacterVoice>(`/characters/${id}/voice`, file),
  removeVoice: (id: number) => api.del<CharacterVoice>(`/characters/${id}/voice`),
  create: (data: any) => api.post('/characters', data),
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  del: (id: number) => api.del(`/characters/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/characters/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, referenceImages?: string[]) => api.post(`/characters/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, reference_images: referenceImages?.length ? referenceImages : undefined }),
  batchImages: (ids: number[], episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post('/characters/batch-generate-images', { character_ids: ids, episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
}

export interface CharacterVoice {
  voice_audio_url: string | null
  voice_audio_name: string | null
}

/** V2 音色档案（character_voices 一行） */
export interface VoiceProfile {
  id: number
  dramaId: number
  characterId: number | null
  scope: 'character' | 'narrator'
  name: string
  source: 'design' | 'clone' | 'upload' | 'preset'
  voicePrompt: string | null
  designInstruct: string | null
  sampleUrl: string | null
  sampleText: string | null
  externalVoiceId: string | null
  status: 'draft' | 'pending_model' | 'generating' | 'ready' | 'failed'
  isActive: boolean
  error?: string | null
  speed?: number | null
  emotion?: string | null
  gender?: string | null
  ageRange?: string | null
  pitch?: string | null
  language?: string | null
  seed?: number | null
  createdAt?: string
  updatedAt?: string
}

export interface VoiceSample {
  id: number
  voiceId: number
  dramaId: number
  kind: 'audition' | 'speech' | 'clone_test'
  text: string
  textSource: 'default' | 'custom' | 'line'
  seed: number | null
  provider: string | null
  model: string | null
  paramsJson: string | null
  audioUrl: string | null
  durationMs: number | null
  hash: string | null
  status: 'generating' | 'ready' | 'failed'
  error?: string | null
  createdAt: string
}

export interface VoiceAuditionMeta {
  items: VoiceSample[]
  text: string
  text_source: 'default' | 'custom' | 'line'
  seed: number | null
  max_chars: number
  max_speech_chars: number
  channel: { provider: string | null; model: string | null }
}

export interface TtsCapabilities {
  provider: string
  model: string | null
  voicePrompt: boolean
  designInstruct: boolean
  emotion: boolean
  speed: boolean
  seed: boolean
  refAudio: boolean
  maxInputChars: number
  maxAuditionChars: number
  maxSpeechChars: number
  ignored: string[]
  note: string | null
}

export interface VoiceProfileList {
  character_id: number
  character_name: string
  active_voice_id: number | null
  voices: VoiceProfile[]
}

export const voiceProfileAPI = {
  list: (dramaId: number) => api.get<{ characters: VoiceProfileList[]; narrator: VoiceProfile[] }>(`/voices?drama_id=${dramaId}`),
  character: (id: number) => api.get<VoiceProfileList>(`/characters/${id}/voice-profile`),
  generate: (id: number, opts?: { force?: boolean; episode_id?: number; model?: string; config_id?: number }) =>
    api.post<{ profile: any; voice: VoiceProfile | null }>(`/characters/${id}/voice-profile`, opts || {}),
  update: (id: number, data: Record<string, any>) => api.put<VoiceProfile>(`/characters/${id}/voice-profile`, data),
  updateById: (voiceId: number, data: Record<string, any>) => api.put<VoiceProfile>(`/voices/${voiceId}`, data),
  sampleById: (voiceId: number, body: { text?: string; seed?: number } = {}) =>
    api.post<{ sample_url: string; duration_ms: number }>(`/voices/${voiceId}/sample`, body),
  activateById: (voiceId: number, characterId?: number) =>
    api.post(`/voices/${voiceId}/activate`, characterId ? { character_id: characterId } : {}),
  removeById: (voiceId: number) => api.del<{ deleted: boolean }>(`/voices/${voiceId}`),
  activate: (characterId: number, voiceId: number) =>
    api.post(`/characters/${characterId}/voice-profile/activate`, { voice_id: voiceId }),
  deactivate: (id: number) => api.del(`/characters/${id}/voice-profile`),
  sample: (characterId: number, body: { text?: string; voice_id?: number; seed?: number }) =>
    api.post<{ sample_url: string; duration_ms: number }>(`/characters/${characterId}/voice-sample`, body),
  clone: (characterId: number, file: File, opts: { refText?: string; xVectorOnly?: boolean } = {}) =>
    uploadForm<VoiceProfile>(`/characters/${characterId}/voice-clone`, file, {
      consent_confirmed: '1',
      ...(opts.refText ? { ref_text: opts.refText } : {}),
      ...(opts.xVectorOnly ? { x_vector_only: 'true' } : {}),
    }),
  sync: (characterId: number, voiceId: number) =>
    api.post<{ voice_audio_url: string }>(`/characters/${characterId}/voice-sync`, { voice_id: voiceId }),
  auditions: (voiceId: number, episodeId?: number | null) =>
    api.get<VoiceAuditionMeta>(`/voices/${voiceId}/auditions${episodeId ? `?episode_id=${episodeId}` : ''}`),
  generateAudition: (voiceId: number, body: { text?: string; seed?: number | null; text_source?: string; episode_id?: number | null; set_sample?: boolean }) =>
    api.post<{ sample: VoiceSample; text: string; text_source: string; seed: number; truncated: boolean; cached: boolean }>(`/voices/${voiceId}/auditions`, body),
  setSample: (voiceId: number, sampleId: number) =>
    api.post<VoiceProfile>(`/voices/${voiceId}/auditions/${sampleId}/set-sample`, {}),
  removeSample: (voiceId: number, sampleId: number) =>
    api.del<{ deleted: boolean }>(`/voices/${voiceId}/auditions/${sampleId}`),
  speech: (voiceId: number, body: { text: string; seed?: number | null; params?: Record<string, any> }) =>
    api.post<{ sample: VoiceSample; text: string; seed: number; cached: boolean }>(`/voices/${voiceId}/speech`, body),
  applyLines: (voiceId: number, body: { episode_id: number; line_ids: number[] }) =>
    api.post<{ updated: number }>(`/voices/${voiceId}/apply-lines`, body),
  design: (voiceId: number, body: { episode_id?: number | null; model?: string; config_id?: number } = {}) =>
    api.post<VoiceProfile>(`/voices/${voiceId}/design`, body),
  capabilities: () => api.get<TtsCapabilities>('/tts/capabilities'),
  cloneTo: (voiceId: number, target: { character_id?: number; scope?: 'character' | 'narrator'; activate?: boolean; name?: string }) =>
    api.post<VoiceProfile>(`/voices/${voiceId}/clone`, target),
  narrator: {
    get: (dramaId: number) => api.get<VoiceProfile | null>(`/voices/narrator?drama_id=${dramaId}`),
    generate: (dramaId: number, force = false) => api.post<VoiceProfile>('/voices/narrator', { drama_id: dramaId, force }),
    bind: (dramaId: number, voiceId: number | null) => api.put('/voices/narrator', { drama_id: dramaId, voice_id: voiceId }),
    sample: (dramaId: number, text?: string) => api.post<{ sample_url: string; duration_ms: number }>('/voices/narrator/sample', { drama_id: dramaId, text }),
  },
}

async function uploadForm<T = any>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {  const fd = new FormData()
  fd.append('file', file)
  for (const [key, value] of Object.entries(fields)) fd.append(key, value)
  const resp = await fetch(`${BASE}${path}`, { method: 'POST', body: fd })
  const json = await resp.json()
  if (!resp.ok || (json.code && json.code >= 400)) throw new Error(json.message || `${resp.status}`)
  return json.data ?? json
}

export interface StoryboardLine {
  id: number
  storyboardId: number | null
  storyboardNumber?: number | null
  lineNo: number
  speakerType: 'dialogue' | 'narration' | 'inner'
  speakerName: string | null
  characterId: number | null
  characterName?: string | null
  text: string
  subtitleText?: string | null
  speakText?: string | null
  speed: number | null
  direction?: string | null
  anchorType?: 'shot' | 'absolute'
  sortOrder?: number
  originKey?: string | null
  textRevision?: number
  audioStale?: boolean
  voiceLocked?: boolean
  activeTakeId?: number | null
  deletedAt?: string | null
  status: 'pending' | 'ready' | 'failed' | string
  plannedStartMs?: number | null
  overflowMs: number | null
  needsReview: boolean
  stale: boolean
  locked: boolean
  audioUrl: string | null
  audioDurationMs: number | null
  voiceId?: number | null
  error?: string | null
}

export interface ContextLine {
  speaker: string
  text: string
  emotion: string | null
}

export interface LineContext {
  episodeId: number
  lineId: number
  mode: 'off' | 'light' | 'deep'
  scene: {
    storyboardId: number | null
    shotNumber: number | null
    shotSummary: string | null
    durationMs: number | null
  }
  previous: ContextLine[]
  current: ContextLine & { direction: string | null }
  next: ContextLine[]
  arc: string | null
  pronunciation: Record<string, string>
}

export interface PerformanceParams {
  emotion: string | null
  speed: number
  instruct: string | null
  pause_hints: { after: string; ms: number }[]
  pronunciation: Record<string, string>
  notes: string | null
}

export interface LineTake {
  id: number
  lineId: number
  takeNo: number
  text: string
  speakText: string | null
  textRevision: number | null
  voiceId: number | null
  voiceFingerprint: string | null
  provider: string | null
  model: string | null
  configId: number | null
  params: Record<string, any>
  seed: number | null
  ignored: string[]
  contextMode: 'off' | 'light' | 'deep'
  context: LineContext | null
  contextHash: string | null
  audioUrl: string | null
  durationMs: number | null
  hash: string | null
  status: 'generating' | 'ready' | 'failed' | string
  error: string | null
  isActive: boolean
  createdAt: string
}

export interface LineContextPreview {
  context: LineContext
  params: PerformanceParams
  source: 'light' | 'deep' | 'fallback' | string
  error?: string
  capability: TtsCapabilities
  ignored: string[]
}

export interface TakeBatchJob {
  id: string
  episodeId: number
  status: 'running' | 'done' | 'failed' | 'cancelled'
  total: number
  done: number
  ok: number
  failed: number
  skipped: number
  currentLineId: number | null
  errors: { lineId: number; message: string }[]
  cancelRequested: boolean
  startedAt: string
  finishedAt: string | null
}

export interface TakeStatus {
  total: number
  ready: number
  pending: number
  failed: number
  stale: number
  takes: number
}

export interface TakeGenerateResult {
  take: LineTake
  line: StoryboardLine
  cached: boolean
  context: LineContext
  params: PerformanceParams
  source: string
}

export type MergeKind = 'added' | 'updated' | 'removed' | 'kept' | 'tombstoned'

export interface MergeItem {
  kind: MergeKind
  lineId: number | null
  text: string
  previousText: string | null
  speakerType: string
  speakerName: string | null
  characterId: number | null
  originKey: string
  lineNo: number
  order: number
  plannedStartMs: number | null
  plannedEndMs: number | null
  needsReview: boolean
  stale: boolean
}

export interface MergeGroup {
  storyboardId: number
  storyboardNumber: number
  skipped: boolean
  sourceHash: string
  added: MergeItem[]
  updated: MergeItem[]
  removed: MergeItem[]
  kept: MergeItem[]
  tombstoned: MergeItem[]
}

export interface MergePlan {
  extractionId: string
  episodeId: number
  createdAt: string
  groups: MergeGroup[]
  summary: {
    added: number
    updated: number
    removed: number
    kept: number
    tombstoned: number
    skipped: number
  }
}

export interface MergeDecision {
  storyboardId: number
  kind: MergeKind
  lineId?: number | null
  text?: string
  action: 'apply' | 'skip'
}

export interface MergeResult {
  inserted: number
  updated: number
  removed: number
  kept: number
  tombstoned: number
  skipped: number
}

export interface TimelineCue {
  lineId: number
  shotId: number | null
  startMs: number
  endMs: number
  subtitleStartMs: number
  subtitleEndMs: number
  text: string
  speaker: string
  kind: 'dialogue' | 'narration' | 'inner'
  speed: number
  overflowMs: number
  overlap: boolean
  trimmed: boolean
  audioDurationMs: number
  audioUrl: string | null
}

export interface TimelineResult {
  cues: TimelineCue[]
  totalDurationMs: number
  maxOverflowMs: number
  overlapCount: number
  atempoCount: number
  trimmedCount: number
  skippedLineIds: number[]
}

export interface DubbingDefaults {
  subtitleMode: 'soft' | 'burn' | 'none'
  subtitleFontSize: number | null
  subtitleMargin: number | null
  narratorPrefix: boolean
  originalAudio: 'duck' | 'keep' | 'mute'
  duckingRatio: number
  targetLufs: number
  bgmVolume: number
  autoPromptVoices: boolean
  autoPreviewVoices: boolean
  voiceLanguage: '' | 'zh' | 'en' | 'ja' | 'ko'
  voiceSpeed: number
  autoDubForNewEpisodes: boolean
  videoAudioModeForNewEpisodes: 'auto' | 'native' | 'ambient' | 'silent'
}

export type NovelStageKey = 'architecture' | 'blueprint' | 'chapter' | 'finalize' | 'enrich' | 'compass'

export interface NovelSettings {
  textConfigId: number | null
  stageModels: Partial<Record<NovelStageKey, number>>
  temperature: number
  maxTokens: number
  timeout: number
  autosaveMs: number
  importTargetWords: number
  importIncludeDraft: boolean
  importAutoExtract: boolean
  defaultAspectRatio: '16:9' | '9:16'
  promptVersion: string
}

export type FfmpegSource = 'custom' | 'env' | 'static' | 'path' | 'none'

export interface FfmpegBinaryStatus {
  path: string | null
  source: FfmpegSource
  available: boolean
  version: string | null
}

export interface FfmpegStatus {
  ffmpegDir: string
  ffmpeg: FfmpegBinaryStatus
  ffprobe: FfmpegBinaryStatus
}

export interface MediaSettingsPayload {
  settings: { ffmpegDir: string }
  status: FfmpegStatus
}

export interface DubState {
  status: 'idle' | 'running' | 'done' | 'failed' | 'stopped'
  progress: number
  note: string
  outputUrl?: string
  subtitleUrl?: string
  error?: string
}

export type AudioTrackKind = 'ambience' | 'sfx' | 'bgm' | 'voice' | 'custom'

export interface EpisodeAudioClip {
  id: number
  trackId: number
  episodeId: number
  startMs: number
  endMs: number
  sourceStartMs: number
  fadeInMs: number
  fadeOutMs: number
  sourceUrl: string | null
  audioUrl: string | null
  text: string | null
  voiceId: number | null
  lineId: number | null
  status: string
  error: string | null
}

export interface EpisodeAudioTrack {
  id: number
  episodeId: number
  dramaId: number
  kind: AudioTrackKind
  name: string
  volume: number
  muted: boolean
  solo: boolean
  ducking: boolean
  loop: boolean
  sortOrder: number
  clips: EpisodeAudioClip[]
}

/* ---------- V3 · 阶段 4：原声分离与混音计划 ---------- */

export type MixBusKey = 'dialogue' | 'original' | 'sfx' | 'bgm' | 'master'

export interface MixBus {
  id: number
  key: MixBusKey
  name: string
  volume: number
  muted: boolean
  solo: boolean
  effectiveMuted: boolean
  ducking: boolean
  duckRatio: number
  duckAttackMs: number
  duckReleaseMs: number
  lufsTarget: number | null
  limiterCeiling: number | null
}

export interface MixClip {
  id: number | null
  assetId: number | null
  takeId: number | null
  lineId: number | null
  name: string | null
  startMs: number
  endMs: number
  sourceStartMs: number
  gainDb: number
  pan: number
  fadeInMs: number
  fadeOutMs: number
  fadeCurve: string
  loop: boolean
  muted: boolean
  locked: boolean
  audioUrl: string | null
  usable: boolean
  reason: string | null
}

export interface MixTrack {
  id: number | null
  role: string
  name: string
  busId: MixBusKey
  virtual: boolean
  volume: number
  pan: number
  muted: boolean
  solo: boolean
  effectiveMuted: boolean
  ducking: boolean
  locked: boolean
  hidden: boolean
  loop: boolean
  color: string | null
  height: number
  sortOrder: number
  origin: string | null
  stemAssetId: number | null
  clips: MixClip[]
}

export interface MixPlan {
  version: 1
  episodeId: number
  durationMs: number
  sampleRate: number
  buses: MixBus[]
  tracks: MixTrack[]
  master: { lufs: number; truePeak: number; limiter: string }
}

/** 混音源成片快照（与后端 MixPlanSource 镜像，Task 7 mix-source.ts） */
export interface MixSourceSnapshot {
  filmId: number
  kind: 'concat' | 'mix' | 'edit' | 'import'
  url: string
  durationMs: number
  hasAudio: boolean
  containsDialogue: boolean
  containsBgm: boolean
}

export interface MixSourceWarning {
  code: string
  message: string
}

/** 混音计划响应携带的源成片与警告（GET /mix、PUT /mix/source） */
export type MixPlanWithSource = MixPlan & {
  source_film: MixSourceSnapshot | null
  source_warnings: MixSourceWarning[]
}

/** 从混音移除的台词（虚拟对白轨不再生成对应片段） */
export interface MixExcludedLine {
  lineId: number
  lineNo: number
  text: string
  speaker: string
  lineDeleted: boolean
}

export type SoundscapeCategory = 'ambience' | 'sfx' | 'crowd' | 'bgm'
export type SoundscapeMode = 'scenes' | 'episode-bed' | 'assets-only'
export type SoundscapeCrowdMode = 'walla' | 'lines'

export interface SoundscapeOverride {
  itemId: string
  prompt?: string
  negativePrompt?: string
  seconds?: number
}

export interface SoundscapeRequest {
  mode: SoundscapeMode
  categories: SoundscapeCategory[]
  crowdMode: SoundscapeCrowdMode
  sceneIds?: number[]
  overwrite?: boolean
  overrides?: SoundscapeOverride[]
  categoryHints?: Partial<Record<SoundscapeCategory, string>>
  configId?: number
}

export interface SoundscapeItem {
  itemId: string
  category: SoundscapeCategory
  source: 'generate' | 'lines'
  sceneId: number | null
  storyboardId: number | null
  startMs: number
  endMs: number
  seconds: number
  loop: boolean
  prompt: string
  negativePrompt: string | null
  degraded: boolean
  cached: boolean
}

export interface SoundscapePreview {
  mode: SoundscapeMode
  items: SoundscapeItem[]
  warnings: string[]
  counts: { total: number; generate: number; lines: number; cached: number }
  estimatedSeconds: number
  degraded: boolean
  model: string
  workflowHash: string
  normalizeLoudness: boolean
}

export interface SoundscapeStatus {
  jobId: number | null
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  step: string | null
  error: string | null
  counts: { total: number; done: number; failed: number; reused: number; clips: number }
  warnings: string[]
  startedAt: string | null
  finishedAt: string | null
}

export interface SoundscapeStart {
  jobId: number
  status: 'running'
}

export interface EpisodeAudioAsset {
  id: number
  episodeId: number
  dramaId: number
  kind: string
  sourceHash: string | null
  url: string | null
  durationMs: number | null
  sampleRate: number | null
  channels: number | null
  engine: string | null
  model: string | null
  modelLicense: string | null
  confidence: number | null
  status: string | null
  error: string | null
  metadataJson: string | null
  createdAt: string
  deletedAt: string | null
}

export interface SeparationStatus {
  jobId: number | null
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'
  progress: number
  step: string | null
  error: string | null
  engine: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface SeparationStart {
  jobId: number | null
  status: 'running' | 'done'
  reused: boolean
}

export interface MixRevision {
  id: number
  episodeId: number
  revisionNo: number
  planJson: string
  planHash: string | null
  note: string | null
  isCurrent: boolean
  createdAt: string
}

export interface PeaksPayload {
  assetId?: number
  takeId?: number
  sampleId?: number
  sampleRate: number
  durationMs: number
  levels: { spp: number; peaks: [number, number][] }[]
}

export interface MixPreviewResult {
  url: string
  startMs: number
  endMs: number
  durationMs: number
  planHash: string
  cached: boolean
}

export interface MixRenderResult {
  url: string
  outputPath: string
  format: 'wav' | 'm4a'
  durationMs: number
  planHash: string
}

/** 多轨混音（V3 · C）：环境声/音效/语音轨 + 时间段试听 */
export const audioTrackAPI = {
  list: (episodeId: number) => api.get<{ items: EpisodeAudioTrack[] }>(`/episodes/${episodeId}/audio/tracks`),
  create: (episodeId: number, data: { kind: AudioTrackKind; name?: string; volume?: number; muted?: boolean; solo?: boolean; ducking?: boolean; loop?: boolean }) =>
    api.post<EpisodeAudioTrack>(`/episodes/${episodeId}/audio/tracks`, data),
  update: (episodeId: number, trackId: number, data: Partial<Pick<EpisodeAudioTrack, 'kind' | 'name' | 'volume' | 'muted' | 'solo' | 'ducking' | 'loop' | 'sortOrder'>>) =>
    api.put<EpisodeAudioTrack>(`/episodes/${episodeId}/audio/tracks/${trackId}`, data),
  remove: (episodeId: number, trackId: number) => api.del(`/episodes/${episodeId}/audio/tracks/${trackId}`),
  addClip: (episodeId: number, trackId: number, data: { audio_url: string; start_ms: number; end_ms: number; source_start_ms?: number; fade_in_ms?: number; fade_out_ms?: number; text?: string }) =>
    api.post<EpisodeAudioClip>(`/episodes/${episodeId}/audio/tracks/${trackId}/clips`, data),
  updateClip: (episodeId: number, clipId: number, data: { audio_url?: string; start_ms?: number; end_ms?: number; source_start_ms?: number; fade_in_ms?: number; fade_out_ms?: number; text?: string }) =>
    api.put<EpisodeAudioClip>(`/episodes/${episodeId}/audio/clips/${clipId}`, data),
  removeClip: (episodeId: number, clipId: number) => api.del(`/episodes/${episodeId}/audio/clips/${clipId}`),
  voiceClip: (episodeId: number, data: { text: string; voice_id?: string | number | null; character_id?: number | null; start_ms: number; duration_ms?: number | null; line_id?: number | null }) =>
    api.post<{ track: EpisodeAudioTrack; clip: EpisodeAudioClip; cached: boolean }>(`/episodes/${episodeId}/audio/voice-clips`, data),
  preview: (episodeId: number, data: { start_ms: number; end_ms: number; bgm_url?: string | null; bgm_volume?: number; original_audio?: 'keep' | 'duck' | 'mute'; target_lufs?: number; ducking_ratio?: number }) =>
    api.post<{ url: string; startMs: number; endMs: number; durationMs: number; hasBgm: boolean; trackCount: number; soloActive: boolean }>(`/episodes/${episodeId}/audio/preview`, data),
  summary: (episodeId: number) => api.get<{ count: number; solo_active: boolean; signature: string; tracks: { id: number; kind: string; name: string; volume: number; muted: boolean; clips: number }[] }>(`/episodes/${episodeId}/audio/summary`),
}

/** 原声分离、素材、波形与 MixPlan（V3 · 阶段 4） */
export const mixAPI = {
  separate: (
    episodeId: number,
    data: { engine?: 'uvr' | 'demucs' | 'basic'; model?: string; diarization?: boolean; force?: boolean } = {},
  ) => api.post<SeparationStart>(`/episodes/${episodeId}/audio/separate`, data),
  separationStatus: (episodeId: number) =>
    api.get<SeparationStatus>(`/episodes/${episodeId}/audio/separate/status`),
  cancelSeparation: (episodeId: number) =>
    api.post<{ cancelled: boolean }>(`/episodes/${episodeId}/audio/separate/cancel`),
  assets: (episodeId: number) =>
    api.get<{ items: EpisodeAudioAsset[] }>(`/episodes/${episodeId}/audio/assets`),
  importAudioAsset: (episodeId: number, file: File) =>
    uploadForm<{ asset: EpisodeAudioAsset }>(`/episodes/${episodeId}/audio/assets/import`, file),
  removeAsset: (episodeId: number, assetId: number) =>
    api.del<{ deleted: boolean }>(`/episodes/${episodeId}/audio/assets/${assetId}`),
  autoTracks: (episodeId: number, assetId: number) =>
    api.post<{ tracks: EpisodeAudioTrack[]; clips: EpisodeAudioClip[] }>(`/episodes/${episodeId}/audio/assets/${assetId}/tracks`),
  getPlan: (episodeId: number) => api.get<MixPlan>(`/episodes/${episodeId}/mix`),
  /** GET /mix 支持 ?source_film_id= 预览指定源成片（不写持久化），响应带 source_film / source_warnings */
  plan: (episodeId: number, sourceFilmId?: number | null) =>
    api.get<MixPlan & {
      source_film: MixSourceSnapshot | null
      source_warnings: MixSourceWarning[]
    }>(`/episodes/${episodeId}/mix${sourceFilmId ? `?source_film_id=${sourceFilmId}` : ''}`),
  setSource: (episodeId: number, filmId: number) =>
    api.put<MixPlan & {
      source_film: MixSourceSnapshot | null
      source_warnings: MixSourceWarning[]
    }>(`/episodes/${episodeId}/mix/source`, { film_id: filmId }),
  savePlan: (
    episodeId: number,
    data: {
      buses?: Partial<MixBus>[]
      tracks?: any[]
      clips?: any[]
      virtualTracks?: Array<{
        role: string
        volume?: number
        pan?: number
        muted?: boolean
        solo?: boolean
        loop?: boolean
      }>
    },
  ) => api.put<MixPlan>(`/episodes/${episodeId}/mix`, data),
  buses: (episodeId: number) =>
    api.get<{ items: MixBus[] }>(`/episodes/${episodeId}/mix/buses`),
  saveBuses: (episodeId: number, buses: Partial<MixBus>[]) =>
    api.put<{ items: MixBus[] }>(`/episodes/${episodeId}/mix/buses`, { buses }),
  revisions: (episodeId: number) =>
    api.get<{ items: MixRevision[] }>(`/episodes/${episodeId}/mix/revisions`),
  saveRevision: (episodeId: number, note?: string) =>
    api.post<MixRevision>(`/episodes/${episodeId}/mix/revisions`, { note }),
  restoreRevision: (episodeId: number, revisionId: number) =>
    api.post<{ revision: MixRevision; plan: MixPlan }>(`/episodes/${episodeId}/mix/revisions/${revisionId}/restore`),
  excludedLines: (episodeId: number) =>
    api.get<{ items: MixExcludedLine[] }>(`/episodes/${episodeId}/mix/lines/excluded`),
  excludeLine: (episodeId: number, lineId: number) =>
    api.del<{ items: MixExcludedLine[]; plan: MixPlan }>(`/episodes/${episodeId}/mix/lines/${lineId}`),
  restoreLine: (episodeId: number, lineId: number) =>
    api.post<{ items: MixExcludedLine[]; plan: MixPlan }>(`/episodes/${episodeId}/mix/lines/${lineId}/restore`),
  preview: (episodeId: number, data: { start_ms: number; end_ms: number }) =>
    api.post<MixPreviewResult>(`/episodes/${episodeId}/mix/preview`, data),
  render: (episodeId: number, data: { format?: 'wav' | 'm4a' } = {}) =>
    api.post<MixRenderResult>(`/episodes/${episodeId}/mix/render`, data),
  previewSoundscape: (episodeId: number, data: SoundscapeRequest) =>
    api.post<SoundscapePreview>(`/episodes/${episodeId}/audio/soundscape/preview`, data),
  startSoundscape: (episodeId: number, data: SoundscapeRequest) =>
    api.post<SoundscapeStart>(`/episodes/${episodeId}/audio/soundscape`, data),
  soundscapeStatus: (episodeId: number) =>
    api.get<SoundscapeStatus>(`/episodes/${episodeId}/audio/soundscape/status`),
  cancelSoundscape: (episodeId: number) =>
    api.post<{ status: 'cancelled' }>(`/episodes/${episodeId}/audio/soundscape/cancel`),
  peaks: (episodeId: number, source: { assetId?: number; takeId?: number; sampleId?: number }) => {
    const query = source.assetId ? `asset_id=${source.assetId}`
      : source.takeId ? `take_id=${source.takeId}`
        : source.sampleId ? `sample_id=${source.sampleId}`
          : ''
    if (!query) throw new Error('波形来源缺失')
    return api.get<PeaksPayload>(`/episodes/${episodeId}/audio/peaks?${query}`)
  },
}

export type ExportKind = 'mix' | 'video' | 'stems'
export type ExportSubtitleMode = 'soft' | 'burn' | 'none' | 'copy'
export type ExportStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ExportRecord {
  id: number
  episodeId: number
  kind: ExportKind
  preset: string | null
  paramsJson: string | null
  planRevisionId: number | null
  planHash: string | null
  sourceVideoHash: string | null
  subtitleHash: string | null
  status: ExportStatus | null
  progress: number | null
  error: string | null
  outputUrl: string | null
  durationMs: number | null
  sizeBytes: number | null
  lufs: number | null
  truePeak: number | null
  lra: number | null
  isCurrent: boolean | null
  createdAt: string
  finishedAt: string | null
  deletedAt: string | null
}

export interface ExportCheckItem {
  ok: boolean
  message: string
}

export interface ExportChecks {
  episodeId: number
  lines: ExportCheckItem & { total: number; ready: number }
  video: ExportCheckItem & { durationMs: number; clips: number }
  mix: ExportCheckItem & { durationMs: number; trackCount: number; planHash: string | null }
  subtitles: ExportCheckItem & { count: number }
  ffmpeg: ExportCheckItem
  disk: ExportCheckItem & { freeBytes: number | null; requiredBytes: number }
  mixReady: boolean
  videoReady: boolean
  stemsReady: boolean
}

/** 导出（V3 · 阶段 5）：检查、启动、记录、取消/重试/当前/删除 */
export const exportAPI = {
  checks: (episodeId: number) => api.get<ExportChecks>(`/episodes/${episodeId}/export-checks`),
  start: (
    episodeId: number,
    data: { kind?: ExportKind; preset?: string; subtitle_mode?: ExportSubtitleMode; source_film_id?: number; title?: string; set_current?: boolean } = {},
  ) => api.post<{ record: ExportRecord; reused: boolean }>(`/episodes/${episodeId}/exports`, data),
  list: (episodeId: number) => api.get<{ items: ExportRecord[] }>(`/episodes/${episodeId}/exports`),
  get: (id: number) => api.get<ExportRecord>(`/exports/${id}`),
  cancel: (id: number) => api.post<ExportRecord>(`/exports/${id}/cancel`),
  retry: (id: number) => api.post<ExportRecord>(`/exports/${id}/retry`),
  setCurrent: (id: number, episodeId?: number) =>
    api.post<ExportRecord>(`/exports/${id}/current`, episodeId ? { episode_id: episodeId } : {}),
  remove: (id: number) => api.del<ExportRecord>(`/exports/${id}`),
}

/** 成片（Film Hub · Phase B）：列表/详情/设当前/删除/重命名/投影重试 */
export interface FilmSummary {
  id: number
  title: string
  kind: 'concat' | 'mix' | 'edit' | 'import'
  origin: string
  url: string
  subtitle_url: string | null
  duration_ms: number
  duration_unknown: boolean
  created_at: string
  is_current: boolean
  source_merge_id: number | null
  export_id: number | null
  edit_revision_id: number | null
  mix_revision_id: number | null
  edit_project_id: number | null
}

export interface FilmListResult {
  episode_id: number
  current_film_id: number | null
  films: FilmSummary[]
}

export const filmAPI = {
  list(episodeId: number, limit = 50) {
    return api.get<FilmListResult>(`/episodes/${episodeId}/films?limit=${limit}`)
  },
  get(filmId: number) {
    return api.get<FilmSummary>(`/films/${filmId}`)
  },
  setCurrent(episodeId: number, filmId: number) {
    return api.post(`/episodes/${episodeId}/films/${filmId}/current`)
  },
  remove(filmId: number) {
    return api.del(`/films/${filmId}`)
  },
  rename(filmId: number, title: string) {
    return api.patch(`/films/${filmId}`, { title })
  },
  projectExport(episodeId: number, exportId: number) {
    return api.post<{ film_id: number }>(`/episodes/${episodeId}/exports/${exportId}/project-film`)
  },
}

export const dubbingAPI = {
  lines: (episodeId: number) => api.get<{ items: StoryboardLine[] }>(`/episodes/${episodeId}/lines`),
  extract: (episodeId: number, force = false) => api.post(`/episodes/${episodeId}/lines/extract?force=${force ? 1 : 0}`),
  extractPreview: (episodeId: number, options: { force?: boolean; storyboardIds?: number[] } = {}) =>
    api.post<MergePlan>(`/episodes/${episodeId}/lines/extract/preview`, {
      force: Boolean(options.force),
      ...(options.storyboardIds?.length ? { storyboard_ids: options.storyboardIds } : {}),
    }),
  extractApply: (episodeId: number, extractionId: string, decisions: MergeDecision[] = []) =>
    api.post<MergeResult>(`/episodes/${episodeId}/lines/extract/apply`, { extraction_id: extractionId, decisions }),
  lineStatus: (episodeId: number) => api.get(`/episodes/${episodeId}/lines/status`),
  synthesizeAll: (episodeId: number, force = false) => api.post(`/episodes/${episodeId}/lines/synthesize`, { force }),
  addLine: (episodeId: number, data: {
    text: string
    speaker_type?: string
    character_id?: number | null
    speaker_name?: string | null
    direction?: string | null
    anchor: { type: 'shot' | 'absolute'; storyboard_id?: number | null; start_ms?: number; after_line_id?: number | null }
  }) => api.post<StoryboardLine>(`/episodes/${episodeId}/lines`, data),
  reorderLines: (episodeId: number, ids: number[]) => api.post<{ updated: number }>(`/episodes/${episodeId}/lines/reorder`, { ids }),
  bindSpeaker: (episodeId: number, data: { speaker_name: string; character_id?: number | null }) =>
    api.post<{ character_id: number; bound: number }>(`/episodes/${episodeId}/lines/bind-speaker`, data),
  resetVoices: (episodeId: number, characterId?: number | null) =>
    api.post<{ cleared: number }>(`/episodes/${episodeId}/lines/reset-voices`, characterId ? { character_id: characterId } : {}),
  detachSpeaker: (episodeId: number, characterId: number) =>
    api.post<{ mode: 'unbound' | 'deleted'; character_id: number; cleared_lines: number }>(`/episodes/${episodeId}/lines/detach-speaker`, { character_id: characterId }),
  restoreLine: (lineId: number) => api.post<StoryboardLine>(`/lines/${lineId}/restore`),
  updateLine: (lineId: number, data: Record<string, any>) => api.put(`/lines/${lineId}`, data),
  synthesizeLine: (lineId: number) => api.post(`/lines/${lineId}/synthesize`),
  deleteLine: (lineId: number) => api.del(`/lines/${lineId}`),
  startDub: (episodeId: number, options: { subtitle_mode?: string; original_audio?: string; force?: boolean; bgm_url?: string | null; bgm_volume?: number; ducking_ratio?: number } = {}) =>
    api.post<{ job_id: number; state: DubState }>(`/episodes/${episodeId}/dub`, options),
  dubState: (episodeId: number) => api.get<DubState>(`/episodes/${episodeId}/dub`),
  stopDub: (episodeId: number) => api.post(`/episodes/${episodeId}/dub/stop`),
  subtitles: (episodeId: number, format: 'srt' | 'ass' = 'srt') => api.post<{ url: string; cues: number }>(`/episodes/${episodeId}/subtitles`, { format }),
  timeline: (episodeId: number) => api.get<TimelineResult>(`/episodes/${episodeId}/timeline`),
  motionPost: (episodeId: number, opts: { bgm_url?: string; set_as_video?: boolean } = {}) =>
    api.post<{ mergeId: number; url: string; durationMs: number; shots: number; subtitleUrl: string | null; subtitleAssUrl: string | null; withDialogue: boolean; hasBgm: boolean }>(`/episodes/${episodeId}/motion-post`, opts),
  setVersion: (episodeId: number, mergeId: number) =>
    api.post<{ video_url: string; kind: string }>(`/episodes/${episodeId}/video-version`, { merge_id: mergeId }),
  status: () => api.get<{ enabled: boolean }>('/dubbing/status'),
  setEnabled: (enabled: boolean) => api.put('/dubbing/enabled', { enabled }),
}

export interface TakeOverrides {
  emotion?: string | null
  speed?: number | null
  instruct?: string | null
  pause_hints?: { after: string; ms: number }[]
  pronunciation?: Record<string, string>
  notes?: string | null
  seed?: number | null
  note?: string | null
  language?: string | null
}

export const takeAPI = {
  list: (lineId: number) => api.get<{ items: LineTake[] }>(`/lines/${lineId}/takes`),
  generate: (lineId: number, body: {
    context_mode?: 'off' | 'light' | 'deep'
    overrides?: TakeOverrides
    voice_id?: number | null
    force?: boolean
    reuse?: boolean
    activate?: boolean
  } = {}) => api.post<TakeGenerateResult>(`/lines/${lineId}/takes`, body),
  activate: (takeId: number) => api.post<{ take: LineTake; line: StoryboardLine }>(`/takes/${takeId}/activate`),
  remove: (takeId: number) => api.del<{ lineId: number; fallbackTakeId: number | null }>(`/takes/${takeId}`),
  previewContext: (lineId: number, body: { mode?: 'off' | 'light' | 'deep'; overrides?: TakeOverrides } = {}) =>
    api.post<LineContextPreview>(`/lines/${lineId}/context/preview`, body),
  batch: (episodeId: number, body: {
    line_ids?: number[] | null
    filter?: 'pending' | 'failed' | 'audio_stale' | 'all'
    context_mode?: 'off' | 'light' | 'deep'
    concurrency?: number
  } = {}) => api.post<{ job_id: string }>(`/episodes/${episodeId}/takes/batch`, body),
  batchStatus: (episodeId: number, jobId: string) =>
    api.get<TakeBatchJob>(`/episodes/${episodeId}/takes/batch/${jobId}`),
  cancelBatch: (episodeId: number, jobId: string) =>
    api.post<TakeBatchJob>(`/episodes/${episodeId}/takes/batch/${jobId}/cancel`),
  status: (episodeId: number) => api.get<TakeStatus>(`/episodes/${episodeId}/takes/status`),
}

/** 宫格图（V2 · M4-2）：一次生成多格，再切分/人工校正 */
export const gridAPI = {
  create: (d: { drama_id: number; episode_id?: number; kind: string; rows: number; cols: number; prompt?: string; targets?: string[]; model?: string; config_id?: number; inset?: number }) =>
    api.post<{ id: number; status: string; taskId: number | null }>('/grid', d),
  get: (id: number) => api.get<{ id: number; imageUrl: string | null; cells: any[]; status: string; taskId: number | null }>(`/grid/${id}`),
  split: (id: number, d: { inset?: number; cells?: any[] } = {}) => api.post<{ cells: { row: number; col: number; url: string }[] }>(`/grid/${id}/split`, d),
  updateCells: (id: number, cells: any[], inset?: number) => api.put(`/grid/${id}/cells`, { cells, inset }),
}

/** 整本剧本导入（V2 · M5-3） */
export const scriptImportAPI = {
  parseText: (dramaId: number, text: string, filename?: string) =>
    api.post<{ import_id: number; existing: boolean; chapter_count: number; chapters: { index: number; title: string; char_count: number }[]; plans: { title: string; char_count: number; chapters: number[] }[]; episode_count: number }>(`/dramas/${dramaId}/script/parse`, { text, filename }),
  parseFile: (dramaId: number, file: File) =>
    uploadForm<{ import_id: number; existing: boolean; chapter_count: number; chapters: { index: number; title: string; char_count: number }[]; plans: { title: string; char_count: number; chapters: number[] }[]; episode_count: number }>(`/dramas/${dramaId}/script/parse`, file),
  commit: (dramaId: number, d: { import_id: number; mode?: 'append' | 'replace'; chapter_indexes?: number[]; auto_pipeline?: boolean; auto_dub?: boolean; target_words?: number }) =>
    api.post<{ episodes: { id: number; episode_number: number; title: string }[]; importId: number; created: number; skipped: number; episode_ids: number[] }>(`/dramas/${dramaId}/script/commit`, d),
}

/** BGM 曲库（V2 · M4-4）：本地文件列表 / 上传 / 删除，单集选择写回 episodes.bgm_url */
export const bgmAPI = {
  list: () => api.get<{ items: { name: string; url: string; size: number; updated_at: string }[]; dir?: string }>('/bgm'),
  upload: (file: File) => uploadForm<{ name: string; url: string }>('/bgm/upload', file),
  remove: (name: string) => api.del(`/bgm/${encodeURIComponent(name)}`),
}

/** 持久化队列（V2 · M5-1/M5-2） */
export const jobsAPI = {
  list: (params: { status?: string; episode_id?: number; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.episode_id) q.set('episode_id', String(params.episode_id))
    if (params.limit) q.set('limit', String(params.limit))
    return api.get<{ items: any[] }>(`/jobs${q.size ? `?${q.toString()}` : ''}`)
  },
  stats: () => api.get<{ queued: number; running: number; done: number; failed: number; enabled: boolean; max_concurrent: number }>('/jobs/stats'),
  settings: () => api.get<{ enabled: boolean; max_concurrent: number }>('/jobs/settings'),
  saveSettings: (d: { enabled?: boolean; max_concurrent?: number }) => api.put('/jobs/settings', d),
  get: (id: number) => api.get(`/jobs/${id}`),
  retry: (id: number) => api.post(`/jobs/${id}/retry`),
  cancel: (id: number) => api.post(`/jobs/${id}/cancel`),
}

export const sceneAPI = {
  create: (data: any) => api.post('/scenes', data),
  update: (id: number, data: any) => api.put(`/scenes/${id}`, data),
  del: (id: number) => api.del(`/scenes/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/scenes/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, referenceImages?: string[]) => api.post(`/scenes/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, reference_images: referenceImages?.length ? referenceImages : undefined }),
}

export const propAPI = {
  create: (data: any) => api.post('/props', data),
  update: (id: number, data: any) => api.put(`/props/${id}`, data),
  del: (id: number) => api.del(`/props/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/props/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, referenceImages?: string[]) => api.post(`/props/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, reference_images: referenceImages?.length ? referenceImages : undefined }),
}

// 统一生成任务（图片/视频）：POST 带 type 字段，列表按 type 过滤
export const taskAPI = {
  generate: (d: any) => api.post('/tasks', d),
  recover: (id: number) => api.post(`/tasks/${id}/recover`),
  diagnostics: (id: number) => api.get(`/tasks/${id}/diagnostics`),
  get: (id: number) => api.get(`/tasks/${id}`),
  del: (id: number) => api.del(`/tasks/${id}`),
  list: (params?: { type?: 'image' | 'video'; drama_id?: number; storyboard_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.type) query.set('type', params.type)
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    return api.get(`/tasks${query.size ? `?${query.toString()}` : ''}`)
  },
  // 按集聚合生成任务（sys_task + video_merges）
  listByEpisode: (episodeId: number) => api.get<{ tasks: any[]; merges: any[] }>(`/episodes/${episodeId}/generation-tasks`),
  // 清空本集已完成/失败任务（保留进行中与成片）
  clearByEpisode: (episodeId: number) => api.del<{ deleted: number }>(`/episodes/${episodeId}/generation-tasks`),
}

async function uploadReq<T = any>(path: string, file: File, dramaId?: number): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  // 带项目时后端落到 static/projects/<id>/uploads，不带则走全局 uploads
  if (dramaId && Number.isSafeInteger(Number(dramaId))) fd.append('drama_id', String(dramaId))
  console.log(`%c[API] %cPOST %c${path} %c${file.name}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', 'color:#888')
  const resp = await fetch(`${BASE}${path}`, { method: 'POST', body: fd })
  const json = await resp.json()
  if (!resp.ok || (json.code && json.code >= 400)) {
    console.log(`%c[API] %cPOST ${path} %c${resp.status}`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold')
    throw new Error(json.message || `${resp.status}`)
  }
  return json.data ?? json
}

export const uploadAPI = {
  image: (f: File, dramaId?: number) => uploadReq<{ url: string; path: string }>('/upload/image', f, dramaId),
  video: (f: File, dramaId?: number) => uploadReq<{ url: string; path: string }>('/upload/video', f, dramaId),
  audio: (f: File, dramaId?: number) => uploadReq<{ url: string; path: string }>('/upload/audio', f, dramaId),
}
export const mergeAPI = {
  merge: (epId: number, storyboardIds?: number[], title?: string, useAiTransitions = false) => api.post(`/merge/episodes/${epId}/merge`, {
    ...(storyboardIds?.length ? { storyboard_ids: storyboardIds } : {}),
    ...(title?.trim() ? { title: title.trim() } : {}),
    ...(useAiTransitions ? { use_ai_transitions: true } : {}),
  }),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
  list: (epId: number) => api.get<any[]>(`/merge/episodes/${epId}/merges`),
  del: (id: number) => api.del(`/merge/merges/${id}`),
}
export const transitionAPI = {
  list: (epId: number, storyboardIds?: number[]) => api.get<any>(`/merge/episodes/${epId}/transitions${
    storyboardIds?.length ? `?storyboard_ids=${storyboardIds.join(',')}` : ''
  }`),
  prepare: (epId: number, payload: Record<string, any>) => api.post<any>(`/merge/episodes/${epId}/transitions/prepare`, payload),
  retry: (id: number, payload: Record<string, any> = {}) => api.post<any>(`/merge/transitions/${id}/retry`, payload),
  analyze: (id: number, payload: Record<string, any> = {}) => api.post<any>(`/merge/transitions/${id}/analyze`, payload),
  savePrompt: (id: number, prompt: string) => api.put<any>(`/merge/transitions/${id}/prompt`, { prompt }),
  skip: (id: number) => api.post<any>(`/merge/transitions/${id}/skip`, {}),
  del: (id: number) => api.del(`/merge/transitions/${id}`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
  comfyWorkflows: (d: { base_url: string; api_key?: string; kind?: string }) =>
    api.post<{ workflows: any[] }>('/ai-configs/comfyui/workflows', d),
}

// lang 缺省/为 zh 时读写基础版（不带 query，保持原请求形态）
const langQ = (lang?: string) => (lang && lang !== 'zh' ? `?lang=${lang}` : '')

export const promptAPI = {
  list: () => api.get('/prompts'),
  get: (type: string, lang?: string) => api.get(`/prompts/${type}${langQ(lang)}`),
  update: (type: string, d: any, lang?: string) => api.put(`/prompts/${type}${langQ(lang)}`, d),
  reset: (type: string, lang?: string) => api.post(`/prompts/${type}/reset${langQ(lang)}`),
}

export const skillsAPI = {
  list: (lang?: string) => api.get(`/skills${langQ(lang)}`),
  get: (id: string, lang?: string) => api.get(`/skills/${id}${langQ(lang)}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string, lang?: string) => api.put(`/skills/${id}${langQ(lang)}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const stylePresetAPI = {
  list: (all = false) => api.get(`/style-presets${all ? '?all=1' : ''}`),
  create: (d: any) => api.post('/style-presets', d),
  update: (id: number, d: any) => api.put(`/style-presets/${id}`, d),
  del: (id: number) => api.del(`/style-presets/${id}`),
  // 从参考图提炼风格：backend 落库并返回 { analysis, preset }
  analyze: (d: { images: string[]; config_id?: number; model?: string; language?: string; name?: string; description?: string; create?: boolean }) =>
    api.post('/style-presets/analyze', d),
}

export const storageAPI = {
  info: () => api.get('/storage'),
}

export const settingsAPI = {
  contentLanguage: () => api.get<{ language: string }>('/settings/content-language'),
  setContentLanguage: (language: string) => api.put('/settings/content-language', { language }),
  dubbing: () => api.get<{ defaults: DubbingDefaults }>('/settings/dubbing'),
  saveDubbing: (patch: Partial<DubbingDefaults>) => api.put<{ defaults: DubbingDefaults }>('/settings/dubbing', patch),
  novel: () => api.get<{ settings: NovelSettings }>('/settings/novel'),
  saveNovel: (patch: Partial<NovelSettings>) => api.put<{ settings: NovelSettings }>('/settings/novel', patch),
  media: () => api.get<MediaSettingsPayload>('/settings/media'),
  saveMedia: (ffmpegDir: string) => api.put<MediaSettingsPayload>('/settings/media', { ffmpegDir }),
}

// MCP 服务：开关、端口、访问 token
export const mcpAPI = {
  status: () => api.get('/mcp'),
  update: (data: { enabled?: boolean; port?: number }) => api.put('/mcp', data),
  rotateToken: () => api.post('/mcp/token'),
}

// 服务器/Docker 部署的版本检查与更新（桌面版走 useDesktopBridge，不用此 API）
export const serverUpdateAPI = {
  state: () => api.get('/server-update/state'),
  check: () => api.post('/server-update/check'),
  apply: () => api.post('/server-update/apply'),
}
