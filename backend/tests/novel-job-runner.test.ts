import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-job-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { createNovel, getNovel, updateNovel } = await import('../src/services/novels.ts')
const { saveChapter, getChapter } = await import('../src/services/novel-chapters.ts')
const {
  startNovelJob,
  cancelNovelJob,
  markInterruptedNovelJobs,
  getNovelJob,
  NovelJobError,
} = await import('../src/services/novel-job-runner.ts')
const { NovelLlmError } = await import('../src/services/novel/llm.ts')
const { saveStoryAtlas } = await import('../src/services/novel/story-atlas-store.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

function detectArchitecturePrompt(prompt: string): string {
  if (prompt.includes('雪花写作法')) return 'coreSeed'
  if (prompt.includes('核心驱动力三角')) return 'characterDynamics'
  if (prompt.includes('角色状态文档')) return 'characterState'
  if (prompt.includes('物理维度')) return 'worldBuilding'
  if (prompt.includes('三幕式情节架构')) return 'plotArchitecture'
  if (prompt.includes('设计世界地图')) return 'worldMap'
  if (prompt.includes('关键时间事件线')) return 'timeline'
  throw new Error(`unexpected architecture prompt: ${prompt.slice(0, 80)}`)
}

function architectureStub(calls: string[], prompts: string[] = []) {
  return {
    async complete(prompt: string) {
      prompts.push(prompt)
      const key = detectArchitecturePrompt(prompt)
      calls.push(key)
      if (key === 'worldMap') {
        return JSON.stringify({ regions: [{ id: 'r1', name: '北境' }], factions: [], places: [{ id: 'p1', name: '钟楼', regionId: 'r1', x: 0.4, y: 0.5, importance: 4 }], routes: [] })
      }
      if (key === 'timeline') {
        return JSON.stringify({ events: [{ chapterNo: 1, timeLabel: '第一日', title: '开端', placeId: 'p1', importance: 4 }] })
      }
      return `【${key}】`
    },
  }
}

const BLUEPRINT = `第1章 - 开端
本章定位：引入主角
核心作用：推进
情感强度：★★☆☆☆
伏笔操作：埋设玉佩
情节张力：★★☆☆☆
本章简述：主角入山门。
旁白描述：山雾压低视线。
核心人物：主角
关键道具：玉佩
场景地点：山门
时间压力：三日内

第2章 - 第二幕
本章定位：发展
核心作用：转折
情感强度：★★★★☆
伏笔操作：回收玉佩
情节张力：★★★★★
本章简述：主角坠崖。
旁白描述：冷雨压住节奏。
核心人物：反派首领
关键道具：断剑
场景地点：悬崖
时间压力：当夜

第3章 - 终章
本章定位：收束
核心作用：高潮
情感强度：★★★★★
情节张力：★★★★★
本章简述：真相揭晓。`

test('architecture runs seven steps in order and persists each field', async () => {
  const novel = createNovel({
    title: '架构书',
    topic: '权谋',
    genre: ['古装', '悬疑'],
    number_of_chapters: 3,
    word_number: 2500,
    user_guidance: '节奏快',
  })

  const calls: string[] = []
  const prompts: string[] = []
  const { job, completion } = startNovelJob({
    novelId: novel.id,
    type: 'architecture',
    llm: architectureStub(calls, prompts),
  })
  await completion

  assert.deepEqual(calls, [
    'coreSeed',
    'characterDynamics',
    'characterState',
    'worldBuilding',
    'plotArchitecture',
    'worldMap',
    'timeline',
  ])
  assert.match(prompts[1], /核心种子：【coreSeed】/)
  assert.match(prompts[4], /核心种子：【coreSeed】/)
  assert.match(prompts[4], /角色体系：【characterDynamics】/)
  assert.match(prompts[4], /世界观：【worldBuilding】/)

  const row = getNovelJob(job.id)
  assert.ok(row)
  assert.equal(row.status, 'done')
  assert.equal(row.progress, 7)
  assert.equal(row.total, 7)
  assert.ok(row.finishedAt)

  const stored = getNovel(novel.id)
  assert.ok(stored)
  assert.equal(stored.coreSeed, '【coreSeed】')
  assert.equal(stored.characterDynamics, '【characterDynamics】')
  assert.equal(stored.characterState, '【characterState】')
  assert.equal(stored.worldBuilding, '【worldBuilding】')
  assert.equal(stored.plotArchitecture, '【plotArchitecture】')
  assert.equal(stored.architectureGenerated, true)
  assert.equal(stored.timelineEvents[0]?.title, '开端')
  assert.equal(stored.worldMap?.places[0]?.name, '钟楼')

  const result = JSON.parse(row.result || '{}')
  assert.equal(result.promptVersion, '1.2.0')
  assert.deepEqual(result.steps.map((step: { key: string }) => step.key), calls)
})

test('architecture skips existing fields and force regenerates them', async () => {
  const novel = createNovel({
    title: '续跑书',
    topic: '仙侠',
    genre: ['仙侠'],
    number_of_chapters: 3,
    word_number: 2000,
  })
  updateNovel(novel.id, { core_seed: '已有种子', world_building: '已有世界观' })

  const calls: string[] = []
  await startNovelJob({
    novelId: novel.id,
    type: 'architecture',
    llm: architectureStub(calls),
  }).completion

  assert.deepEqual(calls, ['characterDynamics', 'characterState', 'plotArchitecture', 'worldMap', 'timeline'])
  let stored = getNovel(novel.id)
  assert.ok(stored)
  assert.equal(stored.coreSeed, '已有种子')
  assert.equal(stored.worldBuilding, '已有世界观')

  const forcedCalls: string[] = []
  await startNovelJob({
    novelId: novel.id,
    type: 'architecture',
    force: true,
    llm: architectureStub(forcedCalls),
  }).completion

  assert.deepEqual(forcedCalls, [
    'coreSeed',
    'characterDynamics',
    'characterState',
    'worldBuilding',
    'plotArchitecture',
    'worldMap',
    'timeline',
  ])
  stored = getNovel(novel.id)
  assert.ok(stored)
  assert.equal(stored.coreSeed, '【coreSeed】')
  assert.equal(stored.worldBuilding, '【worldBuilding】')

  const textOnly = createNovel({
    title: '仅缺地图',
    topic: '志怪',
    genre: ['志怪'],
    number_of_chapters: 4,
    word_number: 2000,
  })
  updateNovel(textOnly.id, {
    core_seed: '种子',
    character_dynamics: '角色',
    character_state: '状态',
    world_building: '世界',
    plot_architecture: '情节',
  })
  const atlasCalls: string[] = []
  await startNovelJob({
    novelId: textOnly.id,
    type: 'architecture',
    llm: architectureStub(atlasCalls),
  }).completion
  assert.deepEqual(atlasCalls, ['worldMap', 'timeline'])
})

test('starts at most one running job per novel and returns 409', async () => {
  const novel = createNovel({
    title: '并发书',
    topic: '都市',
    genre: ['都市'],
    number_of_chapters: 2,
    word_number: 1500,
  })
  const gate = deferred()
  const started = deferred()
  const llm = {
    async complete() {
      started.resolve()
      await gate.promise
      return '【coreSeed】'
    },
  }

  const first = startNovelJob({ novelId: novel.id, type: 'architecture', llm })
  await started.promise

  assert.throws(
    () => startNovelJob({ novelId: novel.id, type: 'architecture', llm }),
    (error: unknown) => error instanceof NovelJobError && error.status === 409,
  )

  cancelNovelJob(first.job.id)
  gate.resolve()
  await first.completion
  assert.equal(getNovelJob(first.job.id)?.status, 'cancelled')
})

test('cancel keeps completed fields and a new job resumes from them', async () => {
  const novel = createNovel({
    title: '取消书',
    topic: '悬疑',
    genre: ['悬疑'],
    number_of_chapters: 2,
    word_number: 1800,
  })

  let callCount = 0
  const secondStarted = deferred()
  const llm = {
    async complete(_prompt: string, options?: { signal?: AbortSignal }) {
      callCount += 1
      if (callCount === 1) return '【coreSeed】'
      secondStarted.resolve()
      return await new Promise<string>((_resolve, reject) => {
        const signal = options?.signal
        if (signal?.aborted) return reject(abortError())
        signal?.addEventListener('abort', () => reject(abortError()), { once: true })
      })
    },
  }

  const { job, completion } = startNovelJob({ novelId: novel.id, type: 'architecture', llm })
  await secondStarted.promise
  cancelNovelJob(job.id)
  await completion

  const cancelled = getNovelJob(job.id)
  assert.ok(cancelled)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.error, null)
  let stored = getNovel(novel.id)
  assert.ok(stored)
  assert.equal(stored.coreSeed, '【coreSeed】')
  assert.equal(stored.characterDynamics, null)

  const resumedCalls: string[] = []
  await startNovelJob({
    novelId: novel.id,
    type: 'architecture',
    llm: architectureStub(resumedCalls),
  }).completion

  assert.deepEqual(resumedCalls, ['characterDynamics', 'characterState', 'worldBuilding', 'plotArchitecture', 'worldMap', 'timeline'])
  stored = getNovel(novel.id)
  assert.ok(stored)
  assert.equal(stored.coreSeed, '【coreSeed】')
  assert.equal(stored.plotArchitecture, '【plotArchitecture】')
})

