import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-unit-contract-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const { rebalancePromptTimeline, alignBlockingToFrames, alignScreenSidesToFrames, fitPromptTimeline, stripPlaceholderDialogue, validateStoryboardUnit } = await import('../src/services/storyboard-unit-contract.ts')
const { buildAssetAliasMap, applyAssetAliases } = await import('../src/services/asset-aliases.ts')
const { buildSceneBindingBlock, canonicalSceneKey, getCanonicalSceneGroups, resolveCanonicalSceneId } = await import('../src/services/scene-canonical.ts')
const { createSceneSidePlan, normalizeSceneSides } = await import('../src/services/storyboard-scene-sides.ts')

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'
const FIXED_PROMPT = [
  '出场人物：@唐大郎（唐奕）｜场景：@唐记食铺大堂',
  '画面调度：画面左：唐大郎（唐奕）；画面右：范仲淹；过范仲淹右肩；背景地标：窗在左后、门在右后；轴线A；动作起点：起身；动作终点：抬眼看向范仲淹',
  '0-4秒：唐大郎（唐奕）起身。',
  '4-10秒：唐大郎（唐奕）抬眼看向范仲淹。',
  '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
].join('\n')

test('背景地标接受左/右、上方/中央和“无”，不接受没有位置的地标', () => {
  const upper = FIXED_PROMPT.replace('背景地标：窗在左后、门在右后', '背景地标：唐记招牌位于画面上方')
  assert.equal(validateStoryboardUnit({
    description: '唐大郎起身，抬眼看向范仲淹。',
    videoPrompt: upper,
    duration: 10,
  }).some(item => item.includes('背景地标缺少屏幕位置')), false)
  const missingPosition = FIXED_PROMPT.replace('背景地标：窗在左后、门在右后', '背景地标：唐记招牌')
  assert.ok(validateStoryboardUnit({
    description: '唐大郎起身，抬眼看向范仲淹。',
    videoPrompt: missingPosition,
    duration: 10,
  }).some(item => item.includes('背景地标缺少屏幕位置')))
})

test('单机位/固定四区校验：合法通过，多子镜和缺调度被拒绝', () => {
  assert.deepEqual(validateStoryboardUnit({
    description: '唐大郎起身，抬眼看向范仲淹。',
    videoPrompt: FIXED_PROMPT,
    duration: 10,
  }), [])

  const multi = validateStoryboardUnit({
    description: '【镜头1】唐大郎起身。【镜头2】范仲淹抬眼。',
    videoPrompt: FIXED_PROMPT,
    duration: 10,
  })
  assert.ok(multi.some(item => item.includes('子镜头')))

  const missing = validateStoryboardUnit({
    description: '唐大郎起身。',
    videoPrompt: '出场人物：@唐大郎（唐奕）｜场景：@唐记食铺大堂\n0-10秒：唐大郎起身。',
    duration: 10,
  })
  assert.ok(missing.some(item => item.includes('画面调度')))
  assert.ok(missing.some(item => item.includes('负面约束')))
})

test('新拆分禁止任何【镜头N】编号；旧数据编辑默认不拦截', () => {
  const marked = '【镜头1】唐大郎起身，抬眼看向范仲淹。'
  const strict = validateStoryboardUnit({
    description: marked,
    videoPrompt: FIXED_PROMPT,
    duration: 10,
    forbidShotMarkers: true,
  })
  assert.ok(strict.some(item => item.includes('【镜头N】')))
  assert.deepEqual(validateStoryboardUnit({
    description: marked,
    videoPrompt: FIXED_PROMPT,
    duration: 10,
  }), [])
  assert.deepEqual(validateStoryboardUnit({
    description: '唐大郎起身，抬眼看向范仲淹。',
    videoPrompt: FIXED_PROMPT,
    duration: 10,
    forbidShotMarkers: true,
  }), [])
})

