import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-analysis-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = path.join(root, 'data')
process.env.STORAGE_PATH = path.join(root, 'data', 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const projects = await import('../src/services/video-projects.ts')
const analysis = await import('../src/services/video-analysis.ts')
const storage = await import('../src/services/video-project-storage.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('analyzes a continuous clip into a persistent shot/chunk plan', async () => {
  const clip = path.join(root, 'source.mp4')
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=teal:s=320x240:d=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-r', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', clip,
  ])
  const buffer = await fs.readFile(clip)
  const project = await projects.createVideoProject({ title: 'P6 分析', mode: 'face' })
  await projects.saveVideoProjectSource(project.id, {
    name: 'source.mp4',
    type: 'video/mp4',
    buffer,
  })

  const started = await analysis.startVideoAnalysis(project.id)
  const deadline = Date.now() + 60_000
  let run = null
  while (Date.now() < deadline) {
    run = db.select().from(schema.videoSwapRuns)
      .where(eq(schema.videoSwapRuns.id, started.run_id))
      .get()
    if (run && ['analyzed', 'failed'].includes(run.status)) break
    await sleep(200)
  }
  assert.ok(run, 'analysis run missing')
  assert.equal(run.status, 'analyzed', run.errorMessage || '')
  assert.equal(run.stage, 'plan_ready')
  assert.ok(run.proxyPath)
  assert.ok(run.audioMasterPath)
  assert.ok(await fs.stat(storage.resolveVideoProjectStorageFile(
    project.id,
    run.proxyPath.slice(`static/video-projects/${project.id}/`.length),
  )).then(s => s.size > 0))
  assert.ok(await fs.stat(storage.resolveVideoProjectStorageFile(
    project.id,
    run.audioMasterPath.slice(`static/video-projects/${project.id}/`.length),
  )).then(s => s.size > 0))

  const plan = analysis.getVideoProjectPlan(project.id)
  assert.equal(plan.run?.status, 'analyzed')
  assert.equal(plan.shots.length, 1)
  assert.equal(plan.shots[0].chunks.length, 2)
  assert.equal(plan.shots[0].chunks[0].source_start_ms, 0)
  assert.equal(plan.shots[0].chunks[1].source_end_ms, 12000)
  for (const chunk of plan.shots[0].chunks) {
    assert.ok(chunk.source_end_ms - chunk.source_start_ms >= 5000)
    assert.ok(chunk.source_end_ms - chunk.source_start_ms <= 8000)
  }
  const analysisJson = plan.run?.analysis_json as any
  assert.equal(analysisJson.source.hasAudio, true)
  assert.ok(analysisJson.shots[0].keyframes.length >= 1)

  const first = plan.shots[0].chunks[0]
  const adjusted = analysis.updateVideoChunkPlan(project.id, first.shot_id, first.id, {
    source_end_ms: 6000,
    overlap_after_ms: 1000,
  })
  assert.equal(adjusted.source_end_ms, 6000)
  assert.equal(adjusted.target_frames, 144)
})

test('detects a hard cut and persists two shots', async () => {
  const clip = path.join(root, 'cut-source.mp4')
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=6',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=12',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-r', '24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip,
  ])
  const project = await projects.createVideoProject({ title: 'P6 硬切', mode: 'face' })
  await projects.saveVideoProjectSource(project.id, {
    name: 'cut-source.mp4',
    type: 'video/mp4',
    buffer: await fs.readFile(clip),
  })
  const started = await analysis.startVideoAnalysis(project.id)
  const deadline = Date.now() + 60_000
  let run = null
  while (Date.now() < deadline) {
    run = db.select().from(schema.videoSwapRuns)
      .where(eq(schema.videoSwapRuns.id, started.run_id))
      .get()
    if (run && ['analyzed', 'failed'].includes(run.status)) break
    await sleep(200)
  }
  assert.ok(run)
  assert.equal(run.status, 'analyzed', run.errorMessage || '')
  const plan = analysis.getVideoProjectPlan(project.id)
  assert.ok(plan.shots.length >= 2)
  assert.ok((plan.run?.analysis_json as any).scene_cuts.length >= 1)
})