test('marks a timed out job failed with a readable timeout code', async () => {
  const novel = createNovel({
    title: '超时书',
    topic: '科幻',
    genre: ['科幻'],
    number_of_chapters: 2,
    word_number: 1200,
  })
  const llm = {
    complete(_prompt: string, options?: { signal?: AbortSignal }) {
      return new Promise<string>((_resolve, reject) => {
        const signal = options?.signal
        if (signal?.aborted) return reject(abortError())
        signal?.addEventListener('abort', () => reject(abortError()), { once: true })
      })
    },
  }

  const { job, completion } = startNovelJob({
    novelId: novel.id,
    type: 'architecture',
    llm,
    timeoutMs: 25,
  })
  await completion

  const row = getNovelJob(job.id)
  assert.ok(row)
  assert.equal(row.status, 'failed')
  assert.equal(row.errorCode, 'timeout')
  assert.match(row.error || '', /超时/)
  assert.ok(row.finishedAt)
})

test('markInterruptedNovelJobs turns leftover running jobs into interrupted', () => {
  const novel = createNovel({
    title: '重启书',
    topic: '现实',
    genre: ['现实'],
    number_of_chapters: 2,
    word_number: 1200,
  })
  const ts = '2026-01-01T00:00:00.000Z'
  const inserted = db.insert(schema.novelJobs).values({
    novelId: novel.id,
    type: 'architecture',
    status: 'running',
    progress: 2,
    total: 5,
    createdAt: ts,
    startedAt: ts,
  }).run()

  const count = markInterruptedNovelJobs()
  assert.ok(count >= 1)

  const row = getNovelJob(Number(inserted.lastInsertRowid))
  assert.ok(row)
  assert.equal(row.status, 'interrupted')
  assert.ok(row.finishedAt)
})

