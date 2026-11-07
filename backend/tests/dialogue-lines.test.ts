import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanLineText,
  findQuotedSpans,
  parseVideoPrompt,
  splitSegments,
  summarizeLines,
  toSpeakText,
} from '../src/services/dialogue-lines.js'

const CAST = [
  { id: 11, name: '唐大郎' },
  { id: 12, name: '马老三' },
]

describe('时间码切段', () => {
  it('按 0-3秒：切段并保留镜头内相对时间', () => {
    const segs = splitSegments('0-3秒：第一段\n3-6秒：第二段\n6-9秒：第三段')
    assert.equal(segs.length, 3)
    assert.deepEqual([segs[1].startMs, segs[1].endMs], [3000, 6000])
    assert.equal(segs[2].text, '第三段')
  })

  it('无时间码时按字数估算时长', () => {
    const segs = splitSegments('他说：「走吧。」', 0)
    assert.equal(segs.length, 1)
    assert.ok(segs[0].endMs >= 3000)
  })
})

describe('引号与说话人', () => {
  it('@角色 + 引号台词归属正确', () => {
    const prompt = '0-6秒：@唐大郎 低头刻着，忽然低声自语，忍不住笑出声：「总有一天做得出来。」'
    const lines = parseVideoPrompt(prompt, { cast: CAST })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerType, 'dialogue')
    assert.equal(lines[0].speakerName, '唐大郎')
    assert.equal(lines[0].characterId, 11)
    assert.equal(lines[0].text, '总有一天做得出来。')
    assert.equal(lines[0].needsReview, false)
  })

  it('嵌套引号只取最外层', () => {
    const spans = findQuotedSpans('他说：「老马喊了一句『走。』就跑了。」')
    assert.equal(spans.length, 1)
    assert.match(spans[0].inner, /老马喊了一句『走。』/)
  })

  it('无法判定说话人时标 needs_review，不瞎猜', () => {
    const prompt = '0-4秒：镜头扫过人群，有人喊了一句：「快跑！」'
    const lines = parseVideoPrompt(prompt, { cast: CAST })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerName, '未知')
    assert.equal(lines[0].needsReview, true)
  })
})

describe('裸旁白（第 5 集真实写法）', () => {
  it('无引号的「旁白：」必须抽到', () => {
    const prompt = '0-5秒：木屑簌簌落下，旁白：至于这吉他，纯粹是把我憋得没法儿的产物。'
    const lines = parseVideoPrompt(prompt, { cast: CAST })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerType, 'narration')
    assert.equal(lines[0].speakerName, '旁白')
    assert.equal(lines[0].text, '至于这吉他，纯粹是把我憋得没法儿的产物。')
  })

  it('裸旁白按句号拆句，且不吞掉后面的 @角色 画面', () => {
    const prompt = '0-8秒：旁白（画外音）：他走了。再没回来。@马老三 站在门口发愣。'
    const lines = parseVideoPrompt(prompt, { cast: CAST })
    assert.equal(lines.length, 2)
    assert.deepEqual(lines.map((l) => l.text), ['他走了。', '再没回来。'])
    assert.ok(lines.every((l) => l.speakerType === 'narration'))
  })

  it('「心声」归为 inner', () => {
    const prompt = '0-4秒：@唐大郎 愣在原地，心声：这下完了。'
    const lines = parseVideoPrompt(prompt, { cast: CAST })
    assert.equal(lines[0].speakerType, 'inner')
  })

  it('裸旁白超过 80 字标 needs_review', () => {
    const long = '旁白：' + '这是一段很长的旁白。'.repeat(12)
    const lines = parseVideoPrompt(`0-20秒：${long}`, { cast: CAST })
    assert.ok(lines.length >= 1)
    assert.ok(lines.every((l) => l.needsReview === true))
  })
})

