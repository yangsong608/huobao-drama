/**
 * P7 写路径覆盖审计（§0.2）：
 * 每个入口标注写入对象、事件方式（统一中间件 / 显式补发 / 轮询兜底）与兜底路由。
 * 直接 service 写入必须有显式事件或轮询兜底；已由中间件覆盖的 service 不得重复发事件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = path.join(backendRoot, 'src')

type EventMode = 'middleware' | 'explicit' | 'polling'

interface CoverageEntry {
  id: string
  category: 'internal-rest' | 'direct-service'
  entry: string
  files: string[]
  writes: string
  event: EventMode
  fallback?: { file: string; token: string; note: string }
  note?: string
  /** 该文件没有直连写入旁路，可用于“中间件覆盖即不重复”的源码检查 */
  cleanOfExplicit?: boolean
}

const entries: CoverageEntry[] = [
  {
    id: 'internal-rest:mcp',
    category: 'internal-rest',
    entry: 'MCP 工具调内部 REST（app.fetch）',
    files: ['services/mcp.ts'],
    writes: '各业务资源（剧集/分镜/任务等）',
    event: 'middleware',
    cleanOfExplicit: true,
  },
  {
    id: 'internal-rest:automation-generation',
    category: 'internal-rest',
    entry: '自动化 callApi → mainApp.fetch',
    files: ['services/automation.ts'],
    writes: '资产生图/视频任务、脚本导入',
    event: 'middleware',
  },
  {
    id: 'internal-rest:video-batch-submit',
    category: 'internal-rest',
    entry: '批量视频 internalApp.fetch → /api/v1/tasks',
    files: ['services/video-batch.ts'],
    writes: '视频生成任务',
    event: 'middleware',
    cleanOfExplicit: true,
  },
  {
    id: 'direct:automation-progress',
    category: 'direct-service',
    entry: 'automation.updateProgress / finishRun',
    files: ['services/automation.ts'],
    writes: 'episodes.automation_status/stage/progress/note/error',
    event: 'polling',
    fallback: {
      file: 'routes/episodes.ts',
      token: "app.get('/:id/automation'",
      note: '自动化面板轮询任务状态；进度为高频字段，按 M12 不走 SSE',
    },
  },
  {
    id: 'direct:automation-content',
    category: 'direct-service',
    entry: 'automation 各步骤直写业务表（改写/提取/声音/分镜/提示词/检验/配音）',
    files: ['services/automation.ts'],
    writes: 'episodes.script_content、characters/scenes/props、character_voices、storyboards、storyboard_lines',
    event: 'explicit',
    note: '每步结束统一补发一次 /api/v1/episodes/:id，避免逐镜逐资产刷屏',
  },
  {
    id: 'direct:automation-dub',
    category: 'direct-service',
    entry: 'automation.stepDub 直接启动配音',
    files: ['services/automation.ts'],
    writes: 'dubbing_jobs / episode_lines（配音启动与台词分配）',
    event: 'explicit',
    note: '配音步骤结束后统一补发 /api/v1/episodes/:id；配音进度仍由配音页轮询',
  },
  {
    id: 'direct:generation-writeback',
    category: 'direct-service',
    entry: 'generation 任务完成回写（图片/视频/过渡/整集）',
    files: ['services/generation.ts'],
    writes: 'storyboards.first/last_frame_image/video_url、characters/scenes/props.image_url、video_transitions、video_merges',
    event: 'explicit',
    note: '任务完成回调不走 REST，按任务归属资源补发一次',
  },
  {
    id: 'direct:task-progress',
    category: 'direct-service',
    entry: 'job-queue.updateJobProgress / heartbeat',
    files: ['services/job-queue.ts'],
    writes: 'pipeline_jobs.progress/status',
    event: 'polling',
    fallback: {
      file: 'routes/jobs.ts',
      token: "app.get('/:id'",
      note: '任务中心轮询作业详情与统计',
    },
  },
  {
    id: 'direct:queue-worker',
    category: 'direct-service',
    entry: 'queue-worker 领取/完成/失败作业与配音启动',
    files: ['services/queue-worker.ts', 'services/job-queue.ts'],
    writes: 'pipeline_jobs.status、dubbing_jobs、episodes.automation_*',
    event: 'polling',
    fallback: {
      file: 'routes/jobs.ts',
      token: "app.get('/stats'",
      note: '作业状态轮询；配音启动另发显式事件，整集配音进度仍由配音页轮询',
    },
  },
  {
    id: 'direct:video-batch-worker',
    category: 'direct-service',
    entry: 'video-batch worker 推进批次与条目',
    files: ['services/video-batch.ts'],
    writes: 'video_batch_jobs / video_batch_items',
    event: 'polling',
    fallback: {
      file: 'routes/episodes.ts',
      token: "app.get('/:id/video-batch'",
      note: '剧集页轮询最新批次进度',
    },
  },
  {
    id: 'direct:storyboard-split',
    category: 'direct-service',
    entry: 'storyboard-split-jobs worker',
    files: ['services/storyboard-split-jobs.ts'],
    writes: 'storyboards、storyboard_characters/props、storyboard_split_jobs',
    event: 'explicit',
    note: '任务终态补发 /api/v1/episodes/:id；任务进度仍由拆分对话框轮询',
  },
  {
    id: 'direct:storyboard-audit',
    category: 'direct-service',
    entry: 'storyboard-audit-jobs worker / 自动修复',
    files: ['services/storyboard-audit-jobs.ts', 'services/storyboard-audit-repair.ts'],
    writes: 'storyboards、video_transitions、storyboard_audit_jobs',
    event: 'explicit',
    note: '任务终态补发 /api/v1/episodes/:id；任务进度仍由检验面板轮询',
  },
  {
    id: 'direct:merge',
    category: 'direct-service',
    entry: 'ffmpeg-merge 合并与成片指针',
    files: ['services/ffmpeg-merge.ts'],
    writes: 'video_merges、episodes.current_film_id/video_url',
    event: 'polling',
    fallback: {
      file: 'routes/merge.ts',
      token: "app.get('/episodes/:id/merge'",
      note: '合并由 POST 同步 await，请求级事件已覆盖；配音内触发的合并由合并状态轮询兜底',
    },
  },
  {
    id: 'direct:export',
    category: 'direct-service',
    entry: 'export-service 后台导出与成片投影',
    files: ['services/export-service.ts'],
    writes: 'episode_exports、video_merges、episodes.video_url/current_film_id',
    event: 'explicit',
    note: '导出记录状态由导出列表轮询；视频投影完成补发 /api/v1/episodes/:id',
  },
  {
    id: 'direct:novel-job',
    category: 'direct-service',
    entry: 'novel-job-runner 后台写作',
    files: ['services/novel-job-runner.ts'],
    writes: 'novels / novel_chapters / novel_jobs',
    event: 'explicit',
    note: '任务终态补发 /api/v1/novels/:id；任务进度沿用状态轮询与 /novel-jobs/:id/stream',
  },
  {
    id: 'direct:task-engine',
    category: 'direct-service',
    entry: 'generation 任务引擎状态写入',
    files: ['services/generation.ts'],
    writes: 'sys_task.status/progress/result',
    event: 'polling',
    fallback: {
      file: 'routes/tasks.ts',
      token: "app.get('/:id'",
      note: '任务进度保持现有轮询（M12），不走 SSE',
    },
  },
  {
    id: 'direct:grid-get-sync',
    category: 'direct-service',
    entry: 'grid-image.syncGridSheet（GET 触发落库）',
    files: ['services/grid-image.ts'],
    writes: 'grid_sheets.image_url/status',
    event: 'explicit',
    note: 'GET 不经过写事件中间件，状态变化时显式补发',
  },
  {
    id: 'direct:audio-assets',
    category: 'direct-service',
    entry: 'audio-separation / soundscape 后台资产写入',
    files: ['services/audio-separation.ts', 'services/soundscape.ts'],
    writes: 'episode_audio_assets / audio_tracks / dubbing_jobs、wav 文件',
    event: 'polling',
    fallback: {
      file: 'routes/mix.ts',
      token: "app.get('/episodes/:id/audio/separate/status'",
      note: '分离任务状态轮询；混音台打开时随状态刷新素材，其他页面手动刷新',
    },
  },
]