test('blueprint job persists each chunk and sets blueprint_generated', async () => {
  const novel = createNovel({
    title: '大纲书',
    topic: '玄幻',
    genre: ['玄幻'],
    number_of_chapters: 2,
    word_number: 2000,
  })
  updateNovel(novel.id, { chapter_blueprint: '第1章 - 开端\n本章简述：开篇。' })

  const prompts: string[] = []
  const llm = {
    async complete(prompt: string) {
      prompts.push(prompt)
      return '第2章 - 续章\n本章定位：发展\n核心作用：推进\n情感强度：★★★☆☆\n情节张力：★★★★☆\n本章简述：续篇。'
    },
  }

  const { job, completion } = startNovelJob({ novelId: novel.id, type: 'blueprint', llm })
  await completion

  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /第2章到第2章/)
  assert.match(prompts[0], /叙述人称：第一人称/)

  const stored = getNovel(novel.id)
  assert.ok(stored)
  assert.equal(stored.blueprintGenerated, true)
  assert.equal(stored.blueprintChapters.length, 2)
  assert.equal(stored.blueprintChapters[1].title, '续章')
  assert.equal(stored.blueprintChapters[1].summary, '续篇。')

  const row = getNovelJob(job.id)
  assert.ok(row)
  assert.equal(row.status, 'done')
  const result = JSON.parse(row.result || '{}')
  assert.equal(result.requests, 1)
  assert.equal(result.chapters, 2)
})

