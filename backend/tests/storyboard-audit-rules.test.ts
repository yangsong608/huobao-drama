import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countPronounceableChars,
  requiredLineDurationMs,
  evaluateStoryboardRules,
  dedupeAuditIssues,
  limitAuditIssues,
  assignIssueIds,
  validateAuditIssueDraft,
  planAuditWindows,
  AUDIT_RULE_CODES_BY_CHECK,
  AUDIT_SEMANTIC_CODE_BY_CHECK,
  AUDIT_TRANSITION_KINDS,
  type AuditAssetCatalog,
  type AuditIssueDraft,
  type AuditLineInput,
  type AuditShotInput,
  type StoryboardRuleInput,
} from '../src/services/storyboard-audit-rules.ts'

const CAST = [{ id: 1, name: '甲' }, { id: 2, name: '乙' }, { id: 7, name: '丙' }]

function scenes(names: string[]) {
  return names.map((name, index) => ({ id: 10 + index, dramaId: 1, name, imageUrl: `uploads/scenes/${index}.png` }))
}

function baseAssets(overrides: Partial<AuditAssetCatalog> = {}): AuditAssetCatalog {
  return {
    characters: [
      { id: 1, dramaId: 1, name: '甲', imageUrl: 'uploads/characters/jia.png' },
      { id: 2, dramaId: 1, name: '乙', imageUrl: 'uploads/characters/yi.png' },
      { id: 7, dramaId: 1, name: '丙', imageUrl: 'uploads/characters/bing.png' },
    ],
    scenes: [
      { id: 10, dramaId: 1, name: '室', imageUrl: 'uploads/scenes/shi.png' },
      { id: 11, dramaId: 1, name: '街', imageUrl: 'uploads/scenes/jie.png' },
      { id: 12, dramaId: 1, name: '院', imageUrl: 'uploads/scenes/yuan.png' },
    ],
    props: [],
    episodeCharacterIds: [1, 2, 7],
    episodeSceneIds: [10, 11, 12],
    episodePropIds: [],
    fileExists: () => true,
    ...overrides,
  }
}

function promptFor(duration: number, body = '@甲站在原地，目光平静。', header = '出场人物：@甲｜场景：@室') {
  const parts: string[] = []
  let start = 0
  while (start < duration) {
    const end = Math.min(duration, start + 3)
    parts.push(`${start}-${end}秒：${body}`)
    start = end
  }
  return `${header}\n${parts.join('\n')}`
}

function shot(overrides: Partial<AuditShotInput> = {}): AuditShotInput {
  const id = overrides.id ?? 1
  const duration = overrides.duration ?? 4
  return {
    id,
    storyboardNumber: overrides.storyboardNumber ?? id,
    duration,
    description: '【镜头1】@甲站在原地，目光平静。',
    videoPrompt: promptFor(duration),
    shotType: '中景',
    angle: '平视',
    movement: '固定',
    continuity: '承接上一镜',
    transition: 'cut',
    sceneId: 10,
    location: '房间',
    referenceImages: null,
    characterIds: [1],
    propIds: [],
    ...overrides,
  }
}

function line(overrides: Partial<AuditLineInput> = {}): AuditLineInput {
  return {
    id: 1,
    storyboardId: 1,
    lineNo: 1,
    speakerType: 'dialogue',
    speakerName: '甲',
    characterId: 1,
    text: '你好',
    speakText: '你好',
    audioDurationMs: null,
    plannedStartMs: null,
    plannedEndMs: null,
    voiceDurationMs: null,
    ...overrides,
  }
}

function input(overrides: Partial<StoryboardRuleInput> = {}): StoryboardRuleInput {
  return {
    dramaId: 1,
    shots: [shot()],
    lines: [],
    cast: CAST,
    assets: baseAssets(),
    ...overrides,
  }
}

function codes(result: { code: string }[]) {
  return result.map((issue) => issue.code)
}

function issuesByCode(result: AuditIssueDraft[], code: string) {
  return result.filter((issue) => issue.code === code)
}

test('基础合法分镜不产生问题', () => {
  assert.deepEqual(evaluateStoryboardRules(input()), [])
})

test('可发音字符计数忽略空白、标点与符号，保留中英文和数字', () => {
  assert.equal(countPronounceableChars('你好，世界！'), 4)
  assert.equal(countPronounceableChars('你 好，世 界！'), 4)
  assert.equal(countPronounceableChars('Hello, 世界！ 123'), 10)
  assert.equal(countPronounceableChars('OK 再见！'), 4)
  assert.equal(countPronounceableChars('@甲说：「走吧」——'), 4)
})

