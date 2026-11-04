import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { buildDialogueTrack, buildBurnFilter, buildExtraTrackAudio, buildLoopedBgmTrack, buildMixGraph, buildMixGraphWithTracks, mixEpisodeAudio, probeDurationMs, renderAudioRange } from '../src/services/audio-mix.js'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

function makeTone(file: string, seconds: number, freq = 440) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
    '-ar', '24000', '-ac', '1', file,
  ])
}

test('对话轨按时码拼装，总时长与传入一致', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-'))
  const a = path.join(dir, 'a.wav')
  const b = path.join(dir, 'b.wav')
  makeTone(a, 0.8, 440)
  makeTone(b, 0.6, 660)

  const out = path.join(dir, 'dialogue.wav')
  const result = await buildDialogueTrack(
    [{ audioPath: a, startMs: 500 }, { audioPath: b, startMs: 2500 }],
    5000,
    out,
    path.join(dir, 'work'),
  )
  assert.equal(result.chunks, 1)
  const duration = await probeDurationMs(out)
  assert.ok(Math.abs(duration - 5000) < 120, `对话轨时长应约 5000ms，实际 ${duration}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('无可用音频时输出等长静音底，不抛错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-'))
  const out = path.join(dir, 'silence.wav')
  const result = await buildDialogueTrack([], 2000, out, dir)
  assert.equal(result.chunks, 0)
  const duration = await probeDurationMs(out)
  assert.ok(Math.abs(duration - 2000) < 120, `静音轨应约 2000ms，实际 ${duration}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('混音图：双声道对齐、normalize=0、sidechain 与 loudnorm 均在', () => {
  const graph = buildMixGraph(
    { originalAudio: 'duck', duckingThreshold: 0.05, duckingRatio: 6, bgmVolume: 0.18, targetLufs: -16, targetTp: -2 },
    false,
    30,
  )
  assert.match(graph, /channel_layouts=stereo/)
  assert.match(graph, /sidechaincompress=threshold=0\.05:ratio=6:attack=15:release=320/)
  assert.match(graph, /amix=inputs=2:normalize=0:duration=first:weights=1 1\.35/)
  assert.match(graph, /loudnorm=I=-16:TP=-2:LRA=9/)
})

test('BGM 循环裁剪到成片时长，生成有限长度音轨', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-bgm-track-'))
  const bgm = path.join(dir, 'bgm.wav')
  makeTone(bgm, 1, 220)
  const track = await buildLoopedBgmTrack(bgm, 3000, dir)
  const duration = await probeDurationMs(track)
  assert.ok(Math.abs(duration - 3000) < 120, `BGM 循环轨应约 3000ms，实际 ${duration}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('混音图：带 BGM 时多一级 duck 与片尾淡出', () => {
  const graph = buildMixGraph(
    { originalAudio: 'duck', duckingThreshold: 0.05, duckingRatio: 6, bgmVolume: 0.18, targetLufs: -16, targetTp: -2 },
    true,
    12,
  )
  assert.match(graph, /asplit=3/)
  assert.match(graph, /afade=t=out:st=10\.000:d=2/)
  assert.match(graph, /amix=inputs=3:normalize=0:duration=first:weights=1 0\.9 1\.35/)
})

test('软字幕短于视频时不得用 -shortest 把整片裁短', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-sub-'))
  const video = path.join(dir, 'v.mp4')
  const dialogue = path.join(dir, 'd.wav')
  const srt = path.join(dir, 's.srt')
  const out = path.join(dir, 'out.mp4')
  makeTone(dialogue, 3, 330)
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', '-ar', '48000', video,
  ])
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\n只有一秒\n', 'utf-8')

  const result = await mixEpisodeAudio({
    videoPath: video,
    dialoguePath: dialogue,
    outputPath: out,
    options: { subtitlePath: srt, subtitleMode: 'soft', durationMs: 3000 },
  })
  // 字幕只到 1s，但成片必须保持 3s
  assert.ok(result.durationMs >= 2900, `成片应保持约 3000ms，实际 ${result.durationMs}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('原声 keep 时不挂 sidechain，mute 必须是真零', () => {
  const keep = buildMixGraph(
    { originalAudio: 'keep', duckingThreshold: 0.05, duckingRatio: 6, bgmVolume: 0.18, targetLufs: -16, targetTp: -2 },
    false,
    10,
  )
  assert.doesNotMatch(keep, /sidechaincompress/)
  const mute = buildMixGraph(
    { originalAudio: 'mute', duckingThreshold: 0.05, duckingRatio: 6, bgmVolume: 0.18, targetLufs: -16, targetTp: -2 },
    false,
    10,
  )
  assert.match(mute, /\[0:a\][^;]*volume=0\[bed\]/)
  assert.doesNotMatch(mute, /volume=0\.03/)
  assert.doesNotMatch(mute, /sidechaincompress/)
})

test('烧录滤镜：有 ASS 用 ass，只有 SRT 退回 subtitles', () => {
  assert.equal(buildBurnFilter('/tmp/a.srt', '/tmp/a.ass'), "ass='/tmp/a.ass'")
  assert.equal(buildBurnFilter('/tmp/a.srt'), "subtitles='/tmp/a.srt'")
  assert.equal(buildBurnFilter('/tmp/a.ass'), "ass='/tmp/a.ass'")
  assert.equal(buildBurnFilter(null, null), null)
  // 路径里的冒号与单引号必须转义，否则滤镜串会被截断
  assert.match(buildBurnFilter(null, "/tmp/it's/a.ass")!, /it\\'s/)
})

/** ffmpeg-static 是否带 libass（ass/subtitles 滤镜） */
function hasLibass(): boolean {
  try {
    const out = execFileSync(ffmpegBin, ['-hide_banner', '-filters'], { encoding: 'utf-8' })
    return /\sass\s/.test(out) && /\ssubtitles\s/.test(out)
  } catch {
    return false
  }
}

async function makeBurnFixture(dir: string) {
  const video = path.join(dir, 'v.mp4')
  const dialogue = path.join(dir, 'd.wav')
  const srt = path.join(dir, 's.srt')
  const ass = path.join(dir, 's.ass')
  makeTone(dialogue, 2, 330)
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', '-ar', '48000', video,
  ])
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,500\n烧录回归\n', 'utf-8')
  fs.writeFileSync(ass, [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 320', 'PlayResY: 240', '',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,20,&H00FFFFFF,&H00000000,0,0,1,2,0,2,10,10,10,1', '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,烧录回归', '',
  ].join('\n'), 'utf-8')
  return { video, dialogue, srt, ass }
}

test('烧录 SRT 不得报 libass track 错误（回归）', async (t) => {
  if (!hasLibass()) return t.skip('当前 ffmpeg 不含 libass')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-burn-srt-'))
  const { video, dialogue, srt } = await makeBurnFixture(dir)
  const out = path.join(dir, 'out.mp4')
  const result = await mixEpisodeAudio({
    videoPath: video,
    dialoguePath: dialogue,
    outputPath: out,
    options: { subtitlePath: srt, subtitleMode: 'burn', durationMs: 2000 },
  })
  assert.ok(result.durationMs >= 1900, `烧录后成片应保持约 2000ms，实际 ${result.durationMs}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('烧录优先使用 ASS 文件', async (t) => {
  if (!hasLibass()) return t.skip('当前 ffmpeg 不含 libass')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-burn-ass-'))
  const { video, dialogue, srt, ass } = await makeBurnFixture(dir)
  const out = path.join(dir, 'out.mp4')
  const result = await mixEpisodeAudio({
    videoPath: video,
    dialoguePath: dialogue,
    outputPath: out,
    options: { subtitlePath: srt, subtitleAssPath: ass, subtitleMode: 'burn', durationMs: 2000 },
  })
  assert.ok(result.durationMs >= 1900, `烧录后成片应保持约 2000ms，实际 ${result.durationMs}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('多轨混音图：输入编号、duck 与权重正确', () => {
  const resolved = {
    originalAudio: 'duck' as const,
    duckingThreshold: 0.05,
    duckingRatio: 6,
    bgmVolume: 0.18,
    targetLufs: -16,
    targetTp: -2,
  }
  const graph = buildMixGraphWithTracks(
    resolved,
    { hasBgm: true, tracks: [{ volume: 0.5, ducking: true }, { volume: 1.2, ducking: false }] },
    10,
  )
  assert.match(graph, /\[3:a\]/)
  assert.match(graph, /\[4:a\]/)
  assert.match(graph, /\[trk0\]\[vo_trk0\]sidechaincompress/)
  assert.doesNotMatch(graph, /trk1\]\[vo_trk1\]/)
  assert.match(graph, /amix=inputs=5:normalize=0:duration=first:weights=1 0\.9 1 1 1\.35/)
})

test('范围试听混音图：所有输入裁到同一时间段且不套片尾淡出', () => {
  const graph = buildMixGraphWithTracks(
    { originalAudio: 'keep', duckingThreshold: 0.05, duckingRatio: 6, bgmVolume: 0.18, targetLufs: -16, targetTp: -2 },
    { hasBgm: true, tracks: [{ volume: 1, ducking: false }], range: { startSec: 2, endSec: 5 }, bgmFadeOut: false },
    3,
  )
  assert.match(graph, /atrim=2\.000:5\.000/)
  assert.doesNotMatch(graph, /afade=t=out/)
})

test('附加音轨：多片段按时码拼成整集等长轨', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-extra-'))
  const a = path.join(dir, 'a.wav')
  const b = path.join(dir, 'b.wav')
  makeTone(a, 1, 440)
  makeTone(b, 0.5, 660)
  const file = await buildExtraTrackAudio({
    kind: 'ambience',
    name: '环境声',
    volume: 0.5,
    loop: false,
    clips: [
      { audioPath: a, startMs: 500, endMs: 1500 },
      { audioPath: b, startMs: 2200, endMs: 3200 },
    ],
  }, 4000, path.join(dir, 'work'))
  assert.ok(file, '应生成音轨文件')
  const duration = await probeDurationMs(file!)
  assert.ok(Math.abs(duration - 4000) < 120, `附加音轨应约 4000ms，实际 ${duration}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('范围试听：输出音频长度与请求时间段一致', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-range-'))
  const tone = path.join(dir, 'tone.wav')
  makeTone(tone, 4, 330)
  const dialogue = path.join(dir, 'dialogue.wav')
  await buildDialogueTrack([{ audioPath: tone, startMs: 0 }], 4000, dialogue, path.join(dir, 'work'))
  const out = path.join(dir, 'range.m4a')
  const result = await renderAudioRange({
    videoPath: null,
    dialoguePath: dialogue,
    outputPath: out,
    rangeStartMs: 1000,
    rangeEndMs: 3000,
  })
  assert.equal(result.startMs, 1000)
  assert.equal(result.endMs, 3000)
  const duration = await probeDurationMs(out)
  assert.ok(Math.abs(duration - 2000) < 200, `试听应约 2000ms，实际 ${duration}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('BGM 混音按时结束并保留音轨（回归：短曲循环不得挂住 ffmpeg）', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-bgm-'))
  const video = path.join(dir, 'v.mp4')
  const dialogue = path.join(dir, 'd.wav')
  const bgm = path.join(dir, 'bgm.wav')
  const out = path.join(dir, 'out.mp4')
  makeTone(dialogue, 3, 330)
  makeTone(bgm, 1, 220)
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', '-ar', '48000', video,
  ])

  const result = await mixEpisodeAudio({
    videoPath: video,
    dialoguePath: dialogue,
    outputPath: out,
    options: { bgmPath: bgm, bgmVolume: 0.18, durationMs: 3000 },
  })
  assert.equal(result.hasBgm, true)
  assert.ok(Math.abs(result.durationMs - 3000) < 200, `带 BGM 成片应约 3000ms，实际 ${result.durationMs}`)
  fs.rmSync(dir, { recursive: true, force: true })
})
