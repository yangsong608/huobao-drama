import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-projects-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = path.join(root, 'data')
process.env.STORAGE_PATH = path.join(root, 'data', 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { Hono } = await import('hono')
const sharp = (await import('sharp')).default
const route = await import('../src/routes/videoProjects.ts')
const { db, schema } = await import('../src/db/index.ts')
const storage = await import('../src/services/video-project-storage.ts')

const app = new Hono()
app.route('/video-projects', route.default)

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const MP4_HEADER = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('isomiso2', 'latin1'),
])

async function api(method: string, pathName: string, body?: unknown) {
  const headers: Record<string, string> = {}
  let payload: BodyInit | undefined
  if (body instanceof FormData) {
    payload = body
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const response = await app.fetch(new Request(`http://local${pathName}`, {
    method,
    headers,
    body: payload,
  }))
  return { status: response.status, payload: await response.json() as any }
}

async function createProject(title = '换人测试', mode = 'face') {
  const result = await api('POST', '/video-projects', { title, mode })
  assert.equal(result.status, 201, result.payload)
  return result.payload.data
}

test('route preview is resolved before project id and reports both modes', async () => {
  const result = await api('GET', '/video-projects/route-preview')
  assert.equal(result.status, 200, result.payload)
  assert.equal(result.payload.data.config_id, null)
  assert.equal(result.payload.data.face.mode, 'face')
  assert.equal(result.payload.data.character.mode, 'character')
  assert.equal(result.payload.data.character.character_short_max_seconds, 6)
})

test('creates, lists, updates and duplicates video projects', async () => {
  const project = await createProject()
  assert.equal(project.mode, 'face')
  assert.equal(project.status, 'draft')
  assert.deepEqual(project.reference_face_paths, [])
  assert.ok(storage.videoProjectStorageExists(project.id))

  const list = await api('GET', '/video-projects?keyword=换人')
  assert.equal(list.status, 200)
  assert.equal(list.payload.data.pagination.total, 1)
  assert.equal(list.payload.data.items[0].id, project.id)

  const video = new FormData()
  video.set('video', new File([MP4_HEADER], 'clip.mp4', { type: 'video/mp4' }))
  const uploadedVideo = await api('POST', `/video-projects/${project.id}/source-video`, video)
  assert.equal(uploadedVideo.status, 200, uploadedVideo.payload)
  assert.match(uploadedVideo.payload.data.source_video_path, new RegExp(`static/video-projects/${project.id}/source/`))
  assert.equal(uploadedVideo.payload.data.status, 'draft')

  const faceBuffer = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 210, g: 160, b: 130 } },
  }).png().toBuffer()
  const face = new FormData()
  face.set('image', new File([faceBuffer], 'face.png', { type: 'image/png' }))
  const uploadedFace = await api('POST', `/video-projects/${project.id}/reference-faces`, face)
  assert.equal(uploadedFace.status, 200, uploadedFace.payload)
  assert.equal(uploadedFace.payload.data.reference_face_paths.length, 1)
  assert.match(uploadedFace.payload.data.reference_face_urls[0], /^\/static\/video-projects\//)

  const updated = await api('PATCH', `/video-projects/${project.id}`, {
    title: '换人测试改名',
    prompt: '保留原动作和场景',
  })
  assert.equal(updated.status, 200, updated.payload)
  assert.equal(updated.payload.data.title, '换人测试改名')
  assert.equal(updated.payload.data.prompt, '保留原动作和场景')
  assert.equal(updated.payload.data.status, 'draft')

  const duplicated = await api('POST', `/video-projects/${project.id}/duplicate`)
  assert.equal(duplicated.status, 201, duplicated.payload)
  assert.equal(duplicated.payload.data.mode, 'face')
  assert.match(duplicated.payload.data.title, /副本$/)
  assert.match(duplicated.payload.data.source_video_path, new RegExp(`static/video-projects/${duplicated.payload.data.id}/source/`))
  assert.equal(duplicated.payload.data.reference_face_paths.length, 1)
  assert.ok(storage.videoProjectStorageExists(duplicated.payload.data.id))

  const detail = await api('GET', `/video-projects/${project.id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.payload.data.latest_run, null)
})

test('rejects invalid project input and invalid uploads', async () => {
  const badMode = await api('POST', '/video-projects', { title: 'x', mode: 'unknown' })
  assert.equal(badMode.status, 400)

  const emptyTitle = await api('POST', '/video-projects', { title: '  ', mode: 'face' })
  assert.equal(emptyTitle.status, 400)

  const project = await createProject('非法上传测试')
  const badVideo = new FormData()
  badVideo.set('video', new File([Buffer.from('not a video')], 'clip.txt', { type: 'text/plain' }))
  const badVideoResult = await api('POST', `/video-projects/${project.id}/source-video`, badVideo)
  assert.equal(badVideoResult.status, 400)

  const badFace = new FormData()
  badFace.set('image', new File([Buffer.from('not an image')], 'face.png', { type: 'image/png' }))
  const badFaceResult = await api('POST', `/video-projects/${project.id}/reference-faces`, badFace)
  assert.equal(badFaceResult.status, 400)
})

test('preflight reports missing video-swap config', async () => {
  const project = await createProject('预检测试')
  const video = new FormData()
  video.set('video', new File([MP4_HEADER], 'clip.mp4', { type: 'video/mp4' }))
  await api('POST', `/video-projects/${project.id}/source-video`, video)
  const faceBuffer = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 180, g: 180, b: 180 } },
  }).png().toBuffer()
  const face = new FormData()
  face.set('image', new File([faceBuffer], 'face.png', { type: 'image/png' }))
  await api('POST', `/video-projects/${project.id}/reference-faces`, face)

  const result = await api('POST', `/video-projects/${project.id}/preflight`)
  assert.equal(result.status, 200, result.payload)
  assert.equal(result.payload.data.ok, false)
  assert.ok(result.payload.data.blockers.some((item: any) => item.code === 'VIDEO_SWAP_CONFIG_MISSING'))
})

test('preflight reads an active video-swap config and checks the gateway', async () => {
  const project = await createProject('配置预检测试')
  const video = new FormData()
  video.set('video', new File([MP4_HEADER], 'clip.mp4', { type: 'video/mp4' }))
  await api('POST', `/video-projects/${project.id}/source-video`, video)
  const faceBuffer = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 160, g: 170, b: 180 } },
  }).png().toBuffer()
  const face = new FormData()
  face.set('image', new File([faceBuffer], 'face.png', { type: 'image/png' }))
  await api('POST', `/video-projects/${project.id}/reference-faces`, face)

  const stamp = new Date().toISOString()
  const inserted = db.insert(schema.aiServiceConfigs).values({
    serviceType: 'video-swap',
    provider: 'comfyui',
    name: '测试换人配置',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'test-key',
    model: '[]',
    priority: 1,
    isActive: true,
    settings: JSON.stringify({ face_workflow_slug: 'h3-face-swap', analysis_config_id: 1 }),
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const configId = Number(inserted.lastInsertRowid)
  try {
    const result = await api('POST', `/video-projects/${project.id}/preflight`)
    assert.equal(result.status, 200, result.payload)
    assert.ok(!result.payload.data.blockers.some((item: any) => item.code === 'VIDEO_SWAP_CONFIG_MISSING'))
    assert.ok(result.payload.data.blockers.some((item: any) => item.code === 'VIDEO_GATEWAY_UNREACHABLE'))
  } finally {
    db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId)).run()
  }
})

test('blocks deletion while a run is active', async () => {
  const project = await createProject('运行中删除测试')
  const stamp = new Date().toISOString()
  const run = db.insert(schema.videoSwapRuns).values({
    projectId: project.id,
    mode: 'face',
    status: 'generating',
    stage: 'generating',
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const runId = Number(run.lastInsertRowid)

  const blocked = await api('DELETE', `/video-projects/${project.id}`)
  assert.equal(blocked.status, 400, blocked.payload)
  assert.match(blocked.payload.message, /运行中/)

  db.update(schema.videoSwapRuns).set({ status: 'completed', stage: 'completed' })
    .where(eq(schema.videoSwapRuns.id, runId)).run()
  const deleted = await api('DELETE', `/video-projects/${project.id}`)
  assert.equal(deleted.status, 200, deleted.payload)
})

test('deletes project children and media explicitly', async () => {
  const project = await createProject('删除清理测试')
  const stamp = new Date().toISOString()
  const run = db.insert(schema.videoSwapRuns).values({
    projectId: project.id,
    mode: 'face',
    status: 'completed',
    stage: 'completed',
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const runId = Number(run.lastInsertRowid)
  const shot = db.insert(schema.videoSwapShots).values({
    runId,
    shotIndex: 0,
    startMs: 0,
    endMs: 6000,
    durationMs: 6000,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const shotId = Number(shot.lastInsertRowid)
  db.insert(schema.videoSwapChunks).values({
    runId,
    shotId,
    chunkIndex: 0,
    sourceStartMs: 0,
    sourceEndMs: 6000,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  db.insert(schema.videoSwapRunLogs).values({
    runId,
    shotId,
    level: 'info',
    stage: 'completed',
    message: 'done',
    createdAt: stamp,
  }).run()

  const deleted = await api('DELETE', `/video-projects/${project.id}`)
  assert.equal(deleted.status, 200, deleted.payload)
  const missing = await api('GET', `/video-projects/${project.id}`)
  assert.equal(missing.status, 404)
  assert.equal(storage.videoProjectStorageExists(project.id), false)
  assert.equal(db.select().from(schema.videoSwapRunLogs).all().length, 0)
  assert.equal(db.select().from(schema.videoSwapChunks).all().length, 0)
  assert.equal(db.select().from(schema.videoSwapShots).all().length, 0)
  assert.equal(db.select().from(schema.videoSwapRuns).all().length, 0)
  const archived = db.select().from(schema.videoProjects).all().find(row => row.id === project.id)
  assert.ok(archived?.deletedAt)
})