test('每句需要时长按 4 字每秒加 1 秒呼吸计算，保留一位小数', () => {
  assert.equal(requiredLineDurationMs('一二三四五六七八九十'), 3500)
  assert.equal(requiredLineDurationMs('一二三四五六七八九十一二三四五六七八九十'), 6000)
  assert.equal(requiredLineDurationMs('一二三四五六七八九十一二三四五六七八九十一'), 6300)
})

test('描述与提示词缺失为错误，景别角度运镜缺失为警告', () => {
  const result = evaluateStoryboardRules(input({
    shots: [shot({
      description: '',
      videoPrompt: '',
      shotType: null,
      angle: null,
      movement: '',
    })],
  }))
  assert.ok(codes(result).includes('shot_missing_description'))
  assert.ok(codes(result).includes('shot_missing_video_prompt'))
  assert.ok(codes(result).includes('shot_missing_camera_fields'))
  assert.equal(issuesByCode(result, 'shot_missing_description')[0].severity, 'error')
  assert.equal(issuesByCode(result, 'shot_missing_video_prompt')[0].severity, 'error')
  assert.equal(issuesByCode(result, 'shot_missing_camera_fields')[0].severity, 'warning')
  assert.ok(!codes(result).includes('prompt_missing_header'))
  assert.ok(!codes(result).includes('prompt_timeline_broken'))
})

test('占位描述视为缺失；时长超过 3 秒缺【镜头N】给警告', () => {
  const placeholder = evaluateStoryboardRules(input({ shots: [shot({ description: '待补充' })] }))
  assert.ok(codes(placeholder).includes('shot_missing_description'))

  const missingSubshots = evaluateStoryboardRules(input({
    shots: [shot({ duration: 4, description: '@甲站在原地，目光平静。', videoPrompt: promptFor(4) })],
  }))
  assert.ok(codes(missingSubshots).includes('description_missing_subshots'))
  assert.equal(issuesByCode(missingSubshots, 'description_missing_subshots')[0].severity, 'warning')

  const shortShot = evaluateStoryboardRules(input({
    shots: [shot({ duration: 3, description: '@甲站在原地，目光平静。', videoPrompt: promptFor(3) })],
  }))
  assert.ok(!codes(shortShot).includes('description_missing_subshots'))
})

test('视频提示词信息头缺失、时间轴断裂、尾端不符各报一次', () => {
  const missingHeader = evaluateStoryboardRules(input({
    shots: [shot({ duration: 6, description: '【镜头1】@甲站着。', videoPrompt: '0-3秒：@甲站着。\n3-6秒：@甲抬头。' })],
  }))
  assert.ok(codes(missingHeader).includes('prompt_missing_header'))

  const broken = evaluateStoryboardRules(input({
    shots: [shot({ duration: 6, description: '【镜头1】@甲站着。', videoPrompt: promptFor(6).replace('3-6秒', '4-6秒') })],
  }))
  assert.equal(issuesByCode(broken, 'prompt_timeline_broken').length, 1)
  assert.match(issuesByCode(broken, 'prompt_timeline_broken')[0].message, /不连续|空档|重叠/)

  const wrongFirst = evaluateStoryboardRules(input({
    shots: [shot({ duration: 6, description: '【镜头1】@甲站着。', videoPrompt: '1-3秒：@甲站着。\n3-6秒：@甲抬头。' })],
  }))
  assert.ok(codes(wrongFirst).includes('prompt_timeline_broken'))

  const wrongTail = evaluateStoryboardRules(input({
    shots: [shot({ duration: 8, description: '【镜头1】@甲站着。', videoPrompt: '出场人物：@甲｜场景：@室\n0-3秒：@甲站着。\n3-6秒：@甲抬头。' })],
  }))
  assert.match(issuesByCode(wrongTail, 'prompt_timeline_broken')[0].message, /结束/)
})

test('每个 3 秒段台词或旁白超过 12 个可发音字符给警告', () => {
  const tooLong = evaluateStoryboardRules(input({
    shots: [shot({ duration: 3, description: '【镜头1】@甲站着。', videoPrompt: '出场人物：@甲｜场景：@室\n0-3秒：@甲说：「这是一句超过十二个字的台词」' })],
  }))
  const issues = issuesByCode(tooLong, 'prompt_segment_too_long')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].severity, 'warning')
  assert.match(issues[0].message, /12/)

  const actionLongText = evaluateStoryboardRules(input({
    shots: [shot({ duration: 3, description: '【镜头1】@甲站着。', videoPrompt: '出场人物：@甲｜场景：@室\n0-3秒：@甲慢慢转身，抬眼看向远处，表情里带着无法掩饰的复杂情绪。' })],
  }))
  assert.ok(!codes(actionLongText).includes('prompt_segment_too_long'))
})

