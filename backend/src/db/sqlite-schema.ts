/**
 * SQLite 启动建表 DDL + 种子数据（自 mysql-schema.ts 翻译）
 * - AUTO_INCREMENT → AUTOINCREMENT；删除 ENGINE/CHARSET；TINYINT(1) → INTEGER
 * - MySQL 内联 INDEX 拆为独立 CREATE INDEX IF NOT EXISTS
 * - 种子语句去掉 FROM DUAL（SQLite 非法），幂等语义（WHERE NOT EXISTS）保留
 */
import type Database from 'better-sqlite3'

/**
 * 台词行 DDL：新库与旧库重建共用。
 * storyboard_id 可空以支持不绑定镜头的绝对锚点台词。
 */
function storyboardLinesDdl(tableName = 'storyboard_lines') {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storyboard_id INTEGER,
    episode_id INTEGER NOT NULL,
    drama_id INTEGER NOT NULL,
    line_no INTEGER NOT NULL,
    speaker_type TEXT NOT NULL DEFAULT 'dialogue',
    character_id INTEGER,
    voice_id INTEGER,
    voice_locked INTEGER DEFAULT 0,
    speaker_name TEXT,
    text TEXT NOT NULL,
    speak_text TEXT,
    subtitle_text TEXT,
    emotion TEXT,
    direction TEXT,
    speed REAL DEFAULT 1.0,
    planned_start_ms INTEGER,
    planned_end_ms INTEGER,
    start_ms INTEGER,
    end_ms INTEGER,
    voice_start_ms INTEGER,
    voice_duration_ms INTEGER,
    audio_url TEXT,
    audio_duration_ms INTEGER,
    audio_hash TEXT,
    status TEXT DEFAULT 'pending',
    overflow_ms INTEGER DEFAULT 0,
    stale INTEGER DEFAULT 0,
    source TEXT DEFAULT 'auto',
    locked INTEGER DEFAULT 0,
    needs_review INTEGER DEFAULT 0,
    error TEXT,
    anchor_type TEXT DEFAULT 'shot',
    sort_order INTEGER DEFAULT 0,
    origin_key TEXT,
    text_revision INTEGER DEFAULT 1,
    audio_stale INTEGER DEFAULT 0,
    active_take_id INTEGER,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (storyboard_id, line_no)
  )`
}

export const sqliteSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS dramas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    genre TEXT,
    style TEXT DEFAULT '3d',
    background TEXT,
    visual_background TEXT,
    aspect_ratio TEXT DEFAULT '16:9',
    total_episodes INTEGER DEFAULT 1,
    total_duration INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    thumbnail TEXT,
    tags TEXT,
    metadata TEXT,
    storage_dir TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    script_content TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    video_url TEXT,
    thumbnail TEXT,
    image_config_id INTEGER,
    video_config_id INTEGER,
    video_mode TEXT DEFAULT 'native',
    comfyui_config_id INTEGER,
    comfyui_workflow_json TEXT,
    resolution TEXT DEFAULT '720p',
    auto_pipeline INTEGER DEFAULT 0,
    automation_status TEXT,
    automation_stage TEXT,
    automation_progress INTEGER DEFAULT 0,
    automation_note TEXT,
    automation_error TEXT,
    automation_started_at TEXT,
    automation_finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    description TEXT,
    appearance TEXT,
    styling TEXT,
    final_prompt TEXT,
    personality TEXT,
    image_url TEXT,
    voice_audio_url TEXT,
    voice_audio_name TEXT,
    reference_images TEXT,
    seed_value TEXT,
    sort_order INTEGER,
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER,
    location TEXT NOT NULL,
    time TEXT NOT NULL,
    prompt TEXT NOT NULL,
    lighting TEXT,
    final_prompt TEXT,
    storyboard_count INTEGER DEFAULT 1,
    image_url TEXT,
    reference_images TEXT,
    status TEXT DEFAULT 'pending',
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS storyboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER,
    storyboard_number INTEGER NOT NULL,
    title TEXT,
    location TEXT,
    time TEXT,
    shot_type TEXT,
    angle TEXT,
    movement TEXT,
    result TEXT,
    atmosphere TEXT,
    image_prompt TEXT,
    video_prompt TEXT,
    bgm_prompt TEXT,
    sound_effect TEXT,
    description TEXT,
    transition TEXT DEFAULT 'cut',
    continuity TEXT,
    duration INTEGER DEFAULT 0,
    composed_image TEXT,
    first_frame_image TEXT,
    last_frame_image TEXT,
    reference_images TEXT,
    video_url TEXT,
    subtitle_url TEXT,
    composed_video_url TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS episode_characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episode_characters_episode_id ON episode_characters (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episode_characters_character_id ON episode_characters (character_id)`,

  `CREATE TABLE IF NOT EXISTS episode_scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episode_scenes_episode_id ON episode_scenes (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episode_scenes_scene_id ON episode_scenes (scene_id)`,

  `CREATE TABLE IF NOT EXISTS episode_props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    prop_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episode_props_episode_id ON episode_props (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episode_props_prop_id ON episode_props (prop_id)`,

  `CREATE TABLE IF NOT EXISTS storyboard_characters (
    storyboard_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    PRIMARY KEY (storyboard_id, character_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_storyboard_characters_character_id ON storyboard_characters (character_id)`,

  `CREATE TABLE IF NOT EXISTS storyboard_props (
    storyboard_id INTEGER NOT NULL,
    prop_id INTEGER NOT NULL,
    PRIMARY KEY (storyboard_id, prop_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_storyboard_props_prop_id ON storyboard_props (prop_id)`,

  `CREATE TABLE IF NOT EXISTS ai_service_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL,
    provider TEXT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT,
    endpoint TEXT,
    query_endpoint TEXT,
    priority INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    settings TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS ai_service_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    display_name TEXT,
    service_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    default_url TEXT,
    preset_models TEXT,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS style_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    prompt TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (value)
  )`,

  `CREATE TABLE IF NOT EXISTS sys_task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    storyboard_id INTEGER,
    drama_id INTEGER,
    scene_id INTEGER,
    character_id INTEGER,
    prop_id INTEGER,
    provider TEXT,
    prompt TEXT,
    model TEXT,
    params TEXT,
    task_id TEXT,
    result_url TEXT,
    local_path TEXT,
    status TEXT DEFAULT 'processing',
    error_msg TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sys_task_type ON sys_task (type)`,
  `CREATE INDEX IF NOT EXISTS idx_sys_task_drama_id ON sys_task (drama_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sys_task_storyboard_id ON sys_task (storyboard_id)`,

  `CREATE TABLE IF NOT EXISTS video_merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER,
    drama_id INTEGER,
    title TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    scenes TEXT,
    merged_url TEXT,
    duration INTEGER,
    task_id TEXT,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT
  )`,

  // AI 过渡片段：相邻两镜的断点记录，一断点一行
  `CREATE TABLE IF NOT EXISTS video_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    drama_id INTEGER,
    from_storyboard_id INTEGER NOT NULL,
    to_storyboard_id INTEGER NOT NULL,
    from_video_url TEXT,
    to_video_url TEXT,
    first_frame_url TEXT,
    last_frame_url TEXT,
    source_hash TEXT,
    prompt TEXT,
    prompt_source TEXT,
    provider TEXT,
    model TEXT,
    config_id INTEGER,
    config_base_url TEXT,
    duration_requested REAL,
    duration_effective REAL,
    duration_actual REAL,
    audio_mode TEXT DEFAULT 'ambient',
    status TEXT DEFAULT 'pending',
    video_url TEXT,
    sys_task_id INTEGER,
    error_msg TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_video_transitions_boundary ON video_transitions (episode_id, from_storyboard_id, to_storyboard_id)`,
  `CREATE INDEX IF NOT EXISTS idx_video_transitions_episode ON video_transitions (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_video_transitions_status ON video_transitions (status)`,

  `CREATE TABLE IF NOT EXISTS props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT,
    description TEXT,
    prompt TEXT,
    final_prompt TEXT,
    image_url TEXT,
    reference_images TEXT,
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER,
    episode_id INTEGER,
    storyboard_id INTEGER,
    storyboard_num INTEGER,
    name TEXT,
    description TEXT,
    type TEXT,
    category TEXT,
    url TEXT,
    thumbnail_url TEXT,
    local_path TEXT,
    file_size INTEGER,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    duration INTEGER,
    format TEXT,
    image_gen_id INTEGER,
    video_gen_id INTEGER,
    is_favorite INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  // 应用级全局设置（key-value，如 AI 内容语言 content_language）
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // ===== V2：音色档案 / 台词 / 宫格 / 剧本导入 / 持久化队列 =====

  // 一个可复现的声音。旁白用 scope='narrator' + character_id=NULL
  `CREATE TABLE IF NOT EXISTS character_voices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    character_id INTEGER,
    scope TEXT NOT NULL DEFAULT 'character',
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'design',
    provider TEXT,
    model TEXT,
    external_voice_id TEXT,
    voice_prompt TEXT,
    voice_prompt_source TEXT DEFAULT 'llm',
    design_instruct TEXT,
    ref_audio_url TEXT,
    ref_text TEXT,
    x_vector_only INTEGER DEFAULT 0,
    sample_url TEXT,
    sample_text TEXT,
    gender TEXT,
    age_range TEXT,
    pitch TEXT,
    speed REAL DEFAULT 1.0,
    emotion TEXT,
    language TEXT DEFAULT 'Chinese',
    seed INTEGER,
    consent_confirmed_at TEXT,
    status TEXT DEFAULT 'draft',
    error TEXT,
    is_active INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  // 最小配音单位：一个分镜里的一句话（storyboard_id 为空表示绝对锚点）
  storyboardLinesDdl(),

  // 成片附加音轨与时间段片段（V3 多轨混音）
  `CREATE TABLE IF NOT EXISTS episode_audio_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    drama_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'ambience',
    name TEXT NOT NULL,
    volume REAL DEFAULT 1.0,
    muted INTEGER DEFAULT 0,
    solo INTEGER DEFAULT 0,
    ducking INTEGER DEFAULT 1,
    loop INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS episode_audio_clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    source_start_ms INTEGER DEFAULT 0,
    fade_in_ms INTEGER DEFAULT 0,
    fade_out_ms INTEGER DEFAULT 0,
    source_url TEXT,
    text TEXT,
    voice_id INTEGER,
    audio_url TEXT,
    status TEXT DEFAULT 'ready',
    error TEXT,
    line_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 配音工作台：每句台词的多次合成结果；同句最多一条 is_active=1
  `CREATE TABLE IF NOT EXISTS line_takes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL,
    drama_id INTEGER NOT NULL,
    take_no INTEGER NOT NULL,
    text TEXT NOT NULL,
    speak_text TEXT,
    text_revision INTEGER DEFAULT 1,
    voice_id INTEGER,
    voice_fingerprint TEXT,
    provider TEXT,
    model TEXT,
    config_id INTEGER,
    params_json TEXT,
    context_mode TEXT DEFAULT 'off',
    context_json TEXT,
    context_hash TEXT,
    audio_url TEXT,
    duration_ms INTEGER,
    hash TEXT,
    status TEXT DEFAULT 'generating',
    error TEXT,
    is_active INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  // 音色试听 / 自由试音历史
  `CREATE TABLE IF NOT EXISTS voice_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_id INTEGER NOT NULL,
    drama_id INTEGER NOT NULL,
    kind TEXT DEFAULT 'audition',
    text TEXT NOT NULL,
    text_source TEXT DEFAULT 'default',
    seed INTEGER,
    provider TEXT,
    model TEXT,
    params_json TEXT,
    audio_url TEXT,
    duration_ms INTEGER,
    hash TEXT,
    status TEXT DEFAULT 'generating',
    error TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  // 已删除台词的墓碑：重抽时跳过，避免已删台词复活
  `CREATE TABLE IF NOT EXISTS line_tombstones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    drama_id INTEGER NOT NULL,
    storyboard_id INTEGER,
    origin_key TEXT NOT NULL,
    text_hash TEXT,
    speaker_key TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  // 原声分离素材：原声 / 人声 / 伴奏 / 对白 / 环境等
  `CREATE TABLE IF NOT EXISTS episode_audio_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    drama_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    source_hash TEXT,
    url TEXT,
    duration_ms INTEGER,
    sample_rate INTEGER,
    channels INTEGER,
    engine TEXT,
    model TEXT,
    model_license TEXT,
    confidence REAL,
    status TEXT DEFAULT 'ready',
    error TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  // 混音总线：dialogue / original / sfx / bgm / master
  `CREATE TABLE IF NOT EXISTS audio_buses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    volume REAL DEFAULT 1.0,
    muted INTEGER DEFAULT 0,
    solo INTEGER DEFAULT 0,
    ducking INTEGER DEFAULT 1,
    duck_ratio REAL DEFAULT 6,
    duck_attack_ms INTEGER DEFAULT 20,
    duck_release_ms INTEGER DEFAULT 250,
    lufs_target REAL,
    limiter_ceiling REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (episode_id, key)
  )`,

  // 混音计划版本快照
  `CREATE TABLE IF NOT EXISTS mix_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    revision_no INTEGER NOT NULL,
    plan_json TEXT NOT NULL,
    plan_hash TEXT,
    note TEXT,
    is_current INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (episode_id, revision_no)
  )`,

  // 导出记录：混音 / 成片 / 分轨 / 字幕
  `CREATE TABLE IF NOT EXISTS episode_exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    preset TEXT,
    params_json TEXT,
    plan_revision_id INTEGER,
    plan_hash TEXT,
    source_video_hash TEXT,
    subtitle_hash TEXT,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    error TEXT,
    output_url TEXT,
    duration_ms INTEGER,
    size_bytes INTEGER,
    lufs REAL,
    true_peak REAL,
    lra REAL,
    is_current INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    deleted_at TEXT
  )`,

  // 配音持久化任务（试听不落库；批量生成/分离/导出走这里）
  `CREATE TABLE IF NOT EXISTS dubbing_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    drama_id INTEGER,
    kind TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    step TEXT,
    payload_json TEXT,
    result_json TEXT,
    error TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 宫格图：一次生成 N 格，再按坐标切分
  `CREATE TABLE IF NOT EXISTS grid_sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER,
    kind TEXT NOT NULL,
    rows INTEGER NOT NULL,
    cols INTEGER NOT NULL,
    prompt TEXT,
    image_url TEXT,
    cells TEXT,
    inset REAL DEFAULT 0.015,
    status TEXT DEFAULT 'pending',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 整本剧本导入：同项目同文件只解析一次
  `CREATE TABLE IF NOT EXISTS script_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    filename TEXT,
    source_hash TEXT NOT NULL,
    raw_text TEXT,
    chapter_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'parsed',
    created_at TEXT NOT NULL,
    UNIQUE (drama_id, source_hash)
  )`,

  `CREATE TABLE IF NOT EXISTS script_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    drama_id INTEGER NOT NULL,
    chapter_index INTEGER NOT NULL,
    part_no INTEGER DEFAULT 1,
    title TEXT,
    content TEXT NOT NULL,
    char_count INTEGER DEFAULT 0,
    episode_id INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (import_id, chapter_index, part_no)
  )`,

  // 持久化队列：心跳恢复 + 资源锁
  `CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    drama_id INTEGER,
    episode_id INTEGER,
    resource TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    priority INTEGER DEFAULT 0,
    payload TEXT,
    progress INTEGER DEFAULT 0,
    note TEXT,
    error TEXT,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 2,
    locked_by TEXT,
    heartbeat_at TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`,

  // ===== V3：小说创作（novels 及其从属表） =====

  `CREATE TABLE IF NOT EXISTS novels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    topic TEXT,
    genre TEXT,
    background TEXT,
    writing_style TEXT,
    number_of_chapters INTEGER DEFAULT 100,
    word_number INTEGER DEFAULT 3000,
    user_guidance TEXT,
    core_seed TEXT,
    character_dynamics TEXT,
    world_building TEXT,
    plot_architecture TEXT,
    character_state TEXT,
    chapter_blueprint TEXT,
    global_summary TEXT,
    graph_meta TEXT,
    architecture_generated INTEGER DEFAULT 0,
    blueprint_generated INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    content_updated_at TEXT,
    narrative_person TEXT DEFAULT 'first',
    timeline_events TEXT,
    world_map TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS novel_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    novel_id INTEGER NOT NULL,
    chapter_no INTEGER NOT NULL,
    title TEXT,
    content TEXT,
    word_count INTEGER DEFAULT 0,
    content_hash TEXT,
    status TEXT DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (novel_id, chapter_no)
  )`,

  `CREATE TABLE IF NOT EXISTS novel_graph_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    novel_id INTEGER NOT NULL,
    chapter_no INTEGER NOT NULL,
    nodes TEXT,
    edges TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (novel_id, chapter_no)
  )`,

  `CREATE TABLE IF NOT EXISTS novel_chapter_graphs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    novel_id INTEGER NOT NULL,
    chapter_no INTEGER NOT NULL,
    nodes TEXT,
    edges TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (novel_id, chapter_no)
  )`,

  `CREATE TABLE IF NOT EXISTS novel_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    novel_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    chapter_no INTEGER,
    status TEXT NOT NULL DEFAULT 'queued',
    stage TEXT,
    progress INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    message TEXT,
    partial TEXT,
    result TEXT,
    error TEXT,
    error_code TEXT,
    cancel_requested INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS novel_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    novel_id INTEGER NOT NULL,
    drama_id INTEGER NOT NULL,
    request_id TEXT,
    mode TEXT DEFAULT 'manual',
    status TEXT DEFAULT 'active',
    source_updated_at TEXT,
    last_synced_at TEXT,
    last_sync_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (novel_id, drama_id)
  )`,

  `CREATE TABLE IF NOT EXISTS novel_import_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    chapter_no INTEGER NOT NULL,
    part_no INTEGER DEFAULT 1,
    episode_id INTEGER NOT NULL,
    content_hash TEXT,
    chapter_hash TEXT,
    synced_title TEXT,
    status TEXT DEFAULT 'synced',
    synced_at TEXT,
    UNIQUE (import_id, chapter_no, part_no)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_novels_updated ON novels (deleted_at, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_novel_chapters_novel ON novel_chapters (novel_id, chapter_no)`,
  `CREATE INDEX IF NOT EXISTS idx_novel_jobs_novel ON novel_jobs (novel_id, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_jobs_running ON novel_jobs (novel_id) WHERE status = 'running'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_imports_request ON novel_imports (request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_novel_imports_drama ON novel_imports (drama_id)`,
  `CREATE INDEX IF NOT EXISTS idx_novel_import_eps_import ON novel_import_episodes (import_id, chapter_no)`,

  `CREATE INDEX IF NOT EXISTS idx_character_voices_char ON character_voices (character_id)`,
  `CREATE INDEX IF NOT EXISTS idx_character_voices_drama ON character_voices (drama_id, scope)`,
  `CREATE INDEX IF NOT EXISTS idx_lines_storyboard ON storyboard_lines (storyboard_id, line_no)`,
  `CREATE INDEX IF NOT EXISTS idx_lines_episode ON storyboard_lines (episode_id, start_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_line_takes_line ON line_takes (line_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_line_takes_active ON line_takes (line_id) WHERE is_active = 1`,
  `CREATE INDEX IF NOT EXISTS idx_line_takes_episode_status ON line_takes (episode_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_voice_samples_voice ON voice_samples (voice_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_line_tombstones_origin ON line_tombstones (episode_id, origin_key)`,
  `CREATE INDEX IF NOT EXISTS idx_audio_assets_episode ON episode_audio_assets (episode_id, kind, source_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_mix_revisions_episode ON mix_revisions (episode_id, revision_no)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mix_revisions_current ON mix_revisions (episode_id) WHERE is_current = 1`,
  `CREATE INDEX IF NOT EXISTS idx_episode_exports_episode ON episode_exports (episode_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_episode_exports_current ON episode_exports (episode_id, kind) WHERE is_current = 1`,
  `CREATE INDEX IF NOT EXISTS idx_dubbing_jobs_episode ON dubbing_jobs (episode_id, kind, status)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_status ON pipeline_jobs (status, resource, priority)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_episode ON pipeline_jobs (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_script_chapters_import ON script_chapters (import_id, chapter_index)`,
]

/**
 * 风格预设种子数据 — value 存入 dramas.style，prompt 注入生图提示词（作为前缀拼接）
 *
 * prompt 统一按多维结构书写，保证跨模型/跨镜头的风格控制力：
 *   核心媒介与渲染 → 线条/造型 → 上色/材质 → 光影 → 色彩调性 → 背景处理 → 画质锚点 → avoid 禁忌项
 */
export const stylePresetSeeds = [
  {
    name: '3D 漫剧', value: '3d', sortOrder: 1,
    prompt: 'high-quality 3D CG animation still, modern game-engine cinematic render, Unreal Engine and Pixar grade quality, semi-realistic stylized characters with refined facial features, clean sculpted anatomy, detailed skin shader with subtle subsurface scattering, PBR materials with crisp detailed textures, volumetric cinematic lighting with soft rim light, rich depth of field, polished film color grading, detailed environment art, sharp focus, consistent character design across shots, avoid flat lighting, avoid plastic waxy skin, avoid low-poly blurry look, avoid 2D flat cel shading, avoid anime line art',
    description: '游戏引擎级 3D 渲染，半写实角色，当前短剧主流的 3D 漫剧质感',
  },
  {
    name: '日漫赛璐璐', value: 'anime', sortOrder: 2,
    prompt: 'Japanese TV anime style, clean cel shading with hard-edged shadow shapes, crisp uniform black line art, vivid saturated color palette, expressive large-eyed character design with on-model proportions, detailed hand-painted anime backgrounds, dramatic anime key lighting with screentone highlights, key-visual poster quality, consistent character design across shots, avoid 3D CGI look, avoid painterly soft blending, avoid watercolor texture, avoid photorealism, avoid thick western comic outlines',
    description: '日式赛璐璐动画风格',
  },
  {
    name: '吉卜力手绘', value: 'ghibli', sortOrder: 3,
    prompt: 'Studio Ghibli hand-drawn animation style, soft painterly brushwork with organic hand-crafted line quality, lush warm watercolor painted backgrounds, gentle natural daylight with nostalgic warm glow, muted earthy natural color palette, whimsical cozy storybook atmosphere, subtle film-grain softness, theatrical background art quality, consistent character design across shots, avoid hard cel shading, avoid 3D render look, avoid neon over-saturated colors, avoid sharp digital edges, avoid photorealism',
    description: '吉卜力手绘治愈风',
  },
  {
    name: '水彩绘本', value: 'watercolor', sortOrder: 4,
    prompt: 'delicate watercolor storybook illustration, soft translucent color washes, visible cold-press paper texture, fluid hand-painted brushstrokes with gentle pigment bleeds, light airy atmosphere, harmonious pastel palette, whimsical children book charm, loose expressive edges, consistent character design across shots, avoid bold black outlines, avoid digital airbrush look, avoid harsh contrast, avoid 3D rendering, avoid photorealism',
    description: '水彩插画质感',
  },
  {
    name: '美式漫画', value: 'comic', sortOrder: 5,
    prompt: 'Western graphic-novel comic book style, bold confident black ink outlines, halftone dot shading and screentone gradients, dynamic saturated colors with dramatic contrast, dramatic spotlight lighting, flat graphic print look, sharp inking details, dynamic cinematic composition, consistent character design across shots, avoid painterly soft blending, avoid watercolor washes, avoid photorealistic rendering, avoid 3D CGI look, avoid anime cel shading',
    description: '美式漫画粗线条风格',
  },
  {
    name: '国风 2.5D', value: 'guofeng', sortOrder: 7,
    prompt: 'Chinese guofeng 2.5D illustration style, semi-realistic donghua-quality character art, elegant flowing line work, rich traditional Chinese aesthetic elements, layered ink-wash inspired atmospheric backgrounds, refined silk and fabric textures, soft luminous lighting with gentle haze, sophisticated muted jewel-tone palette, xianxia drama poster quality, consistent character design across shots, avoid flat cel shading, avoid western comic ink style, avoid photorealism, avoid plastic 3D look, avoid modern clothing and props unless specified',
    description: '国风动画/仙侠剧质感，2.5D 半写实',
  },
  {
    name: '韩系网漫', value: 'webtoon', sortOrder: 8,
    prompt: 'Korean webtoon manhwa style, clean digital painting with soft gradient shading, slim elegant character proportions, large expressive eyes with detailed highlights, soft glowing skin rendering, romantic dreamy lighting, modern pastel-to-vivid color palette, detailed fashion and fabric rendering, webtoon key visual quality, consistent character design across shots, avoid heavy black ink outlines, avoid halftone dots, avoid 3D render look, avoid watercolor paper texture, avoid chibi proportions',
    description: '韩国条漫/网漫精致上色风',
  },
  {
    name: '黑白漫画', value: 'noir', sortOrder: 9,
    prompt: 'black and white manga illustration, high-contrast monochrome ink work, dynamic hatching and cross-hatching shading, bold solid blacks with dramatic negative space, screentone gray gradation, expressive confident ink linework, cinematic noir lighting, professional manga page quality, consistent character design across shots, strictly no color, avoid grayscale blur smudging, avoid painterly soft edges, avoid photorealism, avoid 3D render look',
    description: '黑白漫/ Noir 高对比墨水风',
  },
]

/**
 * 旧版种子 prompt（v1 一句话风格描述）— 用于内容寻址升级：
 * 仅当库中行的 prompt 仍等于旧种子值（未被用户在设置页编辑过）才覆盖为新 prompt
 */
const LEGACY_SEED_PROMPTS: Record<string, string> = {
  '3d': '3D CG animation style, game-engine quality render, semi-realistic stylized characters, refined facial features, detailed materials and textures, cinematic lighting, high detail',
  anime: 'Japanese anime style, cel shading, clean crisp line art, vivid saturated colors, expressive character designs, detailed painted backgrounds',
  ghibli: 'Studio Ghibli style, hand-drawn animation, soft watercolor painted backgrounds, warm nostalgic lighting, gentle natural palette, whimsical cozy atmosphere',
  watercolor: 'watercolor illustration style, soft translucent washes, visible paper texture, delicate fluid brushwork, light airy atmosphere, hand-painted storybook feel',
  comic: 'Western comic book style, bold black ink outlines, halftone dot shading, dynamic saturated colors, dramatic contrast lighting, flat graphic novel look',
}

/**
 * 已下架的种子预设 — 内容寻址删除：仅当库中行的 prompt 仍是种子原文
 * （未被用户编辑过）才删除；用户改过的同名行视为用户数据保留。
 * live（真人写实）：真人影像过不了平台真人内容审核，下架。
 */
const REMOVED_SEED_PROMPTS: Record<string, string> = {
  live: 'ultra-realistic cinematic live-action look, professional film photography, natural skin tones with detailed pores and realistic texture, true human anatomy and proportions, shallow depth of field with creamy bokeh, cinematic three-point lighting, subtle film grain, 35mm lens cinematic framing, true-to-life color grading, detailed real-world environments, consistent actor appearance across shots, avoid cartoon or anime features, avoid 3D render look, avoid illustration style, avoid plastic waxy skin, avoid over-smoothing beauty filter',
}

// INSERT ... SELECT WHERE NOT EXISTS → 幂等：只补缺失行，不覆盖用户编辑
// （SQLite 无 FROM DUAL，无 FROM 的 SELECT 合法）
const SEED_SQL = 'INSERT INTO style_presets ("name", "value", "prompt", "description", "sort_order", "is_active", "created_at", "updated_at") SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM style_presets WHERE value = ?)'
// 内容寻址升级：命中旧种子原文才更新（用户在设置页改过的行不动）
const UPGRADE_SQL = 'UPDATE style_presets SET "name" = ?, "prompt" = ?, "description" = ?, "sort_order" = ?, "updated_at" = ? WHERE "value" = ? AND "prompt" = ?'
// 内容寻址下架：命中下架种子原文才删除
const REMOVE_SQL = 'DELETE FROM style_presets WHERE "value" = ? AND "prompt" = ?'

/**
 * SQLite 不能直接移除 NOT NULL：按官方流程在事务内重建 storyboard_lines。
 * 只在旧库的 storyboard_id 仍为 NOT NULL 时执行；行数不一致或外键校验失败即回滚。
 */
function rebuildStoryboardLinesIfNeeded(sqlite: Database.Database) {
  const columns = sqlite.prepare('PRAGMA table_info(storyboard_lines)').all() as { name: string; notnull: number }[]
  const storyboardId = columns.find((column) => column.name === 'storyboard_id')
  if (!storyboardId || storyboardId.notnull === 0) return

  const names = columns.map((column) => `"${column.name}"`)
  const before = Number((sqlite.prepare('SELECT COUNT(*) AS count FROM storyboard_lines').get() as { count: number }).count)
  sqlite.pragma('foreign_keys = OFF')
  try {
    sqlite.transaction(() => {
      sqlite.exec('DROP TABLE IF EXISTS storyboard_lines_rebuild')
      sqlite.exec(storyboardLinesDdl('storyboard_lines_rebuild').replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE'))
      sqlite.exec(`INSERT INTO storyboard_lines_rebuild (${names.join(', ')}) SELECT ${names.join(', ')} FROM storyboard_lines`)
      sqlite.exec('DROP TABLE storyboard_lines')
      sqlite.exec('ALTER TABLE storyboard_lines_rebuild RENAME TO storyboard_lines')
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_lines_storyboard ON storyboard_lines (storyboard_id, line_no)')
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_lines_episode ON storyboard_lines (episode_id, start_ms)')
      const after = Number((sqlite.prepare('SELECT COUNT(*) AS count FROM storyboard_lines').get() as { count: number }).count)
      if (after !== before) throw new Error(`storyboard_lines 重建前后行数不一致：${before} → ${after}`)
    })()
    const violations = sqlite.prepare('PRAGMA foreign_key_check').all()
    if (violations.length > 0) throw new Error('storyboard_lines 重建后外键校验失败')
  } finally {
    sqlite.pragma('foreign_keys = ON')
  }
}

export function initSqliteSchema(sqlite: Database.Database) {
  for (const statement of sqliteSchemaStatements) {
    sqlite.exec(statement)
  }
  // 兼容已安装的桌面版；仅增加任务恢复元数据，不改写历史生成结果。
  const taskColumns = new Set((sqlite.prepare('PRAGMA table_info(sys_task)').all() as { name: string }[]).map(c => c.name))
  for (const [name, type] of Object.entries({ config_id: 'INTEGER', config_base_url: 'TEXT', stage: 'TEXT', error_code: 'TEXT', transition_id: 'INTEGER' })) {
    if (!taskColumns.has(name)) sqlite.exec(`ALTER TABLE sys_task ADD COLUMN ${name} ${type}`)
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_sys_task_transition_id ON sys_task (transition_id)')
  // 角色音色由用户上传；旧库补充可空字段，不修改已有角色和图片。
  const characterColumns = new Set((sqlite.prepare('PRAGMA table_info(characters)').all() as { name: string }[]).map(c => c.name))
  for (const name of ['voice_audio_url', 'voice_audio_name']) {
    if (!characterColumns.has(name)) sqlite.exec(`ALTER TABLE characters ADD COLUMN ${name} TEXT`)
  }
  // 场景参考图（生成场景图时的参考图，不替换场景成图）；旧库补列，不动已有数据。
  const sceneColumns = new Set((sqlite.prepare('PRAGMA table_info(scenes)').all() as { name: string }[]).map(c => c.name))
  if (!sceneColumns.has('reference_images')) sqlite.exec('ALTER TABLE scenes ADD COLUMN reference_images TEXT')
  // 项目级媒体存储目录（绝对路径）；旧库补列，null 表示使用默认目录。
  const dramaColumns = new Set((sqlite.prepare('PRAGMA table_info(dramas)').all() as { name: string }[]).map(c => c.name))
  if (!dramaColumns.has('storage_dir')) sqlite.exec('ALTER TABLE dramas ADD COLUMN storage_dir TEXT')
  // 项目背景（世界观/时代/地域），提示词生成时自动拼接；旧库补列，历史项目为空不受影响。
  if (!dramaColumns.has('background')) sqlite.exec('ALTER TABLE dramas ADD COLUMN background TEXT')
  // 视觉背景（场景/光影/色彩），仅注入视频提示词；旧库补列，历史项目为空不受影响。
  if (!dramaColumns.has('visual_background')) sqlite.exec('ALTER TABLE dramas ADD COLUMN visual_background TEXT')
  // 全自动流水线状态：旧库补列；历史集 automation_status 为 null，按「未启用自动化」处理。
  const episodeColumns = new Set((sqlite.prepare('PRAGMA table_info(episodes)').all() as { name: string }[]).map(c => c.name))
  const episodeAutomationColumns: Record<string, string> = {
    auto_pipeline: 'INTEGER DEFAULT 0',
    automation_status: 'TEXT',
    automation_stage: 'TEXT',
    automation_progress: 'INTEGER DEFAULT 0',
    automation_note: 'TEXT',
    automation_error: 'TEXT',
    automation_started_at: 'TEXT',
    automation_finished_at: 'TEXT',
  }
  for (const [name, type] of Object.entries(episodeAutomationColumns)) {
    if (!episodeColumns.has(name)) sqlite.exec(`ALTER TABLE episodes ADD COLUMN ${name} ${type}`)
  }

  // ===== V2 列扩展：只加列，不改旧列，历史数据保持原样 =====
  // 配音状态、字幕与单集 BGM/原声策略
  const episodeDubColumns: Record<string, string> = {
    auto_dub: 'INTEGER DEFAULT 0',
    dub_status: 'TEXT',
    dub_progress: 'INTEGER DEFAULT 0',
    dub_note: 'TEXT',
    subtitle_url: 'TEXT',
    video_audio_mode: "TEXT DEFAULT 'auto'",
    bgm_url: 'TEXT',
  }
  for (const [name, type] of Object.entries(episodeDubColumns)) {
    if (!episodeColumns.has(name)) sqlite.exec(`ALTER TABLE episodes ADD COLUMN ${name} ${type}`)
  }
  // 激活音色的只读缓存，供角色列表展示；不参与配音解析
  for (const name of ['voice_prompt', 'voice_status']) {
    if (!characterColumns.has(name)) sqlite.exec(`ALTER TABLE characters ADD COLUMN ${name} TEXT`)
  }
  // 合片/混音多版本与幂等判断
  const mergeColumns = new Set((sqlite.prepare('PRAGMA table_info(video_merges)').all() as { name: string }[]).map(c => c.name))
  const mergeV2Columns: Record<string, string> = {
    kind: "TEXT DEFAULT 'concat'",
    source_hash: 'TEXT',
    subtitle_url: 'TEXT',
    dialogue_track_url: 'TEXT',
    bgm_url: 'TEXT',
    mix_options: 'TEXT',
    transitions: 'TEXT',
  }
  for (const [name, type] of Object.entries(mergeV2Columns)) {
    if (!mergeColumns.has(name)) sqlite.exec(`ALTER TABLE video_merges ADD COLUMN ${name} ${type}`)
  }
  // 过渡提示词来源：旧库补列；历史提示词保留，来源为空按旧记录展示。
  const transitionColumns = new Set((sqlite.prepare('PRAGMA table_info(video_transitions)').all() as { name: string }[]).map(c => c.name))
  if (!transitionColumns.has('prompt_source')) sqlite.exec('ALTER TABLE video_transitions ADD COLUMN prompt_source TEXT')
  // 分镜内容指纹：台词抽取幂等
  const storyboardColumns = new Set((sqlite.prepare('PRAGMA table_info(storyboards)').all() as { name: string }[]).map(c => c.name))
  if (!storyboardColumns.has('source_hash')) sqlite.exec('ALTER TABLE storyboards ADD COLUMN source_hash TEXT')
  if (!storyboardColumns.has('transition')) sqlite.exec("ALTER TABLE storyboards ADD COLUMN transition TEXT DEFAULT 'cut'")
  if (!storyboardColumns.has('continuity')) sqlite.exec('ALTER TABLE storyboards ADD COLUMN continuity TEXT')
  // 台词时间段覆盖：旧库补列；为空时仍按分镜时长自动排布。
  const lineColumns = new Set((sqlite.prepare('PRAGMA table_info(storyboard_lines)').all() as { name: string }[]).map(c => c.name))
  if (!lineColumns.has('voice_start_ms')) sqlite.exec('ALTER TABLE storyboard_lines ADD COLUMN voice_start_ms INTEGER')
  if (!lineColumns.has('voice_duration_ms')) sqlite.exec('ALTER TABLE storyboard_lines ADD COLUMN voice_duration_ms INTEGER')
  // ===== 配音工作台：台词锚点/排序/修订字段；旧库重建为 storyboard_id 可空 =====
  const workbenchLineColumns: Record<string, string> = {
    anchor_type: "TEXT DEFAULT 'shot'",
    sort_order: 'INTEGER DEFAULT 0',
    origin_key: 'TEXT',
    text_revision: 'INTEGER DEFAULT 1',
    audio_stale: 'INTEGER DEFAULT 0',
    active_take_id: 'INTEGER',
    deleted_at: 'TEXT',
    direction: 'TEXT',
  }
  for (const [name, type] of Object.entries(workbenchLineColumns)) {
    if (!lineColumns.has(name)) {
      sqlite.exec(`ALTER TABLE storyboard_lines ADD COLUMN ${name} ${type}`)
      lineColumns.add(name)
    }
  }
  rebuildStoryboardLinesIfNeeded(sqlite)
  // 多轨混音增量字段：只加可空列/带默认值列，历史轨道与片段保持可读。
  const trackColumns = new Set((sqlite.prepare('PRAGMA table_info(episode_audio_tracks)').all() as { name: string }[]).map(c => c.name))
  const trackWorkbenchColumns: Record<string, string> = {
    role: 'TEXT',
    pan: 'REAL DEFAULT 0',
    bus_id: 'INTEGER',
    locked: 'INTEGER DEFAULT 0',
    hidden: 'INTEGER DEFAULT 0',
    color: 'TEXT',
    height: 'INTEGER DEFAULT 72',
    stem_asset_id: 'INTEGER',
    duck_attack_ms: 'INTEGER DEFAULT 20',
    duck_release_ms: 'INTEGER DEFAULT 250',
  }
  for (const [name, type] of Object.entries(trackWorkbenchColumns)) {
    if (!trackColumns.has(name)) sqlite.exec(`ALTER TABLE episode_audio_tracks ADD COLUMN ${name} ${type}`)
  }
  const clipColumns = new Set((sqlite.prepare('PRAGMA table_info(episode_audio_clips)').all() as { name: string }[]).map(c => c.name))
  const clipWorkbenchColumns: Record<string, string> = {
    asset_id: 'INTEGER',
    gain_db: 'REAL DEFAULT 0',
    pan: 'REAL DEFAULT 0',
    fade_curve: "TEXT DEFAULT 'linear'",
    locked: 'INTEGER DEFAULT 0',
    muted: 'INTEGER DEFAULT 0',
    name: 'TEXT',
    color: 'TEXT',
    take_id: 'INTEGER',
    follow_take: 'INTEGER DEFAULT 1',
    loop: 'INTEGER DEFAULT 0',
  }
  for (const [name, type] of Object.entries(clipWorkbenchColumns)) {
    if (!clipColumns.has(name)) sqlite.exec(`ALTER TABLE episode_audio_clips ADD COLUMN ${name} ${type}`)
  }
  if (!episodeColumns.has('mix_revision_id')) sqlite.exec('ALTER TABLE episodes ADD COLUMN mix_revision_id INTEGER')
  if (!episodeColumns.has('last_extract_at')) sqlite.exec('ALTER TABLE episodes ADD COLUMN last_extract_at TEXT')
  // 项目级旁白音色与默认 BGM
  if (!dramaColumns.has('narrator_voice_id')) sqlite.exec('ALTER TABLE dramas ADD COLUMN narrator_voice_id INTEGER')
  if (!dramaColumns.has('bgm_url')) sqlite.exec('ALTER TABLE dramas ADD COLUMN bgm_url TEXT')

  // ===== V3 列扩展：小说来源与故事圣经 =====
  if (!dramaColumns.has('source_novel_id')) sqlite.exec('ALTER TABLE dramas ADD COLUMN source_novel_id INTEGER')
  if (!dramaColumns.has('story_bible')) sqlite.exec('ALTER TABLE dramas ADD COLUMN story_bible TEXT')
  const novelEpisodeColumns: Record<string, string> = {
    source_chapter_no: 'INTEGER',
    source_part_no: 'INTEGER',
    source_stale: 'INTEGER DEFAULT 0',
  }
  for (const [name, type] of Object.entries(novelEpisodeColumns)) {
    if (!episodeColumns.has(name)) sqlite.exec(`ALTER TABLE episodes ADD COLUMN ${name} ${type}`)
  }

  // ===== V3-D 视频制作双模式：旧库补列，默认原生模式 =====
  const videoModeColumns: Record<string, string> = {
    video_mode: "TEXT DEFAULT 'native'",
    comfyui_config_id: 'INTEGER',
    comfyui_workflow_json: 'TEXT',
  }
  for (const [name, type] of Object.entries(videoModeColumns)) {
    if (!episodeColumns.has(name)) sqlite.exec(`ALTER TABLE episodes ADD COLUMN ${name} ${type}`)
  }
  // 小说故事坐标：旧库先加列再回填，避免被新库默认值 first 覆盖历史作品。
  const novelColumns = new Set((sqlite.prepare('PRAGMA table_info(novels)').all() as { name: string }[]).map((c) => c.name))
  if (!novelColumns.has('narrative_person')) {
    sqlite.exec('ALTER TABLE novels ADD COLUMN narrative_person TEXT')
    sqlite.exec("UPDATE novels SET narrative_person = 'third_limited' WHERE narrative_person IS NULL")
  }
  if (!novelColumns.has('timeline_events')) sqlite.exec('ALTER TABLE novels ADD COLUMN timeline_events TEXT')
  if (!novelColumns.has('world_map')) sqlite.exec('ALTER TABLE novels ADD COLUMN world_map TEXT')
  if (!novelColumns.has('background')) sqlite.exec('ALTER TABLE novels ADD COLUMN background TEXT')
  if (!novelColumns.has('writing_style')) sqlite.exec('ALTER TABLE novels ADD COLUMN writing_style TEXT')
  // 剧集素材关联：先清掉旧库可能存在的重复行，再建唯一索引，防止并发自动关联重复写入。
  for (const [table, assetColumn] of [
    ['episode_characters', 'character_id'],
    ['episode_scenes', 'scene_id'],
    ['episode_props', 'prop_id'],
  ]) {
    sqlite.exec(`DELETE FROM ${table} WHERE id NOT IN (SELECT MIN(id) FROM ${table} GROUP BY episode_id, ${assetColumn})`)
    sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_unique ON ${table} (episode_id, ${assetColumn})`)
  }
  // ===== 配音工作台回填：旧音频生成首个 Take、轨道 role、每集默认总线 =====
  const nowIso = new Date().toISOString()
  sqlite.prepare(
    `INSERT INTO line_takes (
       line_id, episode_id, drama_id, take_no, text, speak_text, text_revision, voice_id,
       params_json, context_mode, audio_url, duration_ms, hash, status, is_active, created_at
     )
     SELECT l.id, l.episode_id, l.drama_id, 1, l.text, l.speak_text, COALESCE(l.text_revision, 1), l.voice_id,
            NULL, 'off', l.audio_url, l.audio_duration_ms, l.audio_hash, 'ready', 1, COALESCE(l.updated_at, ?)
     FROM storyboard_lines l
     WHERE l.audio_url IS NOT NULL AND l.status = 'ready' AND l.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM line_takes t WHERE t.line_id = l.id AND t.is_active = 1)`,
  ).run(nowIso)
  sqlite.exec(
    `UPDATE storyboard_lines
     SET active_take_id = (SELECT t.id FROM line_takes t WHERE t.line_id = storyboard_lines.id AND t.is_active = 1)
     WHERE deleted_at IS NULL AND active_take_id IS NULL
       AND EXISTS (SELECT 1 FROM line_takes t WHERE t.line_id = storyboard_lines.id AND t.is_active = 1)`,
  )
  sqlite.exec(
    `UPDATE episode_audio_tracks
     SET role = CASE kind
       WHEN 'voice' THEN 'dialogue'
       WHEN 'ambience' THEN 'ambience'
       WHEN 'sfx' THEN 'sfx'
       WHEN 'bgm' THEN 'bgm'
       WHEN 'custom' THEN 'custom'
       ELSE 'custom'
     END
     WHERE role IS NULL`,
  )
  const defaultBuses = [
    { key: 'dialogue', name: '对白', ducking: 0, lufs: -16, ceiling: null },
    { key: 'original', name: '原声', ducking: 1, lufs: null, ceiling: null },
    { key: 'sfx', name: '音效', ducking: 0, lufs: null, ceiling: null },
    { key: 'bgm', name: '配乐', ducking: 1, lufs: null, ceiling: null },
    { key: 'master', name: '总输出', ducking: 0, lufs: -16, ceiling: -1.5 },
  ]
  const insertBus = sqlite.prepare(
    `INSERT INTO audio_buses (
       episode_id, key, name, volume, muted, solo, ducking, duck_ratio, duck_attack_ms, duck_release_ms,
       lufs_target, limiter_ceiling, created_at, updated_at
     )
     SELECT e.id, ?, ?, 1, 0, 0, ?, 6, 20, 250, ?, ?, ?, ?
     FROM episodes e
     WHERE NOT EXISTS (SELECT 1 FROM audio_buses b WHERE b.episode_id = e.id AND b.key = ?)`,
  )
  for (const bus of defaultBuses) {
    insertBus.run(bus.key, bus.name, bus.ducking, bus.lufs, bus.ceiling, nowIso, nowIso, bus.key)
  }

  const insertSeed = sqlite.prepare(SEED_SQL)
  const upgradeSeed = sqlite.prepare(UPGRADE_SQL)
  const removeSeed = sqlite.prepare(REMOVE_SQL)
  for (const s of stylePresetSeeds) {
    const ts = new Date().toISOString()
    insertSeed.run(s.name, s.value, s.prompt, s.description, s.sortOrder, ts, ts, s.value)
    const legacyPrompt = LEGACY_SEED_PROMPTS[s.value]
    if (legacyPrompt) {
      const res = upgradeSeed.run(s.name, s.prompt, s.description, s.sortOrder, ts, s.value, legacyPrompt)
      if (res.changes > 0) console.log(`🎨 风格预设「${s.name}」已升级为结构化提示词`)
    }
  }
  for (const [value, prompt] of Object.entries(REMOVED_SEED_PROMPTS)) {
    const res = removeSeed.run(value, prompt)
    if (res.changes > 0) console.log(`🗑️ 风格预设「${value}」已下架`)
  }
}
