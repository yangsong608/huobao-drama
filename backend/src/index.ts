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
import storyboardFrameAssets from './routes/storyboardFrameAssets.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import tasks from './routes/tasks.js'
import upload from './routes/upload.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import stylePresets from './routes/stylePresets.js'
import prompts from './routes/prompts.js'
import knowledge from './routes/knowledge.js'
import planning from './routes/planning.js'
import agent from './routes/agent.js'
import merge from './routes/merge.js'
import skills from './routes/skills.js'
import props from './routes/props.js'
import settings from './routes/settings.js'
import storage from './routes/storage.js'
import mcpRoute from './routes/mcp.js'
import pipelineRules from './routes/pipelineRules.js'
import breakdownMethods from './routes/breakdownMethods.js'
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
import films from './routes/films.js'
import remoteRoutes from './routes/remote.js'
import syncRoutes from './routes/sync.js'
import presenceRoutes from './routes/presence.js'
import pipelines from './routes/pipelines.js'
import { createRemoteBridgePipeline } from './services/remote-bridge-pipeline.js'
import { authenticateRemoteDevice, startRemoteDeviceCleanup, touchRemoteDevice } from './services/remote-devices.js'
import { startPresenceCleanup } from './services/presence.js'
import { getRemoteBridgeStatus, setRemoteBridgeFetch } from './services/remote-bridge.js'
import { requestLogger, errorHandler } from './middleware/logger.js'
import { syncEventMiddleware } from './middleware/sync-events.js'
import { resumeInterruptedTasks } from './services/generation.js'
import { initMcp, setMcpMainApp } from './services/mcp.js'
import { markInterruptedAutomations, setAutomationApp } from './services/automation.js'
import { markInterruptedNovelJobs } from './services/novel-job-runner.js'
import { markInterruptedStoryboardSplits } from './services/storyboard-split-jobs.js'
import { markInterruptedStoryboardPipelines } from './services/storyboard-pipeline.js'
import { recoverInterruptedStoryboardAuditJobs } from './services/storyboard-audit-jobs.js'
// 注册修复回滚钩子：中断修复/复查阶段前先按快照回滚本轮修复
import './services/storyboard-audit-repair.js'
import { markInterruptedDubs } from './services/dubbing.js'
import { markInterruptedTakes } from './services/line-takes.js'
import { markInterruptedAudioJobs } from './services/audio-job-recovery.js'
import { markInterruptedMerges } from './services/ffmpeg-merge.js'
import { migrateUploadedVoices } from './services/voice-profile.js'
import { ensureBreakdownMethodsSeeded } from './services/breakdown-methods.js'
import { ensureKnowledgeIndex, ensureDirectorKnowledgeAssignment } from './agents/knowledge.js'
import { ensurePipelineSeeds } from './services/pipeline-chain.js'
import { startQueueWorker } from './services/queue-worker.js'
import { resumeVideoBatches, setVideoBatchApp, startVideoBatchWorker } from './services/video-batch.js'
import { logTaskWarn } from './utils/task-logger.js'
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
// 写请求成功后广播同步事件（远程/同步/在线状态自身接口除外）
api.use('*', syncEventMiddleware)
api.route('/dramas', dramas)
api.route('/episodes', episodes)
api.route('/storyboards', storyboards)
// 分镜末帧资产：/episodes/:id/frame-assets、/storyboards/:id/frame-assets/last、/storyboards/:id/first-frame
api.route('/', storyboardFrameAssets)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/tasks', tasks)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/style-presets', stylePresets)
api.route('/prompts', prompts)
api.route('/knowledge', knowledge)
api.route('/planning', planning)
api.route('/agent', agent)
api.route('/merge', merge)
api.route('/skills', skills)
api.route('/props', props)
api.route('/storage', storage)
api.route('/settings', settings)
api.route('/server-update', serverUpdate)
api.route('/mcp', mcpRoute)
api.route('/pipeline-rules', pipelineRules)
api.route('/breakdown-methods', breakdownMethods)
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
// 成片中心：/episodes/:id/films、/films/:id、/episodes/:id/exports/:exportId/project-film
api.route('/', films)
// 链式分镜流水线：模板、步骤、规则包、运行与 trace
api.route('/pipelines', pipelines)
// 远程接力：本机管理、公开配对与会话
api.route('/remote', remoteRoutes)
// 跨端同步：SSE 事件流与轮询降级
api.route('/sync', syncRoutes)
// 在线状态：心跳上报与按角色过滤的在线列表
api.route('/presence', presenceRoutes)

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
// 整集配音为进程内任务，重启后 running 状态无法续跑，标为中断
markInterruptedDubs()
// 语音 Take / 混音作业 / 成片合并同样是进程内任务，重启后未完成行收敛为 failed
markInterruptedTakes()
markInterruptedAudioJobs()
markInterruptedMerges()
// V3 小说任务：进程重启后 running 一律标为 interrupted，可从前端续跑
markInterruptedNovelJobs()
// 分镜分块拆分：进程重启后 running 任务标为 interrupted，前端可从断点继续
markInterruptedStoryboardSplits()
markInterruptedStoryboardPipelines()
// 分镜动作检验：进程重启后未完成任务标为中断，修复/复查阶段先按快照回滚
await recoverInterruptedStoryboardAuditJobs()
// V1 已上传的角色音色迁移为 character_voices（幂等，失败不影响启动）
migrateUploadedVoices()
// 分镜拆分方案：内置方案按 key 幂等补齐，已有编辑不覆盖；失败不影响启动
try {
  await ensureBreakdownMethodsSeeded()
} catch (error) {
  logTaskWarn('BreakdownMethod', '内置拆分方案播种失败，按标准规范运行', { error: String(error) })
}
// Agent 专用知识库索引：首次启动补齐；已有分配不覆盖
try {
  await ensureKnowledgeIndex()
} catch (error) {
  logTaskWarn('Knowledge', '知识库索引初始化失败', { error: String(error) })
}
// 4.0.38 新增导演 Agent；存量 workspace 的索引是 copy-once，补一次默认知识分配
try {
  await ensureDirectorKnowledgeAssignment()
} catch (error) {
  logTaskWarn('Knowledge', '导演知识分配迁移失败', { error: String(error) })
}
// 链式分镜流水线：内置链/插件/规则包按 key 幂等播种
try {
  await ensurePipelineSeeds()
} catch (error) {
  logTaskWarn('PipelineChain', '内置链播种失败', { error: String(error) })
}

// 应用设置中的自定义 FFmpeg 目录（db 已注入读取器），启动即生效
refreshFfmpegConfig()

// MCP / 自动化 / 批量视频都通过内部 app.fetch 调 REST，先注入实例
setMcpMainApp(app)
setAutomationApp(app)
setVideoBatchApp(app)

// 远程桥：委托回同一 Hono 应用；来源 IP 取自监听 socket，供限流与设备记录
const remoteBridgePipeline = createRemoteBridgePipeline({
  appFetch: (request) => app.fetch(request),
  origin: () => getRemoteBridgeStatus().urls[0] || null,
  authenticate: (token) => authenticateRemoteDevice(token),
  touch: (record, ip) => { touchRemoteDevice(record, ip) },
})
setRemoteBridgeFetch((request, env) => {
  const raw = env?.incoming?.socket?.remoteAddress || ''
  const clientIp = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  return remoteBridgePipeline(request, clientIp || undefined)
})
startRemoteDeviceCleanup()
startPresenceCleanup()

await initMcp()
startQueueWorker()
// 批量视频：先恢复上次批次（接管已提交任务、回队未提交项），再启动 3 秒调度
await resumeVideoBatches()
startVideoBatchWorker()

serve({ fetch: app.fetch, port, hostname })