test('台词或旁白里出现高置信度运镜、表情、心理、动作短语给警告', () => {
  const result = evaluateStoryboardRules(input({
    shots: [shot({
      duration: 3,
      description: '【镜头1】@甲站着。',
      videoPrompt: '出场人物：@甲｜场景：@室\n0-3秒：@甲说：「两人不由失望地相视」',
    })],
  }))
  const issues = issuesByCode(result, 'prompt_action_in_dialogue')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].severity, 'warning')
  assert.match(issues[0].evidence || '', /不由失望地相视/)
})

test('说话人未绑定给提示，不在本集角色列表给警告', () => {
  const result = evaluateStoryboardRules(input({
    lines: [
      line({ id: 1, storyboardId: 1, speakerName: '乙', characterId: 2 }),
      line({ id: 2, storyboardId: 1, speakerName: '陌生人', characterId: 99 }),
      line({ id: 3, storyboardId: 1, speakerType: 'narration', speakerName: '旁白', characterId: null }),
    ],
  }))
  const unbound = issuesByCode(result, 'speaker_unbound')
  const unknown = issuesByCode(result, 'speaker_unknown')
  assert.equal(unbound.length, 1)
  assert.equal(unbound[0].severity, 'info')
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].severity, 'warning')
  assert.equal(unknown[0].lineId, 2)
})

test('第二镜起 continuity 为空给警告，第一镜豁免', () => {
  const result = evaluateStoryboardRules(input({
    shots: [
      shot({ id: 1, storyboardNumber: 1, continuity: null }),
      shot({ id: 2, storyboardNumber: 2, continuity: '   ' }),
      shot({ id: 3, storyboardNumber: 3, continuity: '承接抬手动作' }),
    ],
  }))
  const issues = issuesByCode(result, 'continuity_missing')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].storyboardId, 2)
})

test('跨场景硬切且无连贯性时额外提示', () => {
  const result = evaluateStoryboardRules(input({
    shots: [
      shot({ id: 1, storyboardNumber: 1, sceneId: 10, location: '房间', continuity: '开场' }),
      shot({ id: 2, storyboardNumber: 2, sceneId: 11, location: '街道', continuity: null, transition: 'cut' }),
      shot({ id: 3, storyboardNumber: 3, sceneId: 12, location: '院子', continuity: null, transition: 'fade' }),
    ],
  }))
  const cross = issuesByCode(result, 'cross_scene_cut_without_continuity')
  assert.equal(cross.length, 1)
  assert.equal(cross[0].storyboardId, 2)
  assert.equal(issuesByCode(result, 'continuity_missing').length, 2)
})

test('有角色绑定的无对话镜头 8 秒警告、12 秒错误', () => {
  const cases: Array<[number, string | null]> = [
    [7.9, null],
    [8, 'warning'],
    [11.9, 'warning'],
    [12, 'error'],
  ]
  for (const [duration, severity] of cases) {
    const result = evaluateStoryboardRules(input({
      shots: [shot({ duration, videoPrompt: promptFor(duration) })],
    }))
    const issues = issuesByCode(result, 'silent_shot_long')
    if (severity) {
      assert.equal(issues.length, 1, `${duration} 秒应报问题`)
      assert.equal(issues[0].severity, severity, `${duration} 秒级别`)
    } else {
      assert.equal(issues.length, 0, `${duration} 秒不应报问题`)
    }
  }
})

test('无角色绑定的空镜 6 秒警告，5.9 秒不报', () => {
  for (const [duration, expected] of [[5.9, 0], [6, 1]] as const) {
    const result = evaluateStoryboardRules(input({
      shots: [shot({
        duration,
        characterIds: [],
        description: '【镜头1】空荡的房间，光线昏暗。',
        videoPrompt: promptFor(duration, '空荡的房间，光线昏暗。', '出场人物：无｜场景：@室'),
      })],
    }))
    assert.equal(issuesByCode(result, 'empty_shot_long').length, expected)
  }
})

test('有旁白或有台词但没有可验证时长的镜头不算空镜', () => {
  const narration = evaluateStoryboardRules(input({
    shots: [shot({
      duration: 13,
      characterIds: [],
      description: '【镜头1】夜色下的城墙。',
      videoPrompt: promptFor(13, '夜色下的城墙。', '出场人物：无｜场景：@室'),
    })],
    lines: [line({ id: 1, storyboardId: 1, speakerType: 'narration', speakerName: '旁白', characterId: null, text: '夜幕降临。', speakText: '夜幕降临' })],
  }))
  assert.ok(!codes(narration).includes('empty_shot_long'))
  assert.ok(!codes(narration).includes('silent_shot_long'))

  const dialogueNoDuration = evaluateStoryboardRules(input({
    shots: [shot({ duration: 13 })],
    lines: [line({ id: 1, storyboardId: 1, text: '你好', speakText: '你好' })],
  }))
  assert.ok(!codes(dialogueNoDuration).includes('silent_shot_long'))
})

