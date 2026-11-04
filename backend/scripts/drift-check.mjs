#!/usr/bin/env node
/**
 * V2/V3 计划/设计偏离检查
 *
 * 用法：node scripts/drift-check.mjs
 *
 * 检查三类内容：
 *   1. 计划状态：docs/v2-state.json 记录已完成的任务，对应的产物必须存在
 *   2. 设计契约：数据库新表/新列、路由挂载、守卫测试命名
 *   3. 未到里程碑的能力不得提前出现（例如 M3 前仍是 6 阶段、M5 前仍是 29 个 MCP 工具）
 *
 * 只读检查，不改任何文件。退出码 0 = 未发现偏离；1 = 有阻塞偏离。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const backend = join(root, 'backend')
const read = (p) => readFileSync(join(root, p), 'utf8')
const exists = (p) => existsSync(join(root, p))

const problems = []
const warnings = []
const ok = []

function must(condition, message) {
  if (condition) ok.push(message)
  else problems.push(message)
}

// ---------- 1. 计划状态文件 ----------
const statePath = 'docs/v2-state.json'
must(exists(statePath), '计划状态文件存在')
if (!exists(statePath)) {
  console.error('缺少 docs/v2-state.json，无法判断当前里程碑')
  process.exit(1)
}
const state = JSON.parse(read(statePath))
const completed = new Set(state.completed ?? [])
must(exists(state.plan), `计划文档存在：${state.plan}`)
must(exists(state.design), `设计文档存在：${state.design}`)

// V3 进行中时，能力基线以 v3-state 为准（例如 MCP 工具数在 P4-4 由 40 增至 41）
const v3StatePath = 'docs/v3-state.json'
const v3State = exists(v3StatePath) ? JSON.parse(read(v3StatePath)) : null
if (v3State) {
  must(exists(v3State.plan), `V3 计划文档存在：${v3State.plan}`)
  must(exists(v3State.design), `V3 设计文档存在：${v3State.design}`)
  must(Array.isArray(v3State.completed), 'V3 状态记录 completed 数组')
}

// ---------- 2. 已完成任务的产物 ----------
const TASK_ARTIFACTS = {
  'M0-1': ['.git'],
  'M0-2': ['backend/scripts/preflight.ts'],
  'M0-3': ['backend/tests/audio-tts-boundary.test.mjs', 'backend/tests/grid-boundary.test.mjs'],
  'M0-4': [
    'backend/src/db/sqlite-schema.ts',
    'backend/src/db/schema.ts',
    'backend/src/routes/voices.ts',
    'backend/src/routes/lines.ts',
    'backend/src/routes/dubbing.ts',
    'backend/src/routes/grid.ts',
    'backend/src/routes/scriptImport.ts',
    'backend/src/services/app-settings.ts',
  ],
  'A-1': [],
  'A-2': ['backend/src/services/adapters/qwen-tts.ts', 'backend/tests/qwen-tts.test.ts'],
  'A-3': ['backend/src/services/tts.ts'],
  'A-4': [
    'backend/src/services/dialogue-lines.ts',
    'backend/tests/dialogue-lines.test.ts',
    'backend/scripts/dialogue-apply.ts',
  ],
  'A-5': [
    'backend/src/services/timeline.ts',
    'backend/src/services/audio-mix.ts',
    'backend/tests/timeline.test.ts',
    'backend/tests/audio-mix.test.ts',
  ],
  'A-6': [
    'backend/scripts/dub-preview.ts',
    'backend/src/services/subtitles.ts',
    'backend/tests/subtitles.test.ts',
  ],
  'M1-1': [
    'backend/src/services/voice-profile.ts',
    'backend/tests/voice-profile.test.ts',
  ],
  'M1-2': ['backend/src/routes/voices.ts'],
  'M1-3': [
    'backend/src/services/voice-design.ts',
    'backend/src/services/text-call.ts',
  ],
  'M1-5': ['frontend/app/components/VoiceProfilePanel.vue'],
  'M2-1': ['backend/src/services/dialogue-lines.ts'],
  'M2-2': ['backend/src/routes/lines.ts'],
  'M2-6': [
    'backend/src/services/dubbing.ts',
    'backend/src/routes/dubbing.ts',
  ],
  'M2-3': ['backend/src/services/timeline.ts'],
  'M2-4': ['backend/src/services/subtitles.ts'],
  'M4-1': ['backend/src/services/motion-post.ts'],
  'M4-2': ['backend/src/services/grid-image.ts', 'backend/src/routes/grid.ts', 'backend/tests/grid-image.test.ts'],
  'M5-1': ['backend/src/services/job-queue.ts', 'backend/tests/job-queue.test.ts'],
  'M5-2': ['backend/src/services/queue-worker.ts', 'backend/src/routes/jobs.ts'],
  'M5-3': ['backend/src/services/script-import.ts', 'backend/src/routes/scriptImport.ts', 'backend/tests/script-import.test.ts'],
}
for (const task of completed) {
  for (const artifact of TASK_ARTIFACTS[task] ?? []) {
    must(exists(artifact), `${task} 产物存在：${artifact}`)
  }
}

// ---------- 3. 设计契约：数据库 ----------
const dbPath = join(root, 'data/huobao.sqlite3')
if (exists('data/huobao.sqlite3')) {
  try {
    const out = execFileSync('npx', ['tsx', 'scripts/verify-schema.ts', dbPath], {
      cwd: backend,
      encoding: 'utf8',
      timeout: 60_000,
    })
    ok.push(`数据库契约：${out.trim().split('\n').pop()}`)
  } catch (err) {
    problems.push(`数据库契约不符合设计：${(err.stdout || err.message).toString().trim().split('\n').slice(-2).join(' / ')}`)
  }
} else {
  warnings.push('未找到 data/huobao.sqlite3，跳过数据库契约校验')
}

// ---------- 4. 设计契约：路由与开关 ----------
const indexTs = read('backend/src/index.ts')
for (const route of ['/voices', '/lines', '/dubbing', '/grid', '/script-import']) {
  must(indexTs.includes(`api.route('${route}'`), `路由已挂载：${route}`)
}
const appSettings = read('backend/src/services/app-settings.ts')
must(appSettings.includes("dubbing.enabled"), '配音开关 dubbing.enabled 已定义')
must(appSettings.includes('isDubbingEnabled'), '配音开关读取函数存在')

// ---------- 5. 旧实现不得回归（设计明确删除） ----------
const FORBIDDEN = [
  ['backend/src/services/adapters/tts-generation.ts', '旧 tts-generation 不得回归'],
  ['backend/src/services/adapters/minimax-tts.ts', 'MiniMax TTS 适配器不得回归'],
  ['backend/src/routes/aiVoices.ts', '旧 aiVoices 路由不得回归'],
  ['backend/src/services/grid-split.ts', '旧 grid-split 不得回归'],
]
for (const [file, label] of FORBIDDEN) must(!exists(file), label)

// ---------- 6. 已完成里程碑的能力断言 ----------
const aiTs = read('backend/src/services/ai.ts')
const aiConfigsTs = read('backend/src/routes/aiConfigs.ts')

if (completed.has('A-1')) {
  must(/\|\s*'audio'/.test(aiTs), "A-1：ServiceType 已包含 'audio'")
  must(/audio:\s*\[[^\]]*'qwen3-tts'[^\]]*\]/.test(aiTs), 'A-1：audio 注册本地 qwen3-tts')
  must(/audio:\s*\[[^\]]*'aliyun'[^\]]*\]/.test(aiTs), 'A-1：audio 注册阿里云云语音')
  must(/audio:\s*\[[^\]]*'volcengine'[^\]]*\]/.test(aiTs), 'A-1：audio 注册火山云语音')
  must(/audio:\s*\[[^\]]*'openai-compatible'[^\]]*\]/.test(aiTs), 'A-1：audio 注册 OpenAI 兼容本地语音')
  must(/qwen3-tts/.test(aiConfigsTs), 'A-1：配置探测已接入 qwen3-tts')
  must(/\/health/.test(aiConfigsTs), 'A-1：音频探测走 /health')
}

if (completed.has('A-3')) {
  const tts = read('backend/src/services/tts.ts')
  must(/export async function synthesize/.test(tts), 'A-3：合成入口存在')
  must(/sha256/.test(tts), 'A-3：内容寻址缓存')
  must(/ffprobe/.test(tts), 'A-3：时长由 ffprobe 实测')
}

if (completed.has('A-4')) {
  const lines = read('backend/src/services/dialogue-lines.ts')
  must(/export function parseVideoPrompt/.test(lines), 'A-4：video_prompt 解析入口存在')
  must(/旁白\|画外音/.test(lines), 'A-4：裸旁白规则存在')
}

if (completed.has('A-5')) {
  const timeline = read('backend/src/services/timeline.ts')
  const mix = read('backend/src/services/audio-mix.ts')
  must(/export function buildTimeline/.test(timeline), 'A-5：时间轴入口存在')
  must(/MAX_ATEMPO = 1\.12/.test(timeline), 'A-5：atempo 上限 1.12')
  must(/sidechaincompress/.test(mix), 'A-5：原声被 sidechain 压低')
  must(/normalize=0/.test(mix), 'A-5：amix 不自动衰减')
  must(/loudnorm=I=\$\{options\.targetLufs\}/.test(mix), 'A-5：混音图挂 loudnorm')
  must(/targetLufs\s*\?\?\s*-16/.test(mix), 'A-5：目标响度默认 −16 LUFS')
}

if (completed.has('A-6')) {
  const script = read('backend/scripts/dub-preview.ts')
  must(/mixEpisodeAudio/.test(script), 'A-6：预览导出调用混音')
  must(/toSrt/.test(script), 'A-6：预览导出生成 SRT')
  must(/mergeEpisodeVideos/.test(script), 'A-6：合片与镜头不一致时自动重拼')
}

if (completed.has('M1-2')) {
  const voices = read('backend/src/routes/voices.ts')
  must(/voice-profile/.test(voices), 'M1-2：角色音色档案端点')
  must(/voice-clone/.test(voices), 'M1-2：克隆端点')
  must(/voice-sample/.test(voices), 'M1-2：试听端点')
  must(/voice-sync/.test(voices), 'M1-2：同步视频参考端点')
}

if (completed.has('M1-3')) {
  const design = read('backend/src/services/voice-design.ts')
  const rules = read('backend/src/services/pipeline-rules.ts')
  must(/design_instruct/.test(design), 'M1-3：英文 design_instruct')
  must(/templateProfile/.test(design), 'M1-3：LLM 失败回退模板')
  must(/'voice\.design'/.test(rules), 'M1-4：voice.design 规则已注册')
}

if (completed.has('M1-6')) {
  const tts = read('backend/src/services/tts.ts')
  must(/MAX_AUDIO_BYTES/.test(tts), 'M1-6：单次音频体积上限')
  must(/type: 'audio'/.test(tts), 'M1-6：失败落 audio 任务记录')
}

if (completed.has('M2-2')) {
  const lines = read('backend/src/routes/lines.ts')
  must(/lines\/extract/.test(lines), 'M2-2：台词重抽端点')
  must(/lines\/synthesize/.test(lines), 'M2-2：批量合成端点')
}

if (completed.has('M2-6')) {
  const dub = read('backend/src/services/dubbing.ts')
  must(/ensureMergedVideo/.test(dub), 'M2-6：配音前确保合片')
  must(/sourceHash/.test(dub), 'M2-6：混音版本 source_hash')
  must(/subtitleMode/.test(dub), 'M2-6：字幕模式参与混音')
  const mix = read('backend/src/services/audio-mix.ts')
  must(/'-t', durationSec/.test(mix), 'M2-6：成片时长用 -t 而非 -shortest')
}

// ---------- 6.5 小说故事坐标 ----------
{
  const storyAtlas = read('backend/src/services/novel/story-atlas.ts')
  const storyAtlasStore = read('backend/src/services/novel/story-atlas-store.ts')
  const promptIndex = read('backend/src/services/novel/prompts/index.ts')
  const promptArchitecture = read('backend/src/services/novel/prompts/architecture.ts')
  const promptChapter = read('backend/src/services/novel/prompts/chapter.ts')
  const novelRoutes = read('backend/src/routes/novels.ts')
  const runner = read('backend/src/services/novel-job-runner.ts')
  const sqliteSchema = read('backend/src/db/sqlite-schema.ts')
  const blueprint = read('backend/src/services/novel/blueprint.ts')

  must(storyAtlas.includes('normalizeTimelineEvents'), '故事坐标：时间线归一化存在')
  must(storyAtlas.includes('normalizeWorldMap'), '故事坐标：世界地图归一化存在')
  must(storyAtlasStore.includes('StoryAtlasConflictError'), '故事坐标：409 冲突类型存在')
  must(promptIndex.includes("NOVEL_PROMPT_VERSION = '1.2.0'"), '提示词版本为 1.2.0')
  must(promptChapter.includes('chapterTimeline'), '章节时间线提示词存在')
  must(promptArchitecture.includes('worldMap'), '世界地图提示词存在')
  must(novelRoutes.includes('story-atlas'), '故事坐标路由存在')
  must(novelRoutes.includes('blueprint/chapters'), '旁白 PATCH 路由存在')
  must(runner.includes("'atlas'"), 'atlas 任务类型存在')
  must(sqliteSchema.includes('narrative_person'), 'novels 含 narrative_person')
  must(sqliteSchema.includes('timeline_events'), 'novels 含 timeline_events')
  must(sqliteSchema.includes('world_map'), 'novels 含 world_map')
  must(blueprint.includes('narration'), '大纲含旁白字段')
}

// ---------- 7. 未到里程碑的能力不得提前落地 ----------
{
  const mcpTs = read('backend/src/services/mcp.ts')
  const tools = [...mcpTs.matchAll(/^\s+name: '/gm)].length
  const expectedMcpTools = v3State?.currentMetrics?.mcpTools
    ?? (completed.has('M5-5') ? 40 : state.baseline.mcpTools)
  must(tools === expectedMcpTools, `MCP 工具数与状态记录一致（期望 ${expectedMcpTools}，当前 ${tools}）`)
}
if (completed.has('M3-2')) {
  const automation = read('backend/src/services/automation.ts')
  must(/'voices'/.test(automation), 'M3-2：自动化含 voices 阶段')
  must(/'dub'/.test(automation), 'M3-2：自动化含 dub 阶段')
  const weights = [...automation.matchAll(/^\s+(rewrite|extract|voices|asset_images|storyboards|video_prompts|videos|dub):\s*(\d+)/gm)]
    .reduce((sum, m) => sum + Number(m[2]), 0)
  must(weights === 100, `M3-2：八阶段权重合计 100（当前 ${weights}）`)
} else {
  const automation = read('backend/src/services/automation.ts')
  must(!automation.includes("'voices'"), 'M3 前 automation 不出现 voices 阶段')
  must(!automation.includes("'dub'"), 'M3 前 automation 不出现 dub 阶段')
}

if (completed.has('M3-1')) {
  must(exists('frontend/app/components/DubbingWorkbench.vue'), 'M3-1：配音工作台组件存在')
}

if (completed.has('M4-2')) {
  must(/splitGridSheet/.test(read('backend/src/routes/grid.ts')), 'M4-2：宫格切分接口')
}
if (completed.has('M4-3')) {
  must(/audioMode/.test(read('backend/src/services/automation.ts')), 'M4-3：automation 传递 ambient 声音模式')
  must(/ambient/.test(read('backend/src/services/adapters/minimax-video.ts')), 'M4-3：shim 请求带 audio_mode')
}

// ---------- 7. 输出 ----------
console.log(`\nV2/V3 偏离检查｜V2 ${state.current}｜V3 ${v3State?.current ?? '未启用'}｜已完成 ${completed.size} 个 V2 任务`)
console.log('-'.repeat(70))
for (const line of ok) console.log(`  PASS  ${line}`)
for (const line of warnings) console.log(`  WARN  ${line}`)
for (const line of problems) console.log(`  FAIL  ${line}`)
console.log('-'.repeat(70))
console.log(`PASS ${ok.length}｜WARN ${warnings.length}｜FAIL ${problems.length}`)

if (problems.length) {
  console.error('\n存在偏离：先修复 FAIL 项，或更新 docs/v2-state.json / docs/v3-state.json 说明原因。')
  process.exit(1)
}
console.log('未发现偏离计划与设计的情况。')
