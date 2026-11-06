/**
 * Drizzle schema - SQLite column mappings.
 * 自 MySQL 迁移：varchar(x)→text（SQLite 不校验长度）、int→integer、
 * boolean→integer boolean mode、时间戳仍为 text 存 ISO 字符串，表/列名不变。
 */
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core'

export const dramas = sqliteTable('dramas', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description'),
  genre: text('genre'),
  style: text('style').default('3d'),
  /** 项目背景（世界观/时代/地域/主线设定）：资产与剧本生成时自动拼接 */
  background: text('background'),
  /** 视觉背景（场景/光影/色彩等画面描述）：仅注入视频提示词，避免剧情梗概诱导旁白 */
  visualBackground: text('visual_background'),
  aspectRatio: text('aspect_ratio').default('16:9'),
  totalEpisodes: integer('total_episodes').default(1),
  totalDuration: integer('total_duration').default(0),
  status: text('status').notNull().default('draft'),
  thumbnail: text('thumbnail'),
  tags: text('tags'),
  metadata: text('metadata'),
  /** 项目媒体存储根目录（绝对路径）；null = 默认 DATA_ROOT/static/projects/<id> */
  storageDir: text('storage_dir'),
  /** 旁白音色（character_voices.id，V2） */
  narratorVoiceId: integer('narrator_voice_id'),
  /** 项目默认 BGM（V2） */
  bgmUrl: text('bgm_url'),
  /** 来源小说（V3） */
  sourceNovelId: integer('source_novel_id'),
  /** 故事圣经五件套 JSON（V3） */
  storyBible: text('story_bible'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const episodes = sqliteTable('episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeNumber: integer('episode_number').notNull(),
  title: text('title').notNull(),
  content: text('content'),
  scriptContent: text('script_content'),
  description: text('description'),
  duration: integer('duration').default(0),
  status: text('status').default('draft'),
  videoUrl: text('video_url'),
  thumbnail: text('thumbnail'),
  imageConfigId: integer('image_config_id'),
  videoConfigId: integer('video_config_id'),
  /** 视频制作模式：native 原生逐镜 / comfyui 整集工作流（V3-D） */
  videoMode: text('video_mode').default('native'),
  /** ComfyUI 视频配置（video_mode=comfyui 时使用）（V3-D） */
  comfyuiConfigId: integer('comfyui_config_id'),
  /** 本集 ComfyUI 工作流快照（JSON 字符串；null = 使用配置内工作流）（V3-D） */
  comfyuiWorkflowJson: text('comfyui_workflow_json'),
  resolution: text('resolution').default('720p'),
  /** 创建该集时是否选择了全自动流程（仅记录意图，进度看 automation_status） */
  autoPipeline: integer('auto_pipeline', { mode: 'boolean' }).default(false),
  /** 自动化状态：idle / running / done / failed / stopped / interrupted */
  automationStatus: text('automation_status'),
  /** 当前阶段：rewrite / extract / asset_images / storyboards / video_prompts / videos / done */
  automationStage: text('automation_stage'),
  /** 总体进度 0-100 */
  automationProgress: integer('automation_progress').default(0),
  /** 阶段内进度文案，如「角色 2/5」 */
  automationNote: text('automation_note'),
  automationError: text('automation_error'),
  automationStartedAt: text('automation_started_at'),
  automationFinishedAt: text('automation_finished_at'),
  /** 建集时是否同时生成配音（V2） */
  autoDub: integer('auto_dub', { mode: 'boolean' }).default(false),
  /** 配音状态：idle / running / done / failed / stopped */
  dubStatus: text('dub_status'),
  dubProgress: integer('dub_progress').default(0),
  dubNote: text('dub_note'),
  /** 最新字幕（SRT/ASS） */
  subtitleUrl: text('subtitle_url'),
  /** 原声策略：auto / native / ambient / silent（V2） */
  videoAudioMode: text('video_audio_mode').default('auto'),
  /** 单集 BGM */
  bgmUrl: text('bgm_url'),
  /** 当前混音计划版本（mix_revisions.id） */
  mixRevisionId: integer('mix_revision_id'),
  /** 虚拟轨（对白/原声/配乐）的混音覆盖 JSON */
  mixVirtualTracks: text('mix_virtual_tracks'),
  /** 最近一次台词抽取时间 */
  lastExtractAt: text('last_extract_at'),
  /** 当前剪辑版本（edit_revisions.id）；null 表示尚未建立剪辑版本 */
  editRevisionId: integer('edit_revision_id'),
  /** 当前剪辑计划哈希，用于混音桥快速比较 */
  editPlanHash: text('edit_plan_hash'),
  /** 时间/源素材同步哈希 */
  editSyncHash: text('edit_sync_hash'),
  /** 是否已纳入剪辑工作台（V3）；M1 只读不写 */
  editEnabled: integer('edit_enabled', { mode: 'boolean' }).default(false),
  /** 来源小说章节（V3） */
  sourceChapterNo: integer('source_chapter_no'),
  sourcePartNo: integer('source_part_no'),
  /** 原著已更新，剧本/分镜待重做（V3） */
  sourceStale: integer('source_stale', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const characters = sqliteTable('characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  role: text('role'),
  description: text('description'),
  appearance: text('appearance'),
  styling: text('styling'),
  finalPrompt: text('final_prompt'),
  personality: text('personality'),
  imageUrl: text('image_url'),
  voiceAudioUrl: text('voice_audio_url'),
  voiceAudioName: text('voice_audio_name'),
  /** 激活音色的只读缓存（V2）：以 character_voices 为准，这里仅供列表展示 */
  voicePrompt: text('voice_prompt'),
  voiceStatus: text('voice_status'),
  referenceImages: text('reference_images'),
  seedValue: text('seed_value'),
  sortOrder: integer('sort_order'),
  localPath: text('local_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

// Episode-Character many-to-many
export const episodeCharacters = sqliteTable('episode_characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  characterId: integer('character_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Episode-Scene many-to-many
export const episodeScenes = sqliteTable('episode_scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Episode-Prop many-to-many
export const episodeProps = sqliteTable('episode_props', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  propId: integer('prop_id').notNull(),
  createdAt: text('created_at').notNull(),
})

export const scenes = sqliteTable('scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeId: integer('episode_id'),
  location: text('location').notNull(),
  time: text('time').notNull(),
  prompt: text('prompt').notNull(),
  lighting: text('lighting'),
  finalPrompt: text('final_prompt'),
  storyboardCount: integer('storyboard_count').default(1),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  status: text('status').default('pending'),
  localPath: text('local_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const storyboards = sqliteTable('storyboards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id'),
  storyboardNumber: integer('storyboard_number').notNull(),
  title: text('title'),
  location: text('location'),
  time: text('time'),
  shotType: text('shot_type'),
  angle: text('angle'),
  movement: text('movement'),
  result: text('result'),
  atmosphere: text('atmosphere'),
  imagePrompt: text('image_prompt'),
  videoPrompt: text('video_prompt'),
  bgmPrompt: text('bgm_prompt'),
  soundEffect: text('sound_effect'),
  description: text('description'),
  /** 与上一镜的转场：cut / fade / dissolve / wipe */
  transition: text('transition').default('cut'),
  /** 承接上一镜的连续性说明（尾动作、视线、空间关系） */
  continuity: text('continuity'),
  duration: integer('duration').default(0),
  composedImage: text('composed_image'),
  firstFrameImage: text('first_frame_image'),
  lastFrameImage: text('last_frame_image'),
  referenceImages: text('reference_images'),
  videoUrl: text('video_url'),
  subtitleUrl: text('subtitle_url'),
  composedVideoUrl: text('composed_video_url'),
  status: text('status').default('pending'),
  /** 内容指纹：台词抽取幂等（V2） */
  sourceHash: text('source_hash'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const storyboardCharacters = sqliteTable('storyboard_characters', {
  storyboardId: integer('storyboard_id').notNull(),
  characterId: integer('character_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.storyboardId, table.characterId] }),
])

export const storyboardProps = sqliteTable('storyboard_props', {
  storyboardId: integer('storyboard_id').notNull(),
  propId: integer('prop_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.storyboardId, table.propId] }),
])

export const aiServiceConfigs = sqliteTable('ai_service_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceType: text('service_type').notNull(),
  provider: text('provider'),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull(),
  model: text('model'),
  endpoint: text('endpoint'),
  queryEndpoint: text('query_endpoint'),
  priority: integer('priority').default(0),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  settings: text('settings'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // 注意: 此表无 deleted_at
})

export const aiServiceProviders = sqliteTable('ai_service_providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  displayName: text('display_name'),
  serviceType: text('service_type').notNull(),
  provider: text('provider').notNull(),
  defaultUrl: text('default_url'),
  presetModels: text('preset_models'),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const stylePresets = sqliteTable('style_presets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  value: text('value').notNull(),
  prompt: text('prompt').notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').default(0),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // 注意: 此表无 deleted_at（硬删除），value 列有唯一索引（见 sqlite-schema.ts DDL）
})

// 统一生成任务表：图片/视频生成共用，type 区分，生成参数存 params(JSON)
export const sysTask = sqliteTable('sys_task', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  configId: integer('config_id'),
  configBaseUrl: text('config_base_url'),
  stage: text('stage'),
  errorCode: text('error_code'),
  type: text('type').notNull(), // image | video
  storyboardId: integer('storyboard_id'),
  /** AI 过渡任务指向 video_transitions.id；此时 storyboard_id 为空 */
  transitionId: integer('transition_id'),
  dramaId: integer('drama_id'),
  sceneId: integer('scene_id'),
  characterId: integer('character_id'),
  propId: integer('prop_id'),
  provider: text('provider'),
  prompt: text('prompt'),
  model: text('model'),
  // image: {size, frameType, referenceImages[]}
  // video: {referenceMode, firstFrameUrl, lastFrameUrl, referenceImageUrls[], referenceVideoUrls[], referenceAudioUrls[], referenceFileUrl, referenceLinkUrl, generateAudio, duration, aspectRatio, resolution, seed, promptExtend, watermark}
  params: text('params'),
  taskId: text('task_id'),
  resultUrl: text('result_url'),
  localPath: text('local_path'),
  status: text('status').default('processing'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
})

export const videoMerges = sqliteTable('video_merges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id'),
  dramaId: integer('drama_id'),
  title: text('title'),
  provider: text('provider'),
  model: text('model'),
  status: text('status').default('pending'),
  scenes: text('scenes'), // JSON
  mergedUrl: text('merged_url'),
  duration: integer('duration'),
  taskId: text('task_id'),
  errorMsg: text('error_msg'),
  /** 版本类型：concat（纯拼接）/ mix（配音+字幕+BGM）（V2） */
  kind: text('kind').default('concat'),
  /** 幂等指纹：分镜集合 + 混音参数（V2） */
  sourceHash: text('source_hash'),
  /** AI 过渡断点快照（JSON）：used/fallback 与时长，scenes 仍只存镜头（V3） */
  transitions: text('transitions'),
  subtitleUrl: text('subtitle_url'),
  dialogueTrackUrl: text('dialogue_track_url'),
  bgmUrl: text('bgm_url'),
  mixOptions: text('mix_options'), // JSON
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  deletedAt: text('deleted_at'),
})

// AI 过渡片段：相邻两镜断点，一断点一行；同集同断点唯一
export const videoTransitions = sqliteTable('video_transitions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id'),
  fromStoryboardId: integer('from_storyboard_id').notNull(),
  toStoryboardId: integer('to_storyboard_id').notNull(),
  fromVideoUrl: text('from_video_url'),
  toVideoUrl: text('to_video_url'),
  firstFrameUrl: text('first_frame_url'),
  lastFrameUrl: text('last_frame_url'),
  /** 来源视频指纹：URL + 文件大小/mtime，用于复用与过期判断 */
  sourceHash: text('source_hash'),
  prompt: text('prompt'),
  /** ai = 视觉模型分析首尾帧生成；fallback = 文字模板回退；manual = 用户编辑后锁定 */
  promptSource: text('prompt_source'),
  provider: text('provider'),
  model: text('model'),
  configId: integer('config_id'),
  configBaseUrl: text('config_base_url'),
  durationRequested: real('duration_requested'),
  /** 按模型档位折算后的请求时长，落库便于复现 */
  durationEffective: real('duration_effective'),
  durationActual: real('duration_actual'),
  audioMode: text('audio_mode').default('ambient'),
  status: text('status').default('pending'),
  videoUrl: text('video_url'),
  sysTaskId: integer('sys_task_id'),
  errorMsg: text('error_msg'),
  /** 0 = 用户跳过该断点 */
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
})

export const props = sqliteTable('props', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  type: text('type'),
  description: text('description'),
  prompt: text('prompt'),
  finalPrompt: text('final_prompt'),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  localPath: text('local_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const assets = sqliteTable('assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id'),
  episodeId: integer('episode_id'),
  storyboardId: integer('storyboard_id'),
  storyboardNum: integer('storyboard_num'),
  name: text('name'),
  description: text('description'),
  type: text('type'),
  category: text('category'),
  url: text('url'),
  thumbnailUrl: text('thumbnail_url'),
  localPath: text('local_path'),
  fileSize: integer('file_size'),
  mimeType: text('mime_type'),
  width: integer('width'),
  height: integer('height'),
  duration: integer('duration'),
  format: text('format'),
  imageGenId: integer('image_gen_id'),
  videoGenId: integer('video_gen_id'),
  isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false),
  viewCount: integer('view_count').default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// ===== V2 新增表 =====

/** 音色档案：一个可复现的声音。旁白 scope='narrator' 且 characterId 为 null */
export const characterVoices = sqliteTable('character_voices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  characterId: integer('character_id'),
  scope: text('scope').notNull().default('character'),
  name: text('name').notNull(),
  source: text('source').notNull().default('design'),
  provider: text('provider'),
  model: text('model'),
  externalVoiceId: text('external_voice_id'),
  voicePrompt: text('voice_prompt'),
  voicePromptSource: text('voice_prompt_source').default('llm'),
  designInstruct: text('design_instruct'),
  refAudioUrl: text('ref_audio_url'),
  refText: text('ref_text'),
  xVectorOnly: integer('x_vector_only', { mode: 'boolean' }).default(false),
  sampleUrl: text('sample_url'),
  sampleText: text('sample_text'),
  gender: text('gender'),
  ageRange: text('age_range'),
  pitch: text('pitch'),
  speed: real('speed').default(1.0),
  emotion: text('emotion'),
  language: text('language').default('Chinese'),
  seed: integer('seed'),
  consentConfirmedAt: text('consent_confirmed_at'),
  status: text('status').default('draft'),
  error: text('error'),
  isActive: integer('is_active', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

/** 台词行：最小配音单位；storyboard_id 为空表示绝对锚点 */
export const storyboardLines = sqliteTable('storyboard_lines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyboardId: integer('storyboard_id'),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id').notNull(),
  lineNo: integer('line_no').notNull(),
  speakerType: text('speaker_type').notNull().default('dialogue'),
  characterId: integer('character_id'),
  voiceId: integer('voice_id'),
  voiceLocked: integer('voice_locked', { mode: 'boolean' }).default(false),
  speakerName: text('speaker_name'),
  text: text('text').notNull(),
  speakText: text('speak_text'),
  subtitleText: text('subtitle_text'),
  emotion: text('emotion'),
  direction: text('direction'),
  speed: real('speed').default(1.0),
  plannedStartMs: integer('planned_start_ms'),
  plannedEndMs: integer('planned_end_ms'),
  startMs: integer('start_ms'),
  endMs: integer('end_ms'),
  /** 手动指定整集绝对起点（毫秒）；为空时按镜头与顺序自动排布 */
  voiceStartMs: integer('voice_start_ms'),
  /** 手动指定占位时长（毫秒）；为空时使用合成音频真实时长 */
  voiceDurationMs: integer('voice_duration_ms'),
  audioUrl: text('audio_url'),
  audioDurationMs: integer('audio_duration_ms'),
  audioHash: text('audio_hash'),
  status: text('status').default('pending'),
  overflowMs: integer('overflow_ms').default(0),
  stale: integer('stale', { mode: 'boolean' }).default(false),
  source: text('source').default('auto'),
  locked: integer('locked', { mode: 'boolean' }).default(false),
  needsReview: integer('needs_review', { mode: 'boolean' }).default(false),
  error: text('error'),
  /** 锚点类型：shot（镜头内）/ absolute（整集绝对时间） */
  anchorType: text('anchor_type').default('shot'),
  sortOrder: integer('sort_order').default(0),
  /** 自动抽取内容匹配键：镜头 + 规范化文本 + 说话人 + 重复序号 */
  originKey: text('origin_key'),
  textRevision: integer('text_revision').default(1),
  /** 文本/音色已变化但旧音频保留，待重新生成 */
  audioStale: integer('audio_stale', { mode: 'boolean' }).default(false),
  activeTakeId: integer('active_take_id'),
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 台词 Take：同一句的多次合成结果 */
export const lineTakes = sqliteTable('line_takes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  lineId: integer('line_id').notNull(),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id').notNull(),
  takeNo: integer('take_no').notNull(),
  text: text('text').notNull(),
  speakText: text('speak_text'),
  textRevision: integer('text_revision').default(1),
  voiceId: integer('voice_id'),
  voiceFingerprint: text('voice_fingerprint'),
  provider: text('provider'),
  model: text('model'),
  configId: integer('config_id'),
  paramsJson: text('params_json'),
  contextMode: text('context_mode').default('off'),
  contextJson: text('context_json'),
  contextHash: text('context_hash'),
  audioUrl: text('audio_url'),
  durationMs: integer('duration_ms'),
  hash: text('hash'),
  status: text('status').default('generating'),
  error: text('error'),
  isActive: integer('is_active', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),
})

/** 音色试听/自由试音历史 */
export const voiceSamples = sqliteTable('voice_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  voiceId: integer('voice_id').notNull(),
  dramaId: integer('drama_id').notNull(),
  kind: text('kind').default('audition'),
  text: text('text').notNull(),
  textSource: text('text_source').default('default'),
  seed: integer('seed'),
  provider: text('provider'),
  model: text('model'),
  paramsJson: text('params_json'),
  audioUrl: text('audio_url'),
  durationMs: integer('duration_ms'),
  hash: text('hash'),
  status: text('status').default('generating'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),
})

/** 已删除台词墓碑：重抽时跳过 */
export const lineTombstones = sqliteTable('line_tombstones', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id').notNull(),
  storyboardId: integer('storyboard_id'),
  originKey: text('origin_key').notNull(),
  textHash: text('text_hash'),
  speakerKey: text('speaker_key'),
  reason: text('reason'),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),
})

/** 原声分离素材 */
export const episodeAudioAssets = sqliteTable('episode_audio_assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id').notNull(),
  kind: text('kind').notNull(),
  sourceHash: text('source_hash'),
  url: text('url'),
  durationMs: integer('duration_ms'),
  sampleRate: integer('sample_rate'),
  channels: integer('channels'),
  engine: text('engine'),
  model: text('model'),
  modelLicense: text('model_license'),
  confidence: real('confidence'),
  status: text('status').default('ready'),
  error: text('error'),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),
})

/** 混音总线 */
export const audioBuses = sqliteTable('audio_buses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  volume: real('volume').default(1),
  muted: integer('muted', { mode: 'boolean' }).default(false),
  solo: integer('solo', { mode: 'boolean' }).default(false),
  ducking: integer('ducking', { mode: 'boolean' }).default(true),
  duckRatio: real('duck_ratio').default(6),
  duckAttackMs: integer('duck_attack_ms').default(20),
  duckReleaseMs: integer('duck_release_ms').default(250),
  lufsTarget: real('lufs_target'),
  limiterCeiling: real('limiter_ceiling'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 混音计划版本 */
export const mixRevisions = sqliteTable('mix_revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  revisionNo: integer('revision_no').notNull(),
  planJson: text('plan_json').notNull(),
  planHash: text('plan_hash'),
  note: text('note'),
  isCurrent: integer('is_current', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull(),
  editRevisionId: integer('edit_revision_id'),
  editSyncHash: text('edit_sync_hash'),
  dialogueSyncHash: text('dialogue_sync_hash'),
  sourceKind: text('source_kind').default('legacy'),
})

/** 导出记录 */
export const episodeExports = sqliteTable('episode_exports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  kind: text('kind').notNull(),
  preset: text('preset'),
  paramsJson: text('params_json'),
  planRevisionId: integer('plan_revision_id'),
  planHash: text('plan_hash'),
  sourceVideoHash: text('source_video_hash'),
  subtitleHash: text('subtitle_hash'),
  status: text('status').default('pending'),
  progress: integer('progress').default(0),
  error: text('error'),
  outputUrl: text('output_url'),
  durationMs: integer('duration_ms'),
  sizeBytes: integer('size_bytes'),
  lufs: real('lufs'),
  truePeak: real('true_peak'),
  lra: real('lra'),
  isCurrent: integer('is_current', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
  deletedAt: text('deleted_at'),
  editRevisionId: integer('edit_revision_id'),
  mixRevisionId: integer('mix_revision_id'),
  editPlanHash: text('edit_plan_hash'),
  editSyncHash: text('edit_sync_hash'),
  dialogueSyncHash: text('dialogue_sync_hash'),
  renderMode: text('render_mode'),
  subtitleMode: text('subtitle_mode'),
  fileName: text('file_name'),
})

/** 剪辑草稿：每集最多一份，可变 */
export const episodeEditDrafts = sqliteTable('episode_edit_drafts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id'),
  planJson: text('plan_json').notNull(),
  planHash: text('plan_hash'),
  editSyncHash: text('edit_sync_hash'),
  version: integer('version').notNull().default(0),
  baseRevisionId: integer('base_revision_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 不可变剪辑版本 */
export const editRevisions = sqliteTable('edit_revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  revisionNo: integer('revision_no').notNull(),
  planJson: text('plan_json').notNull(),
  planHash: text('plan_hash').notNull(),
  editSyncHash: text('edit_sync_hash').notNull(),
  renderHash: text('render_hash'),
  durationMs: integer('duration_ms'),
  clipCount: integer('clip_count'),
  note: text('note'),
  isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
})

/** 剪辑渲染缓存 */
export const editRenders = sqliteTable('edit_renders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  kind: text('kind').notNull(),
  editRevisionId: integer('edit_revision_id'),
  renderHash: text('render_hash'),
  editSyncHash: text('edit_sync_hash'),
  dialogueSyncHash: text('dialogue_sync_hash'),
  subtitleHash: text('subtitle_hash'),
  mixRevisionId: integer('mix_revision_id'),
  audioVersion: integer('audio_version'),
  cacheKey: text('cache_key'),
  rangeStartMs: integer('range_start_ms'),
  rangeEndMs: integer('range_end_ms'),
  status: text('status').notNull().default('pending'),
  progress: integer('progress').notNull().default(0),
  outputUrl: text('output_url'),
  outputPath: text('output_path'),
  durationMs: integer('duration_ms'),
  sizeBytes: integer('size_bytes'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
  deletedAt: text('deleted_at'),
})

/** 预览代理 */
export const episodeMediaProxies = sqliteTable('episode_media_proxies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id'),
  sourceUrl: text('source_url').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  status: text('status').notNull().default('pending'),
  progress: integer('progress').notNull().default(0),
  outputUrl: text('output_url'),
  width: integer('width'),
  height: integer('height'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
})

/** 编辑 / 导出互斥锁 */
export const episodeLocks = sqliteTable('episode_locks', {
  episodeId: integer('episode_id').primaryKey(),
  kind: text('kind').notNull(),
  owner: text('owner').notNull(),
  acquiredAt: text('acquired_at').notNull(),
  expiresAt: text('expires_at').notNull(),
})

/** 配音持久化任务 */
export const dubbingJobs = sqliteTable('dubbing_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id'),
  kind: text('kind').notNull(),
  status: text('status').default('pending'),
  progress: integer('progress').default(0),
  step: text('step'),
  payloadJson: text('payload_json'),
  resultJson: text('result_json'),
  error: text('error'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 成片附加音轨：环境声/音效/BGM/额外语音 */
export const episodeAudioTracks = sqliteTable('episode_audio_tracks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id').notNull(),
  kind: text('kind').notNull().default('ambience'),
  /** 新代码以 role 为准；kind 仅兼容旧数据 */
  role: text('role'),
  name: text('name').notNull(),
  volume: real('volume').default(1),
  pan: real('pan').default(0),
  busId: integer('bus_id'),
  muted: integer('muted', { mode: 'boolean' }).default(false),
  solo: integer('solo', { mode: 'boolean' }).default(false),
  ducking: integer('ducking', { mode: 'boolean' }).default(true),
  loop: integer('loop', { mode: 'boolean' }).default(false),
  locked: integer('locked', { mode: 'boolean' }).default(false),
  hidden: integer('hidden', { mode: 'boolean' }).default(false),
  color: text('color'),
  height: integer('height').default(72),
  stemAssetId: integer('stem_asset_id'),
  duckAttackMs: integer('duck_attack_ms').default(20),
  duckReleaseMs: integer('duck_release_ms').default(250),
  sortOrder: integer('sort_order').default(0),
  /** 服务端来源：soundscape=AI 生成轨；用户轨为空 */
  origin: text('origin'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 音轨上的时间段片段 */
export const episodeAudioClips = sqliteTable('episode_audio_clips', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trackId: integer('track_id').notNull(),
  episodeId: integer('episode_id').notNull(),
  assetId: integer('asset_id'),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  sourceStartMs: integer('source_start_ms').default(0),
  gainDb: real('gain_db').default(0),
  pan: real('pan').default(0),
  fadeInMs: integer('fade_in_ms').default(0),
  fadeOutMs: integer('fade_out_ms').default(0),
  fadeCurve: text('fade_curve').default('linear'),
  locked: integer('locked', { mode: 'boolean' }).default(false),
  muted: integer('muted', { mode: 'boolean' }).default(false),
  name: text('name'),
  color: text('color'),
  sourceUrl: text('source_url'),
  text: text('text'),
  voiceId: integer('voice_id'),
  takeId: integer('take_id'),
  followTake: integer('follow_take', { mode: 'boolean' }).default(true),
  loop: integer('loop', { mode: 'boolean' }).default(false),
  audioUrl: text('audio_url'),
  status: text('status').default('ready'),
  error: text('error'),
  lineId: integer('line_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 宫格图：一次生成 N 格再切分 */
export const gridSheets = sqliteTable('grid_sheets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeId: integer('episode_id'),
  kind: text('kind').notNull(),
  rows: integer('rows').notNull(),
  cols: integer('cols').notNull(),
  prompt: text('prompt'),
  imageUrl: text('image_url'),
  cells: text('cells'), // JSON
  inset: real('inset').default(0.015),
  status: text('status').default('pending'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 整本剧本导入 */
export const scriptImports = sqliteTable('script_imports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  filename: text('filename'),
  sourceHash: text('source_hash').notNull(),
  rawText: text('raw_text'),
  chapterCount: integer('chapter_count').default(0),
  status: text('status').default('parsed'),
  createdAt: text('created_at').notNull(),
})

export const scriptChapters = sqliteTable('script_chapters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  importId: integer('import_id').notNull(),
  dramaId: integer('drama_id').notNull(),
  chapterIndex: integer('chapter_index').notNull(),
  partNo: integer('part_no').default(1),
  title: text('title'),
  content: text('content').notNull(),
  charCount: integer('char_count').default(0),
  episodeId: integer('episode_id'),
  createdAt: text('created_at').notNull(),
})

// ===== V3：小说创作 =====

export const novels = sqliteTable('novels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  topic: text('topic'),
  genre: text('genre'), // JSON 数组
  background: text('background'),
  writingStyle: text('writing_style'), // JSON {key,name,prompt}
  numberOfChapters: integer('number_of_chapters').default(100),
  wordNumber: integer('word_number').default(3000),
  userGuidance: text('user_guidance'),
  coreSeed: text('core_seed'),
  characterDynamics: text('character_dynamics'),
  worldBuilding: text('world_building'),
  plotArchitecture: text('plot_architecture'),
  characterState: text('character_state'),
  chapterBlueprint: text('chapter_blueprint'),
  globalSummary: text('global_summary'),
  graphMeta: text('graph_meta'), // JSON
  architectureGenerated: integer('architecture_generated', { mode: 'boolean' }).default(false),
  blueprintGenerated: integer('blueprint_generated', { mode: 'boolean' }).default(false),
  status: text('status').default('draft'),
  contentUpdatedAt: text('content_updated_at'),
  narrativePerson: text('narrative_person').default('first'),
  timelineEvents: text('timeline_events'),
  worldMap: text('world_map'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const novelChapters = sqliteTable('novel_chapters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  novelId: integer('novel_id').notNull(),
  chapterNo: integer('chapter_no').notNull(),
  title: text('title'),
  content: text('content'),
  wordCount: integer('word_count').default(0),
  contentHash: text('content_hash'),
  status: text('status').default('draft'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const novelGraphSnapshots = sqliteTable('novel_graph_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  novelId: integer('novel_id').notNull(),
  chapterNo: integer('chapter_no').notNull(),
  nodes: text('nodes'),
  edges: text('edges'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const novelChapterGraphs = sqliteTable('novel_chapter_graphs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  novelId: integer('novel_id').notNull(),
  chapterNo: integer('chapter_no').notNull(),
  nodes: text('nodes'),
  edges: text('edges'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const novelJobs = sqliteTable('novel_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  novelId: integer('novel_id').notNull(),
  type: text('type').notNull(),
  chapterNo: integer('chapter_no'),
  status: text('status').notNull().default('queued'),
  stage: text('stage'),
  progress: integer('progress').default(0),
  total: integer('total').default(0),
  message: text('message'),
  partial: text('partial'),
  result: text('result'), // JSON
  error: text('error'),
  errorCode: text('error_code'),
  cancelRequested: integer('cancel_requested', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
})

export const novelImports = sqliteTable('novel_imports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  novelId: integer('novel_id').notNull(),
  dramaId: integer('drama_id').notNull(),
  requestId: text('request_id'),
  mode: text('mode').default('manual'),
  status: text('status').default('active'),
  sourceUpdatedAt: text('source_updated_at'),
  lastSyncedAt: text('last_synced_at'),
  lastSyncSummary: text('last_sync_summary'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const novelImportEpisodes = sqliteTable('novel_import_episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  importId: integer('import_id').notNull(),
  chapterNo: integer('chapter_no').notNull(),
  partNo: integer('part_no').default(1),
  episodeId: integer('episode_id').notNull(),
  contentHash: text('content_hash'),
  chapterHash: text('chapter_hash'),
  syncedTitle: text('synced_title'),
  status: text('status').default('synced'),
  syncedAt: text('synced_at'),
})

/** 持久化任务队列 */
export const pipelineJobs = sqliteTable('pipeline_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  dramaId: integer('drama_id'),
  episodeId: integer('episode_id'),
  resource: text('resource').notNull(),
  status: text('status').notNull().default('queued'),
  priority: integer('priority').default(0),
  payload: text('payload'), // JSON
  progress: integer('progress').default(0),
  note: text('note'),
  error: text('error'),
  attempts: integer('attempts').default(0),
  maxAttempts: integer('max_attempts').default(2),
  lockedBy: text('locked_by'),
  heartbeatAt: text('heartbeat_at'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
})