test('单句有效时长不足：缺口不超过 1 秒警告，超过 1 秒错误', () => {
  const twenty = '一二三四五六七八九十一二三四五六七八九十'
  const warning = evaluateStoryboardRules(input({
    shots: [shot({ duration: 6, description: '【镜头1】@甲站着。', videoPrompt: promptFor(6) })],
    lines: [line({ id: 1, text: twenty, speakText: twenty, audioDurationMs: 5000 })],
  }))
  assert.equal(issuesByCode(warning, 'line_insufficient_duration')[0].severity, 'warning')

  const error = evaluateStoryboardRules(input({
    shots: [shot({ duration: 6, description: '【镜头1】@甲站着。', videoPrompt: promptFor(6) })],
    lines: [line({ id: 1, text: twenty, speakText: twenty, audioDurationMs: 4900 })],
  }))
  assert.equal(issuesByCode(error, 'line_insufficient_duration')[0].severity, 'error')
})

test('有效时长优先级为音频时长、计划时长、手动占位时长', () => {
  const twenty = '一二三四五六七八九十一二三四五六七八九十'
  const result = evaluateStoryboardRules(input({
    shots: [shot({ duration: 6, description: '【镜头1】@甲站着。', videoPrompt: promptFor(6) })],
    lines: [line({
      id: 1,
      text: twenty,
      speakText: twenty,
      audioDurationMs: 2000,
      plannedStartMs: 0,
      plannedEndMs: 6000,
      voiceDurationMs: 1000,
    })],
  }))
  const issue = issuesByCode(result, 'line_insufficient_duration')[0]
  assert.equal(issue.severity, 'error')
  assert.match(issue.message, /2\.0|2 秒/)
})

test('没有可验证时长的句子只计入整镜容量', () => {
  const twenty = '一二三四五六七八九十一二三四五六七八九十'
  const result = evaluateStoryboardRules(input({
    shots: [shot({ duration: 5, description: '【镜头1】@甲站着。', videoPrompt: promptFor(5) })],
    lines: [line({ id: 1, text: twenty, speakText: twenty })],
  }))
  assert.equal(issuesByCode(result, 'line_insufficient_duration').length, 0)
  const capacity = issuesByCode(result, 'shot_dialogue_over_capacity')
  assert.equal(capacity.length, 1)
  assert.equal(capacity[0].severity, 'error')
  assert.equal(capacity[0].repairable, true)
  assert.equal(capacity[0].repairAction, 'extend_duration')
})

test('整镜所有台词需要时长之和超过镜头时长报错', () => {
  const result = evaluateStoryboardRules(input({
    shots: [shot({ duration: 4, description: '【镜头1】@甲站着。', videoPrompt: promptFor(4) })],
    lines: [
      line({ id: 1, text: '一二三四五', speakText: '一二三四五' }),
      line({ id: 2, text: '六七八九十', speakText: '六七八九十' }),
    ],
  }))
  assert.equal(issuesByCode(result, 'shot_dialogue_over_capacity').length, 1)
})

test('单句超过 6 秒建议拆分，20 字不报、21 字报', () => {
  const twenty = '一二三四五六七八九十一二三四五六七八九十'
  const twentyOne = `${twenty}一`
  const atTwenty = evaluateStoryboardRules(input({
    shots: [shot({ duration: 8, description: '【镜头1】@甲站着。', videoPrompt: promptFor(8) })],
    lines: [line({ id: 1, text: twenty, speakText: twenty, audioDurationMs: 6000 })],
  }))
  assert.ok(!codes(atTwenty).includes('line_requires_split'))

  const over = evaluateStoryboardRules(input({
    shots: [shot({ duration: 8, description: '【镜头1】@甲站着。', videoPrompt: promptFor(8) })],
    lines: [line({ id: 1, text: twentyOne, speakText: twentyOne, audioDurationMs: 6000 })],
  }))
  assert.equal(issuesByCode(over, 'line_requires_split')[0].severity, 'warning')
})