test('chapter job feeds blueprint summary, previous excerpt and defaults into nextDraft', async () => {
  const novel = createNovel({
    title: '章节书',
    topic: '武侠',
    genre: ['武侠'],
    number_of_chapters: 3,
    word_number: 1600,
    user_guidance: '少用旁白',
  })
  updateNovel(novel.id, {
    chapter_blueprint: BLUEPRINT,
    global_summary: '前文摘要内容',
    character_state: '角色状态内容',
    core_seed: '种子内容',
    character_dynamics: '角色体系内容',
    world_building: '世界观内容',
    plot_architecture: '情节架构内容',
  })
  saveChapter(novel.id, 1, { content: 'A'.repeat(500) + 'B'.repeat(800) })

  let prompt = ''
  const llm = {
    async complete(value: string) {
      if (value.includes('提取 1–3 条')) return JSON.stringify({ events: [] })
      prompt = value
      return '第二章正文'
    },
  }

  const { job, completion } = startNovelJob({
    novelId: novel.id,
    type: 'chapter',
    chapterNo: 2,
    llm,
  })
  await completion

  assert.match(prompt, /第2章《第二幕》/)
  assert.match(prompt, /前文摘要内容/)
  assert.match(prompt, /角色状态内容/)
  assert.match(prompt, /核心人物：反派首领/)
  assert.match(prompt, /关键道具：断剑/)
  assert.match(prompt, /场景地点：悬崖/)
  assert.match(prompt, /时间压力：当夜/)
  assert.match(prompt, /下一章节目录[\s\S]*第3章《终章》/)
  assert.match(prompt, /少用旁白/)
  assert.match(prompt, /叙述人称：第一人称/)
  assert.match(prompt, /本章旁白：冷雨压住节奏。/)

  const summaryHits = prompt.split('主角坠崖。').length - 1
  assert.equal(summaryHits, 2, 'shortSummary 与 chapterSummary 都应取大纲本章简述')

  assert.ok(prompt.includes('B'.repeat(800)))
  assert.ok(!prompt.includes('A'.repeat(50)), '只应取前章最后 800 字')

  const chapter = getChapter(novel.id, 2)
  assert.ok(chapter)
  assert.equal(chapter.content, '第二章正文')
  assert.equal(chapter.title, '第二幕')
  assert.equal(chapter.status, 'draft')
  assert.ok(chapter.wordCount > 0)

  const row = getNovelJob(job.id)
  assert.ok(row)
  assert.equal(row.status, 'done')
  const result = JSON.parse(row.result || '{}')
  assert.equal(result.chapter_no, 2)
  assert.ok(result.word_count > 0)
})

test('last chapter leaves next-chapter fields empty', async () => {
  const novel = createNovel({
    title: '末章书',
    topic: '现实',
    genre: ['现实'],
    number_of_chapters: 2,
    word_number: 1200,
  })
  updateNovel(novel.id, {
    chapter_blueprint: '第1章 - 开端\n本章简述：开篇。\n\n第2章 - 收尾\n本章简述：收束。',
    global_summary: '摘要',
    character_state: '状态',
  })
  saveChapter(novel.id, 1, { content: '前章正文' })

  let prompt = ''
  await startNovelJob({
    novelId: novel.id,
    type: 'chapter',
    chapterNo: 2,
    llm: {
      async complete(value: string) {
        if (value.includes('提取 1–3 条')) return JSON.stringify({ events: [] })
        prompt = value
        return '末章正文'
      },
    },
  }).completion

  assert.match(prompt, /第3章《》/)
  assert.doesNotMatch(prompt, /过渡章节/)
  assert.equal(getChapter(novel.id, 2)?.content, '末章正文')
})

test('chapter generation refuses to overwrite existing content without force', async () => {
  const novel = createNovel({
    title: '覆盖书',
    topic: '古装',
    genre: ['古装'],
    number_of_chapters: 2,
    word_number: 1200,
  })
  updateNovel(novel.id, { chapter_blueprint: '第1章 - 开端\n本章简述：开篇。\n\n第2章 - 发展\n本章简述：推进。' })
  saveChapter(novel.id, 1, { content: '已有正文' })

  assert.throws(
    () => startNovelJob({ novelId: novel.id, type: 'chapter', chapterNo: 1 }),
    (error: unknown) => error instanceof NovelJobError && error.status === 409,
  )

  await startNovelJob({
    novelId: novel.id,
    type: 'chapter',
    chapterNo: 1,
    force: true,
    llm: { async complete() { return '覆盖后的正文' } },
  }).completion
  assert.equal(getChapter(novel.id, 1)?.content, '覆盖后的正文')
})

