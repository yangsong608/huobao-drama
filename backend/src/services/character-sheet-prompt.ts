/**
 * 角色设定图提示词守卫
 *
 * 部分生图模型会把「三视图」画成无头服装人台，只保留左侧正脸特写。
 * 这里用确定性的版式/完整头脚约束兜底，不依赖提示词 Agent 每次自觉写全。
 */
export interface CharacterSheetInput {
  name: string
  appearance?: string | null
  description?: string | null
  styling?: string | null
}

const CJK_RE = /[\u3400-\u9fff]/
const KANA_HANGUL_RE = /[\u3040-\u30ff\uac00-\ud7af]/
const GUARD_MARK_RE = /只(?:画|显示)颈部以下|不出现头部、人脸或头发|no head, face or hair|headless full-body/i

/** 右侧三视图必须无头；左侧正脸特写单独提供头部与脸部参考。 */
export const CHARACTER_SHEET_GUARD_ZH = '版式硬约束：左侧为正脸特写，完整呈现头部、面部、发型和肩部；右侧并列三张等高无头全身视图（正面、90 度侧面、背面），三张视图只画颈部以下的躯干、四肢和服装，不出现头部、人脸或头发，颈部断面平齐、脚底对齐；左侧特写与右侧身体视图的服装、体型和配色完全一致。'
export const CHARACTER_SHEET_GUARD_EN = 'Layout constraints: the left panel is a frontal face close-up showing the complete head, face, hairstyle and shoulders. The right side contains three equal headless full-body turnaround views (front, 90-degree side, back) of the same character; each right-side view shows only the neck-down torso, limbs and outfit, with no head, face or hair. The three headless views share the same neck line and sole line; the close-up and the body views share the same outfit, body proportions and colors.'

function guardFor(prompt: string): string {
  return CJK_RE.test(prompt) && !KANA_HANGUL_RE.test(prompt)
    ? CHARACTER_SHEET_GUARD_ZH
    : CHARACTER_SHEET_GUARD_EN
}

/** 清掉上一版“完整头脚”守卫和旧模板里“三个视图都有脸”的描述，避免与无头三视图冲突 */
function normalizeCharacterSheetText(text: string): string {
  return text
    .replace(/，?版式硬约束：[^。]*。/g, '')
    .replace(/，?Layout constraints:[^.]*\./gi, '')
    .replace(/，?每个全身视图从头顶到脚底完整入镜[^。]*。?/g, '')
    .replace(/，?每个全身视图必须完整包含头发[^。]*。?/g, '')
    .replace(/，?头顶上方和脚底下方都?保留空白[^。]*。?/g, '')
    .replace(/，?禁止无头人台、断头、只有服装没有头、头部被画框裁掉/g, '')
    .replace(/，?头顶和脚底不得被画框裁切/g, '')
    .replace(/，?正脸特写与三个(?:全身)?视图的脸、发型和服装完全一致/g, '')
    .replace(/三张全身视图等高并排、头顶脚底对齐/g, '三张无头视图等高并排、颈部断面与脚底对齐')
    .replace(/三张等高(?!无头)全身视图/g, '三张等高无头全身视图')
    .replace(/头顶和脚底对齐|头顶脚底对齐/g, '颈部断面与脚底对齐')
    .replace(/\s{2,}/g, ' ')
    .replace(/，{2,}/g, '，')
    .replace(/。，/g, '。')
    .replace(/；，/g, '；')
    .replace(/，；/g, '；')
    .replace(/。；/g, '。')
    .trim()
}

export function ensureCharacterSheetGuard(prompt: string): string {
  const text = normalizeCharacterSheetText(String(prompt || '').trim())
  if (!text) return CHARACTER_SHEET_GUARD_ZH
  if (GUARD_MARK_RE.test(text)) return text
  const separator = /[。！？.!?；;，,]$/.test(text) ? '' : '，'
  return `${text}${separator}${guardFor(text)}`
}

/** 最终提示词 Agent 失败时的确定性兜底：必须是完整头脚的四视图设定图，不是半身海报 */
export function buildCharacterSheetFallbackPrompt(char: CharacterSheetInput, stylePrompt = ''): string {
  return [
    stylePrompt || '',
    char.name,
    char.appearance || char.description || '人物立绘',
    char.styling || '',
    '16:9 横版角色设定参考图',
    '左侧正脸特写占画面约四分之一，完整呈现头部、面部、发型和肩部',
    '右侧并列展示正面、90 度侧面、背面三张等高无头全身视图，各占画面约四分之一',
    '右侧三张视图只显示颈部以下的躯干、双臂、双腿和服装，不出现头部、人脸或头发，颈部断面平齐、脚底对齐',
    '左侧特写与右侧身体视图的服装、体型和配色完全一致',
    '纯白背景，柔和均匀的光线，电影质感',
  ].filter(Boolean).join('，')
}
