import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStoryboardPlanV2, validateStoryboardPlanV2 } from '../src/services/storyboard-v2.ts'

const SCENE_GROUPS = [{
  key: '唐记食铺',
  name: '唐记食铺',
  canonicalId: 38,
  aliasIds: [],
  usage: 12,
}]

const dialogueScript = `## S01 | 外景 · 星火社摊位 | 上午

曹斌：这人适合技术组。脸皮厚，能扛骂。

沈砚：还能修东西。

曹斌：会修什么？

沈砚：水龙头、自行车、宿舍床板、辅导员的打印机。

曹斌：为什么修打印机？

沈砚：因为打印成绩单的时候，它总在最关键的时候坏。

曹斌：（点头）人才。`

test('V2 按语义节拍生成 Master 与反打，不按固定句数切', () => {
  const plan = buildStoryboardPlanV2({ script: dialogueScript, shotStart: 1, maxDuration: 15, minDuration: 2 })
  assert.equal(plan.issues.length, 0)
  assert.equal(plan.shots.length, 2)
  assert.equal(plan.shots[0].coverage, 'master')
  assert.equal(plan.shots[0].lines.length, 5)
  assert.equal(plan.shots[1].coverage, 'reverse')
  assert.equal(plan.shots[1].lines.length, 2)
  assert.ok(plan.shots.every(shot => shot.duration <= 15))
})

test('V2 每个原文节拍只被一个镜头 claim', () => {
  const plan = buildStoryboardPlanV2({ script: dialogueScript, shotStart: 1, maxDuration: 15, minDuration: 2 })
  assert.equal(plan.diagnostics.unclaimedBeats.length, 0)
  const claimed = plan.shots.flatMap(shot => shot.beatIds)
  assert.equal(claimed.length, plan.beats.length)
  assert.equal(new Set(claimed).size, claimed.length)
  assert.ok(plan.shots.every(shot => Boolean(shot.cutReason)))
})

test('V2 场景变化必须新开镜并带理由', () => {
  const script = `## S01 | 外景 · 广场 | 上午

沈砚：你好。

## S02 | 外景 · 摊位 | 上午

罗晴：请进。`
  const plan = buildStoryboardPlanV2({ script, shotStart: 1, maxDuration: 15, minDuration: 2 })
  assert.equal(plan.issues.length, 0)
  assert.equal(plan.diagnostics.sceneCount, 2)
  assert.equal(plan.shots[1].cutReason, 'scene_change')
  assert.equal(plan.shots[1].coverage, 'master')
})

test('V2 镜头承接场景契约与景别机位', () => {
  const script = `## S01 | 内景 · 唐记食铺 | 清晨

唐奕：来了。`
  const plan = buildStoryboardPlanV2({
    script,
    shotStart: 1,
    sceneGroups: SCENE_GROUPS,
    sceneContracts: new Map([[38, {
      sceneId: 38,
      sceneName: '唐记食铺',
      screenLeft: '柜台（唐奕）',
      screenRight: '店门（客人）',
      axisSide: '中轴线A',
      landmarkSide: '灶台在后景',
      sourceShotNumber: 5,
    }]]),
    maxDuration: 15,
    minDuration: 2,
  })
  assert.equal(plan.issues.length, 0)
  assert.equal(plan.shots[0].screenLeft, '柜台（唐奕）')
  assert.equal(plan.shots[0].screenRight, '店门（客人）')
  assert.equal(plan.shots[0].axisSide, '中轴线A')
  assert.equal(plan.shots[0].landmarkSide, '灶台在后景')
  assert.equal(plan.shots[0].camera.shotSize, 'medium')
  assert.equal(plan.shots[0].camera.angle, 'eye_level')
})

test('V2 用真实配音档案估算台词时长，缺档案时才用默认值', () => {
  const script = `## S01 | 内景 · 唐记食铺 | 清晨

唐奕：这是一段用来验证真实配音语速会被计划采用的较长台词，不能再用全局固定语速去估算。`
  const normal = buildStoryboardPlanV2({ script, shotStart: 1, maxDuration: 15, minDuration: 2 })
  const fast = buildStoryboardPlanV2({ script, shotStart: 1, maxDuration: 15, minDuration: 2 }, {
    timingProfiles: {
      唐奕: {
        speaker: '唐奕',
        characterId: 1,
        voiceId: 1,
        charsPerSecond: 12,
        pauseSeconds: 0.1,
        sampleCount: 4,
        source: 'line_takes',
      },
    },
  })
  assert.equal(normal.diagnostics.timingProfileSources['唐奕'], 'default')
  assert.equal(fast.diagnostics.timingProfileSources['唐奕'], 'line_takes')
  assert.ok(fast.diagnostics.estimatedDialogueSeconds < normal.diagnostics.estimatedDialogueSeconds)
  assert.ok(fast.shots[0].duration <= normal.shots[0].duration)
})