test('finalize updates summary, character state and chapter status', async () => {
  const novel = createNovel({
    title: '定稿书',
    topic: '悬疑',
    genre: ['悬疑'],
    number_of_chapters: 2,
    word_number: 1500,
  })
  saveChapter(novel.id, 1, { content: '第一章正文内容' })

  const prompts: string[] = []
  const llm = {
    async complete(prompt: string) {
      prompts.push(prompt)
      if (prompt.includes('更新前文摘要')) return '新的前文摘要'
      if (prompt.includes('保持原有格式结构')) return '新的角色状态'
      if (prompt.includes('提取 1–3 条')) {
        return JSON.stringify({ events: [{ chapterNo: 1, title: '定稿事件' }] })
      }
      throw new Error(`unexpected finalize prompt: ${prompt.slice(0, 80)}`)
    },
  }

  const { job, completion } = startNovelJob({
    novelId: novel.id,
    type: 'finalize',
    chapterNo: 1,
    llm,
  })
  await completion

  assert.equal(prompts.length, 3)
  assert.equal(getChapter(novel.id, 1)?.status, 'final')
  const stored = getNovel(novel.id)
  assert.ok(stored)
  assert.equal(stored.globalSummary, '新的前文摘要')
  assert.equal(stored.characterState, '新的角色状态')
  assert.equal(stored.timelineEvents[0]?.status, 'confirmed')
  assert.equal(getNovelJob(job.id)?.status, 'done')
})

test('enrich rewrites the chapter content with the requested word count', async () => {
  const novel = createNovel({
    title: '扩写书',
    topic: '玄幻',
    genre: ['玄幻'],
    number_of_chapters: 2,
    word_number: 2000,
    narrative_person: 'third_omniscient',
  })
  updateNovel(novel.id, { chapter_blueprint: BLUEPRINT })
  saveChapter(novel.id, 1, { content: '短文本' })

  let prompt = ''
  await startNovelJob({
    novelId: novel.id,
    type: 'enrich',
    chapterNo: 1,
    wordNumber: 1500,
    llm: {
      async complete(value: string) {
        prompt = value
        return '扩写后的正文'
      },
    },
  }).completion

  assert.match(prompt, /接近 1500 字/)
  assert.match(prompt, /叙述人称：第三人称全知/)
  assert.match(prompt, /本章旁白：山雾压低视线。/)
  assert.equal(getChapter(novel.id, 1)?.content, '扩写后的正文')
})

test('LLM failures keep the error code and message', async () => {
  const novel = createNovel({
    title: '错误书',
    topic: '都市',
    genre: ['都市'],
    number_of_chapters: 2,
    word_number: 1200,
  })
  const llm = {
    async complete() {
      throw new NovelLlmError('quota', '文本模型额度或频率受限（429）')
    },
  }

  const { job, completion } = startNovelJob({ novelId: novel.id, type: 'architecture', llm })
  await completion

  const row = getNovelJob(job.id)
  assert.ok(row)
  assert.equal(row.status, 'failed')
  assert.equal(row.errorCode, 'quota')
  assert.match(row.error || '', /额度/)
})

test('rejects unknown novels and non-P2 job types', () => {
  const novel = createNovel({
    title: '类型书',
    topic: '都市',
    genre: ['都市'],
    number_of_chapters: 2,
    word_number: 1200,
  })

  assert.throws(
    () => startNovelJob({ novelId: 999_999, type: 'architecture' }),
    (error: unknown) => error instanceof NovelJobError && error.status === 404,
  )
  assert.throws(
    () => startNovelJob({ novelId: novel.id, type: 'graph_unknown' }),
    (error: unknown) => error instanceof NovelJobError && error.status === 400,
  )
})

