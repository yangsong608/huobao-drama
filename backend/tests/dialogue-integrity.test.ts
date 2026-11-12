import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractSpokenQuotes,
  inspectDialogueIntegrity,
  formatDialogueIntegrityIssue,
} from '../src/services/dialogue-integrity.ts'

const HEADER = '出场人物：@贾婆子、@六婶｜场景：@邓州西市街道'
const LONG_LINE = '呦！六婶起得可是够早，来来，咱这有刚出锅的大白炊饼，还不捡一笼家去？'
const DESCRIPTION = `【镜头1】一个花袄老妇摇着丝帕款款行来。@贾婆子说：「${LONG_LINE}」（中景）`

test('提取 description 中的角色台词与旁白，排除招牌、字幕等非口白引号', () => {
  const quotes = extractSpokenQuotes([
    '【镜头1】@甲说：「第一句。」',
    '【镜头2】旁白（画外音）：「旁白一句！」',
    '【镜头3】@乙问：「第二句？」',
    '门楣上挂着「唐记」的招牌，墙上写着「今日歇业」。',
  ].join('\n')).map((quote) => quote.text)
  assert.deepEqual(quotes, ['第一句。', '旁白一句！', '第二句？'])
})

test('3 秒分段拆分台词时，只要逐字保留文字与标点就算完整', () => {
  const prompt = [
    HEADER,
    '0-3秒：@贾婆子 眼睛一亮。@贾婆子说：「呦！六婶起得可是够早，」',
    '3-6秒：@贾婆子 扯嗓子唱喝。@贾婆子说：「来来，咱这有刚出锅的大白炊饼，」',
    '6-9秒：@贾婆子 手朝炊饼笼一引。@贾婆子说：「还不捡一笼家去？」',
  ].join('\n')
  const report = inspectDialogueIntegrity(DESCRIPTION, prompt)
  assert.ok(report)
  assert.equal(report.ok, true)
  assert.equal(report.missing, '')
})

test('整句不拆分也完整', () => {
  const prompt = `${HEADER}\n0-6秒：@贾婆子 堆起笑脸。@贾婆子说：「${LONG_LINE}」`
  const report = inspectDialogueIntegrity(DESCRIPTION, prompt)
  assert.ok(report)
  assert.equal(report.ok, true)
})

test('删掉原句中的词（来来，）会被判为丢失', () => {
  const prompt = [
    HEADER,
    '0-3秒：@贾婆子说：「呦！六婶起得可是够早」',
    '3-6秒：@贾婆子说：「咱这有刚出锅的大白炊饼」',
    '6-9秒：@贾婆子说：「还不捡一笼家去？」',
  ].join('\n')
  const report = inspectDialogueIntegrity(DESCRIPTION, prompt)
  assert.ok(report)
  assert.equal(report.ok, false)
  assert.match(report.missing, /来来/)
  assert.match(formatDialogueIntegrityIssue(report, '第 2 镜'), /第 2 镜/)
  assert.match(formatDialogueIntegrityIssue(report, '第 2 镜'), /来来/)
})

test('丢失句末或句中标点会被判为丢失', () => {
  const noTail = `${HEADER}\n0-3秒：@六婶说：「炊饼有何吃头儿？」\n3-6秒：@六婶说：「家里头的要吃唐记」`
  const report = inspectDialogueIntegrity(
    '【镜头1】@六婶说：「炊饼有何吃头儿？家里头的要吃唐记，要不老身才不起这大早！」',
    noTail,
  )
  assert.ok(report)
  assert.equal(report.ok, false)
  assert.match(report.missing, /^[，要]/)

  const noComma = `${HEADER}\n0-3秒：@六婶说：「炊饼有何吃头儿？家里头的要吃唐记要不老身才不起这大早！」`
  const commaReport = inspectDialogueIntegrity(
    '【镜头1】@六婶说：「炊饼有何吃头儿？家里头的要吃唐记，要不老身才不起这大早！」',
    noComma,
  )
  assert.ok(commaReport)
  assert.equal(commaReport.ok, false)
  assert.equal(commaReport.missing.charAt(0), '，')
})

test('引号内的舞台提示不参与逐字比对', () => {
  const report = inspectDialogueIntegrity(
    '【镜头1】@甲说：「你好。（转身看向门外）」',
    `${HEADER}\n0-3秒：@甲说：「你好。」`,
  )
  assert.ok(report)
  assert.equal(report.ok, true)
})

test('description 没有口白引号时不拦截，招牌引号也不会被当成台词', () => {
  assert.equal(
    inspectDialogueIntegrity('【镜头1】@甲站在门前，招牌上写着「唐记」。', `${HEADER}\n0-3秒：@甲站立。`),
    null,
  )
})

test('旁白同样按原文比对，英语和日韩提示词也能识别说话动词', () => {
  const narration = inspectDialogueIntegrity(
    '【镜头1】旁白（画外音）：「三年前，邓州还没有这条街。」',
    `${HEADER}\n0-3秒：旁白（画外音）：「三年前，邓州还没有这条街」`,
  )
  assert.ok(narration)
  assert.equal(narration.ok, false)
  assert.equal(narration.missing, '。')

  const english = inspectDialogueIntegrity(
    '【Shot 1】@Alex says: "I will be back, and I will not forgive you!"',
    'Characters: @Alex | Scene: @Street\n0-3秒：@Alex says: "I will be back, and I will not forgive you"',
  )
  assert.ok(english)
  assert.equal(english.ok, false)
  assert.equal(english.missing, '!')

  const japanese = inspectDialogueIntegrity(
    '【ショット1】@太郎は言う：「もう戻らない。」',
    '登場人物：@太郎／シーン：@街\n0-3秒：@太郎は言う：「もう戻らない」',
  )
  assert.ok(japanese)
  assert.equal(japanese.ok, false)
  assert.equal(japanese.missing, '。')

  const korean = inspectDialogueIntegrity(
    '【샷1】@민수는 말한다: "다시 오지 않아."',
    '등장인물: @민수 | 장면: @거리\n0-3초: @민수는 말한다: "다시 오지 않아"',
  )
  assert.ok(korean)
  assert.equal(korean.ok, false)
  assert.equal(korean.missing, '.')
})
