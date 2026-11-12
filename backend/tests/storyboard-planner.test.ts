import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-planner-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { planStoryboardShots, buildPlannedShotsBlock } = await import('../src/services/storyboard-planner.ts')
const { validatePlanSequence } = await import('../src/services/storyboard-plan-contract.ts')

const SCENE_GROUPS = [{
  key: '唐记食铺',
  name: '唐记食铺',
  canonicalId: 38,
  aliasIds: [],
  usage: 12,
}]

const SAMPLE = `## S01 | 内景 · 唐记食铺 | 清晨

唐奕专心雕琢着手中的琴头，指尖沿着木纹细细打磨，末了凑到眼前端详，露出满意的笑容。

## S02 | 内景 · 唐记食铺 | 清晨

一个留着山羊胡子的老头走进店来，劈头就嚷。

孙郎中：（中气十足）大郎，莫要不务正业，快些做饭，老夫饿了！

唐奕抬头，白了老头一眼。

唐奕：（没好气）蹭吃蹭喝还这般理直气壮的，除了您，全邓州恐怕找不出第二个了。

孙郎中眼睛一立。

孙郎中：胡说！怎是蹭食？老夫前些天还给你提了几斤牛肉来，全当饭资！`

test('planner splits by dialogue speaker and keeps every line inside one shot', () => {
  const result = planStoryboardShots({
    script: SAMPLE,
    shotStart: 1,
    sceneGroups: SCENE_GROUPS,
    maxDuration: 15,
  })
  assert.ok(result.shots.length >= 4)
  assert.ok(result.shots.every(shot => shot.sceneId === 38))
  assert.ok(result.shots.every(shot => shot.duration >= 6 && shot.duration <= 15))
  for (const shot of result.shots) {
    const speakers = [...new Set(shot.speechSegments.map(item => item.speaker).filter(Boolean))]
    assert.ok(speakers.length <= 1, `第 ${shot.storyboardNumber} 镜出现多个说话人：${speakers.join('、')}`)
  }
  const lines = result.shots.flatMap(shot => shot.speechSegments.map(item => item.text))
  assert.ok(lines.includes('大郎，莫要不务正业，快些做饭，老夫饿了！'))
  assert.ok(lines.includes('蹭吃蹭喝还这般理直气壮的，除了您，全邓州恐怕找不出第二个了。'))
  assert.ok(lines.includes('胡说！怎是蹭食？老夫前些天还给你提了几斤牛肉来，全当饭资！'))
})

test('planner carries the same-scene constants from the scene contract', () => {
  const contracts = new Map([[38, {
    sceneId: 38,
    sceneName: '唐记食铺',
    screenLeft: '柜台（唐奕）',
    screenRight: '店门（客人）',
    axisSide: '中轴线A',
    landmarkSide: '灶台在后景',
    sourceShotNumber: 5,
  }]])
  const result = planStoryboardShots({
    script: SAMPLE,
    shotStart: 10,
    sceneGroups: SCENE_GROUPS,
    sceneContracts: contracts,
    maxDuration: 15,
  })
  for (const shot of result.shots) {
    assert.equal(shot.screenLeft, '柜台（唐奕）')
    assert.equal(shot.screenRight, '店门（客人）')
    assert.equal(shot.axisSide, '中轴线A')
    assert.equal(shot.landmarkSide, '灶台在后景')
  }
})

test('planner splits over-capacity dialogue on punctuation into adjacent shots', () => {
  const longLine = '甲说完了第一句话，接着又说第二句话，然后停顿片刻再说第三句话，最后才把第四句话说完。'
  const script = `## S01 | 内景 · 茶棚 | 日\n\n掌柜开口。\n\n掌柜：${longLine}`
  const result = planStoryboardShots({
    script,
    shotStart: 1,
    maxDuration: 6,
  })
  assert.ok(result.shots.length >= 2)
  assert.ok(result.shots.every(shot => shot.speechSegments.length <= 1))
  const merged = result.shots.map(shot => shot.sourceExcerpt).join('')
  for (const part of ['第一句话', '第二句话', '第三句话', '第四句话']) {
    assert.ok(merged.includes(part), `拆分后丢失「${part}」`)
  }
})

test('planner continues the previous scene when the chunk has no scene header', () => {
  const script = '孙郎中：那就再来一笼。\n\n唐奕点头，转身去端蒸笼。'
  const result = planStoryboardShots({
    script,
    shotStart: 20,
    previousShot: {
      shotNumber: 19,
      sceneId: 38,
      location: '唐记食铺',
      time: '清晨',
      screenLeft: '柜台（唐奕）',
      screenRight: '店门（客人）',
      axisSide: '中轴线A',
      landmarkSide: '灶台在后景',
    },
    maxDuration: 15,
  })
  assert.equal(result.shots[0].sceneId, 38)
  assert.equal(result.shots[0].screenLeft, '柜台（唐奕）')
  assert.equal(result.shots[0].speechSegments[0].text, '那就再来一笼。')
})

test('planner keeps the continuation preamble before a new scene header', () => {
  const script = '孙郎中：那就再来一笼。\n\n## S02 | 内景 · 唐记食铺 | 午间\n\n唐奕端着一锅生煎走出来。\n\n唐奕：来了。'
  const result = planStoryboardShots({
    script,
    shotStart: 1,
    sceneGroups: SCENE_GROUPS,
    previousShot: {
      shotNumber: 9,
      sceneId: 38,
      location: '唐记食铺',
      time: '清晨',
      screenLeft: '柜台（唐奕）',
      screenRight: '店门（客人）',
      axisSide: '中轴线A',
      landmarkSide: '灶台在后景',
    },
    maxDuration: 15,
  })
  const merged = result.shots.map(shot => shot.sourceExcerpt).join('')
  assert.ok(merged.includes('那就再来一笼'))
  assert.ok(merged.includes('唐奕端着一锅生煎走出来'))
  assert.equal(result.shots[0].sceneId, 38)
  assert.ok(result.shots.some(shot => shot.time === '午间'))
})

