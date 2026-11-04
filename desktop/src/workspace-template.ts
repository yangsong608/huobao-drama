/**
 * 存量 workspace 提示词迁移。
 *
 * 内置模板随版本升级会强制覆盖，但 `.template-version` 相同的老用户目录不会更新；
 * 旧模板里的「音频：人声清晰靠前……旁白/心声为画外音」会诱导视频模型生成旁白/独白。
 * 这里只替换这句已知旧文案，保留用户其余编辑，且重复执行无副作用。
 */
import fs from 'node:fs'
import path from 'node:path'

const LEGACY_ZH = '音频：人声清晰靠前，环境音压低，无背景音乐；旁白/心声为画外音，不张口。'
const LEGACY_EN = 'Audio: dialogue/narration clear and forward, ambience low, no background music; narration/inner voice is off-screen, mouth not moving.'
const FALLBACK_ZH = '不要写「音频：」要求行或音色/混音指令（声音由生成参数控制）。'
const FALLBACK_EN = 'Do not write an "Audio:" requirement line or voice/tone/mix instructions (sound is controlled by generation parameters).'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const RULES: Array<[RegExp, string]> = [
  [new RegExp(`第二行单独写声音要求「${escapeRegExp(LEGACY_ZH)}」；`, 'g'), '不要写「音频：」要求行或音色/混音指令（声音由生成参数控制）；'],
  [
    new RegExp(`第二行单独写声音要求「${escapeRegExp(LEGACY_ZH)}」`, 'g'),
    '不要写「音频：」要求行或音色/混音指令（声音由生成参数控制）；本镜确有旁白时，旁白只在对应时间段内按「旁白（画外音）：…」书写',
  ],
  [
    new RegExp(`2行目は音声指示「${escapeRegExp(LEGACY_ZH)}」を単独行で置く。`, 'g'),
    '音声指示行「音频：…」や音色／ミックス指示は書かない（音声は生成パラメータで制御する）。',
  ],
  [
    new RegExp(`둘째 줄은 음성 지시 "${escapeRegExp(LEGACY_ZH)}"를 단독 줄로 둡니다\\.`, 'g'),
    '"音频：…" 음성 지시 줄이나 음색/믹스 지시는 쓰지 않습니다(음성은 생성 파라미터로 제어합니다).',
  ],
  [
    new RegExp(`信息头之后单独一行写声音要求：\`${escapeRegExp(LEGACY_ZH)}\``, 'g'),
    '不要写「音频：」要求行或音色/混音指令（声音由生成参数控制）；本镜确有旁白时，旁白只在对应时间段内按「旁白（画外音，普通话，语速平缓）：…」书写',
  ],
  [
    new RegExp(`the second line is a standalone audio direction: "${escapeRegExp(LEGACY_EN)}"; `, 'g'),
    'do not write an "Audio:" requirement line or voice/tone/mix instructions (sound is controlled by generation parameters); ',
  ],
  [
    new RegExp(`Immediately after the header, add a standalone audio direction line: \`${escapeRegExp(LEGACY_EN)}\``, 'g'),
    'Do not write an "Audio:" requirement line or voice/tone/mix instructions (sound is controlled by generation parameters); when this shot genuinely has narration, write it only inside the corresponding time segment as "Narration (off-screen, Mandarin, calm pace): ..."',
  ],
]

export function rewriteLegacyAudioText(content: string): string {
  if (!content.includes(LEGACY_ZH) && !content.includes(LEGACY_EN)) return content
  let next = content
  for (const [pattern, replacement] of RULES) next = next.replace(pattern, replacement)
  return next.replaceAll(LEGACY_ZH, FALLBACK_ZH).replaceAll(LEGACY_EN, FALLBACK_EN)
}

function walk(directory: string, changed: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      walk(file, changed)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const before = fs.readFileSync(file, 'utf8')
    const after = rewriteLegacyAudioText(before)
    if (after === before) continue
    fs.writeFileSync(file, after)
    changed.push(file)
  }
}

export function migrateLegacyAudioInstructions(workspaceDir: string): string[] {
  const changed: string[] = []
  walk(path.join(workspaceDir, 'prompts'), changed)
  walk(path.join(workspaceDir, 'skills'), changed)
  return changed
}
