/**
 * 自定义过渡镜头：空镜/场景/文字视频的创建、类型切换、独立指纹与检验互斥。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-transition-custom-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema, getInsertId } = await import('../src/db/index.ts')
const { eq } = await import('drizzle-orm')
const {
  createCustomTransition,
  listTransitions,
  retryTransition,
  saveTransitionPrompt,
} = await import('../src/services/transition-service.ts')

const ts = '2026-11-10T00:00:00.000Z'
let seedCounter = 0
let submitCounter = 900

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function insertVideoConfig(overrides: Record<string, unknown> = {}) {
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
  storyboards?: { number: number }[]
  scenes?: { imageUrl?: string | null; deleted?: boolean }[]
} = {}) {
  const dramaRes = await db.insert(schema.dramas).values({
    title: `过渡项目-${++seedCounter}`,
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
  const storyboardIds: number[] = []
  for (const item of options.storyboards ?? [{ number: 1 }, { number: 2 }]) {
    const rel = `static/projects/${dramaId}/videos/sb-${item.number}-${++seedCounter}.mp4`
    const absolute = path.join(root, rel)
    fsSync.mkdirSync(path.dirname(absolute), { recursive: true })
    fsSync.writeFileSync(absolute, Buffer.alloc(1024 + seedCounter))
    const res = await db.insert(schema.storyboards).values({
      episodeId,
      storyboardNumber: item.number,
      description: item.number === 1 ? '林晚站在雨夜街头。' : '林晚推门走进咖啡馆。',
      movement: '缓慢推近',
      videoUrl: rel,
      createdAt: ts,
      updatedAt: ts,
    })
    storyboardIds.push(getInsertId(res))
  }
  const sceneIds: number[] = []
  for (const scene of options.scenes ?? []) {
    const res = await db.insert(schema.scenes).values({
      dramaId,
      location: '雨夜街头',
      time: '夜',
      prompt: '雨夜街头',
      imageUrl: scene.imageUrl === undefined ? `static/projects/${dramaId}/scenes/street.jpg` : scene.imageUrl,
      deletedAt: scene.deleted ? ts : null,
      createdAt: ts,
      updatedAt: ts,
    })
    sceneIds.push(getInsertId(res))
  }
  return { dramaId, episodeId, storyboardIds, sceneIds }
}

function fakeDeps() {
  const submissions: any[] = []
  const renders: any[] = []
  return {
    submissions,
    renders,
    deps: {
      submit: async (params: any) => {
        submissions.push(params)
        return ++submitCounter
      },
      extractFrame: async () => {
        throw new Error('自定义过渡不应抽取镜头帧')
      },
      translate: async () => null,
      renderText: async (input: any) => {
        renders.push(input)
        fsSync.mkdirSync(path.dirname(input.absolutePath), { recursive: true })
        fsSync.writeFileSync(input.absolutePath, Buffer.alloc(2048))
      },
    },
  }
}

test('空镜过渡走文生视频：不传首尾帧、强制静音并记录独立指纹', async () => {
  const configId = await insertVideoConfig()
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { submissions, deps } = fakeDeps()

  const view = await createCustomTransition({
    episodeId,
    fromStoryboardId: storyboardIds[0],
    toStoryboardId: storyboardIds[1],
    kind: 'empty',
    prompt: '雨夜空无一人的街角，路灯下的积水泛着微光。',
    duration: 3,
  }, deps)

  assert.equal(view.kind, 'empty')
  assert.equal(view.edgeMode, 'fade')
  assert.equal(view.status, 'processing')
  assert.equal(view.audioMode, 'silent')
  assert.equal(view.prompt, '雨夜空无一人的街角，路灯下的积水泛着微光。')
  assert.equal(submissions.length, 1)
  const params = submissions[0]
  assert.equal(params.transitionId, view.id)
  assert.equal(params.firstFrameUrl, undefined)
  assert.equal(params.lastFrameUrl, undefined)
  assert.equal(params.audioMode, 'silent')
  assert.equal(params.duration, 3)
  assert.match(params.aspectRatio, /16:9/)
  const [row] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.id, view.id!))
  assert.match(row.sourceHash || '', /^[0-9a-f]{64}$/)
  assert.equal(row.dramaId, dramaId)
})

test('场景过渡以场景资产图为首帧；场景图缺失时降级文生视频并标记', async () => {
  const configId = await insertVideoConfig()
  const seeded = await seedEpisode({
    videoConfigId: configId,
    scenes: [{ imageUrl: 'static/projects/x/scenes/street.jpg' }, { imageUrl: null }],
  })
  const { submissions, deps } = fakeDeps()

  const normal = await createCustomTransition({
    episodeId: seeded.episodeId,
    fromStoryboardId: seeded.storyboardIds[0],
    toStoryboardId: seeded.storyboardIds[1],
    kind: 'scene',
    sceneId: seeded.sceneIds[0],
    prompt: '镜头沿着湿润的街面缓慢横移。',
    duration: 3,
  }, deps)
  assert.equal(normal.kind, 'scene')
  assert.equal(normal.sceneId, seeded.sceneIds[0])
  assert.equal(normal.degraded, false)
  assert.equal(submissions[0].firstFrameUrl, 'static/projects/x/scenes/street.jpg')
  assert.equal(submissions[0].lastFrameUrl, undefined)

  await db.update(schema.videoTransitions).set({ status: 'failed' })
    .where(eq(schema.videoTransitions.id, normal.id!))
  const missing = await createCustomTransition({
    episodeId: seeded.episodeId,
    fromStoryboardId: seeded.storyboardIds[0],
    toStoryboardId: seeded.storyboardIds[1],
    kind: 'scene',
    sceneId: seeded.sceneIds[1],
    prompt: '镜头缓慢推近空荡的街口。',
    duration: 3,
  }, deps)
  assert.equal(missing.id, normal.id)
  assert.equal(missing.degraded, true)
  assert.equal(submissions.at(-1).firstFrameUrl, undefined)
  assert.equal(submissions.at(-1).lastFrameUrl, undefined)
})

test('文字过渡本地渲染完成，不占用视频模型与任务', async () => {
  const { dramaId, episodeId, storyboardIds, sceneIds } = await seedEpisode({
    videoConfigId: null,
    scenes: [{ imageUrl: 'static/projects/x/scenes/night.jpg' }],
  })
  const { submissions, renders, deps } = fakeDeps()

  const view = await createCustomTransition({
    episodeId,
    fromStoryboardId: storyboardIds[0],
    toStoryboardId: storyboardIds[1],
    kind: 'text',
    textContent: '  三年后  ',
    textSubtitle: ' 雨夜重逢 ',
    sceneId: sceneIds[0],
    duration: 2.5,
  }, deps)

  assert.equal(submissions.length, 0)
  assert.equal(renders.length, 1)
  assert.equal(renders[0].title, '三年后')
  assert.equal(renders[0].subtitle, '雨夜重逢')
  assert.equal(renders[0].durationMs, 2500)
  assert.equal(renders[0].width, 1280)
  assert.equal(renders[0].height, 720)
  assert.equal(renders[0].fps, 30)
  assert.equal(renders[0].backgroundImagePath, path.join(root, 'static/projects/x/scenes/night.jpg'))
  assert.equal(view.kind, 'text')
  assert.equal(view.edgeMode, 'cut')
  assert.equal(view.status, 'completed')
  assert.equal(view.provider, 'local')
  assert.equal(view.model, 'ffmpeg-text')
  assert.equal(view.durationActual, 2.5)
  assert.match(view.videoUrl || '', new RegExp(`^static/projects/${dramaId}/transitions/.+\\.mp4$`))
  assert.ok(fsSync.existsSync(path.join(root, view.videoUrl!)))
})

test('创建自定义过渡校验断点、类型、时长、场景归属与文字长度', async () => {
  const configId = await insertVideoConfig()
  const three = await seedEpisode({
    videoConfigId: configId,
    storyboards: [{ number: 1 }, { number: 2 }, { number: 3 }],
    scenes: [{ imageUrl: 'static/a.jpg' }],
  })
  const other = await seedEpisode({ videoConfigId: configId, scenes: [{ imageUrl: 'static/b.jpg' }] })
  const { deps } = fakeDeps()

  await assert.rejects(createCustomTransition({
    episodeId: three.episodeId,
    fromStoryboardId: three.storyboardIds[0],
    toStoryboardId: three.storyboardIds[2],
    kind: 'empty', prompt: '空镜', duration: 3,
  }, deps), /断点已变化/)

  await assert.rejects(createCustomTransition({
    episodeId: three.episodeId,
    fromStoryboardId: three.storyboardIds[0],
    toStoryboardId: three.storyboardIds[1],
    kind: 'ai' as any, prompt: '空镜', duration: 3,
  }, deps), /类型不合法/)

  await assert.rejects(createCustomTransition({
    episodeId: three.episodeId,
    fromStoryboardId: three.storyboardIds[0],
    toStoryboardId: three.storyboardIds[1],
    kind: 'empty', prompt: '空镜', duration: 6,
  }, deps), /2-5/)

  await assert.rejects(createCustomTransition({
    episodeId: three.episodeId,
    fromStoryboardId: three.storyboardIds[0],
    toStoryboardId: three.storyboardIds[1],
    kind: 'empty', prompt: '  ', duration: 3,
  }, deps), /提示词/)

  await assert.rejects(createCustomTransition({
    episodeId: three.episodeId,
    fromStoryboardId: three.storyboardIds[0],
    toStoryboardId: three.storyboardIds[1],
    kind: 'scene', sceneId: other.sceneIds[0], prompt: '场景', duration: 3,
  }, deps), /场景/)

  await assert.rejects(createCustomTransition({
    episodeId: three.episodeId,
    fromStoryboardId: three.storyboardIds[0],
    toStoryboardId: three.storyboardIds[1],
    kind: 'text', textContent: '', duration: 3,
  }, deps), /主标题/)
})

test('检验进行中拒绝新建或重生成过渡镜头', async () => {
  const configId = await insertVideoConfig()
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  await db.insert(schema.storyboardAuditJobs).values({
    episodeId,
    dramaId,
    trigger: 'manual',
    status: 'auditing',
    totalShots: 2,
    totalWindows: 1,
    createdAt: ts,
    updatedAt: ts,
  })
  const { deps } = fakeDeps()

  await assert.rejects(createCustomTransition({
    episodeId,
    fromStoryboardId: storyboardIds[0],
    toStoryboardId: storyboardIds[1],
    kind: 'empty', prompt: '空镜', duration: 3,
  }, deps), /检验进行中/)
  assert.equal((await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))).length, 0)

  await db.update(schema.storyboardAuditJobs).set({ status: 'done', finishedAt: ts })
    .where(eq(schema.storyboardAuditJobs.episodeId, episodeId))
  const { deps: okDeps } = fakeDeps()
  const created = await createCustomTransition({
    episodeId,
    fromStoryboardId: storyboardIds[0],
    toStoryboardId: storyboardIds[1],
    kind: 'empty', prompt: '空镜', duration: 3,
  }, okDeps)
  await assert.rejects(retryTransition(created.id!, {}, deps), /运行中/)
  await db.update(schema.videoTransitions).set({ status: 'failed' })
    .where(eq(schema.videoTransitions.id, created.id!))
  await db.insert(schema.storyboardAuditJobs).values({
    episodeId, dramaId, trigger: 'manual', status: 'rechecking', totalShots: 2, totalWindows: 1,
    createdAt: ts, updatedAt: ts,
  })
  await assert.rejects(retryTransition(created.id!, {}, deps), /检验进行中/)
})

test('切换类型会清空旧输出，按新类型重新生成', async () => {
  const configId = await insertVideoConfig()
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps, submissions, renders } = fakeDeps()
  const created = await createCustomTransition({
    episodeId,
    fromStoryboardId: storyboardIds[0],
    toStoryboardId: storyboardIds[1],
    kind: 'empty', prompt: '旧空镜', duration: 3,
  }, deps)
  const oldRel = `static/projects/${dramaId}/transitions/old-empty.mp4`
  fsSync.mkdirSync(path.dirname(path.join(root, oldRel)), { recursive: true })
  fsSync.writeFileSync(path.join(root, oldRel), Buffer.alloc(1024))
  await db.update(schema.videoTransitions).set({ status: 'completed', videoUrl: oldRel })
    .where(eq(schema.videoTransitions.id, created.id!))

  const switched = await createCustomTransition({
    episodeId,
    fromStoryboardId: storyboardIds[0],
    toStoryboardId: storyboardIds[1],
    kind: 'text', textContent: '三年后', duration: 3,
  }, deps)

  assert.equal(switched.id, created.id)
  assert.equal(switched.kind, 'text')
  assert.equal(switched.edgeMode, 'cut')
  assert.equal(switched.status, 'completed')
  assert.equal(renders.length, 1)
  assert.equal(submissions.at(-1).audioMode, 'silent')
  assert.equal(fsSync.existsSync(path.join(root, oldRel)), false, '旧类型的视频应清空')
  const rows = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  assert.equal(rows.length, 1)
})

test('独立指纹：相邻镜头视频变化不使空镜过期，修改提示词才过期', async () => {
  const configId = await insertVideoConfig()
  const { dramaId, episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps } = fakeDeps()
  const created = await createCustomTransition({
    episodeId,
    fromStoryboardId: storyboardIds[0],
    toStoryboardId: storyboardIds[1],
    kind: 'empty', prompt: '雨夜空镜', duration: 3,
  }, deps)
  const rel = `static/projects/${dramaId}/transitions/empty.mp4`
  fsSync.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fsSync.writeFileSync(path.join(root, rel), Buffer.alloc(2048))
  await db.update(schema.videoTransitions).set({ status: 'completed', videoUrl: rel })
    .where(eq(schema.videoTransitions.id, created.id!))

  const first = await listTransitions({ episodeId, storyboardIds })
  assert.equal(first.boundaries[0].stale, false)
  assert.equal(first.boundaries[0].kind, 'empty')
  assert.equal(first.summary.ready, 1)

  const fromVideo = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardIds[0])))[0].videoUrl
  fsSync.appendFileSync(path.join(root, String(fromVideo)), Buffer.alloc(16))
  const afterVideoChange = await listTransitions({ episodeId, storyboardIds })
  assert.equal(afterVideoChange.boundaries[0].stale, false)

  await saveTransitionPrompt(created.id!, { prompt: '修改后的空镜提示词' })
  const afterPrompt = await listTransitions({ episodeId, storyboardIds })
  assert.equal(afterPrompt.boundaries[0].stale, true)
  assert.equal(afterPrompt.boundaries[0].prompt, '修改后的空镜提示词')
})

test('本地 H3 空镜中文提示词翻译失败直接报错，不回退中文', async () => {
  const configId = await insertVideoConfig({
    provider: 'minimax',
    model: 'MiniMax-H3',
    baseUrl: 'http://127.0.0.1:8190',
  })
  const { episodeId, storyboardIds } = await seedEpisode({ videoConfigId: configId })
  const { deps, submissions } = fakeDeps()

  await assert.rejects(createCustomTransition({
    episodeId,
    fromStoryboardId: storyboardIds[0],
    toStoryboardId: storyboardIds[1],
    kind: 'empty',
    prompt: '雨夜空无一人的街角',
    duration: 3,
  }, deps), /翻译|英文/)
  assert.equal(submissions.length, 0)

  const translated = await createCustomTransition({
    episodeId,
    fromStoryboardId: storyboardIds[0],
    toStoryboardId: storyboardIds[1],
    kind: 'empty',
    prompt: '雨夜空无一人的街角',
    duration: 3,
  }, {
    ...deps,
    translate: async () => 'An empty rainy street corner at night.',
  })
  assert.equal(translated.status, 'processing')
  assert.match(submissions.at(-1).prompt, /empty rainy street corner/)
  assert.doesNotMatch(submissions.at(-1).prompt, /[\u4e00-\u9fff]/)
})

test('list 暴露类型、场景、文字与合片方式字段', async () => {
  const configId = await insertVideoConfig()
  const { episodeId, storyboardIds, sceneIds } = await seedEpisode({
    videoConfigId: configId,
    scenes: [{ imageUrl: 'static/scene.jpg' }],
  })
  const { deps } = fakeDeps()
  await createCustomTransition({
    episodeId,
    fromStoryboardId: storyboardIds[0],
    toStoryboardId: storyboardIds[1],
    kind: 'scene',
    sceneId: sceneIds[0],
    prompt: '场景镜头',
    duration: 4,
  }, deps)

  const view = await listTransitions({ episodeId, storyboardIds })
  const boundary = view.boundaries[0]
  assert.equal(boundary.kind, 'scene')
  assert.equal(boundary.sceneId, sceneIds[0])
  assert.equal(boundary.textContent, null)
  assert.equal(boundary.textSubtitle, null)
  assert.equal(boundary.edgeMode, 'fade')
  assert.equal(boundary.durationRequested, 4)
})
