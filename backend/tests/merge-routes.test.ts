/**
 * 成片软删除：最新成片状态接口不得返回已删除记录。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-merge-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { eq } = await import('drizzle-orm')
const { default: mergeRoute } = await import('../src/routes/merge.ts')
const { transitionSourceHash } = await import('../src/services/transition-plan.ts')
const auditSvc = await import('../src/services/storyboard-audit-jobs.ts')

const app = new Hono()
app.route('/api/v1/merge', mergeRoute)

const ts = '2026-03-01T00:00:00.000Z'
let seq = 0

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function insertDrama(): number {
  const res = db.insert(schema.dramas).values({
    title: `成片测试${++seq}`,
    style: '3d',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertEpisode(dramaId: number): number {
  const res = db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '第1集',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertMerge(episodeId: number, patch: Record<string, unknown> = {}): number {
  const res = db.insert(schema.videoMerges).values({
    episodeId,
    title: '成片',
    provider: 'local',
    model: 'ffmpeg',
    status: 'completed',
    mergedUrl: 'https://cdn.local/final.mp4',
    createdAt: ts,
    ...patch,
  }).run()
  return Number(res.lastInsertRowid)
}

test('最新成片状态接口忽略已软删除的记录', async () => {
  const episodeId = insertEpisode(insertDrama())
  insertMerge(episodeId, { title: '旧成片', createdAt: '2026-03-01T00:00:00.000Z' })
  insertMerge(episodeId, { title: '已删除成片', createdAt: '2026-03-01T00:01:00.000Z', deletedAt: ts })

  const response = await app.fetch(new Request(`http://localhost/api/v1/merge/episodes/${episodeId}/merge`))
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data.title, '旧成片')
})

test('全部成片都被软删除时状态接口返回 null', async () => {
  const episodeId = insertEpisode(insertDrama())
  insertMerge(episodeId, { title: '仅一条', deletedAt: ts })

  const response = await app.fetch(new Request(`http://localhost/api/v1/merge/episodes/${episodeId}/merge`))
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data, null)
})

function writeStatic(relativePath: string, content = 'placeholder'): string {
  const absolute = path.join(root, relativePath)
  fsSync.mkdirSync(path.dirname(absolute), { recursive: true })
  fsSync.writeFileSync(absolute, content)
  return absolute
}

function insertStoryboard(episodeId: number, storyboardNumber: number, videoUrl: string): number {
  const res = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber,
    duration: 2000,
    videoUrl,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function sourceHashFor(fromUrl: string, toUrl: string): string {
  const from = fsSync.statSync(path.join(root, fromUrl))
  const to = fsSync.statSync(path.join(root, toUrl))
  return transitionSourceHash({
    fromVideoUrl: fromUrl,
    toVideoUrl: toUrl,
    fromSize: from.size,
    fromMtimeMs: Math.round(from.mtimeMs),
    toSize: to.size,
    toMtimeMs: Math.round(to.mtimeMs),
  })
}

function insertTransitionRow(
  episodeId: number,
  dramaId: number,
  fromStoryboardId: number,
  toStoryboardId: number,
  patch: Record<string, unknown> = {},
): number {
  const res = db.insert(schema.videoTransitions).values({
    episodeId,
    dramaId,
    fromStoryboardId,
    toStoryboardId,
    status: 'pending',
    enabled: true,
    createdAt: ts,
    updatedAt: ts,
    ...patch,
  }).run()
  return Number(res.lastInsertRowid)
}

async function waitMergeRow(mergeId: number, timeoutMs = 20000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let row: any = null
  while (Date.now() < deadline) {
    row = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).get()
    if (row?.status === 'completed' || row?.status === 'failed') return row
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return row
}

test('GET 断点列表包含已完成与处理中，缺失断点标记 missing', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const urls = [1, 2, 3].map(n => `static/projects/${dramaId}/videos/s${n}.mp4`)
  urls.forEach(url => writeStatic(url))
  const [s1, s2, s3] = urls.map((url, index) => insertStoryboard(episodeId, index + 1, url))
  const transitionUrl = `static/projects/${dramaId}/transitions/t1.mp4`
  writeStatic(transitionUrl)
  insertTransitionRow(episodeId, dramaId, s1, s2, {
    status: 'completed',
    videoUrl: transitionUrl,
    durationActual: 3,
    sourceHash: sourceHashFor(urls[0], urls[1]),
    prompt: '镜头从雨夜街角平滑推进到咖啡馆门口。',
    promptSource: 'ai',
  })
  insertTransitionRow(episodeId, dramaId, s2, s3, { status: 'processing', sourceHash: '' })

  const response = await app.fetch(new Request(
    `http://localhost/api/v1/merge/episodes/${episodeId}/transitions?storyboard_ids=${s1},${s2},${s3}`,
  ))
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data.boundaries.length, 2)
  assert.equal(body.data.boundaries[0].status, 'completed')
  assert.equal(body.data.boundaries[0].video_url, transitionUrl)
  assert.equal(body.data.boundaries[0].from_number, 1)
  assert.equal(body.data.boundaries[0].to_number, 2)
  assert.equal(body.data.boundaries[0].stale, false)
  assert.equal(body.data.boundaries[0].prompt, '镜头从雨夜街角平滑推进到咖啡馆门口。')
  assert.equal(body.data.boundaries[0].prompt_source, 'ai')
  assert.equal(body.data.boundaries[1].status, 'processing')
  assert.equal(body.data.summary.ready, 1)
  assert.equal(body.data.summary.processing, 1)
  assert.equal(body.data.summary.missing, 0)
})

test('未生成过渡的断点在列表中返回 missing 且统计正确', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const urls = [1, 2].map(n => `static/projects/${dramaId}/videos/s${n}.mp4`)
  urls.forEach(url => writeStatic(url))
  urls.forEach((url, index) => insertStoryboard(episodeId, index + 1, url))

  const response = await app.fetch(new Request(`http://localhost/api/v1/merge/episodes/${episodeId}/transitions`))
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data.boundaries.length, 1)
  assert.equal(body.data.boundaries[0].status, 'missing')
  assert.equal(body.data.boundaries[0].id, null)
  assert.equal(body.data.summary.missing, 1)
})

test('prepare 路由校验剧集、参数与模型配置', async () => {
  const missingResponse = await app.fetch(new Request(
    'http://localhost/api/v1/merge/episodes/99999/transitions/prepare',
    { method: 'POST', body: JSON.stringify({}) },
  ))
  assert.equal(missingResponse.status, 400)
  assert.match((await missingResponse.json() as any).message, /剧集不存在/)

  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const urls = [1, 2].map(n => `static/projects/${dramaId}/videos/s${n}.mp4`)
  urls.forEach(url => writeStatic(url))
  const [s1] = urls.map((url, index) => insertStoryboard(episodeId, index + 1, url))

  const base = `http://localhost/api/v1/merge/episodes/${episodeId}/transitions/prepare`
  const post = (payload: Record<string, unknown>) => app.fetch(new Request(base, {
    method: 'POST',
    body: JSON.stringify(payload),
  }))

  const single = await post({ storyboard_ids: [s1] })
  assert.equal(single.status, 400)
  assert.match((await single.json() as any).message, /至少需要两个/)

  const badConfig = await post({ config_id: 'abc' })
  assert.equal(badConfig.status, 400)
  assert.match((await badConfig.json() as any).message, /config_id/)

  const badMode = await post({ mode: 'everything' })
  assert.equal(badMode.status, 400)
  assert.match((await badMode.json() as any).message, /mode/)

  const badDuration = await post({ duration: 0 })
  assert.equal(badDuration.status, 400)
  assert.match((await badDuration.json() as any).message, /duration/)

  const badTextConfig = await post({ text_config_id: 'abc' })
  assert.equal(badTextConfig.status, 400)
  assert.match((await badTextConfig.json() as any).message, /text_config_id/)

  const emptyBoundaries = await post({ boundaries: [] })
  assert.equal(emptyBoundaries.status, 400)
  assert.match((await emptyBoundaries.json() as any).message, /boundaries/)

  const badBoundaries = await post({ boundaries: [{ from_storyboard_id: 'x', to_storyboard_id: 2 }] })
  assert.equal(badBoundaries.status, 400)
  assert.match((await badBoundaries.json() as any).message, /boundaries/)

  const noConfig = await post({ text_config_id: 3, text_model: 'qwen-vl-max' })
  assert.equal(noConfig.status, 400)
  assert.match((await noConfig.json() as any).message, /未配置视频模型/)
})

test('retry 拒绝运行中与失效配置，skip 标记跳过', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const urls = [1, 2].map(n => `static/projects/${dramaId}/videos/s${n}.mp4`)
  urls.forEach(url => writeStatic(url))
  const [s1, s2] = urls.map((url, index) => insertStoryboard(episodeId, index + 1, url))

  const processingId = insertTransitionRow(episodeId, dramaId, s1, s2, { status: 'processing' })
  const retryProcessing = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${processingId}/retry`, { method: 'POST' },
  ))
  assert.equal(retryProcessing.status, 400)
  assert.match((await retryProcessing.json() as any).message, /运行中/)

  const badRetryText = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${processingId}/retry`,
    { method: 'POST', body: JSON.stringify({ text_config_id: 'abc' }) },
  ))
  assert.equal(badRetryText.status, 400)
  assert.match((await badRetryText.json() as any).message, /text_config_id/)

  const failedDramaId = insertDrama()
  const failedEpisodeId = insertEpisode(failedDramaId)
  const failedUrls = [1, 2].map(n => `static/projects/${failedDramaId}/videos/s${n}.mp4`)
  failedUrls.forEach(url => writeStatic(url))
  const [f1, f2] = failedUrls.map((url, index) => insertStoryboard(failedEpisodeId, index + 1, url))
  const failedId = insertTransitionRow(failedEpisodeId, failedDramaId, f1, f2, { status: 'failed', errorMsg: '上游失败' })
  const retryFailed = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${failedId}/retry`, { method: 'POST' },
  ))
  assert.equal(retryFailed.status, 400)
  assert.match((await retryFailed.json() as any).message, /配置已删除或停用/)

  const skip = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${processingId}/skip`, { method: 'POST' },
  ))
  assert.equal(skip.status, 200)
  const skippedRow = db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.id, processingId)).get() as any
  assert.equal(skippedRow.enabled, false)
  assert.equal(skippedRow.status, 'skipped')

  const missingSkip = await app.fetch(new Request(
    'http://localhost/api/v1/merge/transitions/99999/skip', { method: 'POST' },
  ))
  assert.equal(missingSkip.status, 400)
})

test('prompt 保存路由写入 manual，analyze 校验参数与缺失记录', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const urls = [1, 2].map(n => `static/projects/${dramaId}/videos/s${n}.mp4`)
  urls.forEach(url => writeStatic(url))
  const [s1, s2] = urls.map((url, index) => insertStoryboard(episodeId, index + 1, url))
  const firstFrameUrl = `static/projects/${dramaId}/transitions/frames/f1.jpg`
  const lastFrameUrl = `static/projects/${dramaId}/transitions/frames/f2.jpg`
  writeStatic(firstFrameUrl)
  writeStatic(lastFrameUrl)
  const rowId = insertTransitionRow(episodeId, dramaId, s1, s2, {
    status: 'failed',
    provider: 'aliyun',
    configBaseUrl: 'https://example.com',
    sourceHash: sourceHashFor(urls[0], urls[1]),
    firstFrameUrl,
    lastFrameUrl,
  })

  const save = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${rowId}/prompt`,
    { method: 'PUT', body: JSON.stringify({ prompt: '  用户改写的过渡提示词  ' }) },
  ))
  const saveBody = await save.json() as any
  assert.equal(save.status, 200)
  assert.equal(saveBody.data.prompt, '用户改写的过渡提示词')
  assert.equal(saveBody.data.prompt_source, 'manual')
  const saved = db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.id, rowId)).get() as any
  assert.equal(saved.promptSource, 'manual')

  const emptySave = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${rowId}/prompt`,
    { method: 'PUT', body: JSON.stringify({ prompt: '   ' }) },
  ))
  assert.equal(emptySave.status, 400)
  assert.match((await emptySave.json() as any).message, /不能为空/)

  const missingSave = await app.fetch(new Request(
    'http://localhost/api/v1/merge/transitions/99999/prompt',
    { method: 'PUT', body: JSON.stringify({ prompt: '任意提示词' }) },
  ))
  assert.equal(missingSave.status, 400)
  assert.match((await missingSave.json() as any).message, /不存在/)

  const badAnalyze = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${rowId}/analyze`,
    { method: 'POST', body: JSON.stringify({ text_config_id: 'abc' }) },
  ))
  assert.equal(badAnalyze.status, 400)
  assert.match((await badAnalyze.json() as any).message, /text_config_id/)

  const missingAnalyze = await app.fetch(new Request(
    'http://localhost/api/v1/merge/transitions/99999/analyze',
    { method: 'POST', body: JSON.stringify({}) },
  ))
  assert.equal(missingAnalyze.status, 400)
  assert.match((await missingAnalyze.json() as any).message, /不存在/)

  const analyzeNoText = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${rowId}/analyze`,
    { method: 'POST', body: JSON.stringify({}) },
  ))
  assert.equal(analyzeNoText.status, 400)
  assert.match((await analyzeNoText.json() as any).message, /文本模型/)
})

test('reference-images 路由保存槽位与追加列表，校验上限并支持清空', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const urls = [1, 2, 3].map(n => `static/projects/${dramaId}/videos/s${n}.mp4`)
  urls.forEach(url => writeStatic(url))
  const [s1, s2, s3] = urls.map((url, index) => insertStoryboard(episodeId, index + 1, url))
  const rowId = insertTransitionRow(episodeId, dramaId, s1, s2, {
    status: 'failed',
    provider: 'minimax',
    model: 'MiniMax-H3',
    configBaseUrl: 'http://127.0.0.1:8190',
    sourceHash: sourceHashFor(urls[0], urls[1]),
  })
  const saveUrl = `http://localhost/api/v1/merge/transitions/${rowId}/reference-images`

  const save = await app.fetch(new Request(saveUrl, {
    method: 'PUT',
    body: JSON.stringify({
      first_frame_upload_url: ' static/uploads/u-first.jpg ',
      reference_image_urls: [' a ', 'a', ' static/uploads/b.jpg '],
    }),
  }))
  const saveBody = await save.json() as any
  assert.equal(save.status, 200)
  assert.equal(saveBody.data.first_frame_upload_url, 'static/uploads/u-first.jpg')
  assert.equal(saveBody.data.last_frame_upload_url, null)
  assert.deepEqual(saveBody.data.reference_image_urls, ['a', 'static/uploads/b.jpg'])

  const over = await app.fetch(new Request(saveUrl, {
    method: 'PUT',
    body: JSON.stringify({
      reference_image_urls: Array.from({ length: 10 }, (_, i) => `static/uploads/r-${i}.jpg`),
    }),
  }))
  assert.equal(over.status, 400)
  assert.match((await over.json() as any).message, /9 张/)

  const blankSlot = await app.fetch(new Request(saveUrl, {
    method: 'PUT',
    body: JSON.stringify({ first_frame_upload_url: '   ' }),
  }))
  assert.equal(blankSlot.status, 400)
  assert.match((await blankSlot.json() as any).message, /路径/)

  const clear = await app.fetch(new Request(saveUrl, {
    method: 'PUT',
    body: JSON.stringify({ first_frame_upload_url: null, reference_image_urls: [] }),
  }))
  const clearBody = await clear.json() as any
  assert.equal(clear.status, 200)
  assert.equal(clearBody.data.first_frame_upload_url, null)
  assert.deepEqual(clearBody.data.reference_image_urls, [])

  const missing = await app.fetch(new Request(
    'http://localhost/api/v1/merge/transitions/99999/reference-images',
    { method: 'PUT', body: JSON.stringify({ reference_image_urls: [] }) },
  ))
  assert.equal(missing.status, 400)
  assert.match((await missing.json() as any).message, /不存在/)

  // 运行中的断点允许保存参考图：旧片段按 source hash 过期，不破坏在跑任务
  const processingId = insertTransitionRow(episodeId, dramaId, s2, s3, {
    status: 'processing',
    provider: 'minimax',
    model: 'MiniMax-H3',
    sourceHash: '',
  })
  const onProcessing = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${processingId}/reference-images`,
    { method: 'PUT', body: JSON.stringify({ reference_image_urls: ['static/uploads/c.jpg'] }) },
  ))
  assert.equal(onProcessing.status, 200)
})

test('merge 按 use_ai_transitions 写入过渡快照，关闭时保持旧行为', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const urls = [1, 2].map(n => `static/projects/${dramaId}/videos/s${n}.mp4`)
  urls.forEach(url => writeStatic(url))
  const [s1, s2] = urls.map((url, index) => insertStoryboard(episodeId, index + 1, url))
  const transitionUrl = `static/projects/${dramaId}/transitions/t1.mp4`
  writeStatic(transitionUrl, 'not a real video')
  insertTransitionRow(episodeId, dramaId, s1, s2, {
    status: 'completed',
    videoUrl: transitionUrl,
    durationActual: 1,
    sourceHash: sourceHashFor(urls[0], urls[1]),
  })

  const enabledResponse = await app.fetch(new Request(
    `http://localhost/api/v1/merge/episodes/${episodeId}/merge`,
    { method: 'POST', body: JSON.stringify({ use_ai_transitions: true }) },
  ))
  const enabledBody = await enabledResponse.json() as any
  assert.equal(enabledResponse.status, 200)
  const enabledRow = await waitMergeRow(Number(enabledBody.data.merge_id))
  assert.ok(enabledRow.transitions, '开启 AI 过渡时应写入断点快照')
  const snapshot = JSON.parse(enabledRow.transitions)
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].from_storyboard_id, s1)
  assert.equal(snapshot[0].to_storyboard_id, s2)
  assert.equal(snapshot[0].status, 'fallback')
  assert.equal(snapshot[0].reason, 'corrupt')
  assert.equal(JSON.parse(enabledRow.mixOptions).aiTransitions.fallback, 1)
  assert.deepEqual(JSON.parse(enabledRow.scenes), urls, 'scenes 只记录镜头 URL')

  const disabledResponse = await app.fetch(new Request(
    `http://localhost/api/v1/merge/episodes/${episodeId}/merge`,
    { method: 'POST', body: JSON.stringify({ use_ai_transitions: false }) },
  ))
  const disabledBody = await disabledResponse.json() as any
  assert.equal(disabledResponse.status, 200)
  const disabledRow = await waitMergeRow(Number(disabledBody.data.merge_id))
  assert.equal(disabledRow.transitions, null)
  assert.equal(JSON.parse(disabledRow.mixOptions).aiTransitions, undefined)
})

test('检验进行中拒绝新建与重新生成过渡镜头，结束后恢复', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const urls = [1, 2].map(n => `static/projects/${dramaId}/videos/s${n}.mp4`)
  urls.forEach(url => writeStatic(url))
  const [s1, s2] = urls.map((url, index) => insertStoryboard(episodeId, index + 1, url))
  const failedId = insertTransitionRow(episodeId, dramaId, s1, s2, { status: 'failed' })

  await auditSvc.createStoryboardAuditJob({ episodeId, dramaId }, { autorun: false })

  const prepare = await app.fetch(new Request(
    `http://localhost/api/v1/merge/episodes/${episodeId}/transitions/prepare`,
    { method: 'POST', body: JSON.stringify({ storyboard_ids: [s1, s2] }) },
  ))
  assert.equal(prepare.status, 400)
  assert.match((await prepare.json() as any).message, /检验进行中，暂不能生成过渡镜头/)

  const custom = await app.fetch(new Request(
    `http://localhost/api/v1/merge/episodes/${episodeId}/transitions/custom`,
    { method: 'POST', body: JSON.stringify({ from_storyboard_id: s1, to_storyboard_id: s2, kind: 'empty', duration: 3 }) },
  ))
  assert.equal(custom.status, 400)
  assert.match((await custom.json() as any).message, /检验进行中，暂不能生成过渡镜头/)

  const retry = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${failedId}/retry`,
    { method: 'POST' },
  ))
  assert.equal(retry.status, 400)
  assert.match((await retry.json() as any).message, /检验进行中，暂不能生成过渡镜头/)

  await auditSvc.interruptStoryboardAuditForEpisode(episodeId, '测试结束')
  const released = await app.fetch(new Request(
    `http://localhost/api/v1/merge/episodes/${episodeId}/transitions/custom`,
    { method: 'POST', body: JSON.stringify({ from_storyboard_id: s1, to_storyboard_id: s2 }) },
  ))
  assert.equal(released.status, 400)
  assert.match((await released.json() as any).message, /请选择过渡类型/)
})

test('DELETE 过渡片段删除记录与本地文件，运行中与缺失拒绝', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const urls = [1, 2].map(n => `static/projects/${dramaId}/videos/s${n}.mp4`)
  urls.forEach(url => writeStatic(url))
  const [s1, s2] = urls.map((url, index) => insertStoryboard(episodeId, index + 1, url))

  const videoUrl = `static/projects/${dramaId}/transitions/delete.mp4`
  const firstFrameUrl = `static/projects/${dramaId}/transitions/frames/first.jpg`
  const lastFrameUrl = `static/projects/${dramaId}/transitions/frames/last.jpg`
  for (const file of [videoUrl, firstFrameUrl, lastFrameUrl]) writeStatic(file)
  const rowId = insertTransitionRow(episodeId, dramaId, s1, s2, {
    status: 'completed',
    videoUrl,
    firstFrameUrl,
    lastFrameUrl,
  })

  const response = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${rowId}`, { method: 'DELETE' },
  ))
  assert.equal(response.status, 200)
  assert.equal((await response.json() as any).data.id, rowId)
  assert.equal(db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.id, rowId)).get(), undefined)
  for (const file of [videoUrl, firstFrameUrl, lastFrameUrl]) {
    assert.equal(fsSync.existsSync(path.join(root, file)), false, `${file} 应被删除`)
  }

  const processingId = insertTransitionRow(episodeId, dramaId, s1, s2, { status: 'processing' })
  const blocked = await app.fetch(new Request(
    `http://localhost/api/v1/merge/transitions/${processingId}`, { method: 'DELETE' },
  ))
  assert.equal(blocked.status, 400)
  assert.match((await blocked.json() as any).message, /运行中/)

  const missing = await app.fetch(new Request(
    'http://localhost/api/v1/merge/transitions/99999', { method: 'DELETE' },
  ))
  assert.equal(missing.status, 400)
  assert.match((await missing.json() as any).message, /不存在/)
})