const REQUIRED_IDS = [
  'internal-rest:mcp',
  'internal-rest:automation-generation',
  'internal-rest:video-batch-submit',
  'direct:automation-progress',
  'direct:automation-content',
  'direct:automation-dub',
  'direct:generation-writeback',
  'direct:task-progress',
  'direct:queue-worker',
  'direct:video-batch-worker',
  'direct:storyboard-split',
  'direct:storyboard-audit',
  'direct:merge',
  'direct:export',
  'direct:novel-job',
  'direct:task-engine',
  'direct:grid-get-sync',
  'direct:audio-assets',
]

function read(relative: string): string {
  return fs.readFileSync(path.join(backendRoot, relative), 'utf8')
}

test('审计表覆盖 §0.2 全部类别，且每个入口文件存在', () => {
  const ids = new Set(entries.map(entry => entry.id))
  for (const id of REQUIRED_IDS) assert.ok(ids.has(id), `缺少写路径类别：${id}`)
  for (const entry of entries) {
    for (const file of entry.files) {
      assert.ok(fs.existsSync(path.join(srcRoot, file)), `入口文件不存在：${file}`)
    }
    assert.ok(entry.writes.trim().length > 0, `${entry.id} 未标注写入对象`)
  }
  const categories = new Set(entries.map(entry => entry.category))
  assert.deepEqual([...categories].sort(), ['direct-service', 'internal-rest'])
})

