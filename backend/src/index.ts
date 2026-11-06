import 'dotenv/config'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import path from 'path'
import { fileURLToPath } from 'url'

import dramas from './routes/dramas.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import tasks from './routes/tasks.js'
import upload from './routes/upload.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import stylePresets from './routes/stylePresets.js'
import prompts from './routes/prompts.js'
import agent from './routes/agent.js'
import merge from './routes/merge.js'
import skills from './routes/skills.js'
import props from './routes/props.js'
import settings from './routes/settings.js'
import storage from './routes/storage.js'
import mcpRoute from './routes/mcp.js'
import pipelineRules from './routes/pipelineRules.js'
import serverUpdate from './routes/serverUpdate.js'
import projectFiles from './routes/project-files.js'
import voices, { characterVoices } from './routes/voices.js'
import ttsRoute from './routes/tts.js'
import lines, { episodeLines } from './routes/lines.js'
import takes from './routes/takes.js'
import dubbing from './routes/dubbing.js'
import audioTracks from './routes/audio-tracks.js'
import audioPeaks from './routes/audio-peaks.js'
import mix from './routes/mix.js'
import exportsRoute from './routes/exports.js'
import edit from './routes/edit.js'
import grid from './routes/grid.js'
import scriptImport from './routes/scriptImport.js'
import jobs from './routes/jobs.js'
import bgm from './routes/bgm.js'
import novels from './routes/novels.js'
import novelImports from './routes/novelImports.js'
import novelJobs from './routes/novelJobs.js'
import { requestLogger, errorHandler } from './middleware/logger.js'
import { resumeInterruptedTasks } from './services/generation.js'
import { initMcp, setMcpMainApp } from './services/mcp.js'
import { markInterruptedAutomations, setAutomationApp } from './services/automation.js'
import { markInterruptedNovelJobs } from './services/novel-job-runner.js'
import { migrateUploadedVoices } from './services/voice-profile.js'
import { startQueueWorker } from './services/queue-worker.js'
import { refreshFfmpegConfig } from './utils/ffmpeg.js'
import { DATA_ROOT } from './utils/paths.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

const app = new Hono()

// Middleware
app.use('*', cors({
  origin: ['http://localhost:3013', 'http://localhost:5679'],
  credentials: true,
}))
app.use('*', requestLogger)
app.use('*', errorHandler)

// Health check（version 供部署巡检/更新检查核对当前运行版本）
app.get('/api/v1/health', (c) => c.json({
  status: 'ok',
  version: process.env.HUOBAO_VERSION || undefined,
  timestamp: new Date().toISOString(),
}))

// API routes
const api = new Hono()
api.route('/dramas', dramas)
api.route('/episodes', episodes)
api.route('/storyboards', storyboards)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/tasks', tasks)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/style-presets', stylePresets)
api.route('/prompts', prompts)
api.route('/agent', agent)
api.route('/merge', merge)
api.route('/skills', skills)
api.route('/props', props)
api.route('/storage', storage)
api.route('/settings', settings)
api.route('/server-update', serverUpdate)
api.route('/mcp', mcpRoute)
api.route('/pipeline-rules', pipelineRules)
// V2 新增路由：M0 先按契约挂载（501/503），后续里程碑逐项替换实现
api.route('/voices', voices)
api.route('/tts', ttsRoute)
api.route('/characters', characterVoices)
api.route('/lines', lines)
api.route('/episodes', episodeLines)
// Take 路由：/lines/:id/takes、/takes/:id、/episodes/:id/takes/batch|status
api.route('/', takes)
// 根路径挂载以匹配设计：/episodes/:id/dub、/episodes/:id/subtitles、/jobs/:id
api.route('/', dubbing)
// 多轨混音：/episodes/:id/audio/tracks、/audio/preview
api.route('/', audioTracks)
// 波形 peaks：/episodes/:id/audio/peaks
api.route('/', audioPeaks)
// 原声分离、素材与混音计划：/episodes/:id/audio/separate、/episodes/:id/mix
api.route('/', mix)
// 导出：/episodes/:id/export-checks、/episodes/:id/exports、/exports/:id
api.route('/', exportsRoute)
// 剪辑工作台聚合状态：GET /episodes/:id/edit（M1 只读）
api.route('/', edit)
// 兼容 M0 的 /dubbing 前缀
api.route('/dubbing', dubbing)
api.route('/grid', grid)
api.route('/script-import', scriptImport)
api.route('/', scriptImport)
api.route('/jobs', jobs)
api.route('/bgm', bgm)
api.route('/novels', novelImports)
api.route('/novels', novels)
api.route('/novel-jobs', novelJobs)

app.route('/api/v1', api)

// Serve static files (storage)
// 项目媒体先走自定义解析（支持任意磁盘 + Range）；未命中再回落到历史全局目录。
app.route('/static/projects', projectFiles)
// 生成的图片/视频按 uuid 命名、内容不变，标记为 immutable 让浏览器长缓存
app.use('/static/*', async (c, next) => {
  await next()
  if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable')
})
app.use('/static/*', serveStatic({ root: DATA_ROOT }))

// Serve frontend (production build) — 桌面版由主进程注入 FRONTEND_DIST（resources/frontend）
const distPath = process.env.FRONTEND_DIST || path.join(projectRoot, 'frontend', 'dist')
app.use('*', serveStatic({ root: distPath }))
app.get('*', serveStatic({ root: distPath, path: 'index.html' }))


// 本地运行时兜底：Node 的 undici 在第三方服务异常断开时会抛断言（非业务错误），
// 这里捕获后记录日志，避免整个服务进程退出（浏览器会显示「服务器异常」）。
process.on('uncaughtException', (err) => {
  console.error('[guard] uncaughtException:', err?.message || err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[guard] unhandledRejection:', (reason as any)?.message || reason)
})

const port = Number(process.env.PORT || 5679)
// 桌面版只监听回环（无鉴权，绝不能暴露到局域网）；服务器/Docker 默认仍为 0.0.0.0
const hostname = process.env.HOST || (process.env.HUOBAO_DESKTOP === '1' ? '127.0.0.1' : '0.0.0.0')
console.log(`🚀 Huobao Drama TS server on http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}`)

await resumeInterruptedTasks()
// 上次进程遗留的自动化标为中断（生成任务恢复后再判断，避免与 recover 冲突）
await markInterruptedAutomations()
// V3 小说任务：进程重启后 running 一律标为 interrupted，可从前端续跑
markInterruptedNovelJobs()
// V1 已上传的角色音色迁移为 character_voices（幂等，失败不影响启动）
migrateUploadedVoices()

// 应用设置中的自定义 FFmpeg 目录（db 已注入读取器），启动即生效
refreshFfmpegConfig()

// MCP / 自动化都通过内部 app.fetch 调 REST，先注入实例
setMcpMainApp(app)
setAutomationApp(app)
await initMcp()
startQueueWorker()

serve({ fetch: app.fetch, port, hostname })
