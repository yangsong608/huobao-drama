/**
 * 过渡服务：断点落库、提交参数、复用/过期、跳过、能力门禁、本地 H3 英文化。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-transition-service-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema, getInsertId } = await import('../src/db/index.ts')
const { eq } = await import('drizzle-orm')
const {
  deleteTransition,
  listTransitions,
  prepareTransitions,
  retryTransition,
  skipTransition,
  analyzeTransitionPrompt,
  saveTransitionPrompt,
  saveTransitionReferenceImages,
} = await import('../src/services/transition-service.ts')

const ts = '2026-11-05T00:00:00.000Z'
let videoCounter = 0
let submitCounter = 900

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function insertBaseConfig(overrides: Record<string, unknown> = {}) {
  const res = await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'video',
    provider: 'aliyun',
    name: '测试视频配置',
    baseUrl: 'https://example.com',
    apiKey: 'test-key',
    model: 'wan3.0-video',
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  } as any)
  return getInsertId(res)
}

async function seedEpisode(options: {
  videoConfigId?: number | null
  storyboards?: { number: number; description?: string; continuity?: string; video?: boolean }[]
} = {}) {
  const dramaRes = await db.insert(schema.dramas).values({
    title: `过渡项目-${videoCounter}`,
    aspectRatio: '16:9',
    createdAt: ts,
    updatedAt: ts,
  })
  const dramaId = getInsertId(dramaRes)
  const episodeRes = await db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '第1集',
    resolution: '720p',
    videoConfigId: options.videoConfigId ?? null,
    createdAt: ts,
    updatedAt: ts,
  })
  const episodeId = getInsertId(episodeRes)
  const ids: number[] = []
  for (const item of options.storyboards ?? [{ number: 1 }, { number: 2 }]) {
    const videoRel = `static/projects/${dramaId}/videos/sb-${item.number}-${++videoCounter}.mp4`
    const absolute = path.join(root, videoRel)
    fsSync.mkdirSync(path.dirname(absolute), { recursive: true })
    fsSync.writeFileSync(absolute, Buffer.alloc(1024 + videoCounter))
    const sbRes = await db.insert(schema.storyboards).values({
      episodeId,
      storyboardNumber: item.number,
      sceneId: 1,
      description: item.description ?? (item.number === 1 ? '林晚站在雨夜街头。' : '林晚推门走进咖啡馆。'),
      continuity: item.continuity ?? '',
      movement: '缓慢推近',
      atmosphere: '冷色调雨夜',
      videoUrl: item.video === false ? null : videoRel,
      createdAt: ts,
      updatedAt: ts,
    })
    ids.push(getInsertId(sbRes))
  }
  return { dramaId, episodeId, storyboardIds: ids }
}

function fakeDeps(options: { analyzeError?: Error; failSubmitFor?: number[] } = {}) {
  const submissions: any[] = []
  const taskIds: number[] = []
  const frameCalls: { videoPath: string; position: string; label?: string }[] = []
  const analyzeCalls: any[] = []
  return {
    submissions,
    taskIds,
    frameCalls,
    analyzeCalls,
    deps: {
      submit: async (params: any) => {
        const index = submissions.length
        submissions.push(params)
        if (options.failSubmitFor?.includes(index)) throw new Error('本地 H3 过渡提示词仅支持英文')
        const id = ++submitCounter
        taskIds.push(id)
        return id
      },
      extractFrame: async (videoPath: string, position: 'first' | 'last', options: any) => {
        frameCalls.push({ videoPath, position, label: options?.label })
        const relativePath = `static/projects/1/transitions/frames/fake-${options?.label}-${position}.jpg`
        const absolutePath = path.join(root, relativePath)
        fsSync.mkdirSync(path.dirname(absolutePath), { recursive: true })
        fsSync.writeFileSync(absolutePath, Buffer.alloc(256))
        return { relativePath, absolutePath, width: 1280, height: 720 }
      },
      translate: async (text: string) => `EN: English description of the shot (${text.length} chars)`,
      analyze: async (input: any) => {
        analyzeCalls.push(input)
        if (options.analyzeError) throw options.analyzeError
        return {
          prompt: input.localShim
            ? 'Camera glides forward through the rain as warm cafe light grows in the frame.'
            : '镜头从雨夜街角平滑推进到咖啡馆门口，雨丝与暖光自然衔接。',
          configId: input.configId ?? null,
          model: input.model || 'fake-vision',
        }
      },
    },
  }
}

test('prepare 为断点建记录并提交首尾帧任务', async () => {
  const configId = await insertBaseConfig()
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, taskIds, frameCalls, deps } = fakeDeps()

  const result = await prepareTransitions({
    episodeId,
    storyboardIds,
    configId,
    duration: 3,
    audioMode: 'ambient',
  }, deps)

  assert.equal(result.created, 1)
  assert.equal(result.failed, 0)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  assert.equal(row.fromStoryboardId, storyboardIds[0])
  assert.equal(row.toStoryboardId, storyboardIds[1])
  assert.equal(row.dramaId, dramaId)
  assert.equal(row.status, 'processing')
  assert.equal(row.sysTaskId, taskIds[0])
  // 断点首帧取上一镜尾帧，断点尾帧取下一镜首帧。
  assert.match(row.firstFrameUrl || '', /last/)
  assert.match(row.lastFrameUrl || '', /first/)
  assert.equal(row.promptSource, 'ai')
  assert.equal(row.prompt, '镜头从雨夜街角平滑推进到咖啡馆门口，雨丝与暖光自然衔接。')
  assert.equal(row.durationRequested, 3)
  assert.equal(row.durationEffective, 3)
  assert.equal(row.audioMode, 'ambient')
  assert.equal(row.provider, 'aliyun')
  assert.equal(row.model, 'wan3.0-video')
  assert.equal(row.enabled, true)
  assert.match(row.sourceHash || '', /^[0-9a-f]{64}$/)

  assert.equal(frameCalls.length, 2)
  assert.equal(frameCalls[0].position, 'last')
  assert.equal(frameCalls[0].label, `sb-${storyboardIds[0]}`)
  assert.equal(frameCalls[1].position, 'first')
  assert.equal(frameCalls[1].label, `sb-${storyboardIds[1]}`)

  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].transitionId, row.id)
  assert.equal(submissions[0].episodeId, episodeId)
  assert.equal(submissions[0].duration, 3)
  assert.equal(submissions[0].allowShortDuration, false)
  // 过渡提示词已按首尾帧写好，禁止云端扩写改坏画面约束
  assert.equal(submissions[0].promptExtend, false)
  assert.equal(submissions[0].watermark, false)
  assert.match(submissions[0].firstFrameUrl, /fake-sb-\d+-last/)
  assert.match(submissions[0].lastFrameUrl, /fake-sb-\d+-first/)
  assert.equal(submissions[0].prompt, row.prompt)
})

test('list 返回缺失/处理中状态与能力摘要', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps } = fakeDeps()

  const before = await listTransitions({ episodeId, storyboardIds })
  assert.equal(before.summary.total, 1)
  assert.equal(before.summary.missing, 1)
  assert.equal(before.boundaries[0].status, 'missing')
  assert.equal(before.provider?.first_last_frame, true)

  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const afterPrepare = await listTransitions({ episodeId, storyboardIds })
  assert.equal(afterPrepare.summary.processing, 1)
  assert.equal(afterPrepare.boundaries[0].status, 'processing')
  assert.equal(afterPrepare.boundaries[0].promptSource, 'ai')
  assert.equal(afterPrepare.boundaries[0].prompt, '镜头从雨夜街角平滑推进到咖啡馆门口，雨丝与暖光自然衔接。')
})

test('运行中的断点再次 prepare 不重复提交也不改写状态', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, taskIds, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))

  const second = await prepareTransitions({ episodeId, storyboardIds, duration: 3, mode: 'all' }, deps)

  assert.equal(submissions.length, 1)
  assert.equal(second.created, 0)
  assert.equal(second.skipped, 1)
  const [unchanged] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.equal(unchanged.status, 'processing')
  assert.equal(unchanged.sysTaskId, taskIds[0])
  assert.equal(unchanged.errorMsg, null)
})

test('已完成且来源未变的断点直接复用，不重复提交', async () => {
  const configId = await insertBaseConfig()
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)

  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  const videoRel = `static/projects/${dramaId}/transitions/transition-${row.id}.mp4`
  const absolute = path.join(root, videoRel)
  fsSync.mkdirSync(path.dirname(absolute), { recursive: true })
  fsSync.writeFileSync(absolute, Buffer.alloc(2048))
  await db.update(schema.videoTransitions).set({ status: 'completed', videoUrl: videoRel }).where(eq(schema.videoTransitions.id, row.id))

  const result = await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  assert.equal(result.reused, 1)
  assert.equal(result.created, 0)
  assert.equal(submissions.length, 1)
  assert.equal((await listTransitions({ episodeId, storyboardIds })).summary.ready, 1)
})

test('来源视频变化后重新生成并覆盖原断点', async () => {
  const configId = await insertBaseConfig()
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)

  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  const oldRel = `static/projects/${dramaId}/transitions/transition-${row.id}.mp4`
  fsSync.mkdirSync(path.dirname(path.join(root, oldRel)), { recursive: true })
  fsSync.writeFileSync(path.join(root, oldRel), Buffer.alloc(2048))
  await db.update(schema.videoTransitions)
    .set({ status: 'completed', videoUrl: oldRel })
    .where(eq(schema.videoTransitions.id, row.id))
  fsSync.appendFileSync(path.join(root, `static/projects/${dramaId}/videos/sb-1-${videoCounter - 1}.mp4`), Buffer.alloc(10))

  const result = await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  assert.equal(result.created, 1)
  assert.equal(submissions.length, 2)
  const rows = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, row.id)
  assert.notEqual(rows[0].sourceHash, row.sourceHash)
})

test('skip 后记录保留但不再参与生成，list 显示 skipped', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)

  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  await skipTransition(row.id)
  const result = await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  assert.equal(result.skipped, 1)
  assert.equal(submissions.length, 1)
  const view = await listTransitions({ episodeId, storyboardIds })
  assert.equal(view.boundaries[0].status, 'skipped')
  assert.equal(view.summary.skipped, 1)
})

test('模型不支持首尾帧时拒绝生成且不创建任务', async () => {
  const configId = await insertBaseConfig({ model: 'wan2.2-i2v-plus' })
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, deps } = fakeDeps()

  await assert.rejects(
    prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps),
    /首尾帧/,
  )
  assert.equal(submissions.length, 0)
  const rows = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  assert.equal(rows.length, 0)
})

test('本地 H3 使用帧网格时长并把提示词限制为英文', async () => {
  const configId = await insertBaseConfig({
    provider: 'minimax',
    model: 'MiniMax-H3',
    baseUrl: 'http://127.0.0.1:8190',
  })
  const { episodeId, storyboardIds } = await seedEpisode({
    videoConfigId: configId,
    storyboards: [
      { number: 1, description: '两人站在天台栏杆旁。', continuity: '保持同一服装。' },
      { number: 2, description: '两人转身看向城市夜景。', continuity: '' },
    ],
  })
  const { submissions, deps } = fakeDeps()
  const result = await prepareTransitions({ episodeId, storyboardIds, duration: 3, audioMode: 'silent' }, deps)

  assert.equal(result.created, 1)
  assert.equal(submissions[0].duration, 3.042)
  assert.equal(submissions[0].allowShortDuration, true)
  assert.match(submissions[0].prompt, /Camera glides/)
  assert.doesNotMatch(submissions[0].prompt, /[\u4e00-\u9fff]/)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  assert.equal(row.promptSource, 'ai')
})

test('视觉分析失败时回退文字提示词并标记 fallback', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, deps } = fakeDeps({ analyzeError: new Error('当前文本模型不支持图片理解') })

  const result = await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)

  assert.equal(result.created, 1)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  assert.equal(row.promptSource, 'fallback')
  assert.match(row.prompt || '', /S1/)
  assert.match(row.prompt || '', /S2/)
  assert.equal(submissions[0].prompt, row.prompt)
})

test('翻译失败时省略描述段落但不把中文送进本地 H3', async () => {
  const configId = await insertBaseConfig({
    provider: 'minimax',
    model: 'MiniMax-H3',
    baseUrl: 'http://127.0.0.1:8190',
  })
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, deps } = fakeDeps({ analyzeError: new Error('视觉模型调用失败') })
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, {
    ...deps,
    translate: async () => null,
  })

  assert.equal(submissions.length, 1)
  assert.doesNotMatch(submissions[0].prompt, /林晚/)
  assert.match(submissions[0].prompt, /A short cinematic transition shot/)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  assert.equal(row.promptSource, 'fallback')
})

test('retry 重新提交原断点并拒绝运行中的任务', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, analyzeCalls, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))

  await assert.rejects(retryTransition(row.id, {}, deps), /运行中/)

  await db.update(schema.videoTransitions).set({ status: 'failed', errorMsg: '测试失败' }).where(eq(schema.videoTransitions.id, row.id))
  await retryTransition(row.id, {}, deps)
  assert.equal(submissions.length, 2)
  assert.equal(analyzeCalls.length, 2)
  const [retried] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.equal(retried.status, 'processing')
  assert.equal(retried.errorMsg, null)
  assert.equal(retried.promptSource, 'ai')
})

test('AI 分析使用页面选中的文本模型与断点两帧', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { analyzeCalls, deps } = fakeDeps()

  await prepareTransitions({
    episodeId,
    storyboardIds,
    duration: 3,
    textConfigId: 42,
    textModel: 'qwen-vl-max',
  }, deps)

  assert.equal(analyzeCalls.length, 1)
  assert.equal(analyzeCalls[0].configId, 42)
  assert.equal(analyzeCalls[0].model, 'qwen-vl-max')
  assert.match(analyzeCalls[0].firstFramePath, /fake-sb-\d+-last\.jpg/)
  assert.match(analyzeCalls[0].lastFramePath, /fake-sb-\d+-first\.jpg/)
  assert.equal(analyzeCalls[0].prevDescription, '林晚站在雨夜街头。')
  assert.equal(analyzeCalls[0].nextDescription, '林晚推门走进咖啡馆。')
  assert.equal(analyzeCalls[0].localShim, false)
})

test('retry 提交用户修改后的提示词并标记 manual', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, analyzeCalls, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  await db.update(schema.videoTransitions).set({ status: 'failed' }).where(eq(schema.videoTransitions.id, row.id))

  await retryTransition(row.id, { prompt: '  用户改写的过渡提示词，镜头缓慢横移。  ' }, deps)

  assert.equal(analyzeCalls.length, 1)
  assert.equal(submissions.at(-1).prompt, '用户改写的过渡提示词，镜头缓慢横移。')
  const [retried] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.equal(retried.prompt, '用户改写的过渡提示词，镜头缓慢横移。')
  assert.equal(retried.promptSource, 'manual')
})

test('来源视频变化后沿用用户手动提示词，不重新分析', async () => {
  const configId = await insertBaseConfig()
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, analyzeCalls, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)

  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  const videoRel = `static/projects/${dramaId}/transitions/transition-${row.id}.mp4`
  fsSync.mkdirSync(path.dirname(path.join(root, videoRel)), { recursive: true })
  fsSync.writeFileSync(path.join(root, videoRel), Buffer.alloc(2048))
  await db.update(schema.videoTransitions)
    .set({ status: 'completed', videoUrl: videoRel, prompt: '用户锁定的提示词', promptSource: 'manual' })
    .where(eq(schema.videoTransitions.id, row.id))

  const boards = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  const fromVideo = boards.find(board => board.id === row.fromStoryboardId)?.videoUrl
  fsSync.appendFileSync(path.join(root, String(fromVideo)), Buffer.alloc(10))

  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)

  assert.equal(analyzeCalls.length, 1)
  assert.equal(submissions.at(-1).prompt, '用户锁定的提示词')
  const [regenerated] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.equal(regenerated.promptSource, 'manual')
  assert.equal(regenerated.prompt, '用户锁定的提示词')
})

test('analyze 复用已有帧返回 AI 提示词但不落库', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { frameCalls, analyzeCalls, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  const framesBefore = frameCalls.length
  const callsBefore = analyzeCalls.length

  const result = await analyzeTransitionPrompt(row.id, { textConfigId: 9, textModel: 'vision-v2' }, deps)

  assert.equal(result.promptSource, 'ai')
  assert.equal(result.prompt, '镜头从雨夜街角平滑推进到咖啡馆门口，雨丝与暖光自然衔接。')
  assert.equal(result.model, 'vision-v2')
  assert.equal(frameCalls.length, framesBefore)
  assert.equal(analyzeCalls.length, callsBefore + 1)
  assert.equal(analyzeCalls.at(-1).configId, 9)
  const [unchanged] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.equal(unchanged.prompt, row.prompt)
  assert.equal(unchanged.promptSource, 'ai')
})

test('analyze 在视觉分析失败时向上抛出可读错误', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  const broken = fakeDeps({ analyzeError: new Error('当前文本模型不支持图片理解，请在设置中启用视觉模型') })

  await assert.rejects(analyzeTransitionPrompt(row.id, {}, broken.deps), /不支持图片理解/)
})

test('save 保存手动提示词，拒绝空值与本地 H3 中文', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))

  await saveTransitionPrompt(row.id, { prompt: '  用户自定义的过渡提示词  ' })
  const [saved] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.equal(saved.prompt, '用户自定义的过渡提示词')
  assert.equal(saved.promptSource, 'manual')
  await assert.rejects(saveTransitionPrompt(row.id, { prompt: '   ' }), /不能为空/)

  const localConfigId = await insertBaseConfig({
    provider: 'minimax',
    model: 'MiniMax-H3',
    baseUrl: 'http://127.0.0.1:8190',
  })
  const local = await seedEpisode({ videoConfigId: localConfigId })
  await prepareTransitions({ episodeId: local.episodeId, storyboardIds: local.storyboardIds, duration: 3 }, deps)
  const [localRow] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, local.episodeId))
  await assert.rejects(saveTransitionPrompt(localRow.id, { prompt: '镜头缓慢横移的中文提示词' }), /英文/)
})

test('prepare 返回每个失败断点的原因，不把失败吞成成功', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({
    videoConfigId: configId,
    storyboards: [{ number: 1 }, { number: 2 }, { number: 3 }],
  })
  const { deps } = fakeDeps({ failSubmitFor: [0] })

  const result = await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)

  assert.equal(result.created, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].fromStoryboardId, storyboardIds[0])
  assert.equal(result.failures[0].toStoryboardId, storyboardIds[1])
  assert.match(result.failures[0].message, /英文/)
})

test('save 按剧集当前视频配置判断本地 H3，而不是历史行来源', async () => {
  const localConfigId = await insertBaseConfig({
    provider: 'minimax',
    model: 'MiniMax-H3',
    baseUrl: 'http://127.0.0.1:8190',
  })
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: localConfigId })
  const { deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  await db.update(schema.videoTransitions).set({
    configId: null,
    provider: 'aliyun',
    configBaseUrl: 'https://example.com',
  }).where(eq(schema.videoTransitions.id, row.id))

  await assert.rejects(saveTransitionPrompt(row.id, { prompt: '镜头缓慢横移的中文提示词' }), /英文/)
})

test('retry 拒绝超过 1200 字的手动提示词', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  await db.update(schema.videoTransitions).set({ status: 'failed' })
    .where(eq(schema.videoTransitions.id, row.id))

  await assert.rejects(
    retryTransition(row.id, { prompt: '雨'.repeat(1201) }, deps),
    /1200/,
  )
})

test('配置被替换后 retry 改用新配置的模型，不沿用旧模型', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  await db.update(schema.videoTransitions).set({ status: 'failed' })
    .where(eq(schema.videoTransitions.id, row.id))
  await db.update(schema.aiServiceConfigs).set({ isActive: false })
  const localConfigId = await insertBaseConfig({
    provider: 'minimax',
    model: 'MiniMax-H3',
    baseUrl: 'http://127.0.0.1:8190',
  })

  const retry = fakeDeps()
  await retryTransition(row.id, {}, retry.deps)

  assert.equal(retry.submissions.length, 1)
  assert.equal(retry.submissions[0].model, 'MiniMax-H3')
  assert.equal(retry.submissions[0].configId, localConfigId)
  const [retried] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.id, row.id))
  assert.equal(retried.model, 'MiniMax-H3')
  assert.equal(retried.configId, localConfigId)
})

test('retry 提交失败时保留已完成的过渡片段作为回退', async () => {
  const configId = await insertBaseConfig()
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  const videoRel = `static/projects/${dramaId}/transitions/transition-${row.id}.mp4`
  fsSync.mkdirSync(path.dirname(path.join(root, videoRel)), { recursive: true })
  fsSync.writeFileSync(path.join(root, videoRel), Buffer.alloc(4096))
  await db.update(schema.videoTransitions).set({
    status: 'completed',
    videoUrl: videoRel,
    durationActual: 2.8,
    completedAt: ts,
    errorMsg: null,
  }).where(eq(schema.videoTransitions.id, row.id))

  const broken = fakeDeps({ failSubmitFor: [0] })
  await assert.rejects(retryTransition(row.id, {}, broken.deps), /英文/)

  const [after] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.id, row.id))
  assert.equal(after.status, 'completed')
  assert.equal(after.videoUrl, videoRel)
  assert.equal(after.durationActual, 2.8)
  assert.equal(after.sourceHash, row.sourceHash)
  assert.ok(fsSync.existsSync(path.join(root, videoRel)))
})

test('并发 prepare 对同一失败断点只提交一次', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const first = fakeDeps({ failSubmitFor: [0] })
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, first.deps)
  const [failed] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  assert.equal(failed.status, 'failed')

  const retry = fakeDeps()
  const [a, b] = await Promise.all([
    prepareTransitions({ episodeId, storyboardIds, duration: 3 }, retry.deps),
    prepareTransitions({ episodeId, storyboardIds, duration: 3 }, retry.deps),
  ])

  assert.equal(retry.submissions.length, 1)
  assert.equal(a.created + b.created, 1)
  assert.equal(a.skipped + b.skipped, 1)
  const rows = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  assert.equal(rows.length, 1)
})

test('prepare 只处理勾选的断点，未勾选断点保持缺失', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({
    videoConfigId: configId,
    storyboards: [{ number: 1 }, { number: 2 }, { number: 3 }],
  })
  const { submissions, deps } = fakeDeps()

  const result = await prepareTransitions({
    episodeId,
    storyboardIds,
    duration: 3,
    boundaries: [{
      fromStoryboardId: storyboardIds[1],
      toStoryboardId: storyboardIds[2],
    }],
  }, deps)

  assert.equal(result.created, 1)
  assert.equal(submissions.length, 1)
  const rows = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].fromStoryboardId, storyboardIds[1])
  assert.equal(rows[0].toStoryboardId, storyboardIds[2])

  const view = await listTransitions({ episodeId, storyboardIds })
  assert.equal(view.summary.processing, 1)
  assert.equal(view.summary.missing, 1)
  assert.equal(view.boundaries.find(item => item.fromStoryboardId === storyboardIds[0])?.status, 'missing')
})

test('prepare 拒绝空勾选，避免误把全部断点当目标', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, deps } = fakeDeps()

  await assert.rejects(
    prepareTransitions({ episodeId, storyboardIds, duration: 3, boundaries: [] }, deps),
    /至少勾选一个过渡断点/,
  )
  assert.equal(submissions.length, 0)
})

test('list 全集模式包含非相邻断点的历史片段，子集模式只返回子集断点', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({
    videoConfigId: configId,
    storyboards: [{ number: 1 }, { number: 2 }, { number: 3 }],
  })
  const { deps } = fakeDeps()
  await prepareTransitions({
    episodeId,
    storyboardIds: [storyboardIds[0], storyboardIds[2]],
    duration: 3,
  }, deps)

  const full = await listTransitions({ episodeId })
  const pairs = full.boundaries.map(b => `${b.fromStoryboardId}:${b.toStoryboardId}`).sort()
  assert.deepEqual(pairs, [
    `${storyboardIds[0]}:${storyboardIds[1]}`,
    `${storyboardIds[0]}:${storyboardIds[2]}`,
    `${storyboardIds[1]}:${storyboardIds[2]}`,
  ].sort())
  const extra = full.boundaries.find(b =>
    b.fromStoryboardId === storyboardIds[0] && b.toStoryboardId === storyboardIds[2])
  assert.ok(extra, '跨镜生成的历史片段应出现在全集列表')
  assert.equal(extra.fromNumber, 1)
  assert.equal(extra.toNumber, 3)
  assert.notEqual(extra.id, null)

  const scoped = await listTransitions({
    episodeId,
    storyboardIds: [storyboardIds[0], storyboardIds[2]],
  })
  assert.deepEqual(
    scoped.boundaries.map(b => `${b.fromStoryboardId}:${b.toStoryboardId}`),
    [`${storyboardIds[0]}:${storyboardIds[2]}`],
  )
})

test('delete 不删除仍被其他断点引用的首尾帧缓存', async () => {
  const configId = await insertBaseConfig()
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({
    videoConfigId: configId,
    storyboards: [{ number: 1 }, { number: 2 }, { number: 3 }],
  })
  const { deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const rows = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  const target = rows.find(row => row.fromStoryboardId === storyboardIds[0])!
  const videoRel = `static/projects/${dramaId}/transitions/shared-video.mp4`
  const sharedFirstRel = `static/projects/${dramaId}/transitions/frames/shared-first.jpg`
  const ownLastRel = `static/projects/${dramaId}/transitions/frames/own-last.jpg`
  const siblingVideoRel = `static/projects/${dramaId}/transitions/sibling-video.mp4`
  const siblingLastRel = `static/projects/${dramaId}/transitions/frames/sibling-last.jpg`
  for (const rel of [videoRel, sharedFirstRel, ownLastRel, siblingVideoRel, siblingLastRel]) {
    fsSync.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fsSync.writeFileSync(path.join(root, rel), Buffer.alloc(512))
  }
  await db.update(schema.videoTransitions).set({
    status: 'completed',
    videoUrl: videoRel,
    firstFrameUrl: sharedFirstRel,
    lastFrameUrl: ownLastRel,
  }).where(eq(schema.videoTransitions.id, target.id))
  await db.insert(schema.videoTransitions).values({
    episodeId,
    dramaId,
    fromStoryboardId: storyboardIds[0],
    toStoryboardId: storyboardIds[2],
    status: 'completed',
    enabled: true,
    videoUrl: siblingVideoRel,
    firstFrameUrl: sharedFirstRel,
    lastFrameUrl: siblingLastRel,
    createdAt: ts,
    updatedAt: ts,
  })

  await deleteTransition(target.id)

  assert.equal(fsSync.existsSync(path.join(root, videoRel)), false, '自有视频应删除')
  assert.equal(fsSync.existsSync(path.join(root, ownLastRel)), false, '自有尾帧应删除')
  assert.equal(fsSync.existsSync(path.join(root, sharedFirstRel)), true, '共享首帧必须保留')
  assert.equal((await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))).length, 2)
})

test('delete 待生成记录也拒绝删除，避免任务完成后留下孤儿文件', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  await db.update(schema.videoTransitions).set({ status: 'pending' })
    .where(eq(schema.videoTransitions.id, row.id))

  await assert.rejects(deleteTransition(row.id), /运行中/)
  assert.equal((await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.id, row.id))).length, 1)
})

test('delete 删除过渡记录与本地文件，运行中拒绝删除', async () => {  const configId = await insertBaseConfig()
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  const videoRel = `static/projects/${dramaId}/transitions/delete-video.mp4`
  const firstRel = `static/projects/${dramaId}/transitions/frames/delete-first.jpg`
  const lastRel = `static/projects/${dramaId}/transitions/frames/delete-last.jpg`
  for (const rel of [videoRel, firstRel, lastRel]) {
    fsSync.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fsSync.writeFileSync(path.join(root, rel), Buffer.alloc(512))
  }
  await db.update(schema.videoTransitions).set({
    status: 'completed',
    videoUrl: videoRel,
    firstFrameUrl: firstRel,
    lastFrameUrl: lastRel,
  }).where(eq(schema.videoTransitions.id, row.id))

  await deleteTransition(row.id)

  assert.equal((await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.id, row.id))).length, 0)
  for (const rel of [videoRel, firstRel, lastRel]) {
    assert.equal(fsSync.existsSync(path.join(root, rel)), false, `${rel} 应被删除`)
  }
  await assert.rejects(deleteTransition(row.id), /不存在/)

  const processingEpisode = await seedEpisode({ videoConfigId: configId })
  const processingDeps = fakeDeps()
  await prepareTransitions({
    episodeId: processingEpisode.episodeId,
    storyboardIds: processingEpisode.storyboardIds,
    duration: 3,
  }, processingDeps.deps)
  const [processing] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, processingEpisode.episodeId))
  await assert.rejects(deleteTransition(processing.id), /运行中/)
  assert.equal((await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.id, processing.id))).length, 1)
})

const UPLOAD_FIRST = 'static/uploads/transition-upload-first.jpg'
const UPLOAD_LAST = 'static/uploads/transition-upload-last.jpg'
const UPLOAD_REF_A = 'static/uploads/transition-ref-a.jpg'
const UPLOAD_REF_B = 'static/uploads/transition-ref-b.jpg'

test('retry 把上传槽位图作为生效首尾帧并把追加参考图传给提交', async () => {
  const configId = await insertBaseConfig({
    provider: 'minimax',
    model: 'MiniMax-H3',
    baseUrl: 'http://127.0.0.1:8190',
  })
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, analyzeCalls, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  const extractedFirst = row.firstFrameUrl
  const extractedLast = row.lastFrameUrl
  await db.update(schema.videoTransitions).set({
    status: 'failed',
    firstFrameUploadUrl: UPLOAD_FIRST,
    lastFrameUploadUrl: UPLOAD_LAST,
    referenceImageUrls: JSON.stringify([UPLOAD_REF_A, UPLOAD_REF_B]),
  }).where(eq(schema.videoTransitions.id, row.id))

  await retryTransition(row.id, {}, deps)

  assert.equal(submissions.length, 2)
  // 生效帧 = 上传槽位优先，追加参考图随首尾帧一起提交
  assert.equal(submissions[1].firstFrameUrl, UPLOAD_FIRST)
  assert.equal(submissions[1].lastFrameUrl, UPLOAD_LAST)
  assert.deepEqual(submissions[1].referenceImageUrls, [UPLOAD_REF_A, UPLOAD_REF_B])
  // 提示词分析同样以生效槽位图与追加参考图为依据（生效解析在 analyze 内部完成）
  assert.equal(analyzeCalls[1].firstFrameUploadPath, UPLOAD_FIRST)
  assert.equal(analyzeCalls[1].lastFrameUploadPath, UPLOAD_LAST)
  assert.deepEqual(analyzeCalls[1].referenceImagePaths, [UPLOAD_REF_A, UPLOAD_REF_B])
  // 库里首尾帧保留镜头抽帧缓存，恢复默认就是清空上传槽位
  const [retried] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.equal(retried.firstFrameUrl, extractedFirst)
  assert.equal(retried.lastFrameUrl, extractedLast)
  assert.equal(retried.firstFrameUploadUrl, UPLOAD_FIRST)
  assert.deepEqual(JSON.parse(retried.referenceImageUrls || '[]'), [UPLOAD_REF_A, UPLOAD_REF_B])
})

test('Wan 3.0 等不支持混用的模型自动降级：保留槽位、丢弃追加参考图', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, analyzeCalls, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  await db.update(schema.videoTransitions).set({
    status: 'failed',
    firstFrameUploadUrl: UPLOAD_FIRST,
    lastFrameUploadUrl: UPLOAD_LAST,
    referenceImageUrls: JSON.stringify([UPLOAD_REF_A, UPLOAD_REF_B]),
  }).where(eq(schema.videoTransitions.id, row.id))

  await retryTransition(row.id, {}, deps)

  assert.equal(submissions.length, 2)
  // 槽位上传图替换首尾帧输入，保证衔接语义不丢
  assert.equal(submissions[1].firstFrameUrl, UPLOAD_FIRST)
  assert.equal(submissions[1].lastFrameUrl, UPLOAD_LAST)
  assert.equal(submissions[1].referenceImageUrls, undefined)
  // 参考图记录保留，换回支持的模型后重新生成即可生效
  const [retried] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.equal(retried.firstFrameUploadUrl, UPLOAD_FIRST)
  assert.deepEqual(JSON.parse(retried.referenceImageUrls || '[]'), [UPLOAD_REF_A, UPLOAD_REF_B])
  // 分析不受生成端混用限制影响：参考图仍是提示词的有效依据
  assert.deepEqual(analyzeCalls[1].referenceImagePaths, [UPLOAD_REF_A, UPLOAD_REF_B])
})

test('AI 分析入口同样使用生效槽位图与追加参考图', async () => {
  const configId = await insertBaseConfig()
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { analyzeCalls, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  await saveTransitionReferenceImages(row.id, {
    firstFrameUploadUrl: UPLOAD_FIRST,
    lastFrameUploadUrl: UPLOAD_LAST,
    referenceImageUrls: [UPLOAD_REF_A, UPLOAD_REF_B],
  })
  const before = analyzeCalls.length

  await analyzeTransitionPrompt(row.id, {}, deps)

  assert.equal(analyzeCalls.length, before + 1)
  assert.equal(analyzeCalls.at(-1).firstFrameUploadPath, UPLOAD_FIRST)
  assert.equal(analyzeCalls.at(-1).lastFrameUploadPath, UPLOAD_LAST)
  assert.deepEqual(analyzeCalls.at(-1).referenceImagePaths, [UPLOAD_REF_A, UPLOAD_REF_B])
})

test('参考图变化使已完成的旧片段过期并重新生成，参考图不变则继续复用', async () => {
  const configId = await insertBaseConfig({
    provider: 'minimax',
    model: 'MiniMax-H3',
    baseUrl: 'http://127.0.0.1:8190',
  })
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  const videoRel = `static/projects/${dramaId}/transitions/transition-${row.id}.mp4`
  fsSync.mkdirSync(path.dirname(path.join(root, videoRel)), { recursive: true })
  fsSync.writeFileSync(path.join(root, videoRel), Buffer.alloc(2048))
  await db.update(schema.videoTransitions).set({ status: 'completed', videoUrl: videoRel })
    .where(eq(schema.videoTransitions.id, row.id))

  await saveTransitionReferenceImages(row.id, { referenceImageUrls: [UPLOAD_REF_A] })
  // 落库的 hash 保持旧值，过期由比较时的公式（纳入参考图）判定
  const [stale] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.equal(stale.sourceHash, row.sourceHash)
  const staleView = await listTransitions({ episodeId, storyboardIds })
  assert.equal(staleView.boundaries[0].stale, true)

  const regenerate = await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  assert.equal(regenerate.created, 1)
  assert.equal(regenerate.reused, 0)
  assert.equal(submissions.length, 2)
  assert.deepEqual(submissions[1].referenceImageUrls, [UPLOAD_REF_A])
  const [regenerated] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.notEqual(regenerated.sourceHash, row.sourceHash)

  fsSync.writeFileSync(path.join(root, videoRel), Buffer.alloc(4096))
  await db.update(schema.videoTransitions).set({ status: 'completed', videoUrl: videoRel })
    .where(eq(schema.videoTransitions.id, row.id))
  const reuse = await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  assert.equal(reuse.created, 0)
  assert.equal(reuse.reused, 1)
})

test('saveTransitionReferenceImages 校验上限、去重并支持清空槽位', async () => {
  const configId = await insertBaseConfig({
    provider: 'minimax',
    model: 'MiniMax-H3',
    baseUrl: 'http://127.0.0.1:8190',
  })
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))

  await saveTransitionReferenceImages(row.id, {
    firstFrameUploadUrl: ` ${UPLOAD_FIRST} `,
    lastFrameUploadUrl: UPLOAD_LAST,
    referenceImageUrls: [' ', UPLOAD_REF_A, UPLOAD_REF_A, UPLOAD_REF_B],
  })
  const [saved] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.equal(saved.firstFrameUploadUrl, UPLOAD_FIRST)
  assert.equal(saved.lastFrameUploadUrl, UPLOAD_LAST)
  assert.deepEqual(JSON.parse(saved.referenceImageUrls || '[]'), [UPLOAD_REF_A, UPLOAD_REF_B])

  await assert.rejects(
    saveTransitionReferenceImages(row.id, {
      referenceImageUrls: Array.from({ length: 10 }, (_, i) => `static/uploads/ref-${i}.jpg`),
    }),
    /9/,
  )

  await saveTransitionReferenceImages(row.id, { firstFrameUploadUrl: null, referenceImageUrls: [] })
  const [cleared] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, row.id))
  assert.equal(cleared.firstFrameUploadUrl, null)
  assert.equal(cleared.lastFrameUploadUrl, UPLOAD_LAST)
  assert.equal(cleared.referenceImageUrls, null)

  await assert.rejects(saveTransitionReferenceImages(row.id, { firstFrameUploadUrl: '   ' }), /路径/)
  await assert.rejects(saveTransitionReferenceImages(999999, {}), /不存在/)
})

test('list 暴露参考图字段与模型混用能力', async () => {
  const configId = await insertBaseConfig({
    provider: 'minimax',
    model: 'MiniMax-H3',
    baseUrl: 'http://127.0.0.1:8190',
  })
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps } = fakeDeps()
  await prepareTransitions({ episodeId, storyboardIds, duration: 3 }, deps)
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.episodeId, episodeId))
  await saveTransitionReferenceImages(row.id, {
    firstFrameUploadUrl: UPLOAD_FIRST,
    referenceImageUrls: [UPLOAD_REF_A, UPLOAD_REF_B],
  })

  const view = await listTransitions({ episodeId, storyboardIds })
  const boundary = view.boundaries[0]
  assert.equal(boundary.firstFrameUploadUrl, UPLOAD_FIRST)
  assert.equal(boundary.lastFrameUploadUrl, null)
  assert.deepEqual(boundary.referenceImageUrls, [UPLOAD_REF_A, UPLOAD_REF_B])
  assert.equal(view.provider?.reference_images_allowed, true)
  assert.equal(view.provider?.reference_images_max, 9)
})