test('一个分镜只允许一个简单运镜', () => {
  const twoMoves = FIXED_PROMPT
    .replace('0-4秒：唐大郎（唐奕）起身。', '0-4秒：镜头轻推，唐大郎（唐奕）起身。')
    .replace('4-10秒：唐大郎（唐奕）抬眼看向范仲淹。', '4-10秒：镜头继续推近，唐大郎（唐奕）抬眼看向范仲淹。')
  const errors = validateStoryboardUnit({
    description: '唐大郎起身，抬眼看向范仲淹。',
    videoPrompt: twoMoves,
    duration: 10,
    movement: '固定，尾段轻推',
  })
  assert.ok(errors.some(item => item.includes('运镜') && item.includes('多个动作')))
  assert.ok(errors.some(item => item.includes('2 次运镜')))

  const fixedWithMove = FIXED_PROMPT.replace(
    '0-4秒：唐大郎（唐奕）起身。',
    '0-4秒：镜头缓慢推进，唐大郎（唐奕）起身。',
  )
  assert.ok(validateStoryboardUnit({
    description: '唐大郎起身，抬眼看向范仲淹。',
    videoPrompt: fixedWithMove,
    duration: 10,
    movement: '固定',
  }).some(item => item.includes('固定镜头不得写')))

  const oneMove = FIXED_PROMPT.replace(
    '0-4秒：唐大郎（唐奕）起身。',
    '0-4秒：镜头轻推，唐大郎（唐奕）起身。',
  )
  assert.equal(validateStoryboardUnit({
    description: '唐大郎起身，抬眼看向范仲淹。',
    videoPrompt: oneMove,
    duration: 10,
    movement: '轻推',
  }).some(item => item.includes('运镜')), false)
})


test('多人对白时间帧会按台词字数自动重排', () => {
  const prompt = [
    '出场人物：@陆小满、@沈砚｜场景：@大学社团招新广场',
    '画面调度：画面左：沈砚；画面右：陆小满；无过肩；背景地标：树在左后；轴线A；动作起点：陆小满开口；动作终点：沈砚抬头',
    '0-3秒：陆小满说：「陆小满，新闻学。」',
    '3-5秒：陆小满说：「刚才在采访。」',
    '5-7秒：陆小满说：「校园社团招新期间的安全隐患。」',
    '7-12秒：陆小满说：「比如这根线，谁踩谁倒霉。」',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕',
  ].join('\n')
  const rebalanced = rebalancePromptTimeline(prompt, 12)
  assert.match(rebalanced, /12秒/)
  const errors = validateStoryboardUnit({
    description: '陆小满连续说完四句短对白，沈砚听着。',
    videoPrompt: rebalanced,
    duration: 12,
    characterIds: [1, 2],
  })
  assert.equal(errors.some(item => item.includes('最多容纳')), false)
})

test('台词小帧过多时合并相邻帧，不留下超容量的1秒帧', () => {
  const prompt = [
    '出场人物：@周屿、@陆小满｜场景：@星火社摊位',
    '画面调度：画面左：陆小满；画面右：周屿；无过肩；背景地标：横幅在画面后景；轴线A；动作起点：周屿递提纲；动作终点：陆小满接住',
    '0-2秒：周屿低头看完提纲，抬眼看向陆小满。',
    '2-4秒：周屿开口。@周屿说：「问题写得不错。」',
    '4-5秒：周屿继续开口。@周屿说：「你先把」',
    '5-6秒：周屿继续开口。@周屿说：「"谁来采访"」',
    '6-7秒：周屿收尾。@周屿说：「和"采访完谁审稿"写清楚。」',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕',
  ].join('\n')
  const rebalanced = rebalancePromptTimeline(prompt, 7)
  assert.match(rebalanced, /7秒/)
  const errors = validateStoryboardUnit({
    description: '周屿递回提纲，要求写清采访人与审稿人。',
    videoPrompt: rebalanced,
    duration: 7,
    characterIds: [1, 2],
  })
  assert.equal(errors.some(item => item.includes('最多容纳')), false)
})

test('末帧没有台词时不吞掉全部剩余时长', () => {
  const prompt = [
    '出场人物：@陆小满、@沈砚｜场景：@大学社团招新广场',
    '画面调度：画面左：沈砚；画面右：陆小满；无过肩；背景地标：树在左后；轴线A；动作起点：陆小满开口；动作终点：沈砚抬头',
    '0-2秒：陆小满说：「你来了。」',
    '2-4秒：沈砚说：「来了。」',
    '4-12秒：两人站着对视，谁也没有再说话。',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕',
  ].join('\n')
  const fitted = fitPromptTimeline(prompt, 12)
  assert.ok(fitted.duration < 12)
  assert.match(fitted.prompt, new RegExp(`${fitted.duration}秒`))
})

