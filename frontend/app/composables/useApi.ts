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
      const error = new Error(json.message || `${resp.status}`) as Error & { status?: number; data?: any }
      error.status = resp.status || json.code
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
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  props: (id: number) => api.get(`/episodes/${id}/props`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
  extract: (id: number, target: string, model?: string, configId?: number) => api.post(`/episodes/${id}/extract`, { target, model: model || undefined, config_id: configId || undefined }),
  extractStatus: (id: number) => api.get(`/episodes/${id}/extract-status`),
  generateVideoPrompts: (id: number, model?: string, configId?: number, storyboardIds?: number[]) => api.post(`/episodes/${id}/generate-video-prompts`, { model: model || undefined, config_id: configId || undefined, storyboard_ids: storyboardIds?.length ? storyboardIds : undefined }),
  videoPromptsStatus: (id: number) => api.get(`/episodes/${id}/video-prompts-status`),
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
}

export interface VoiceProfileList {
  character_id: number
  character_name: string
  active_voice_id: number | null
  voices: VoiceProfile[]
}

export const voiceProfileAPI = {
  list: (dramaId: number) => api.get(`/voices?drama_id=${dramaId}`),
  character: (id: number) => api.get<VoiceProfileList>(`/characters/${id}/voice-profile`),
  generate: (id: number, opts?: { force?: boolean; episode_id?: number; model?: string; config_id?: number }) =>
    api.post<{ profile: any; voice: VoiceProfile | null }>(`/characters/${id}/voice-profile`, opts || {}),
  update: (id: number, data: Record<string, any>) => api.put<VoiceProfile>(`/characters/${id}/voice-profile`, data),
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
  storyboardId: number
  storyboardNumber?: number | null
  lineNo: number
  speakerType: 'dialogue' | 'narration' | 'inner'
  speakerName: string | null
  characterId: number | null
  text: string
  subtitleText?: string | null
  speakText?: string | null
  speed: number | null
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

export interface TimelineCue {
  lineId: number
  shotId: number
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

export interface DubState {
  status: 'idle' | 'running' | 'done' | 'failed' | 'stopped'
  progress: number
  note: string
  outputUrl?: string
  subtitleUrl?: string
  error?: string
}

export const dubbingAPI = {
  lines: (episodeId: number) => api.get<{ items: StoryboardLine[] }>(`/episodes/${episodeId}/lines`),
  extract: (episodeId: number, force = false) => api.post(`/episodes/${episodeId}/lines/extract?force=${force ? 1 : 0}`),
  lineStatus: (episodeId: number) => api.get(`/episodes/${episodeId}/lines/status`),
  synthesizeAll: (episodeId: number, force = false) => api.post(`/episodes/${episodeId}/lines/synthesize`, { force }),
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
  merge: (epId: number, storyboardIds?: number[], title?: string) => api.post(`/merge/episodes/${epId}/merge`, {
    ...(storyboardIds?.length ? { storyboard_ids: storyboardIds } : {}),
    ...(title?.trim() ? { title: title.trim() } : {}),
  }),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
  list: (epId: number) => api.get<any[]>(`/merge/episodes/${epId}/merges`),
  del: (id: number) => api.del(`/merge/merges/${id}`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
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
