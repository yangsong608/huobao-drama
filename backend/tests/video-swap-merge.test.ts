import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-swap-merge-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = path.join(root, 'data')
process.env.STORAGE_PATH = path.join(root, 'data', 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const sharp = (await import('sharp')).default
const { refreshFfmpegConfig, resolveFfmpegSuite } = await import('../src/utils/ffmpeg.ts')
refreshFfmpegConfig()
const { db, schema } = await import('../src/db/index.ts')
const projects = await import('../src/services/video-projects.ts')
const storage = await import('../src/services/video-project-storage.ts')
const media = await import('../src/services/video-swap-media.ts')
const seam = await import('../src/services/video-swap-seam.ts')
const runner = await import('../src/services/video-swap-runner.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function execFfmpeg(args: string[]): Promise<void> {
  const binary = resolveFfmpegSuite().ffmpeg.path
  if (!binary) return Promise.reject(new Error('ffmpeg 不可用'))
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `ffmpeg exit ${code}`))
    })
  })
}

async function makeSourceVideo(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await execFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest', file,
  ])
}

async function imageBuffer(color: { r: number; g: number; b: number }) {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: color } }).png().toBuffer()
}

test('media trim, concat and original audio mux keep frame count and duration', async () => {
  const source = path.join(root, 'source.mp4')
  await makeSourceVideo(source)
  const chunk = path.join(root, 'chunk.mp4')
  const trimmed = path.join(root, 'trimmed.mp4')
  await media.extractSourceChunk(source, chunk, 0, 4000)
  const info = await media.trimChunkVideo(chunk, trimmed, 0, 96)
  assert.ok(Math.abs(info.frameCount - 96) <= 1)
  const second = path.join(root, 'second.mp4')
  const secondTrimmed = path.join(root, 'second-trimmed.mp4')
  await media.extractSourceChunk(source, second, 4000, 6000)
  await media.trimChunkVideo(second, secondTrimmed, 0, 48)
  const joined = path.join(root, 'joined.mp4')
  await media.concatVideoParts([trimmed, secondTrimmed], joined)
  const joinedInfo = await media.probeMedia(joined)
  assert.ok(Math.abs(joinedInfo.frameCount - 144) <= 2)
  const final = path.join(root, 'final.mp4')
  const finalInfo = await media.muxOriginalAudio(joined, source, final)
  assert.equal(finalInfo.hasAudio, true)
  assert.ok(Math.abs(finalInfo.durationMs - 6000) <= 120)
})

test('extractSourceChunk adds a silent audio track when the source has none', async () => {
  const silent = path.join(root, 'silent.mp4')
  await fs.mkdir(path.dirname(silent), { recursive: true })
  await execFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-t', '3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    silent,
  ])
  const before = await media.probeMedia(silent)
  assert.equal(before.hasAudio, false)
  const chunk = path.join(root, 'silent-chunk.mp4')
  await media.extractSourceChunk(silent, chunk, 0, 2000)
  const info = await media.probeMedia(chunk)
  assert.equal(info.hasAudio, true)
  assert.ok(Math.abs(info.durationMs - 2000) <= 120)
  assert.ok(Math.abs(info.frameCount - 48) <= 1)
})

test('muxOriginalAudio copies the video when the source has no audio', async () => {
  const video = path.join(root, 'no-audio.mp4')
  const output = path.join(root, 'no-audio-muxed.mp4')
  await execFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    video,
  ])
  const info = await media.muxOriginalAudio(video, video, output)
  assert.equal(info.hasAudio, false)
  assert.ok(Math.abs(info.frameCount - 24) <= 1)
  assert.ok((await fs.stat(output)).size > 0)
})

test('seam metrics distinguish identical frames from a color jump', async () => {
  const a = path.join(root, 'a.png')
  const b = path.join(root, 'b.png')
  const c = path.join(root, 'c.png')
  await fs.writeFile(a, await imageBuffer({ r: 40, g: 80, b: 120 }))
  await fs.writeFile(b, await imageBuffer({ r: 40, g: 80, b: 120 }))
  await fs.writeFile(c, await imageBuffer({ r: 0, g: 0, b: 0 }))
  const same = await seam.computeSeamMetrics(a, b)
  assert.ok(same.ssim > 0.99)
  assert.ok(same.colorDelta < 0.01)
  assert.equal(seam.seamVerdict(same, seam.DEFAULT_SEAM_THRESHOLDS), 'ok')
  const jump = await seam.computeSeamMetrics(a, c)
  assert.ok(jump.ssim < 0.9)
  assert.ok(jump.colorDelta > 20)
  assert.equal(seam.seamVerdict(jump, seam.DEFAULT_SEAM_THRESHOLDS), 'warning')
})

