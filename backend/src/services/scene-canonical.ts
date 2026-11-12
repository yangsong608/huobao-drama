/**
 * 场景 canonical 归组
 *
 * 同一地点存在多个 scene_id / 多张参考图时（例如 54/55/56 都叫“唐记食铺大堂”），
 * 拆分阶段只暴露一个 canonical scene_id，保存时把别名自动改绑到 canonical。
 * 不修改 scenes 表，只做运行时归组；时间变化仍写在 time / 画面调度里。
 */
import { and, count, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

export interface CanonicalSceneGroup {
  key: string
  name: string
  canonicalId: number
  aliasIds: number[]
  usage: number
}

interface SceneRow {
  id: number
  location: string
  time: string | null
  imageUrl: string | null
}

/** 只做地点归一，不处理时间；处理常见同义名称 */
export function canonicalSceneKey(location: string | null | undefined): string {
  let value = String(location || '').trim().replace(/\s+/g, '')
  if (!value) return ''
  value = value.replace(/^邓州/, '')
  value = value.replace(/唐家宅邸|唐家老宅|唐宅/g, '唐宅')
  value = value.replace(/街道$/, '街')
  value = value.replace(/(?:废墟|宅邸|老宅)$/g, '')
  return value
}

export function matchesSceneLocation(group: CanonicalSceneGroup, location: string): boolean {
  const key = canonicalSceneKey(location)
  if (!key) return false
  if (key === group.key) return true
  return key.startsWith(group.key) || group.key.startsWith(key)
}

export async function getCanonicalSceneGroups(dramaId: number): Promise<CanonicalSceneGroup[]> {
  const scenes = await db.select({
    id: schema.scenes.id,
    location: schema.scenes.location,
    time: schema.scenes.time,
    imageUrl: schema.scenes.imageUrl,
  }).from(schema.scenes).where(and(
    eq(schema.scenes.dramaId, dramaId),
    isNull(schema.scenes.deletedAt),
  ))
  const usageRows = await db.select({
    sceneId: schema.storyboards.sceneId,
    n: count(),
  }).from(schema.storyboards)
    .innerJoin(schema.episodes, eq(schema.episodes.id, schema.storyboards.episodeId))
    .where(and(
      eq(schema.episodes.dramaId, dramaId),
      isNull(schema.storyboards.deletedAt),
    ))
    .groupBy(schema.storyboards.sceneId)
  const usage = new Map<number, number>()
  for (const row of usageRows) {
    if (row.sceneId != null) usage.set(row.sceneId, Number(row.n || 0))
  }

  const groups = new Map<string, SceneRow[]>()
  for (const scene of scenes) {
    const key = canonicalSceneKey(scene.location)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(scene)
  }

  const result: CanonicalSceneGroup[] = []
  for (const [key, rows] of groups) {
    const sorted = [...rows].sort((a, b) => {
      const imageA = a.imageUrl ? 1 : 0
      const imageB = b.imageUrl ? 1 : 0
      if (imageA !== imageB) return imageB - imageA
      const usageA = usage.get(a.id) || 0
      const usageB = usage.get(b.id) || 0
      if (usageA !== usageB) return usageB - usageA
      return a.id - b.id
    })
    const canonical = sorted[0]
    result.push({
      key,
      name: canonical.location,
      canonicalId: canonical.id,
      aliasIds: sorted.slice(1).map(row => row.id),
      usage: usage.get(canonical.id) || 0,
    })
  }
  return result.sort((a, b) => a.canonicalId - b.canonicalId)
}

export async function resolveCanonicalSceneId(dramaId: number, sceneId: number | null | undefined): Promise<number | null | undefined> {
  if (sceneId == null) return sceneId
  const groups = await getCanonicalSceneGroups(dramaId)
  for (const group of groups) {
    if (group.canonicalId === sceneId) return sceneId
    if (group.aliasIds.includes(sceneId)) return group.canonicalId
  }
  return sceneId
}

/** 按地点名找 canonical 场景；用于模型只填 location 没填 scene_id 时自动绑定 */
export function resolveCanonicalSceneByName(groups: CanonicalSceneGroup[], location: string | null | undefined): CanonicalSceneGroup | null {
  const text = String(location || '').trim()
  if (!text) return null
  return groups
    .filter(group => matchesSceneLocation(group, text))
    .sort((a, b) => b.key.length - a.key.length)[0] || null
}

/** 给拆分消息追加 canonical 场景绑定块；script 里能识别的场次直接给 scene_id */
export function buildSceneBindingBlock(script: string, groups: CanonicalSceneGroup[]): string {
  if (!groups.length) return ''
  const lines = [
    '### Canonical 场景绑定（硬约束，优先于上面的场景列表）',
    '同一地点只允许使用一个 canonical scene_id；下面列出的别名场景禁止再选，时间变化写进 time / 画面调度，不要按时间另选场景。',
  ]
  for (const group of groups) {
    const aliases = group.aliasIds.length ? `；别名=${group.aliasIds.join('/')}（禁用）` : ''
    lines.push(`- ${group.name}：canonical scene_id=${group.canonicalId}${aliases}`)
  }
  const headings = [...String(script || '').matchAll(/^##\s*(S\d+)\s*\|\s*[^|·]+\s*·\s*([^|]+?)\s*\|\s*([^\n]+)$/gm)]
  if (headings.length) {
    lines.push('本段场次绑定：')
    for (const [, label, location] of headings) {
      const group = groups.filter(item => matchesSceneLocation(item, location)).sort((a, b) => b.key.length - a.key.length)[0]
      lines.push(`- ${label}（${location.trim()}）→ scene_id=${group ? group.canonicalId : '未匹配，按 canonical 组选择'}`)
    }
  }
  return lines.join('\n')
}
