import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-character-runner-'))
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

async function makeSourceVideo(file: string, seconds: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await execFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest', file,
  ])
}

async function imageBuffer(color: { r: number; g: number; b: number }) {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: color } }).png().toBuffer()
}

test('character runner routes 6s chunks to Recast and 7s chunks to Relay', async () => {
  const project = await projects.createVideoProject({ title: '角色路由验收', mode: 'character' })
  const sourceRelative = storage.videoProjectStorageRelative(project.id, 'source', 'source.mp4')
  const sourceAbsolute = storage.resolveVideoProjectStorageFile(project.id, 'source/source.mp4')
  await makeSourceVideo(sourceAbsolute, 14)
  const withFace = await projects.saveVideoProjectFace(project.id, {
    name: 'character.png',
    type: 'image/png',
    buffer: await imageBuffer({ r: 210, g: 120, b: 150 }),
  })
  const faceRelative = String((withFace!.reference_face_paths as string[])[0])
  db.update(schema.videoProjects).set({
    sourceVideoPath: sourceRelative,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.videoProjects.id, project.id)).run()

  const stamp = new Date().toISOString()
  const inserted = db.insert(schema.videoSwapRuns).values({
    projectId: project.id,
    mode: 'character',
    status: 'prompt_ready',
    stage: 'prompt_ready',
    progress: 100,
    maxGenerationSeconds: 10,
    chunkOverlapMs: 0,
    minChunkSeconds: 1,
    maxChunks: 10,
    audioMasterPath: sourceRelative,
    proxyPath: sourceRelative,
    analysisJson: JSON.stringify({
      source: { durationMs: 13000, width: 320, height: 180, fps: 24, hasAudio: true },
      shots: [
        { shot_index: 0, start_ms: 0, end_ms: 6000, duration_ms: 6000, chunk_count: 1 },
        { shot_index: 1, start_ms: 6000, end_ms: 13000, duration_ms: 7000, chunk_count: 1 },
      ],
    }),
    totalChunks: 2,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const runId = Number(inserted.lastInsertRowid)

  const shotA = db.insert(schema.videoSwapShots).values({
    runId,
    shotIndex: 0,
    startMs: 0,
    endMs: 6000,
    durationMs: 6000,
    chunkCount: 1,
    sceneReferencePath: faceRelative,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const shotB = db.insert(schema.videoSwapShots).values({
    runId,
    shotIndex: 1,
    startMs: 6000,
    endMs: 13000,
    durationMs: 7000,
    chunkCount: 1,
    sceneReferencePath: faceRelative,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const shotAId = Number(shotA.lastInsertRowid)
  const shotBId = Number(shotB.lastInsertRowid)

  const prompt = 'Replace the selected person with the character in <Picture 1>. Keep the reference face, hair and clothing, and preserve movement and scene.'
  db.update(schema.videoSwapRuns).set({
    finalPromptJson: JSON.stringify({
      mode: 'character',
      people: [{ slot: 1, caption: 'the character becomes the reference person' }],
      shots: [
        { shot_id: shotAId, shot_index: 0, final_prompt: prompt, negative_prompt: '', scene_reference_prompt: '' },
        { shot_id: shotBId, shot_index: 1, final_prompt: prompt, negative_prompt: '', scene_reference_prompt: '' },
      ],
      global_prompt: '',
      negative_prompt: '',
      generation: { seed: 7, steps: 8 },
      warnings: [],
    }),
    updatedAt: stamp,
  }).where(eq(schema.videoSwapRuns.id, runId)).run()

  for (const chunk of [
    { shotId: shotAId, index: 0, start: 0, end: 6000, frames: 144 },
    { shotId: shotBId, index: 0, start: 6000, end: 13000, frames: 168 },
  ]) {
    db.insert(schema.videoSwapChunks).values({
      runId,
      shotId: chunk.shotId,
      chunkIndex: chunk.index,
      sourceStartMs: chunk.start,
      sourceEndMs: chunk.end,
      overlapBeforeMs: 0,
      overlapAfterMs: 0,
      targetFrames: chunk.frames,
      status: 'queued',
      createdAt: stamp,
      updatedAt: stamp,
    }).run()
  }

  const submitted: Array<{ slug: string; inputs: Record<string, unknown> }> = []
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
    async submitJob(_config: any, slug: string, inputs: Record<string, unknown>) {
      submitted.push({ slug, inputs })
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
      await fs.copyFile(uploads.get(jobs.get(jobId)!)!, destination)
    },
  }
  const config = {
    id: 1,
    provider: 'comfyui',
    baseUrl: 'http://fake:8194',
    apiKey: 'fake',
    model: '',
    settings: {
      character_workflow_slug: 'h3-recast-relay',
      character_short_workflow_slug: 'h3-recast',
      character_short_max_seconds: 6,
      character_relay_warmup_seconds: 5.17,
      timeout_seconds: 60,
      poll_interval_ms: 5,
      max_auto_retries: 0,
      seam_ssim_threshold: 0.8,
      seam_color_delta_threshold: 20,
    },
  }

  const started = await runner.startVideoSwapRun(project.id, {
    config,
    gateway,
    pollIntervalMs: 5,
    timeoutMs: 5000,
    maxAutoRetries: 0,
  })
  await runner.waitForVideoSwapIdle()
  const details = runner.getVideoSwapRunDetails(project.id, started.run_id)
  assert.equal(details.run.status, 'completed', details.run.error_message || '')
  assert.deepEqual(submitted.map(item => item.slug), ['h3-recast', 'h3-recast-relay'])
  for (const item of submitted) {
    assert.equal(typeof item.inputs.scene_reference, 'string')
    assert.ok(String(item.inputs.scene_reference).startsWith('data:image/'))
    assert.equal(item.inputs.reference_face_1, undefined)
    assert.equal(typeof item.inputs.prompt, 'string')
    assert.ok(String(item.inputs.prompt).length > 0)
  }
  assert.ok(details.run.merge_path)
  assert.equal(details.shots.length, 2)
  assert.ok(details.shots.every(shot => shot.status === 'completed'))
  assert.equal(details.shots[0].chunks[0].warmup_frames, 0)
  assert.equal(details.shots[1].chunks[0].warmup_frames, 124)
  assert.ok(Number(details.shots[1].chunks[0].trim_start_ms) >= 5000, JSON.stringify(details.shots[1].chunks[0]))
})