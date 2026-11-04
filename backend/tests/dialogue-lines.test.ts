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