describe('冒号对白（第 1 集新写法，无引号 @角色 动作：台词）', () => {
  const NEW_CAST = [
    { id: 21, name: '贾婆子' },
    { id: 22, name: '六婶' },
    { id: 23, name: '马老三' },
    { id: 24, name: '唐大郎（唐奕）' },
    { id: 25, name: '马婶' },
  ]

  it('单角色 @A 动作：台词 归 A', () => {
    const prompt = '3-7秒：@六婶 催灶：我说马老三，唐家大郎怎么就雇了你这么个温吞老汉，快些出锅，家里还等着吃食呢！'
    const lines = parseVideoPrompt(prompt, { cast: NEW_CAST })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerType, 'dialogue')
    assert.equal(lines[0].speakerName, '六婶')
    assert.equal(lines[0].characterId, 22)
    assert.equal(lines[0].text, '我说马老三，唐家大郎怎么就雇了你这么个温吞老汉，快些出锅，家里还等着吃食呢！')
    assert.equal(lines[0].needsReview, false)
  })

  it('多句冒号台词整句保留，不按句拆碎', () => {
    const prompt = '7-11秒：@马老三 眼睛一立，压着锅盖没动：嘿。就你急？着急你咋不去照顾别家生意？'
    const lines = parseVideoPrompt(prompt, { cast: NEW_CAST })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerName, '马老三')
    assert.equal(lines[0].text, '嘿。就你急？着急你咋不去照顾别家生意？')
  })

  it('双角色时归给动作落到冒号的 @B', () => {
    const prompt = '7-10秒：跟镜接住 @六婶 起步，@贾婆子 朝背影暗啐一口：老叼婆！只凭一张厉嘴！'
    const lines = parseVideoPrompt(prompt, { cast: NEW_CAST })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerName, '贾婆子')
  })

  it('宾语前置（冲…的 @B）不算说话人', () => {
    const prompt = '3-7秒：@贾婆子 把炊饼往上一托，冲路过的 @六婶 堆笑：呦！六婶起得可是够早，来来，咱这有刚出锅的大白炊饼，还不捡一笼家去？'
    const lines = parseVideoPrompt(prompt, { cast: NEW_CAST })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerName, '贾婆子')
    assert.equal(lines[0].characterId, 21)
  })

  it('冒号紧贴 @B 时 B 是听众，说话人是前面的 @A', () => {
    const prompt = '5-9秒：@唐大郎（唐奕） 笑盈盈看着 @六婶：跑了不怕，只要婶子和众位街坊还来关照小店，就饿不死小子！'
    const lines = parseVideoPrompt(prompt, { cast: NEW_CAST })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerName, '唐大郎（唐奕）')
    assert.equal(lines[0].characterId, 24)
  })

  it('同一段两个冒号拆两条台词', () => {
    const prompt = '0-6秒：反打 @六婶 白少年一眼：嘿，端是一张巧嘴！转头吃味：兀那老汉真是福气，摊上唐大郎这位运财童子。老身要是遇上这样的主家，也要甘当佣户了。'
    const lines = parseVideoPrompt(prompt, { cast: NEW_CAST })
    assert.equal(lines.length, 2)
    assert.deepEqual(lines.map((l) => l.text), ['嘿，端是一张巧嘴！', '兀那老汉真是福气，摊上唐大郎这位运财童子。老身要是遇上这样的主家，也要甘当佣户了。'])
    assert.ok(lines.every((l) => l.speakerName === '六婶'))
  })

  it('非角色冒号（队里一人：/另一人接：）标 needs_review，不吞后面 @角色', () => {
    const prompt = '10-15秒：众人大笑，队里一人：这哪是个十四岁的娃子，简直就是个小人精！另一人接：唐冠宇那浪荡鬼若是知道，也能含笑九泉了。@唐大郎（唐奕） 攥着小刀折回店中'
    const lines = parseVideoPrompt(prompt, { cast: NEW_CAST })
    assert.equal(lines.length, 2)
    assert.deepEqual(lines.map((l) => l.speakerName), ['队里一人', '另一人'])
    assert.deepEqual(lines.map((l) => l.text), ['这哪是个十四岁的娃子，简直就是个小人精！', '唐冠宇那浪荡鬼若是知道，也能含笑九泉了。'])
    assert.ok(lines.every((l) => l.needsReview && l.characterId === null))
  })

  it('群杂标签若已是注册角色则绑定 characterId', () => {
    const prompt = '10-15秒：众人大笑，队里一人：这哪是个十四岁的娃子，简直就是个小人精！'
    const lines = parseVideoPrompt(prompt, { cast: [...NEW_CAST, { id: 32, name: '队里一人' }] })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerName, '队里一人')
    assert.equal(lines[0].characterId, 32)
    assert.equal(lines[0].needsReview, false)
  })

  it('群杂拟声引号（「哎哟」）不生成台词', () => {
    const prompt = '11-15秒：@马老三 顺势一掀锅盖，白汽腾地扑起，一锅生煎包金黄油亮、底壳煎得焦脆，滋啦作响；队里一阵「哎哟」往前挤了半步'
    const lines = parseVideoPrompt(prompt, { cast: NEW_CAST })
    assert.equal(lines.length, 0)
  })

  it('表头键（人物：/场景：）不被当作对白', () => {
    const prompt = '人物：@六婶、@马老三；场景：@唐记食铺门前\n@六婶 嗤之以鼻：人家那是邓州名吃，也是你这炊饼能比的？'
    const lines = parseVideoPrompt(prompt, { cast: NEW_CAST })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerName, '六婶')
    assert.equal(lines[0].text, '人家那是邓州名吃，也是你这炊饼能比的？')
  })
})

