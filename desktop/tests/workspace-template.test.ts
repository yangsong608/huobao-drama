import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateLegacyAudioInstructions, rewriteLegacyAudioText } from '../src/workspace-template.ts'

const LEGACY_ZH = '音频：人声清晰靠前，环境音压低，无背景音乐；旁白/心声为画外音，不张口。'
const LEGACY_EN = 'Audio: dialogue/narration clear and forward, ambience low, no background music; narration/inner voice is off-screen, mouth not moving.'

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-workspace-'))
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return root
}

test('legacy audio instructions are rewritten in existing prompts and skills', () => {
  const root = workspace({
    'prompts/prompt_generator.md': `2. 据此生成 video_prompt：第一行信息头列出出场人物与场景；第二行单独写声音要求「${LEGACY_ZH}」；之后按 3 秒为一段。`,
    'prompts/prompt_generator.ja.md': `2. これに基づき video_prompt を生成する：1行目は情報ヘッダー。2行目は音声指示「${LEGACY_ZH}」を単独行で置く。その後、3秒を1区間とする。`,
    'prompts/prompt_generator.ko.md': `2. 이를 바탕으로 video_prompt 를 생성합니다: 첫 줄은 정보 헤더. 둘째 줄은 음성 지시 "${LEGACY_ZH}"를 단독 줄로 둡니다. 그다음 3초를 한 구간으로 합니다.`,
    'prompts/prompt_generator.en.md': `2. Generate the video_prompt accordingly: the second line is a standalone audio direction: "${LEGACY_EN}"; then split into 3-second segments.`,
    'prompts/storyboard_breaker.md': `- 第一行信息头列出出场人物与场景；第二行单独写声音要求「${LEGACY_ZH}」\n`,
    'skills/prompt-generator/video-prompt/SKILL.md': `- 信息头之后单独一行写声音要求：\`${LEGACY_ZH}\`\n`,
    'skills/prompt-generator/video-prompt/SKILL.en.md': `- Immediately after the header, add a standalone audio direction line: \`${LEGACY_EN}\`\n`,
  })
  try {
    const changed = migrateLegacyAudioInstructions(root)
    assert.equal(changed.length, 7)

    const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
    for (const file of changed) assert.ok(!fs.readFileSync(file, 'utf8').includes(LEGACY_ZH))
    assert.ok(!read('prompts/prompt_generator.en.md').includes(LEGACY_EN))

    assert.match(read('prompts/prompt_generator.md'), /不要写「音频：」要求行或音色\/混音指令/)
    assert.match(read('prompts/prompt_generator.md'), /；之后按 3 秒为一段/)
    assert.match(read('prompts/prompt_generator.ja.md'), /音声指示行「音频：…」や音色／ミックス指示は書かない/)
    assert.match(read('prompts/prompt_generator.ko.md'), /"音频：…" 음성 지시 줄이나 음색\/믹스 지시는 쓰지 않습니다/)
    assert.match(read('prompts/prompt_generator.en.md'), /do not write an "Audio:" requirement line/)
    assert.match(read('prompts/prompt_generator.en.md'), /then split into 3-second segments/)
    assert.match(read('prompts/storyboard_breaker.md'), /本镜确有旁白时/)
    assert.match(read('skills/prompt-generator/video-prompt/SKILL.md'), /旁白（画外音，普通话，语速平缓）/)
    assert.match(read('skills/prompt-generator/video-prompt/SKILL.en.md'), /Narration \(off-screen, Mandarin, calm pace\)/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('migration is idempotent and leaves clean or user-edited files alone', () => {
  const root = workspace({
    'prompts/prompt_generator.md': `2. 已更新：不要写「音频：」要求行或音色/混音指令（声音由生成参数控制）；之后按 3 秒为一段。`,
    'prompts/custom.md': '用户自己的分镜习惯：先写画面，再写对白。',
  })
  try {
    assert.deepEqual(migrateLegacyAudioInstructions(root), [])
    assert.equal(fs.readFileSync(path.join(root, 'prompts/prompt_generator.md'), 'utf8').includes('音频：」要求行'), true)
    assert.match(fs.readFileSync(path.join(root, 'prompts/custom.md'), 'utf8'), /用户自己的分镜习惯/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('unknown legacy contexts fall back to a neutral replacement', () => {
  const text = `画外音要求：「${LEGACY_ZH}」请照做。`
  const rewritten = rewriteLegacyAudioText(text)
  assert.ok(!rewritten.includes(LEGACY_ZH))
  assert.match(rewritten, /声音由生成参数控制/)
})