test('V2 结构校验能发现被篡改的台词与跨场景节拍', () => {
  const script = `## S01 | 内景 · 唐记食铺 | 清晨

唐奕：来了。

## S02 | 外景 · 长街 | 清晨

沈砚：走。`
  const plan = buildStoryboardPlanV2({ script, shotStart: 1, sceneGroups: SCENE_GROUPS, maxDuration: 15, minDuration: 2 })
  plan.shots[0].lines[0].text = '被改掉的台词'
  plan.shots[0].beatIds.push(plan.shots[1].beatIds[0])
  const issues = validateStoryboardPlanV2(plan)
  assert.ok(issues.some(issue => issue.ruleId === 'SHT-02'))
  assert.ok(issues.some(issue => issue.ruleId === 'COV-03' || issue.ruleId === 'SHT-01'))
})

test('V2 结构校验拦截同场景无依据的屏幕左右翻转', () => {
  const script = `## S01 | 内景 · 唐记食铺 | 清晨

唐奕：来了。

沈砚：走。`
  const plan = buildStoryboardPlanV2({
    script,
    shotStart: 1,
    sceneGroups: SCENE_GROUPS,
    sceneContracts: new Map([[38, {
      sceneId: 38,
      sceneName: '唐记食铺',
      screenLeft: '柜台（唐奕）',
      screenRight: '店门（客人）',
      axisSide: '中轴线A',
      landmarkSide: '灶台在后景',
      sourceShotNumber: 5,
    }]]),
    maxDuration: 2,
    minDuration: 2,
  })
  assert.ok(plan.shots.length >= 2)
  plan.shots[1].screenLeft = '画面左：店门'
  const issues = validateStoryboardPlanV2(plan)
  assert.ok(issues.some(issue => issue.ruleId === 'COV-06'))
})


test('长台词按真实语速拆成多镜且每镜不超上限', () => {
  const long = '这是一段用来验证长台词会被真实语速拆开的内容，包含成本、损耗、回款和面子四个数，谁先算清谁先回家，所以这里继续补充更多文字，确保总时长超过十五秒而必须拆成多个镜头。'
  const plan = buildStoryboardPlanV2({
    script: `## S01 | 内景 · 唐记食铺 | 清晨\n\n唐奕：${long}`,
    shotStart: 1,
    maxDuration: 15,
    minDuration: 2,
    characters: [{ name: '唐奕' }],
  }, {
    timingProfiles: {
      唐奕: {
        speaker: '唐奕',
        characterId: 1,
        voiceId: 1,
        charsPerSecond: 4,
        pauseSeconds: 0,
        sampleCount: 3,
        source: 'line_takes',
      },
    },
  })
  assert.equal(plan.issues.length, 0)
  assert.ok(plan.shots.length >= 2)
  assert.ok(plan.shots.every(shot => shot.duration <= 15))
  const merged = plan.beats.filter(beat => beat.kind === 'dialogue').map(beat => beat.dialogueText).join('')
  assert.equal(merged, long)
})

test('静态描写与首句台词合并为 Master，不生成 2 秒空镜', () => {
  const plan = buildStoryboardPlanV2({
    script: `## S01 | 内景 · 唐记食铺 | 清晨\n\n唐奕坐在柜台后整理木料。\n\n唐奕：今天的木料已经整理好了。`,
    shotStart: 1,
    maxDuration: 15,
    minDuration: 2,
    characters: [{ name: '唐奕' }],
  })
  assert.equal(plan.shots.length, 1)
  assert.equal(plan.shots[0].coverage, 'master')
  assert.equal(plan.shots[0].lines.length, 1)
  assert.ok(plan.shots[0].actions.length >= 1)
  assert.ok(plan.shots[0].duration > 2)
})


test('旁白形态按语音档案计时，不把长叙述当 2 秒动作', () => {
  const prose = '卯时未过，朝阳初升，街面已经人声鼎沸，各色商铺临街而立，贩夫走卒往来穿梭。'
  const plan = buildStoryboardPlanV2({
    script: `## S01 | 外景 · 邓州西市街 | 清晨\n\n${prose}`,
    shotStart: 1,
    maxDuration: 15,
    minDuration: 2,
    narrationForm: 'narration',
  }, {
    timingProfiles: {
      旁白: {
        speaker: '旁白',
        characterId: null,
        voiceId: null,
        charsPerSecond: 4,
        pauseSeconds: 0,
        sampleCount: 3,
        source: 'line_takes',
      },
    },
  })
  assert.equal(plan.issues.length, 0)
  assert.equal(plan.shots[0].actions[0].narration, true)
  assert.equal(plan.shots[0].durationSource, 'narration_audio_estimate')
  assert.ok(plan.shots[0].duration > 2)
})