test('planner moves a speech cue into the shot that carries the line', () => {
  const script = `## S01 | 外景 · 邓州西市街道 | 清晨

贾婆子站在店前，扯着嗓子揽客。街上人来人往，进店的却寥寥无几。一个花袄老妇走来，贾婆子眼睛一亮，急忙高声唱喝。

贾婆子：（热情地）呦！六婶起得可是够早，来来，咱这有刚出锅的大白炊饼，还不捡一笼家去？`
  const result = planStoryboardShots({ script, shotStart: 1, maxDuration: 12 })
  const gate = validatePlanSequence(result.shots, { minDuration: 6, maxDuration: 12 })
  assert.equal(gate.issues.some(issue => issue.code === 'speech_split_across_shots'), false)
  const lineShot = result.shots.find(shot => shot.speaker === '贾婆子')
  assert.ok(lineShot)
  assert.match(lineShot!.sourceExcerpt, /高声唱喝/)
})

test('planner splits an outdoor shot when an action enters the shop', () => {
  const script = `## S01 | 外景 · 邓州西市街道 | 清晨

贾婆子朝着六婶的背身暗啐一口。

骂完自觉无趣，反身回了店里，望着门前的长队，愈发心酸。`
  const result = planStoryboardShots({ script, shotStart: 1, maxDuration: 15 })
  const gate = validatePlanSequence(result.shots, { minDuration: 6, maxDuration: 15 })
  assert.equal(gate.issues.some(issue => issue.code === 'location_change_inside_shot'), false)
  assert.ok(result.shots.some(shot => shot.location === '室内（待绑定）'))
})

test('document title is never treated as a shot', () => {
  const script = `# 唐记食铺

## S01 | 外景 · 邓州西市街 | 清晨

卯时未过，朝阳初升，街面已人声鼎沸。

贾婆子站在自家店前揽客。`
  const result = planStoryboardShots({ script, shotStart: 1, maxDuration: 15 })
  assert.ok(result.shots.length > 0)
  assert.ok(result.shots.every(shot => !/^#{1,4}\s+/.test(shot.sourceExcerpt.trim())))
  assert.match(result.shots[0].sourceExcerpt, /卯时未过/)
  assert.ok(result.shots.every(shot => shot.shotType))
})

test('establishing scene and character action stay in separate shots', () => {
  const script = `## S01 | 外景 · 邓州西市街 | 清晨

卯时未过，街面人声鼎沸，商铺林立。

贾婆子站在自家店前扯着嗓子揽客。`
  const result = planStoryboardShots({
    script,
    shotStart: 1,
    characters: [{ name: '贾婆子' }],
    maxDuration: 15,
  })
  const establishing = result.shots.find(shot => shot.shotType === 'establishing')
  const action = result.shots.find(shot => shot.subject === '贾婆子')
  assert.ok(establishing)
  assert.ok(action)
  assert.notEqual(establishing!.storyboardNumber, action!.storyboardNumber)
})

test('vocal action becomes an inferred speech requirement and title block exposes it', () => {
  const script = `## S01 | 外景 · 邓州西市街 | 清晨

贾婆子刚起了一锅白面炊饼，站在自家店前扯着嗓子揽客。`
  const result = planStoryboardShots({
    script,
    shotStart: 1,
    characters: [{ name: '贾婆子' }],
    maxDuration: 15,
  })
  const shot = result.shots.find(item => item.speechRequirement)
  assert.ok(shot)
  assert.equal(shot!.speechRequirement!.speaker, '贾婆子')
  assert.equal(shot!.speechRequirement!.basis, '揽客')
  assert.ok(shot!.actionArc.initial)
  assert.ok(shot!.actionArc.result)
  assert.notEqual(shot!.actionArc.initial, shot!.actionArc.result)
  const block = buildPlannedShotsBlock(result.shots)
  assert.match(block, /发声要求/)
  assert.match(block, /inferred_dialogue/)
})

test('v3 shots always carry distinct visible action endpoints', () => {
  const script = `## S01 | 内景 · 唐记食铺 | 清晨

贾婆子站在柜台后。她抬头看向店门，抬手招呼客人。`
  const result = planStoryboardShots({ script, shotStart: 1, characters: [{ name: '贾婆子' }], maxDuration: 15 })
  for (const shot of result.shots) {
    assert.ok(shot.shotType)
    if (shot.shotType !== 'establishing' && shot.shotType !== 'insert') {
      assert.ok(shot.actionStart)
      assert.ok(shot.actionEnd)
      assert.notEqual(shot.actionStart, shot.actionEnd)
    }
  }
})

test('planned shot block locks count, excerpts and durations for the model', () => {
  const result = planStoryboardShots({ script: SAMPLE, shotStart: 1, sceneGroups: SCENE_GROUPS, maxDuration: 15 })
  const block = buildPlannedShotsBlock(result.shots)
  assert.match(block, /必须逐条落地/)
  assert.match(block, new RegExp(`固定 ${result.shots.length} 个骨架`))
  assert.match(block, new RegExp(`第 ${result.shots[0].storyboardNumber} 镜`))
  assert.match(block, /锁定摘录/)
})