test('单句有效时长超过需要时长 3 秒以上给警告', () => {
  const twenty = '一二三四五六七八九十一二三四五六七八九十'
  const result = evaluateStoryboardRules(input({
    shots: [shot({ duration: 9, description: '【镜头1】@甲站着。', videoPrompt: promptFor(9) })],
    lines: [line({ id: 1, text: twenty, speakText: twenty, audioDurationMs: 9000 })],
  }))
  assert.equal(issuesByCode(result, 'line_overlong_duration')[0].severity, 'warning')
})

test('speak_text 优先且标点空白不计入字符数', () => {
  const speakPriority = evaluateStoryboardRules(input({
    shots: [shot({ duration: 4, description: '【镜头1】@甲站着。', videoPrompt: promptFor(4) })],
    lines: [line({ id: 1, text: '你好', speakText: '你们好朋友们', audioDurationMs: 2000 })],
  }))
  const priority = issuesByCode(speakPriority, 'line_insufficient_duration')[0]
  assert.equal(priority.severity, 'warning')
  assert.match(priority.message, /6/)

  const punctuation = evaluateStoryboardRules(input({
    shots: [shot({ duration: 4, description: '【镜头1】@甲站着。', videoPrompt: promptFor(4) })],
    lines: [line({ id: 1, text: '你 好，世 界！', speakText: '你 好，世 界！', audioDurationMs: 1500 })],
  }))
  assert.equal(issuesByCode(punctuation, 'line_insufficient_duration')[0].severity, 'warning')
})

test('检查五：场景缺失、无效、未关联本集', () => {
  const missing = evaluateStoryboardRules(input({ shots: [shot({ sceneId: null })] }))
  assert.equal(issuesByCode(missing, 'scene_binding_missing')[0].severity, 'warning')

  const invalid = evaluateStoryboardRules(input({
    assets: baseAssets({
      scenes: [
        { id: 10, dramaId: 1, name: '室', imageUrl: 'uploads/scenes/shi.png', deletedAt: '2026-01-01' },
        { id: 13, dramaId: 2, name: '皇', imageUrl: 'uploads/scenes/huang.png' },
      ],
    }),
    shots: [shot({ sceneId: 10 })],
  }))
  assert.equal(issuesByCode(invalid, 'scene_binding_invalid')[0].severity, 'error')

  const crossProject = evaluateStoryboardRules(input({
    assets: baseAssets({
      scenes: [{ id: 13, dramaId: 2, name: '皇', imageUrl: 'uploads/scenes/huang.png' }],
    }),
    shots: [shot({ sceneId: 13 })],
  }))
  assert.equal(issuesByCode(crossProject, 'scene_binding_invalid')[0].severity, 'error')

  const notLinked = evaluateStoryboardRules(input({
    assets: baseAssets({ episodeSceneIds: [] }),
    shots: [shot({ sceneId: 10 })],
  }))
  assert.equal(issuesByCode(notLinked, 'scene_not_linked')[0].severity, 'info')
})

test('检查五：角色、道具绑定无效与未关联本集', () => {
  const result = evaluateStoryboardRules(input({
    assets: baseAssets({
      characters: [
        { id: 1, dramaId: 1, name: '甲', imageUrl: 'uploads/characters/jia.png' },
        { id: 2, dramaId: 1, name: '乙', imageUrl: 'uploads/characters/yi.png' },
        { id: 4, dramaId: 1, name: '丁', imageUrl: 'uploads/characters/ding.png', deletedAt: '2026-01-01' },
      ],
      props: [
        { id: 20, dramaId: 1, name: '剑', imageUrl: 'uploads/props/jian.png' },
        { id: 21, dramaId: 1, name: '刀', imageUrl: 'uploads/props/dao.png', deletedAt: '2026-01-01' },
      ],
      episodeCharacterIds: [1],
      episodePropIds: [],
    }),
    shots: [shot({ characterIds: [4, 2], propIds: [21], description: '【镜头1】@丁站着。', videoPrompt: promptFor(4) })],
  }))
  assert.equal(issuesByCode(result, 'character_binding_invalid')[0].severity, 'error')
  assert.equal(issuesByCode(result, 'character_not_linked')[0].severity, 'info')
  assert.equal(issuesByCode(result, 'prop_binding_invalid')[0].severity, 'error')
})

test('检查五：重复绑定给警告', () => {
  const result = evaluateStoryboardRules(input({
    shots: [shot({ characterIds: [1, 1], propIds: [] })],
  }))
  assert.equal(issuesByCode(result, 'binding_duplicate')[0].severity, 'warning')
})

