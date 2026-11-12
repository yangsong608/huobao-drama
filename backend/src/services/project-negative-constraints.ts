/**
 * 项目负面约束分析
 *
 * “不出现现代物品”不能对所有项目写死：
 * - 历史/古代项目排除现代物品、服装、文字标识；
 * - 现代项目只排除与项目设定冲突的时代物品/品牌/文字；
 * - 玄幻/仙侠/未来项目排除现代科技产品但不必排除“现代”这个概念本身。
 *
 * 输入优先使用项目背景/题材/标签/故事圣经，再结合本集剧本做确定性关键词分析。
 * 不依赖文本模型，保证离线、可复现；只产出负面约束，不改画面内容。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

export type ProjectEra = 'historical' | 'modern' | 'fantasy' | 'unknown'

export interface ProjectNegativeAnalysis {
  era: ProjectEra
  rule: string
  evidence: string[]
}

const HISTORICAL_MARKERS = [
  '北宋', '南宋', '大宋', '宋朝', '宋代', '唐朝', '唐代', '明朝', '明代', '清朝', '清代', '民国',
  '古代', '王朝', '皇帝', '皇后', '太子', '衙门', '官府', '客栈', '酒楼', '西市', '东市',
  '市井', '炊饼', '铜钱', '银子', '布衣', '长街', '科举', '诗会', '江湖', '武侠', '古装',
]
const MODERN_MARKERS = [
  '现代', '当代', '都市', '公司', '集团', '总裁', '手机', '电脑', '互联网', '汽车', '地铁',
  '高铁', '飞机', '电梯', '咖啡', '校园', '医院', '警局', '法院', '律师', '直播', '短视频',
  '科幻', '未来', '机器人', '人工智能', '芯片', '赛博',
]
const FANTASY_MARKERS = [
  '玄幻', '仙侠', '修真', '灵气', '法术', '妖兽', '神族', '魔族', '异世界', '仙界', '妖界',
]

const ERA_RULES: Record<ProjectEra, string> = {
  historical: '不出现现代物品、现代服装、现代文字和标识',
  modern: '不出现与项目设定冲突的时代物品、品牌、文字和标识',
  fantasy: '不出现现代科技产品、现代服装和现代文字标识',
  unknown: '不出现与项目时代、地域和设定冲突的物品、服装、文字和标识',
}

const ERA_LABELS: Record<ProjectEra, string> = {
  historical: '历史/古代',
  modern: '现代/都市',
  fantasy: '玄幻/仙侠/未来',
  unknown: '未明确',
}

function matches(text: string, markers: string[]): string[] {
  return [...new Set(markers.filter(marker => text.includes(marker)))]
}

/** 纯函数：按关键词判断项目时代/题材，返回命中的证据词 */
export function analyzeProjectEra(text: string): { era: ProjectEra; evidence: string[] } {
  const source = String(text || '')
  if (!source.trim()) return { era: 'unknown', evidence: [] }
  const historical = matches(source, HISTORICAL_MARKERS)
  const modern = matches(source, MODERN_MARKERS)
  const fantasy = matches(source, FANTASY_MARKERS)
  const scores: Array<[ProjectEra, number]> = [
    ['historical', historical.length],
    ['modern', modern.length],
    ['fantasy', fantasy.length],
  ]
  scores.sort((a, b) => b[1] - a[1])
  const [era, score] = scores[0]
  if (score <= 0) return { era: 'unknown', evidence: [] }
  const evidence = era === 'historical' ? historical : era === 'modern' ? modern : fantasy
  return { era, evidence: evidence.slice(0, 8) }
}

export function projectNegativeRule(era: ProjectEra): string {
  return ERA_RULES[era]
}

export function projectEraLabel(era: ProjectEra): string {
  return ERA_LABELS[era]
}

async function loadProjectText(dramaId: number, episodeId?: number): Promise<string> {
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  const parts: string[] = []
  if (drama) {
    parts.push(
      drama.title,
      drama.genre || '',
      drama.tags || '',
      drama.background || '',
      drama.visualBackground || '',
      drama.storyBible || '',
    )
  }
  if (episodeId) {
    const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
    if (episode) parts.push(episode.content || '', episode.scriptContent || '', episode.description || '')
  }
  return parts.filter(Boolean).join('\n')
}

export async function deriveProjectNegativeConstraints(
  dramaId: number,
  episodeId?: number,
): Promise<ProjectNegativeAnalysis> {
  const text = await loadProjectText(dramaId, episodeId)
  const { era, evidence } = analyzeProjectEra(text)
  return {
    era,
    rule: projectNegativeRule(era),
    evidence: evidence.length ? evidence : (text.trim() ? ['项目背景'] : []),
  }
}

/** 给 Agent 用户消息用的可读行 */
export function formatProjectNegativeAnalysis(analysis: ProjectNegativeAnalysis): string {
  const basis = analysis.evidence.length ? `（依据：${analysis.evidence.join('、')}）` : ''
  return `项目负面约束：${analysis.rule}${basis}`
}