test('chapter draft updates chapter timeline after saving text', async () => {
  const novel = createNovel({ title: '草稿线', number_of_chapters: 3 })
  updateNovel(novel.id, { chapter_blueprint: BLUEPRINT })
  saveStoryAtlas(novel.id, {
    worldMap: { version: 1, generatedAt: null, regions: [], factions: [], places: [{ id: 'p1', name: '山门', x: 0.5, y: 0.5, importance: 3 }], routes: [] },
  })
  const calls: string[] = []
  const llm = {
    async complete(prompt: string) {
      if (prompt.includes('提取 1–3 条')) {
        calls.push('timeline')
        return JSON.stringify({ events: [{ chapterNo: 1, timeLabel: '第一日', title: '入山门', placeId: 'p1', importance: 3 }] })
      }
      calls.push('draft')
      return '第一章正文'
    },
  }
  const { completion } = startNovelJob({ novelId: novel.id, type: 'chapter', chapterNo: 1, force: true, llm })
  await completion
  assert.deepEqual(calls, ['draft', 'timeline'])
  const stored = getNovel(novel.id)!
  assert.equal(stored.chapters.find((chapter) => chapter.chapterNo === 1)?.content, '第一章正文')
  assert.equal(stored.timelineEvents[0].title, '入山门')
  assert.equal(stored.timelineEvents[0].status, 'planned')
  const job = getNovelJob((await import('../src/services/novel-job-runner.ts')).listNovelJobs(novel.id)[0].id)!
  assert.equal(JSON.parse(job.result || '{}').timeline_updated, true)
})

test('timeline failure keeps draft saved and reports warning', async () => {
  const novel = createNovel({ title: '草稿降级', number_of_chapters: 3 })
  updateNovel(novel.id, { chapter_blueprint: BLUEPRINT })
  const llm = {
    async complete(prompt: string) {
      if (prompt.includes('提取 1–3 条')) return 'not json'
      return '仍要保存的正文'
    },
  }
  const { job, completion } = startNovelJob({ novelId: novel.id, type: 'chapter', chapterNo: 1, force: true, llm })
  await completion
  const row = getNovelJob(job.id)!
  assert.equal(row.status, 'done')
  const result = JSON.parse(row.result || '{}')
  assert.equal(result.timeline_updated, false)
  assert.ok(result.timeline_error)
  assert.equal(getNovel(novel.id)!.chapters.find((chapter) => chapter.chapterNo === 1)?.content, '仍要保存的正文')
})

test('finalize runs three stages and confirms timeline', async () => {
  const novel = createNovel({ title: '定稿线', number_of_chapters: 3 })
  updateNovel(novel.id, { chapter_blueprint: BLUEPRINT })
  saveStoryAtlas(novel.id, {
    worldMap: { version: 1, generatedAt: null, regions: [], factions: [], places: [{ id: 'p1', name: '山门', x: 0.5, y: 0.5, importance: 3 }], routes: [] },
  })
  saveChapter(novel.id, 1, { content: '第一章正文', title: '开端', status: 'draft' })
  const calls: string[] = []
  const llm = {
    async complete(prompt: string) {
      if (prompt.includes('前文摘要')) { calls.push('summary'); return '摘要' }
      if (prompt.includes('角色状态文档')) { calls.push('state'); return '状态' }
      if (prompt.includes('提取 1–3 条')) {
        calls.push('timeline')
        return JSON.stringify({ events: [{ chapterNo: 1, title: '确认事件', placeId: 'p1' }] })
      }
      throw new Error(`unexpected: ${prompt.slice(0, 40)}`)
    },
  }
  const { completion } = startNovelJob({ novelId: novel.id, type: 'finalize', chapterNo: 1, llm })
  await completion
  assert.deepEqual(calls, ['summary', 'state', 'timeline'])
  const stored = getNovel(novel.id)!
  assert.equal(stored.timelineEvents[0].status, 'confirmed')
  assert.equal(stored.chapters.find((chapter) => chapter.chapterNo === 1)?.status, 'final')
})

test('finalize timeline failure still finalizes and reports warning', async () => {
  const novel = createNovel({ title: '定稿降级', number_of_chapters: 3 })
  updateNovel(novel.id, { chapter_blueprint: BLUEPRINT })
  saveChapter(novel.id, 1, { content: '正文', title: '开端', status: 'draft' })
  const llm = {
    async complete(prompt: string) {
      if (prompt.includes('前文摘要')) return '摘要'
      if (prompt.includes('角色状态文档')) return '状态'
      return 'broken'
    },
  }
  const { job, completion } = startNovelJob({ novelId: novel.id, type: 'finalize', chapterNo: 1, llm })
  await completion
  const row = getNovelJob(job.id)!
  assert.equal(row.status, 'done')
  const result = JSON.parse(row.result || '{}')
  assert.equal(result.timeline_updated, false)
  assert.ok(result.timeline_error)
  assert.equal(getNovel(novel.id)!.chapters.find((chapter) => chapter.chapterNo === 1)?.status, 'final')
})