test('检查五：@引用已绑定通过，未绑定与未知分别警告，场景道具引用不误报', () => {
  const result = evaluateStoryboardRules(input({
    assets: baseAssets({
      props: [{ id: 20, dramaId: 1, name: '剑', imageUrl: 'uploads/props/jian.png' }],
      episodePropIds: [20],
    }),
    shots: [shot({
      characterIds: [1],
      propIds: [20],
      description: '【镜头1】@甲在@室拿起@剑，@乙走来，@丙看向@不存在。',
      videoPrompt: promptFor(4),
    })],
  }))
  assert.equal(issuesByCode(result, 'reference_character_unbound').length, 1)
  assert.match(issuesByCode(result, 'reference_character_unbound')[0].evidence || '', /乙/)
  assert.match(issuesByCode(result, 'reference_character_unbound')[0].evidence || '', /丙/)
  assert.equal(issuesByCode(result, 'reference_character_unknown').length, 1)
  assert.match(issuesByCode(result, 'reference_character_unknown')[0].evidence || '', /不存在/)
})

test('检查五：已删除资产名称不再视为已知 @引用', () => {
  const result = evaluateStoryboardRules(input({
    assets: baseAssets({
      characters: [
        { id: 1, dramaId: 1, name: '甲', imageUrl: 'uploads/characters/jia.png' },
        { id: 4, dramaId: 1, name: '丁', imageUrl: 'uploads/characters/ding.png', deletedAt: '2026-01-01' },
      ],
      episodeCharacterIds: [1],
    }),
    shots: [shot({
      characterIds: [1],
      description: '【镜头1】@甲看向@丁。',
      videoPrompt: promptFor(4, '@甲看向@丁。'),
    })],
  }))
  const unknown = issuesByCode(result, 'reference_character_unknown')
  assert.equal(unknown.length, 1)
  assert.match(unknown[0].evidence || '', /丁/)
})

test('检查五：同名多角色提示人工确认', () => {
  const result = evaluateStoryboardRules(input({
    assets: baseAssets({
      characters: [
        { id: 1, dramaId: 1, name: '甲', imageUrl: 'uploads/characters/jia.png' },
        { id: 5, dramaId: 1, name: '双', imageUrl: 'uploads/characters/shuang1.png' },
        { id: 6, dramaId: 1, name: '双', imageUrl: 'uploads/characters/shuang2.png' },
      ],
      episodeCharacterIds: [1],
    }),
    shots: [shot({ characterIds: [], description: '【镜头1】@双站在门口。', videoPrompt: promptFor(4, '@双站在门口。', '出场人物：@双｜场景：@室') })],
  }))
  const issue = issuesByCode(result, 'reference_character_unbound')[0]
  assert.ok(issue)
  assert.match(issue.message, /同名|多个|确认/)
})

test('检查五：绑定资产缺图、引用图格式非法、相对路径文件缺失', () => {
  const result = evaluateStoryboardRules(input({
    assets: baseAssets({
      characters: [
        { id: 1, dramaId: 1, name: '甲', imageUrl: 'uploads/characters/missing.png' },
        { id: 2, dramaId: 1, name: '乙', imageUrl: '' },
      ],
      scenes: [{ id: 10, dramaId: 1, name: '室', imageUrl: '' }],
      props: [{ id: 20, dramaId: 1, name: '剑', imageUrl: '' }],
      episodeCharacterIds: [1, 2],
      episodePropIds: [20],
      fileExists: (path) => path !== 'uploads/characters/missing.png',
    }),
    shots: [shot({
      characterIds: [1, 2],
      propIds: [20],
      referenceImages: '{"bad":true}',
      description: '【镜头1】@甲和@乙站着。',
    })],
  }))
  assert.equal(issuesByCode(result, 'character_asset_missing')[0].severity, 'warning')
  assert.equal(issuesByCode(result, 'scene_asset_missing')[0].severity, 'warning')
  assert.equal(issuesByCode(result, 'prop_asset_missing')[0].severity, 'warning')
  assert.equal(issuesByCode(result, 'asset_reference_malformed')[0].severity, 'warning')
  assert.equal(issuesByCode(result, 'asset_file_missing')[0].severity, 'warning')
})

test('检查五：外链图片不探测文件，合法 reference_images 不报', () => {
  let probed = 0
  const result = evaluateStoryboardRules(input({
    assets: baseAssets({
      characters: [{ id: 1, dramaId: 1, name: '甲', imageUrl: 'https://example.com/jia.png' }],
      scenes: [{ id: 10, dramaId: 1, name: '室', imageUrl: 'https://example.com/shi.png' }],
      fileExists: () => {
        probed += 1
        return false
      },
    }),
    shots: [shot({ characterIds: [1], referenceImages: '["uploads/ref/1.png","uploads/ref/2.png"]' })],
  }))
  assert.equal(probed, 0)
  assert.ok(!codes(result).includes('asset_file_missing'))
  assert.ok(!codes(result).includes('asset_reference_malformed'))
})