describe('旁白过滤导演备注（第 1 集真实踩坑）', () => {
  const NEW_CAST = [{ id: 21, name: '贾婆子' }]

  it('「画面切黑」等导演备注不生成旁白行', () => {
    const prompt = '15-18秒：镜头顺着他的目光摇到街对面，@贾婆子 掀了掀自家炊饼笼，笼里冷冷清清；她朝这边的长队望了半晌，扁着嘴暗啐一口，反身回了店里。旁白（画外音，压低）：……这西市里，眼红唐记的，可不止她一个。画面切黑'
    const lines = parseVideoPrompt(prompt, { cast: NEW_CAST })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerType, 'narration')
    assert.equal(lines[0].text, '…这西市里，眼红唐记的，可不止她一个。')
  })

  it('「画面只留…不出现…」整句过滤，正文多句保留', () => {
    const prompt = '8-13秒：他坐在床沿没动。旁白（画外音，普通话，语速平缓，人物不张口）：我本姓唐名奕，千年之后一位普通研究生，与北宋的唐大郎同名。一声惊天巨响，把唐家的私营小厂炸上了天，连我也崩得骨头渣子都没剩——一睁眼，竟到了北宋。画面只留他打量自身的动作，不出现现代场景、不出现爆炸'
    const lines = parseVideoPrompt(prompt, { cast: NEW_CAST })
    assert.equal(lines.length, 2)
    assert.ok(lines.every((l) => l.speakerType === 'narration'))
    assert.ok(lines.every((l) => !l.text.startsWith('画面')))
    assert.equal(lines[0].text, '我本姓唐名奕，千年之后一位普通研究生，与北宋的唐大郎同名。')
  })

  it('自说自话冒号归角色本人', () => {
    const prompt = '10-15秒：他停刀把木条举到眼前比量，忽然自己先乐了。@唐大郎（唐奕）自说自话：这物件，宋人当它是半截怪扁担。可要搁我那头儿……嘿，认得的多了去了。一个十四岁的北宋小少爷，刻这玩意儿？说出去谁信。'
    const lines = parseVideoPrompt(prompt, { cast: [{ id: 24, name: '唐大郎（唐奕）' }] })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].speakerType, 'dialogue')
    assert.equal(lines[0].speakerName, '唐大郎（唐奕）')
    assert.equal(lines[0].characterId, 24)
    assert.ok(lines[0].text.startsWith('这物件'))
  })
})

describe('清洗与朗读文本', () => {
  it('去舞台提示/镜头标记/@，破折号转逗号', () => {
    assert.equal(cleanLineText('（低声）@唐大郎 说：「【镜头2】走——吧」'), '唐大郎 说：走，吧')
  })

  it('年份逐位读，数量按中文读法', () => {
    assert.equal(toSpeakText('2026年，他3次回到这里。'), '二零二六年，他三次回到这里。')
  })

  it('汇总统计能反映未知说话人比例', () => {
    const prompt = [
      '0-4秒：@唐大郎 说：「走。」',
      '4-8秒：有人喊：「快跑！」',
    ].join('\n')
    const summary = summarizeLines(parseVideoPrompt(prompt, { cast: CAST }))
    assert.equal(summary.total, 2)
    assert.equal(summary.unknown, 1)
    assert.equal(summary.unknownRatio, 0.5)
  })
})