function seedRun(runId: number, sourceRelative: string) {
  const stamp = new Date().toISOString()
  const runRow = db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, runId)).get()!
  db.update(schema.videoProjects).set({ sourceVideoPath: sourceRelative, updatedAt: stamp }).where(eq(schema.videoProjects.id, runRow.projectId)).run()
  const shot = db.insert(schema.videoSwapShots).values({
    runId,
    shotIndex: 0,
    startMs: 0,
    endMs: 6000,
    durationMs: 6000,
    chunkCount: 2,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const shotId = Number(shot.lastInsertRowid)
  const plan = {
    mode: 'face',
    people: [{ slot: 1, name: '目标', description: 'woman', caption: 'the woman becomes a young woman' }],
    shots: [{
      shot_id: shotId,
      shot_index: 0,
      scene_reference_prompt: '',
      final_prompt: 'Faceswap, keep the original pose and background, natural skin, cinematic quality.',
      negative_prompt: 'subtitles',
      caption: 'single face',
    }],
    global_prompt: '',
    negative_prompt: 'subtitles',
    generation: { seed: 321, steps: 8 },
    warnings: [],
  }
  for (const chunk of [
    { index: 0, start: 0, end: 4000, before: 0, after: 1000, frames: 96 },
    { index: 1, start: 3000, end: 6000, before: 1000, after: 0, frames: 72 },
  ]) {
    db.insert(schema.videoSwapChunks).values({
      runId,
      shotId,
      chunkIndex: chunk.index,
      sourceStartMs: chunk.start,
      sourceEndMs: chunk.end,
      overlapBeforeMs: chunk.before,
      overlapAfterMs: chunk.after,
      targetFrames: chunk.frames,
      status: 'queued',
      createdAt: stamp,
      updatedAt: stamp,
    }).run()
  }
  db.update(schema.videoSwapRuns).set({
    status: 'prompt_ready',
    stage: 'prompt_ready',
    progress: 100,
    analysisJson: JSON.stringify({
      source: { durationMs: 6000, width: 320, height: 180, fps: 24, hasAudio: true },
      shots: [{ shot_index: 0, start_ms: 0, end_ms: 6000, duration_ms: 6000, chunk_count: 2 }],
    }),
    finalPromptJson: JSON.stringify(plan),
    audioMasterPath: sourceRelative,
    proxyPath: sourceRelative,
    totalChunks: 2,
    completedChunks: 0,
    updatedAt: stamp,
  }).where(eq(schema.videoSwapRuns.id, runId)).run()
  return { plan, shotId }
}

test('runner generates chunks, retries one failed chunk, checks seams and merges with original audio', async () => {
  const project = await projects.createVideoProject({ title: 'P8 运行器', mode: 'face' })
  const sourceRelative = storage.videoProjectStorageRelative(project.id, 'source', 'source.mp4')
  const sourceAbsolute = storage.resolveVideoProjectStorageFile(project.id, 'source/source.mp4')
  await makeSourceVideo(sourceAbsolute)
  await projects.saveVideoProjectFace(project.id, {
    name: 'face.png',
    type: 'image/png',
    buffer: await imageBuffer({ r: 180, g: 120, b: 100 }),
  })
  const stamp = new Date().toISOString()
  const inserted = db.insert(schema.videoSwapRuns).values({
    projectId: project.id,
    mode: 'face',
    status: 'prompt_ready',
    stage: 'prompt_ready',
    progress: 100,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const runId = Number(inserted.lastInsertRowid)
  seedRun(runId, sourceRelative)

  const uploads = new Map<string, string>()
  const jobs = new Map<string, string>()
  let uploadSeq = 0
  let jobSeq = 0
  let failedOnce = false
  const gateway = {
    async uploadVideo(_config: any, filePath: string) {
      uploadSeq += 1
      const name = `upload-${uploadSeq}.mp4`
      uploads.set(name, filePath)
      return name
    },
    async submitJob(_config: any, _slug: string, inputs: Record<string, unknown>) {
      jobSeq += 1
      const id = `job-${jobSeq}`
      jobs.set(id, String(inputs.source_video))
      return id
    },
    async fetchJob(_config: any, jobId: string) {
      if (jobId === 'job-2' && !failedOnce) {
        failedOnce = true
        return { status: 'failed', error: 'mock failure' }
      }
      return { status: 'succeeded', file_url: `fake://${jobId}` }
    },
    async cancelJob() {},
    async download(fileUrl: string, destination: string) {
      const jobId = fileUrl.replace('fake://', '')
      const uploaded = jobs.get(jobId)!
      await fs.copyFile(uploads.get(uploaded)!, destination)
    },
  }
  const config = {
    id: 1,
    provider: 'comfyui',
    baseUrl: 'http://fake:8194',
    apiKey: 'fake',
    model: '',
    settings: {
      face_workflow_slug: 'h3-face-swap',
      timeout_seconds: 60,
      poll_interval_ms: 5,
      max_auto_retries: 1,
      seam_ssim_threshold: 0.8,
      seam_color_delta_threshold: 20,
    },
  }
  const started = await runner.startVideoSwapRun(project.id, {
    config,
    gateway,
    pollIntervalMs: 5,
    timeoutMs: 5000,
    maxAutoRetries: 1,
  })
  await runner.waitForVideoSwapIdle()
  const details = runner.getVideoSwapRunDetails(project.id, started.run_id)
  assert.equal(details.run.status, 'completed', details.run.error_message || '')
  assert.equal(details.shots.length, 1)
  assert.equal(details.shots[0].chunks.length, 2)
  assert.ok(details.shots[0].chunks.every(chunk => chunk.status === 'completed'))
  assert.ok(details.shots[0].chunks[1].retry_count >= 1)
  assert.equal(details.shots[0].chunks[0].retry_count, 0)
  assert.equal(details.shots[0].chunks[1].seam_verdict, 'ok')
  assert.ok(details.run.merge_path)
  const merged = storage.resolveVideoProjectStorageFile(
    project.id,
    details.run.merge_path!.slice(`static/video-projects/${project.id}/`.length),
  )
  assert.ok((await fs.stat(merged)).size > 0)
  const info = await media.probeMedia(merged)
  assert.equal(info.hasAudio, true)
  assert.ok(Math.abs(info.durationMs - 6000) <= 120)
  assert.ok(Math.abs(info.frameCount - 144) <= 2)
})

test('seam warning automatically retries the next chunk once', async () => {
  const project = await projects.createVideoProject({ title: 'P8 接缝重试', mode: 'face' })
  const sourceRelative = storage.videoProjectStorageRelative(project.id, 'source', 'source.mp4')
  const sourceAbsolute = storage.resolveVideoProjectStorageFile(project.id, 'source/source.mp4')
  await makeSourceVideo(sourceAbsolute)
  await projects.saveVideoProjectFace(project.id, {
    name: 'face.png', type: 'image/png', buffer: await imageBuffer({ r: 90, g: 110, b: 130 }),
  })
  const stamp = new Date().toISOString()
  const inserted = db.insert(schema.videoSwapRuns).values({
    projectId: project.id, mode: 'face', status: 'prompt_ready', stage: 'prompt_ready', progress: 100,
    createdAt: stamp, updatedAt: stamp,
  }).run()
  const runId = Number(inserted.lastInsertRowid)
  seedRun(runId, sourceRelative)
  const bad = path.join(root, 'bad.mp4')
  await execFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:size=320x180:rate=24', '-t', '3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', bad,
  ])
  const uploads = new Map<string, string>()
  const jobs = new Map<string, string>()
  let uploadSeq = 0
  let jobSeq = 0
  const gateway = {
    async uploadVideo(_config: any, filePath: string) {
      uploadSeq += 1
      const name = `upload-${uploadSeq}.mp4`
      uploads.set(name, filePath)
      return name
    },
    async submitJob(_config: any, _slug: string, inputs: Record<string, unknown>) {
      jobSeq += 1
      const id = `job-${jobSeq}`
      jobs.set(id, String(inputs.source_video))
      return id
    },
    async fetchJob(_config: any, jobId: string) {
      return { status: 'succeeded', file_url: `fake://${jobId}` }
    },
    async cancelJob() {},
    async download(fileUrl: string, destination: string) {
      const jobId = fileUrl.replace('fake://', '')
      if (jobId === 'job-2') return fs.copyFile(bad, destination)
      await fs.copyFile(uploads.get(jobs.get(jobId)!)!, destination)
    },
  }
  const config = {
    id: 1, provider: 'comfyui', baseUrl: 'http://fake:8194', apiKey: 'fake', model: '',
    settings: {
      face_workflow_slug: 'h3-face-swap', timeout_seconds: 60, poll_interval_ms: 5,
      max_auto_retries: 1, seam_ssim_threshold: 0.8, seam_color_delta_threshold: 20,
    },
  }
  const started = await runner.startVideoSwapRun(project.id, {
    config, gateway, pollIntervalMs: 5, timeoutMs: 5000, maxAutoRetries: 1,
  })
  await runner.waitForVideoSwapIdle()
  const details = runner.getVideoSwapRunDetails(project.id, started.run_id)
  assert.equal(details.run.status, 'completed', details.run.error_message || '')
  assert.equal(uploadSeq, 3)
  assert.equal(details.shots[0].chunks[1].retry_count, 1)
  assert.equal(details.shots[0].chunks[1].seam_verdict, 'ok')
  assert.ok((details.run.output_meta?.warnings || []).length === 0)
})

test('a chunk failure blocks merge and preserves the failed chunk', async () => {
  const project = await projects.createVideoProject({ title: 'P8 失败阻断', mode: 'face' })
  const sourceRelative = storage.videoProjectStorageRelative(project.id, 'source', 'source.mp4')
  await makeSourceVideo(storage.resolveVideoProjectStorageFile(project.id, 'source/source.mp4'))
  await projects.saveVideoProjectFace(project.id, {
    name: 'face.png', type: 'image/png', buffer: await imageBuffer({ r: 70, g: 71, b: 72 }),
  })
  const stamp = new Date().toISOString()
  const inserted = db.insert(schema.videoSwapRuns).values({
    projectId: project.id, mode: 'face', status: 'prompt_ready', stage: 'prompt_ready', progress: 100,
    createdAt: stamp, updatedAt: stamp,
  }).run()
  const runId = Number(inserted.lastInsertRowid)
  seedRun(runId, sourceRelative)
  const gateway = {
    async uploadVideo() { return 'upload-failed.mp4' },
    async submitJob() { return 'job-failed' },
    async fetchJob() { return { status: 'failed', error: 'mock permanent failure' } },
    async cancelJob() {},
    async download() { throw new Error('should not download') },
  }
  const config = {
    id: 1, provider: 'comfyui', baseUrl: 'http://fake:8194', apiKey: 'fake', model: '',
    settings: { face_workflow_slug: 'h3-face-swap', poll_interval_ms: 5, timeout_seconds: 60, max_auto_retries: 1 },
  }
  const started = await runner.startVideoSwapRun(project.id, {
    config, gateway, pollIntervalMs: 5, timeoutMs: 5000, maxAutoRetries: 1,
  })
  await runner.waitForVideoSwapIdle()
  const deadline = Date.now() + 5000
  let details = runner.getVideoSwapRunDetails(project.id, started.run_id)
  while (details.run.status === 'generating' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
    details = runner.getVideoSwapRunDetails(project.id, started.run_id)
  }
  assert.equal(details.run.status, 'failed')
  assert.equal(details.run.merge_path, null)
  assert.equal(details.shots[0].chunks[0].status, 'failed')
  assert.match(details.run.error_message || '', /permanent failure/)
})

test('cancel stops an in-flight run without merging', async () => {
  const project = await projects.createVideoProject({ title: 'P8 取消', mode: 'face' })
  const sourceRelative = storage.videoProjectStorageRelative(project.id, 'source', 'source.mp4')
  await makeSourceVideo(storage.resolveVideoProjectStorageFile(project.id, 'source/source.mp4'))
  await projects.saveVideoProjectFace(project.id, {
    name: 'face.png', type: 'image/png', buffer: await imageBuffer({ r: 120, g: 140, b: 160 }),
  })
  const stamp = new Date().toISOString()
  const inserted = db.insert(schema.videoSwapRuns).values({
    projectId: project.id, mode: 'face', status: 'prompt_ready', stage: 'prompt_ready', progress: 100,
    createdAt: stamp, updatedAt: stamp,
  }).run()
  const runId = Number(inserted.lastInsertRowid)
  seedRun(runId, sourceRelative)
  const gateway = {
    async uploadVideo() { return 'upload-cancel.mp4' },
    async submitJob() { return 'job-cancel' },
    async fetchJob() { return { status: 'processing' } },
    async cancelJob() {},
    async download() { throw new Error('should not download') },
  }
  const config = {
    id: 1, provider: 'comfyui', baseUrl: 'http://fake:8194', apiKey: 'fake', model: '',
    settings: { face_workflow_slug: 'h3-face-swap', poll_interval_ms: 5, timeout_seconds: 60 },
  }
  const started = await runner.startVideoSwapRun(project.id, {
    config, gateway, pollIntervalMs: 5, timeoutMs: 5000,
  })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const chunk = db.select().from(schema.videoSwapChunks).where(eq(schema.videoSwapChunks.runId, started.run_id)).get()
    if (chunk?.status === 'generating') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const cancelled = runner.cancelVideoSwapRun(project.id, started.run_id)
  assert.equal(cancelled.run.status, 'cancelled')
  await runner.waitForVideoSwapIdle()
  const details = runner.getVideoSwapRunDetails(project.id, started.run_id)
  assert.equal(details.run.status, 'cancelled')
  assert.equal(details.run.merge_path, null)
})

test('resume skips completed chunks and only submits the remaining chunk', async () => {
  const project = await projects.createVideoProject({ title: 'P8 恢复', mode: 'face' })
  const sourceRelative = storage.videoProjectStorageRelative(project.id, 'source', 'source.mp4')
  const sourceAbsolute = storage.resolveVideoProjectStorageFile(project.id, 'source/source.mp4')
  await makeSourceVideo(sourceAbsolute)
  await projects.saveVideoProjectFace(project.id, {
    name: 'face.png', type: 'image/png', buffer: await imageBuffer({ r: 60, g: 90, b: 120 }),
  })
  const stamp = new Date().toISOString()
  const inserted = db.insert(schema.videoSwapRuns).values({
    projectId: project.id, mode: 'face', status: 'generating', stage: 'generating', progress: 40,
    createdAt: stamp, updatedAt: stamp,
  }).run()
  const runId = Number(inserted.lastInsertRowid)
  const seeded = seedRun(runId, sourceRelative)
  const first = db.select().from(schema.videoSwapChunks)
    .where(eq(schema.videoSwapChunks.runId, runId)).all().find(chunk => chunk.chunkIndex === 0)!
  const firstTrimmed = storage.videoProjectStorageRelative(project.id, 'chunks', `run-${runId}/resume-first.mp4`)
  await media.extractSourceChunk(sourceAbsolute, path.join(root, 'resume-chunk.mp4'), 0, 4000)
  await media.trimChunkVideo(path.join(root, 'resume-chunk.mp4'), storage.resolveVideoProjectStorageFile(project.id, firstTrimmed.slice(`static/video-projects/${project.id}/`.length)), 0, 96)
  db.update(schema.videoSwapChunks).set({
    status: 'completed',
    trimmedPath: firstTrimmed,
    outputPath: firstTrimmed,
    targetFrames: 96,
  }).where(eq(schema.videoSwapChunks.id, first.id)).run()
  db.update(schema.videoSwapShots).set({ status: 'pending' }).where(eq(schema.videoSwapShots.id, seeded.shotId)).run()
  db.update(schema.videoSwapRuns).set({
    paramsJson: JSON.stringify({
      version: 1, workflow_slug: 'h3-face-swap', seed: 1, steps: 8, fps: 24,
      max_generation_seconds: 8, chunk_overlap_ms: 1000, timeout_ms: 5000,
      poll_interval_ms: 5, max_auto_retries: 1, crossfade_frames: 0,
      seam: { ssim: 0.8, colorDelta: 20, faceSimilarity: 0.75 },
    }),
    status: 'generating',
  }).where(eq(schema.videoSwapRuns.id, runId)).run()

  let uploads = 0
  let uploadedPath = ''
  const gateway = {
    async uploadVideo(_config: any, filePath: string) {
      uploads += 1
      uploadedPath = filePath
      return 'upload-resume.mp4'
    },
    async submitJob() { return 'job-resume' },
    async fetchJob() { return { status: 'succeeded', file_url: 'fake://resume' } },
    async cancelJob() {},
    async download(_fileUrl: string, destination: string) {
      await fs.copyFile(uploadedPath, destination)
    },
  }
  const config = {
    id: 1, provider: 'comfyui', baseUrl: 'http://fake:8194', apiKey: 'fake', model: '',
    settings: { face_workflow_slug: 'h3-face-swap', poll_interval_ms: 5, timeout_seconds: 60 },
  }
  await runner.executeVideoSwapRun(runId, {
    config, gateway, pollIntervalMs: 5, timeoutMs: 5000,
  })
  const details = runner.getVideoSwapRunDetails(project.id, runId)
  assert.equal(uploads, 1)
  assert.equal(details.run.status, 'completed', details.run.error_message || '')
  assert.equal(details.shots[0].chunks[0].status, 'completed')
  assert.equal(details.shots[0].chunks[1].status, 'completed')
  assert.equal(details.shots[0].chunks[0].retry_count, 0)
})