test('未入画的调度元素会被裁掉，左右只保留本镜角色', () => {
  const prompt = [
    '出场人物：@沈砚、@陆小满｜场景：@大学社团招新广场',
    '画面调度：画面左：周屿把橙色救援绳搭上肩；画面右：沈砚举手机扫二维码立牌；无过肩；背景地标：红底白字横幅在画面后景；轴线A；动作起点：沈砚抬手；动作终点：沈砚放下',
    '0-3秒：@沈砚抬起手，手机举在胸前，嘴唇闭合。',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕',
  ].join('\n')
  const aligned = alignBlockingToFrames(prompt)
  assert.match(aligned, /画面左：无/)
  assert.match(aligned, /画面右：沈砚/)
  assert.match(aligned, /背景地标：无/)
  assert.doesNotMatch(aligned, /周屿/)
  assert.equal(validateStoryboardUnit({
    description: '沈砚抬起手。',
    videoPrompt: aligned,
    duration: 6,
    characterIds: [1],
  }).some(item => item.includes('没有对应内容')), false)
})

test('画面左右写反时按轴线和时间帧自动交换', () => {
  const prompt = [
    '出场人物：@沈砚、@罗晴｜场景：@星火社摊位',
    '画面调度：画面左：罗晴抬头夹着文件夹站着；画面右：沈砚双手捏着报名表站在折叠长桌前；无过肩；背景地标：横幅在画面后景；轴线A：沈砚在左、罗晴在右；动作起点：罗晴抬头；动作终点：罗晴说完',
    '0-2秒：画面左侧沈砚抬眼看向画面右侧，嘴唇开合。',
    '2-4秒：画面右侧罗晴抬起头，视线落在画面左侧。',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕',
  ].join('\n')
  const aligned = alignScreenSidesToFrames(prompt)
  assert.match(aligned, /画面左：沈砚/)
  assert.match(aligned, /画面右：罗晴/)
})

test('画面调度元素必须在本镜时间帧出现', () => {
  const bad = FIXED_PROMPT
    .replace('画面左：唐大郎（唐奕）', '画面左：周屿把橙色救援绳搭上肩')
    .replace('画面右：范仲淹', '画面右：陆小满举相机')
  const badErrors = validateStoryboardUnit({
    description: '唐大郎起身，抬眼看向范仲淹。',
    videoPrompt: bad,
    duration: 10,
    movement: '固定',
  })
  assert.equal(badErrors.some(item => item.includes('没有对应内容')), true)

  const goodErrors = validateStoryboardUnit({
    description: '唐大郎起身，抬眼看向范仲淹。',
    videoPrompt: FIXED_PROMPT,
    duration: 10,
    movement: '固定',
  })
  assert.equal(goodErrors.some(item => item.includes('没有对应内容')), false)
})

test('单帧长台词按标点拆帧，运镜不重复', () => {
  const prompt = [
    '出场人物：@罗晴、@郑策｜场景：@大学社团招新广场',
    '画面调度：画面左：罗晴；画面右：郑策；无过肩；背景地标：树在左后；轴线A；动作起点：罗晴抬手；动作终点：罗晴拍桌',
    '0-9秒：镜头轻推，罗晴：「一半场地经费，你要成果、要宣传、还不能出安全问题。这不叫活动要求，这叫许愿。」郑策嘴唇闭合。',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕',
  ].join('\n')
  const rebalanced = rebalancePromptTimeline(prompt, 9)
  assert.equal((rebalanced.match(/秒[：:]/g) || []).length, 2)
  assert.equal((rebalanced.match(/镜头轻推/g) || []).length, 1)
  const errors = validateStoryboardUnit({
    description: '罗晴一字一顿地数落经费与要求，郑策嘴唇闭合。',
    videoPrompt: rebalanced,
    duration: 9,
    movement: '轻推',
    characterIds: [1],
  })
  assert.equal(errors.some(item => item.includes('最多容纳')), false)
  assert.equal(errors.some(item => item.includes('运镜')), false)
})

