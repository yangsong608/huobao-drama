import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-sound-plan-audio-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  cueSeconds,
  cueContexts,
  compileCuePrompts,
  resolveCueTiming,
} = await import('../src/services/sound-plan-audio.ts')
import type { LoadedSoundPlan, SoundPlanCueContext } from '../src/services/sound-plan-audio.ts'
import type { TimelineCue, TimelineResult } from '../src/services/timeline.ts'

function shot(id: number, number: number, duration: number, patch: Record<string, unknown> = {}) {
  return {
    id,
    episodeId: 1,
    sceneId: 10,
    storyboardNumber: number,
    duration,
    location: '街道',
    time: '夜',
    atmosphere: '紧张',
    description: `镜头 ${number} 的动作`,
    videoPrompt: `镜头 ${number} 的动作`,
    soundEffect: null,
    bgmPrompt: null,
    ...patch,
  } as any
}

function cue(id: number, kind: string, fromShotId: number, toShotId: number, patch: Record<string, unknown> = {}) {
  return {
    id,
    planId: 1,
    unitKey: `unit-${id}`,
    unitLabel: '声音单元',
    kind,
    fromShotId,
    toShotId,
    fromShotNumber: fromShotId,
    toShotNumber: toShotId,
    startMs: null,
    endMs: null,
    description: kind === 'ambience' ? '街道夜的环境底噪' : '脚步声',
    intensity: null,
    entry: null,
    exit: null,
    delivery: 'post',
    sortOrder: id,
    ...patch,
  } as any
}

function timelineCue(id: number, startMs: number, endMs: number, text: string): TimelineCue {
  return {
    lineId: id,
    shotId: 1,
    startMs,
    endMs,
    subtitleStartMs: startMs,
    subtitleEndMs: endMs,
    text,
    speaker: '六婶',
    kind: 'dialogue',
    speed: 1,
    overflowMs: 0,
    overlap: false,
    trimmed: false,
    audioDurationMs: endMs - startMs,
    audioUrl: null,
  }
}

function timeline(clips: TimelineResult['clips'], cues: TimelineCue[] = []): TimelineResult {
  return {
    clips,
    cues,
    totalDurationMs: clips.length ? clips[clips.length - 1].endMs : 0,
    maxOverflowMs: 0,
    overlapCount: 0,
    atempoCount: 0,
    trimmedCount: 0,
    skippedLineIds: [],
  }
}

test('cue 时间：优先实际时间轴，缺少视频时回退计划时长', () => {
  const storyboards = [shot(1, 1, 5), shot(2, 2, 7)]
  const actual = resolveCueTiming(cue(1, 'ambience', 1, 2), storyboards, timeline([
    { storyboardId: 1, startMs: 0, endMs: 5000, durationMs: 5000 },
    { storyboardId: 2, startMs: 5000, endMs: 12000, durationMs: 7000 },
  ]))
  assert.deepEqual(actual, { startMs: 0, endMs: 12000, timeSource: 'timeline' })

  const planned = resolveCueTiming(cue(1, 'ambience', 1, 2), storyboards, timeline([]))
  assert.deepEqual(planned, { startMs: 0, endMs: 12000, timeSource: 'planned' })
})

test('分镜重建后旧 cue 的 shot id 失效，仍按镜头号解析计划时间', () => {
  const storyboards = Array.from({ length: 9 }, (_, index) => shot(701 + index, index + 1, 5))
  const stale = cue(1, 'bgm', 642, 650, { fromShotNumber: 1, toShotNumber: 9 })
  const timing = resolveCueTiming(stale, storyboards, timeline([]))
  assert.deepEqual(timing, { startMs: 0, endMs: 45000, timeSource: 'planned' })
})

test('cueContexts：收集镜头、场景、台词窗口，静默线索不生成', () => {
  const loaded = {
    plan: { id: 1, episodeId: 1, version: 1 } as any,
    cues: [cue(1, 'ambience', 1, 2), cue(2, 'silence', 1, 2)],
    storyboards: [shot(1, 1, 5), shot(2, 2, 7)],
    scenes: new Map([[10, { id: 10, location: '街道', time: '夜' } as any]]),
    timeline: timeline([
      { storyboardId: 1, startMs: 0, endMs: 5000, durationMs: 5000 },
      { storyboardId: 2, startMs: 5000, endMs: 12000, durationMs: 7000 },
    ], [timelineCue(11, 1000, 2200, '走吧'), timelineCue(12, 6000, 7600, '别回头')]),
  } as LoadedSoundPlan
  const { contexts } = cueContexts(loaded)
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].cue.id, 1)
  assert.equal(contexts[0].sceneLocation, '街道')
  assert.equal(contexts[0].dialogueCount, 2)
  assert.equal(contexts[0].timeSource, 'timeline')
  assert.equal(contexts[0].seconds, 30)
})

test('cue 时长：环境声/BGM 30–45 秒，音效 2–10 秒', () => {
  assert.equal(cueSeconds('ambience', 5000), 30)
  assert.equal(cueSeconds('bgm', 120000), 45)
  assert.equal(cueSeconds('sfx', 800), 2)
  assert.equal(cueSeconds('sfx', 60000), 10)
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('提示词覆盖优先；没有文本模型时确定性降级', async () => {
  const context = {
    cue: cue(1, 'ambience', 1, 2),
    category: 'ambience',
    startMs: 0,
    endMs: 5000,
    timeSource: 'planned',
    seconds: 30,
    sceneLocation: '街道',
    sceneTime: '夜',
    dialogueCount: 0,
    dialogueSummary: '',
    sourceSummary: '#1–#2 · 街道 · 夜 · 环境底噪',
    warnings: [],
  } as SoundPlanCueContext
  const overridden = await compileCuePrompts([context], [shot(1, 1, 5)], {
    prompts: { 1: 'custom rain ambience, no dialogue' },
    negatives: { 1: 'speech' },
  })
  assert.equal(overridden.items[0].prompt, 'custom rain ambience, no dialogue')
  assert.equal(overridden.items[0].negativePrompt, 'speech')
  assert.equal(overridden.items[0].degraded, false)

  const fallback = await compileCuePrompts([context], [shot(1, 1, 5)])
  assert.match(fallback.items[0].prompt, /ambient background/)
  assert.equal(fallback.items[0].degraded, true)
})
