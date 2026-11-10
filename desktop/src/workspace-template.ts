/**
 * 存量 workspace 提示词迁移。
 *
 * 内置模板随版本升级会强制覆盖，但 `.template-version` 相同的老用户目录不会更新；
 * 旧模板里的「音频：人声清晰靠前……旁白/心声为画外音」会诱导视频模型生成旁白/独白。
 * 这里只替换这句已知旧文案，保留用户其余编辑，且重复执行无副作用。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface LegacyBuiltinFileRule {
  path: string
  sha256: string[]
}

/**
 * 只替换「与上一版内置文件逐字节一致」的技能：
 * - 4.0.26 给 storyboard-breaker 增加了「剧本全覆盖」硬规则，但 skills 目录只增不覆盖；
 * - 按旧版哈希精确匹配，用户改过的文件不匹配、保持原样。
 */
export const LEGACY_BUILTIN_FILES: LegacyBuiltinFileRule[] = [
  {
    path: 'skills/storyboard-breaker/SKILL.md',
    sha256: [
      'a4bd229ccc436e9f649399ff0f3cfef32bc51f9942461308b9e5655c1a851935',
      '67cf31026b95b20df6c28f29becb78cc15abb0f4c42fbf9d4d6b2ff83f85d4a2',
    ],
  },
  {
    path: 'skills/storyboard-breaker/SKILL.en.md',
    sha256: [
      'ff11dac4c7b06baaf527a3ecc392452d177bef321b3ba63e5a6a4f7bccb338c8',
      'ca4db206d576bc4b7479b2d91546e14de771cf907a13678556f8924404773596',
    ],
  },
  {
    path: 'skills/storyboard-breaker/SKILL.ja.md',
    sha256: [
      '4902a0e9d450445125b503186fb172cac4e1902749016c9b32fc358856ffb7c2',
      '60ca6f56cbb369fe5e9ce78e2c7a4c987495543f91ee086ccdaf52c582d0fd5d',
    ],
  },
  {
    path: 'skills/storyboard-breaker/SKILL.ko.md',
    sha256: [
      '8e7a1e016f75327b1d60f77a0392b828efa1b892501ed66c57a23f03d55826a2',
      'ddddb8d9e7e3dd0e991f19c9384763886437930d164971e659719a98b389c897',
    ],
  },
  {
    path: 'skills/prompt-generator/video-prompt/SKILL.md',
    sha256: ['7e69435996755bd1c616806c03d028bab241e44848383c09bd3ebbbf8a29895e'],
  },
  {
    path: 'skills/prompt-generator/video-prompt/SKILL.en.md',
    sha256: ['93e0bcb8afe7c550a464d56772a633dfb40e374034471767e74b7441cfeb77f9'],
  },
  {
    path: 'skills/prompt-generator/video-prompt/SKILL.ja.md',
    sha256: ['417cfad9d5f78a293d937c9944d3b3c32a5031a118eda27e43f427ecd455aa58'],
  },
  {
    path: 'skills/prompt-generator/video-prompt/SKILL.ko.md',
    sha256: ['52069c6d651b3a31f051ca2f73af5dd6248d50d214468036649767eb180eaa04'],
  },
  {
    path: 'skills/storyboard-auditor/SKILL.md',
    sha256: [
      '73d21c14f321d137ee6c02925fde6e5e684f1c4bdb4133d8c337df4ad4b6cf53',
      '9689014430fc5fc1cb049810265aa2c69fdff623d9f67f23a884416d73abcbb6',
      '2a40f9af38b4ca10c583b8e4d30dc833a8ad3c27153b9e1fbf2b6acbb75d9eb5',
    ],
  },
  {
    path: 'skills/storyboard-auditor/SKILL.en.md',
    sha256: [
      '868c738cffd15d1d846c24c8e6257fc37a2440d0852d9b2b3d3a3118a6624c82',
      '8724a532c753cfb0c98ec4d7a6baa8026101369ea2dbcba7cc87c603e3e114f2',
      'c352c8cf195dc954b1d0e5cca405e3a068aa919f9c7ea3f9d4f7ee47bc970622',
    ],
  },
  {
    path: 'skills/storyboard-auditor/SKILL.ja.md',
    sha256: [
      'a84a9bfa264fcf2850e4e3faedb24a132fe71ee6454bcf37246230fd0802c95d',
      '6c2a02bab683361b03f328084df9331ac6434b05e200f80943d950682c6cf19a',
      '3e958d9b0ec80834425667ac8fc14375133a1b730e9e2b664345eb6cab84bb57',
    ],
  },
  {
    path: 'skills/storyboard-auditor/SKILL.ko.md',
    sha256: [
      'd3e51139512aea042b431632699c288a3d0cd0a6de17d5912aca161d48a31859',
      '344927be5751c69db1e63a6418d8b8d4d1c4e08c9b300fc0ff2a72d584573708',
      'd13248df23b2ada90b5671a3f6f08287c513e027c7b810eec3acd4c66b2c906e',
    ],
  },
]

export function migrateLegacyBuiltinFiles(
  workspaceDir: string,
  templateDir: string,
  rules: LegacyBuiltinFileRule[] = LEGACY_BUILTIN_FILES,
): string[] {
  const changed: string[] = []
  for (const rule of rules) {
    const target = path.join(workspaceDir, rule.path)
    const source = path.join(templateDir, rule.path)
    if (!fs.existsSync(target) || !fs.existsSync(source)) continue
    const current = fs.readFileSync(target)
    const hash = createHash('sha256').update(current).digest('hex')
    if (!rule.sha256.includes(hash)) continue
    const next = fs.readFileSync(source)
    if (current.equals(next)) continue
    fs.writeFileSync(target, next)
    changed.push(target)
  }
  return changed
}

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