test('问题码白名单覆盖检查五的 15 个问题码并拒绝未知码', () => {
  assert.equal(AUDIT_RULE_CODES_BY_CHECK[5].length, 15)
  assert.deepEqual(
    [...AUDIT_TRANSITION_KINDS].sort(),
    ['empty', 'scene', 'text'],
  )
  const unknown = validateAuditIssueDraft(baseIssue({ code: 'made_up_code' }))
  assert.ok(unknown.some((item) => item.includes('未登记')))

  const assetMismatch = validateAuditIssueDraft(baseIssue({ check: 1, code: 'semantic_asset_mismatch', source: 'semantic' }))
  assert.ok(assetMismatch.some((item) => item.includes('检查 5')))
  assert.equal(AUDIT_SEMANTIC_CODE_BY_CHECK.semantic_asset_mismatch, 5)
})

test('suggestedTransition 只允许检查 2 与三种类型；检查 5 不可修复', () => {
  const wrongCheck = validateAuditIssueDraft(baseIssue({ check: 1, suggestedTransition: 'empty' }))
  assert.ok(wrongCheck.some((item) => item.includes('suggestedTransition')))

  const wrongKind = validateAuditIssueDraft(baseIssue({ check: 2, suggestedTransition: 'fade' as never }))
  assert.ok(wrongKind.some((item) => item.includes('suggestedTransition')))

  const valid = validateAuditIssueDraft(baseIssue({ check: 2, code: 'continuity_missing', suggestedTransition: 'scene' }))
  assert.deepEqual(valid, [])

  const assetRepairable = validateAuditIssueDraft(baseIssue({ check: 5, code: 'scene_binding_missing', repairable: true }))
  assert.ok(assetRepairable.some((item) => item.includes('检查 5')))
})

function baseIssue(overrides: Partial<AuditIssueDraft> = {}): AuditIssueDraft {
  return {
    check: 1,
    source: 'rule',
    severity: 'warning',
    code: 'shot_missing_camera_fields',
    storyboardId: 1,
    storyboardNumber: 1,
    lineId: null,
    relatedStoryboardIds: [],
    message: '测试问题',
    evidence: '',
    suggestion: '',
    repairable: false,
    repairAction: null,
    suggestedTransition: null,
    status: 'open',
    windowIndex: null,
    ...overrides,
  }
}

test('规则与语义同位置合并，语义重复保留证据更完整的一条', () => {
  const rule = baseIssue({ check: 2, code: 'continuity_missing', evidence: '规则证据', severity: 'warning' })
  const semanticShort = baseIssue({
    check: 2, source: 'semantic', code: 'semantic_continuity_break',
    evidence: '短', severity: 'error', windowIndex: 1,
  })
  const semanticLong = baseIssue({
    check: 2, source: 'semantic', code: 'semantic_continuity_break',
    evidence: '更完整的语义证据，说明上一镜尾动作没有承接', severity: 'error', windowIndex: 2,
  })
  const merged = dedupeAuditIssues([rule, semanticShort, semanticLong])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].code, 'continuity_missing')
  assert.equal(merged[0].source, 'rule+semantic')
  assert.equal(merged[0].severity, 'error')
  assert.match(merged[0].evidence || '', /更完整的语义证据/)

  const onlySemantic = dedupeAuditIssues([semanticShort, semanticLong])
  assert.equal(onlySemantic.length, 1)
  assert.match(onlySemantic[0].evidence || '', /更完整的语义证据/)
})

test('问题数量上限：单窗口语义 30 条、单任务 400 条', () => {
  const semantic = Array.from({ length: 31 }, (_, index) => baseIssue({
    check: 1,
    source: 'semantic',
    code: 'semantic_shot_description',
    storyboardId: index + 1,
    storyboardNumber: index + 1,
    windowIndex: 1,
  }))
  const windowLimited = limitAuditIssues(semantic)
  assert.equal(windowLimited.issues.length, 30)
  assert.equal(windowLimited.truncated, true)

  const many = Array.from({ length: 401 }, (_, index) => baseIssue({
    storyboardId: index + 1,
    storyboardNumber: index + 1,
  }))
  const totalLimited = limitAuditIssues(many)
  assert.equal(totalLimited.issues.length, 400)
  assert.equal(totalLimited.truncated, true)
})

test('问题编号按顺序生成', () => {
  const issues = assignIssueIds([baseIssue(), baseIssue({ storyboardId: 2 })])
  assert.deepEqual(issues.map((issue) => issue.id), ['ISSUE-1', 'ISSUE-2'])
})

