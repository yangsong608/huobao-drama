/**
 * 混音台词 Bug 回归：台词准备/生成中已删除（软删）的台词不得再进入混音时间轴。
 * 根因：previewTimeline 过滤 storyboardLines 时漏掉 deletedAt。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-preview-timeline-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { previewTimeline } = await import('../src/services/dubbing.ts')
const { softDeleteLine } = await import('../src/services/line-workbench.ts')

const ts = '2026-11-07T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '已删台词回归', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
}).returning().all()

const projectRoot = path.join(root, 'static', 'projects', '1')
const audioDir = path.join(projectRoot, 'audio')
const videoDir = path.join(projectRoot, 'videos')
await fs.mkdir(audioDir, { recursive: true })
await fs.mkdir(videoDir, { recursive: true })
const tonePath = path.join(audioDir, 'tone.wav')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-ar', '48000', '-ac', '2', tonePath,
])
const shotPath = path.join(videoDir, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', shotPath,
])
const toneUrl = 'static/projects/1/audio/tone.wav'
const shotUrl = 'static/projects/1/videos/shot.mp4'

const [storyboard] = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, description: '雨夜', videoUrl: shotUrl,
  createdAt: ts, updatedAt: ts,
}).returning().all()

function insertLine(input: { lineNo: number; text: string; speaker: string }) {
  return db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id,
    lineNo: input.lineNo, sortOrder: input.lineNo,
    speakerType: 'dialogue', speakerName: input.speaker,
    text: input.text, speakText: input.text,
    plannedStartMs: 200, audioDurationMs: 1000, audioUrl: toneUrl,
    status: 'ready', createdAt: ts, updatedAt: ts,
  }).returning().get()
}

const keep = insertLine({ lineNo: 1, text: '这句要保留。', speaker: '林小雨' })
const dropped = insertLine({ lineNo: 2, text: '这句已经删除。', speaker: '林小雨' })
softDeleteLine(dropped.id)

test('已删除台词不得出现在 previewTimeline 时间轴', async () => {
  const timeline = await previewTimeline(episode.id, 1)
  const cueLineIds = timeline.cues.map((cue) => cue.lineId)
  assert.ok(cueLineIds.includes(keep.id), '未删除台词应保留在时间轴')
  assert.ok(
    !cueLineIds.includes(dropped.id),
    '已删除台词不应进入混音时间轴（混音对白轨由该时间轴生成）',
  )
})