test('直接 service 写入必须有显式事件或轮询兜底，兜底路由真实存在', () => {
  for (const entry of entries.filter(item => item.category === 'direct-service')) {
    assert.notEqual(entry.event, 'middleware', `${entry.id} 直连写入不能依赖中间件`)
    if (entry.event === 'polling') {
      assert.ok(entry.fallback, `${entry.id} 缺少轮询兜底`)
      const source = fs.readFileSync(path.join(srcRoot, entry.fallback!.file), 'utf8')
      assert.ok(source.includes(entry.fallback!.token), `${entry.id} 兜底路由不存在：${entry.fallback!.token}`)
      assert.ok(entry.fallback!.note.trim().length > 0, `${entry.id} 缺少兜底说明`)
    }
    if (entry.event === 'explicit') {
      const sources = entry.files.map(file => fs.readFileSync(path.join(srcRoot, file), 'utf8')).join('\n')
      assert.ok(sources.includes('emitChange('), `${entry.id} 标注显式发事件但未找到 emitChange`)
      assert.ok(entry.note && entry.note.trim().length > 0, `${entry.id} 缺少显式事件说明`)
    }
  }
})

test('中间件统一挂载，未在业务路由逐个手写事件', () => {
  const indexSource = read('src/index.ts')
  assert.ok(indexSource.includes("api.use('*', syncEventMiddleware)"))
  assert.ok(indexSource.includes("import { syncEventMiddleware } from './middleware/sync-events.js'"))

  const routeDir = path.join(srcRoot, 'routes')
  const offenders = fs.readdirSync(routeDir)
    .filter(name => name.endsWith('.ts'))
    .filter(name => fs.readFileSync(path.join(routeDir, name), 'utf8').includes('emitChange('))
  assert.deepEqual(offenders, [], '业务路由不应手写 emitChange')

  const bridgeSource = read('src/services/remote-bridge-pipeline.ts')
  assert.ok(!bridgeSource.includes('syncEventMiddleware'), '桥入口不重复挂载事件中间件')
})

test('内部 REST 已覆盖的 service 不重复发事件', () => {
  const middlewareCovered = entries.filter(entry => entry.event === 'middleware' && entry.cleanOfExplicit)
  assert.ok(middlewareCovered.length >= 2)
  for (const entry of middlewareCovered) {
    for (const file of entry.files) {
      const source = fs.readFileSync(path.join(srcRoot, file), 'utf8')
      assert.ok(!source.includes('emitChange('), `${file} 既走内部 REST 又显式发事件，会重复`)
    }
  }
})