test('语义窗口：16 镜一窗、步进 15、重叠 1 镜、前后上下文只读', () => {
  const shots = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    storyboardNumber: index + 1,
  }))

  const sixteen = planAuditWindows(shots(16))
  assert.equal(sixteen.windows.length, 1)
  assert.equal(sixteen.windows[0].targets.length, 16)
  assert.equal(sixteen.windows[0].contextBefore, null)
  assert.equal(sixteen.windows[0].contextAfter, null)

  const seventeen = planAuditWindows(shots(17))
  assert.equal(seventeen.windows.length, 2)
  assert.equal(seventeen.windows[1].targets[0].storyboardNumber, 16)
  assert.equal(seventeen.windows[1].targets.length, 2)
  assert.equal(seventeen.windows[1].contextBefore?.storyboardNumber, 15)

  const forty = planAuditWindows(shots(40))
  assert.equal(forty.windows.length, 3)
  assert.deepEqual(forty.windows.map((window) => window.targets.length), [16, 16, 10])
  assert.equal(forty.windows[2].contextBefore?.storyboardNumber, 30)
})

test('语义窗口：301 镜 20 窗，302 镜多余分镜仅规则检验', () => {
  const shots = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    storyboardNumber: index + 1,
  }))
  const first = planAuditWindows(shots(301))
  assert.equal(first.windows.length, 20)
  assert.equal(first.ruleOnlyIds.length, 0)
  assert.equal(first.windows[19].targets[15].storyboardNumber, 301)

  const second = planAuditWindows(shots(302))
  assert.equal(second.windows.length, 20)
  assert.deepEqual(second.ruleOnlyIds, [302])
  assert.equal(second.truncated, true)
})

test('策略开关可以逐项关闭规则检验', () => {
  const broken = shot({ description: '', sceneId: null })
  const all = evaluateStoryboardRules(input({ shots: [broken] }))
  assert.ok(all.some((issue) => issue.check === 1))
  assert.ok(all.some((issue) => issue.check === 5))

  const shotOff = evaluateStoryboardRules(input({ shots: [broken], options: { checks: { shot: false } } }))
  assert.ok(!shotOff.some((issue) => issue.check === 1))
  assert.ok(shotOff.some((issue) => issue.check === 5))

  const allOff = evaluateStoryboardRules(input({
    shots: [broken],
    options: { checks: { shot: false, continuity: false, silent: false, lineDuration: false, assets: false } },
  }))
  assert.deepEqual(allOff, [])
})

test('策略阈值可以自定义空镜与单句时长口径', () => {
  const sevenSilent = evaluateStoryboardRules(input({
    shots: [shot({ duration: 7, videoPrompt: promptFor(7) })],
  }))
  assert.ok(!issuesByCode(sevenSilent, 'silent_shot_long').length)

  const customSilent = evaluateStoryboardRules(input({
    shots: [shot({ duration: 7, videoPrompt: promptFor(7) })],
    options: { thresholds: { silentCharacterWarnMs: 5000, silentCharacterErrorMs: 9000 } },
  }))
  assert.equal(issuesByCode(customSilent, 'silent_shot_long')[0]?.severity, 'warning')

  const longLine = line({ text: '一二三四五六七八九十一二三四五六七八九十一', speakText: null, audioDurationMs: null, plannedStartMs: null, plannedEndMs: null })
  const defaultMax = evaluateStoryboardRules(input({
    shots: [shot({ duration: 8, videoPrompt: promptFor(8, '', '出场人物：@甲｜场景：@室') })],
    lines: [longLine],
  }))
  assert.ok(issuesByCode(defaultMax, 'line_requires_split').length)

  const customMax = evaluateStoryboardRules(input({
    shots: [shot({ duration: 8, videoPrompt: promptFor(8, '', '出场人物：@甲｜场景：@室') })],
    lines: [longLine],
    options: { thresholds: { lineRequiredMaxSeconds: 10 } },
  }))
  assert.ok(!issuesByCode(customMax, 'line_requires_split').length)
})

test('策略窗口可以自定义窗口大小、步长与上限', () => {
  const shots = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    storyboardNumber: index + 1,
  }))
  const plan = planAuditWindows(shots(10), { size: 4, step: 3, maxWindows: 2 })
  assert.equal(plan.windows.length, 2)
  assert.deepEqual(plan.windows.map((window) => window.targets.map((target) => target.storyboardNumber)), [
    [1, 2, 3, 4],
    [4, 5, 6, 7],
  ])
  assert.deepEqual(plan.ruleOnlyIds, [8, 9, 10])
  assert.equal(plan.truncated, true)
})
