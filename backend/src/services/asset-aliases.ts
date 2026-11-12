/**
 * 资产别名归一
 *
 * 模型常把「唐大郎（唐奕）」写成「唐大郎」，把「邓州西市街道」写成「邓州西市街」。
 * 保存前按项目资产生成别名表，只替换 @mention，不改台词正文的其他文字。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { canonicalSceneKey, getCanonicalSceneGroups } from './scene-canonical.js'

export interface AssetAliasMap {
  exact: Map<string, string>
  canonicalNames: Set<string>
  /** 前缀兜底：只在唯一命中时使用，避免把「唐记食铺」误配到多个场景 */
  prefixes: Array<{ alias: string; canonical: string }>
}

function addAlias(map: AssetAliasMap, alias: string, canonical: string, canonicalNames: Set<string>) {
  const key = alias.trim().replace(/^@+/, '')
  if (!key || key === canonical || canonicalNames.has(key)) return
  if (map.exact.has(key)) return
  map.exact.set(key, canonical)
}

export async function buildAssetAliasMap(dramaId: number): Promise<AssetAliasMap> {
  const map: AssetAliasMap = { exact: new Map(), canonicalNames: new Set(), prefixes: [] }
  const characters = await db.select({ id: schema.characters.id, name: schema.characters.name })
    .from(schema.characters)
    .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
  const props = await db.select({ id: schema.props.id, name: schema.props.name })
    .from(schema.props)
    .where(and(eq(schema.props.dramaId, dramaId), isNull(schema.props.deletedAt)))
  const groups = await getCanonicalSceneGroups(dramaId)
  const canonicalNames = new Set<string>([
    ...characters.map(item => item.name),
    ...props.map(item => item.name),
    ...groups.map(item => item.name),
  ])
  map.canonicalNames = canonicalNames

  for (const character of characters) {
    const base = character.name.replace(/[（(].*?[）)]/g, '').trim()
    if (base && base.length >= 2) addAlias(map, base, character.name, canonicalNames)
  }
  for (const prop of props) {
    const base = prop.name.replace(/[（(].*?[）)]/g, '').trim()
    if (base && base.length >= 2) addAlias(map, base, prop.name, canonicalNames)
  }
  for (const group of groups) {
    const canonicalName = group.name
    const aliases = new Set<string>()
    for (const row of await db.select({ location: schema.scenes.location }).from(schema.scenes)
      .where(and(eq(schema.scenes.dramaId, dramaId), isNull(schema.scenes.deletedAt)))) {
      if (!row.location) continue
      if (canonicalSceneKey(row.location) === group.key && row.location !== canonicalName) aliases.add(row.location)
    }
    for (const alias of aliases) addAlias(map, alias, canonicalName, canonicalNames)
  }
  // 模型可能漏掉“道”“宅”等尾字：为足够长的 canonical 名建立前缀兜底，只在唯一命中时生效
  for (const group of groups) {
    for (let length = 4; length < group.name.length; length += 1) {
      map.prefixes.push({ alias: group.name.slice(0, length), canonical: group.name })
    }
  }
  const seen = new Set<string>()
  map.prefixes = map.prefixes.filter(item => {
    const key = `${item.alias}|${item.canonical}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // 唯一场景名前缀作为精确别名，例如 @邓州西市街 → @邓州西市街道；
  // 多义前缀（如 @唐记食铺）不加入，避免把不同场景混在一起。
  const prefixOwners = new Map<string, Set<string>>()
  for (const group of groups) {
    for (let length = 4; length < group.name.length; length += 1) {
      const prefix = group.name.slice(0, length)
      if (canonicalNames.has(prefix)) continue
      if (!prefixOwners.has(prefix)) prefixOwners.set(prefix, new Set())
      prefixOwners.get(prefix)!.add(group.name)
    }
  }
  for (const [prefix, owners] of prefixOwners) {
    if (owners.size === 1) addAlias(map, prefix, [...owners][0], canonicalNames)
  }
  return map
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 只替换 @mention，绝不吞掉 mention 后面的普通文字 */
export function applyAssetAliases(text: string | null | undefined, map: AssetAliasMap): string {
  if (!text) return text || ''
  let output = String(text)
  // 1) 精确别名/全名，按长度倒序匹配，避免 @唐大郎 抢先吃掉 @唐大郎（唐奕）
  const exactEntries = [
    ...map.exact.entries(),
    ...[...map.canonicalNames].map(name => [name, name] as [string, string]),
  ]
  exactEntries.sort((a, b) => b[0].length - a[0].length)
  if (exactEntries.length) {
    const pattern = new RegExp(`@(${exactEntries.map(([alias]) => escapeRegExp(alias)).join('|')})`, 'g')
    output = output.replace(pattern, (_match, token: string) => {
      const canonical = map.exact.get(token) || token
      return `@${canonical}`
    })
  }
  // 2) 前缀兜底：只在本 token 后面不是字母/数字时替换，避免吞掉后续描述
  if (map.prefixes.length) {
    const sorted = [...map.prefixes].sort((a, b) => b.alias.length - a.alias.length)
    const pattern = new RegExp(`@(${sorted.map(item => escapeRegExp(item.alias)).join('|')})(?![\\p{L}\\p{N}])`, 'gu')
    output = output.replace(pattern, (match, token: string) => {
      const candidates = [...new Set(sorted.filter(item => item.alias === token).map(item => item.canonical))]
      return candidates.length === 1 ? `@${candidates[0]}` : match
    })
  }
  return output
}
