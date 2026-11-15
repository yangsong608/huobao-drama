import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-facefusion-runner-'))
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

async function imageBuffer() {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 180, g: 120, b: 100 } } }).png().toBuffer()
}

test('face runner uses FaceFusion instead of the gateway when configured', async () => {
  const project = await projects.createVideoProject({ title: 'FaceFusion 运行器', mode: 'face' })
  const sourceRelative = storage.videoProjectStorageRelative(project.id, 'source', 'source.mp4')
  const sourceAbsolute = storage.resolveVideoProjectStorageFile(project.id, 'source/source.mp4')
  await fs.mkdir(path.dirname(sourceAbsolute), { recursive: true })
  await execFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', sourceAbsolute,
  ])
  await projects.saveVideoProjectFace(project.id, {
    name: 'face.png',
    type: 'image/png',
    buffer: await imageBuffer(),
  })
  db.update(schema.videoProjects).set({
    sourceVideoPath: sourceRelative,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.videoProjects.id, project.id)).run()

  const stamp = new Date().toISOString()
  const inserted = db.insert(schema.videoSwapRuns).values({
    projectId: project.id,
    mode: 'face',
    status: 'prompt_ready',
    stage: 'prompt_ready',
    progress: 100,
    maxGenerationSeconds: 8,
    chunkOverlapMs: 0,
    minChunkSeconds: 1,
    maxChunks: 10,
    audioMasterPath: sourceRelative,
    proxyPath: sourceRelative,
    analysisJson: JSON.stringify({
      source: { durationMs: 2000, width: 320, height: 180, fps: 24, hasAudio: true },
      shots: [{ shot_index: 0, start_ms: 0, end_ms: 2000, duration_ms: 2000, chunk_count: 1 }],
    }),
    totalChunks: 1,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const runId = Number(inserted.lastInsertRowid)
  const shot = db.insert(schema.videoSwapShots).values({
    runId,
    shotIndex: 0,
    startMs: 0,
    endMs: 2000,
    durationMs: 2000,
    chunkCount: 1,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const shotId = Number(shot.lastInsertRowid)
  db.insert(schema.videoSwapChunks).values({
    runId,
    shotId,
    chunkIndex: 0,
    sourceStartMs: 0,
    sourceEndMs: 2000,
    overlapBeforeMs: 0,
    overlapAfterMs: 0,
    targetFrames: 48,
    status: 'queued',
    createdAt: stamp,
    updatedAt: stamp,
  }).run()

  const dir = path.join(root, 'facefusion')
  await fs.mkdir(path.join(dir, '.assets/models'), { recursive: true })
  await fs.writeFile(path.join(dir, 'facefusion.py'), '')
  await fs.writeFile(path.join(dir, '.assets/models/hyperswap_1a_256.onnx'), '')
  const python = path.join(dir, 'fake-python')
  await fs.writeFile(python, `#!/bin/sh
src=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -t) src="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$src" "$out"
`)
  await fs.chmod(python, 0o755)

  const config = {
    id: 1,
    provider: 'comfyui',
    baseUrl: 'http://fake:8194',
    apiKey: 'fake',
    model: '',
    settings: {
      face_engine: 'facefusion',
      face_workflow_slug: 'h3-face-swap',
      facefusion_dir: dir,
      facefusion_python: python,
      facefusion_model: 'hyperswap_1a_256',
      facefusion_execution_providers: 'cpu',
      facefusion_timeout_seconds: 60,
      poll_interval_ms: 5,
      timeout_seconds: 60,
      max_auto_retries: 0,
    },
  }

  const started = await runner.startVideoSwapRun(project.id, {
    config,
    runId,
    pollIntervalMs: 5,
    timeoutMs: 5000,
    maxAutoRetries: 0,
  })
  await runner.waitForVideoSwapIdle()
  const details = runner.getVideoSwapRunDetails(project.id, started.run_id)
  assert.equal(details.run.status, 'completed', details.run.error_message || '')
  assert.equal(details.shots[0].chunks[0].status, 'completed')
  assert.ok(details.run.merge_path)
})