test('canonical 场景归组：同名大堂 54/55/56 只保留一个 canonical，剧本场次可绑定', async () => {
  db.insert(schema.dramas).values({ id: 1, title: '场景测试', createdAt: ts, updatedAt: ts }).run()
  db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts }).run()
  const [hall54, hall55, hall56, street38, street42] = [
    db.insert(schema.scenes).values({ dramaId: 1, location: '唐记食铺大堂', time: '上午', imageUrl: 'static/a.png', prompt: '', createdAt: ts, updatedAt: ts }).returning().get(),
    db.insert(schema.scenes).values({ dramaId: 1, location: '唐记食铺大堂', time: '午时', imageUrl: 'static/b.png', prompt: '', createdAt: ts, updatedAt: ts }).returning().get(),
    db.insert(schema.scenes).values({ dramaId: 1, location: '唐记食铺大堂', time: '清晨', imageUrl: 'static/c.png', prompt: '', createdAt: ts, updatedAt: ts }).returning().get(),
    db.insert(schema.scenes).values({ dramaId: 1, location: '邓州西市街道', time: '清晨', imageUrl: 'static/d.png', prompt: '', createdAt: ts, updatedAt: ts }).returning().get(),
    db.insert(schema.scenes).values({ dramaId: 1, location: '西市街道', time: '白天', imageUrl: 'static/e.png', prompt: '', createdAt: ts, updatedAt: ts }).returning().get(),
  ].map(row => row)
  // 用 55 作为使用最多的场景，验证 canonical 不按最小 ID 选
  for (let i = 0; i < 3; i += 1) {
    db.insert(schema.storyboards).values({
      episodeId: 1, storyboardNumber: i + 1, sceneId: hall55.id, duration: 5,
      createdAt: ts, updatedAt: ts,
    }).run()
  }
  db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 4, sceneId: hall54.id, duration: 5, createdAt: ts, updatedAt: ts }).run()
  db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 5, sceneId: street38.id, duration: 5, createdAt: ts, updatedAt: ts }).run()
  db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 6, sceneId: street42.id, duration: 5, createdAt: ts, updatedAt: ts }).run()

  const groups = await getCanonicalSceneGroups(1)
  const hall = groups.find(group => group.key === '唐记食铺大堂')!
  assert.equal(hall.canonicalId, hall55.id)
  assert.deepEqual(hall.aliasIds.sort(), [hall54.id, hall56.id].sort())
  const street = groups.find(group => group.key === '西市街')!
  assert.equal(street.canonicalId, street38.id)
  assert.ok(street.aliasIds.includes(street42.id))
  assert.equal(canonicalSceneKey('邓州西市街'), '西市街')

  assert.equal(await resolveCanonicalSceneId(1, hall56.id), hall55.id)
  assert.equal(await resolveCanonicalSceneId(1, street42.id), street38.id)
  const block = buildSceneBindingBlock('## S01 | 外景 · 邓州西市街 | 清晨\n## S02 | 内景 · 唐记食铺大堂 | 午时', groups)
  assert.match(block, /S01（邓州西市街）→ scene_id=\d+/)
  assert.match(block, /唐记食铺大堂：canonical scene_id=\d+/)
})

test('资产别名：@唐大郎 归一为 @唐大郎（唐奕），不误伤其他文本', async () => {
  db.insert(schema.characters).values({ dramaId: 1, name: '唐大郎（唐奕）', createdAt: ts, updatedAt: ts }).run()
  const map = await buildAssetAliasMap(1)
  assert.equal(applyAssetAliases('@唐大郎 走进来，@唐大郎（唐奕）坐下。', map), '@唐大郎（唐奕） 走进来，@唐大郎（唐奕）坐下。')
  assert.equal(applyAssetAliases('唐大郎（唐奕）不是别名文本', map), '唐大郎（唐奕）不是别名文本')
})

test('场景左右归一：同场人物翻边时自动交换画面左右', () => {
  const characters = [{ id: 25, name: '贾婆子' }, { id: 26, name: '六婶' }]
  const prompt = [
    '出场人物：@贾婆子、@六婶｜场景：@邓州西市街道',
    '画面调度：画面左：@六婶；画面右：@贾婆子；无过肩；背景地标：门在左后；轴线A；动作起点：六婶开口；动作终点：贾婆子回应',
    '0-4秒：@六婶开口。',
    '4-8秒：@贾婆子回应。',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
  ].join('\n')
  const plan = createSceneSidePlan()
  plan.left.add('贾婆子')
  plan.right.add('六婶')
  const result = normalizeSceneSides(prompt, plan, characters)
  assert.equal(result.swapped, true)
  assert.match(result.prompt, /画面左：@贾婆子/)
  assert.match(result.prompt, /画面右：@六婶/)
})

test('占位台词“无”不会保存，真实台词保留', () => {
  const text = '0-3秒：@六婶说：「嘿，端是一张巧嘴！」\n3-6秒：旁白（画外音）：「无。」\n6-8秒：@马老三说：无。'
  const cleaned = stripPlaceholderDialogue(text)
  assert.match(cleaned, /嘿，端是一张巧嘴/)
  assert.doesNotMatch(cleaned, /：「无。？」|说：无。/)
})

test('唯一场景前缀别名：@邓州西市街 → @邓州西市街道，多义前缀不替换', async () => {
  const map = await buildAssetAliasMap(1)
  assert.equal(applyAssetAliases('@邓州西市街一派繁华', map), '@邓州西市街道一派繁华')
})
