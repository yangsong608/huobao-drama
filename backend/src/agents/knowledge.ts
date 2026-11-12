/**
 * Agent 专用知识库
 *
 * 每个 Agent 读自己分配的知识，不做全员共读。索引 knowledge/index.json 记录
 * id/name/description/agents/required/enabled；索引和正文都在 workspace/knowledge/。
 * 拆分/校验/提示词等必读知识缺失时直接报错，不允许无知识运行。
 */
import { createHash } from 'node:crypto'
import { skillsManagerWorkspace } from './skills.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'

const fsm = () => skillsManagerWorkspace.filesystem!

export interface KnowledgeIndexItem {
  id: string
  name: string
  description: string
  agents: string[]
  required: boolean
  enabled: boolean
}

export interface KnowledgeIndex {
  version: number
  items: KnowledgeIndexItem[]
}

export interface LoadedKnowledge {
  text: string
  ids: string[]
  version: string
  missing: string[]
}

export interface KnowledgeListItem extends KnowledgeIndexItem {
  fileExists: boolean
  contentHash: string | null
}

const INDEX_PATH = 'knowledge/index.json'
const KNOWLEDGE_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const LANGS = ['zh', 'en', 'ja', 'ko']

const DEFAULT_INDEX: KnowledgeIndex = {
  version: 1,
  items: [
    { id: 'novel-to-short-drama', name: '小说改编短剧', description: '小说叙事转短剧剧本。', agents: ['script_rewriter'], required: true, enabled: true },
    { id: 'asset-extraction', name: '角色场景道具提取', description: '资产提取边界与去重。', agents: ['extractor'], required: true, enabled: true },
    { id: 'short-drama-grammar', name: '短剧叙事与节奏', description: '结构、节拍、时长、对白容量。', agents: ['storyboard_breaker', 'storyboard_director'], required: true, enabled: true },
    { id: 'storyboard-direction', name: '分镜与导演语法', description: '景别、轴线、正反打、场景地理。', agents: ['storyboard_breaker', 'storyboard_director'], required: true, enabled: true },
    { id: 'continuity-and-transitions', name: '前后镜连贯与过渡分镜', description: '成对合同、尾帧/首帧、过渡空镜。', agents: ['storyboard_breaker', 'storyboard_director', 'storyboard_auditor', 'prompt_generator'], required: true, enabled: true },
    { id: 'storyboard-validation', name: '分镜校验清单', description: '三层校验、门禁、证据、修复。', agents: ['storyboard_auditor'], required: true, enabled: true },
    { id: 'video-prompt-consistency', name: '视频提示词一致性', description: '提示词结构、画内人物、首尾帧、声音。', agents: ['prompt_generator'], required: true, enabled: true },
    { id: 'voice-and-narration', name: '声音与旁白设计', description: '音色档案、四型声音、跨集一致性。', agents: ['voice_designer'], required: true, enabled: true },
  ],
}

function normalizeLang(value?: string | null) {
  return value && LANGS.includes(value) ? value : 'zh'
}

function normalizeItem(raw: any): KnowledgeIndexItem | null {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  if (!KNOWLEDGE_ID_RE.test(id)) return null
  const agents: string[] = Array.isArray(raw.agents)
    ? [...new Set<string>(raw.agents.map((item: any) => String(item || '').trim()).filter(Boolean))]
    : []
  return {
    id,
    name: String(raw.name || id).trim(),
    description: String(raw.description || '').trim(),
    agents,
    required: raw.required !== false,
    enabled: raw.enabled !== false,
  }
}

function normalizeIndex(raw: any): KnowledgeIndex | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null
  const items = (raw.items as unknown[]).map(normalizeItem).filter((item): item is KnowledgeIndexItem => item != null)
  if (!items.length) return null
  return { version: Number(raw.version) || 1, items }
}

/** 首次启动补齐索引；已有索引不覆盖，避免冲掉用户的 Agent 分配 */
export async function ensureKnowledgeIndex(): Promise<void> {
  if (await fsm().exists(INDEX_PATH)) return
  await fsm().writeFile(INDEX_PATH, JSON.stringify(DEFAULT_INDEX, null, 2) + '\n', { recursive: true })
}

export async function loadKnowledgeIndex(): Promise<KnowledgeIndex> {
  try {
    if (!await fsm().exists(INDEX_PATH)) {
      await ensureKnowledgeIndex()
      return DEFAULT_INDEX
    }
    const raw = String(await fsm().readFile(INDEX_PATH, { encoding: 'utf-8' }))
    const parsed = normalizeIndex(JSON.parse(raw))
    if (parsed) return parsed
    logTaskWarn('Knowledge', 'index-invalid', { path: INDEX_PATH })
  } catch (error) {
    logTaskWarn('Knowledge', 'index-read-failed', {
      path: INDEX_PATH,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return DEFAULT_INDEX
}

function stripFrontmatter(raw: string) {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? raw.slice(match[0].length) : raw
}

async function readKnowledgeContent(id: string, lang?: string | null): Promise<{ content: string; hash: string } | null> {
  const normalized = normalizeLang(lang)
  const candidates = normalized === 'zh'
    ? [`knowledge/${id}.md`]
    : [`knowledge/${id}.${normalized}.md`, `knowledge/${id}.md`]
  for (const path of candidates) {
    try {
      if (!await fsm().exists(path)) continue
      const content = stripFrontmatter(String(await fsm().readFile(path, { encoding: 'utf-8' }))).trim()
      if (!content) continue
      return { content, hash: createHash('sha256').update(content).digest('hex') }
    } catch {
      // 读取失败按缺失处理，不阻断其它知识库
    }
  }
  return null
}

/** 读取指定 Agent 分配的知识库；每次重新读文件，设置保存后下一次调用生效 */
const CRITICAL_AGENTS = new Set(['storyboard_breaker', 'storyboard_director', 'storyboard_auditor', 'prompt_generator'])
const DIRECTOR_DEFAULT_KNOWLEDGE = ['short-drama-grammar', 'storyboard-direction', 'continuity-and-transitions']

export async function loadAssignedKnowledge(agentType: string, lang?: string | null): Promise<LoadedKnowledge> {  const index = await loadKnowledgeIndex()
  const assigned = index.items.filter(item => item.enabled && item.agents.includes(agentType))
  if (CRITICAL_AGENTS.has(agentType) && assigned.length && !assigned.some(item => item.required)) {
    throw new Error(`关键 Agent（${agentType}）没有必读知识库。请在设置 → Agent 配置 → 知识库至少保留一个必读知识。`)
  }
  if (!assigned.length) {
    if (CRITICAL_AGENTS.has(agentType)) {
      throw new Error(`关键 Agent（${agentType}）没有分配任何必读知识库。请在设置 → Agent 配置 → 知识库至少保留一个必读知识。`)
    }
    return { text: '', ids: [], version: '', missing: [] }
  }

  const sections: string[] = []
  const ids: string[] = []
  const missing: string[] = []
  const hashes: string[] = []
  for (const item of assigned) {
    const loaded = await readKnowledgeContent(item.id, lang)
    if (!loaded) {
      missing.push(item.id)
      continue
    }
    ids.push(item.id)
    hashes.push(`${item.id}:${loaded.hash}`)
    sections.push(`### 知识库：${item.name}（${item.id}）\n${loaded.content}`)
  }
  const requiredMissing = assigned.filter(item => item.required && missing.includes(item.id)).map(item => item.name)
  if (requiredMissing.length) {
    throw new Error(`必读知识库缺失：${requiredMissing.join('、')}。请先在设置 → Agent 配置 → 知识库补全或恢复默认，再重新执行。`)
  }
  if (missing.length) logTaskWarn('Knowledge', 'optional-missing', { agent: agentType, missing })

  const version = createHash('sha256').update(hashes.sort().join('|')).digest('hex').slice(0, 12)
  const text = [
    '## 专用知识库（本 Agent 必须预读）',
    '以下知识库按 Agent 分配加载。开始任务前先按这些规范执行；与用户明确要求冲突时，以用户要求为准。',
    '',
    sections.join('\n\n'),
  ].join('\n')
  logKnowledgeLoadedOnce(agentType, version, ids)
  return { text, ids, version, missing }
}

/**
 * 按显式 id 列表加载知识（链式流水线的步骤级绑定）。
 * 与 Agent 默认分配不同：这里不读取 agents 字段，只按 id 取正文；缺失直接阻断。
 */
export async function loadKnowledgeByIds(ids: string[], lang?: string | null): Promise<LoadedKnowledge> {
  const unique = [...new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean))]
  if (!unique.length) return { text: '', ids: [], version: '', missing: [] }
  const index = await loadKnowledgeIndex()
  const byId = new Map(index.items.map(item => [item.id, item]))
  const unknown = unique.filter(id => !byId.has(id))
  if (unknown.length) throw new Error(`步骤绑定的知识库不存在：${unknown.join('、')}`)
  const sections: string[] = []
  const loadedIds: string[] = []
  const missing: string[] = []
  const hashes: string[] = []
  for (const id of unique) {
    const loaded = await readKnowledgeContent(id, lang)
    if (!loaded) {
      missing.push(id)
      continue
    }
    loadedIds.push(id)
    hashes.push(`${id}:${loaded.hash}`)
    sections.push(`### 知识库：${byId.get(id)?.name || id}（${id}）\n${loaded.content}`)
  }
  if (missing.length) throw new Error(`步骤绑定的知识库缺失：${missing.join('、')}。请先在设置 → Agent 配置 → 知识库补全。`)
  const version = createHash('sha256').update(hashes.sort().join('|')).digest('hex').slice(0, 12)
  const text = [
    '## 专用知识库（本步骤必须预读）',
    '以下知识库由当前流水线步骤显式绑定。开始任务前先按这些规范执行；与用户明确要求冲突时，以用户要求为准。',
    '',
    sections.join('\n\n'),
  ].join('\n')
  return { text, ids: loadedIds, version, missing: [] }
}

/**
 * 存量 workspace 的知识索引是 copy-once 的；4.0.38 新增导演 Agent 后，
 * 老索引里没有 storyboard_director。这里做一次幂等追加：只在导演完全没有分配时补默认知识。
 */
export async function ensureDirectorKnowledgeAssignment(): Promise<void> {
  const index = await loadKnowledgeIndex()
  if (index.items.some(item => item.agents.includes('storyboard_director'))) return
  let changed = false
  const items = index.items.map(item => {
    if (!DIRECTOR_DEFAULT_KNOWLEDGE.includes(item.id)) return item
    changed = true
    return { ...item, agents: [...item.agents, 'storyboard_director'] }
  })
  if (!changed) return
  await writeIndex({ ...index, items })
  logTaskProgress('Knowledge', 'director-assignment-added', {
    ids: items.filter(item => item.agents.includes('storyboard_director')).map(item => item.id),
  })
}

const logged = new Set<string>()
function logKnowledgeLoadedOnce(agentType: string, version: string, ids: string[]) {
  const key = `${agentType}|${version}`
  if (logged.has(key)) return
  logged.add(key)
  logTaskProgress('Knowledge', 'loaded', { agent: agentType, ids, version })
}

export async function listKnowledge(lang?: string | null): Promise<KnowledgeListItem[]> {
  const index = await loadKnowledgeIndex()
  const out: KnowledgeListItem[] = []
  for (const item of index.items) {
    const loaded = await readKnowledgeContent(item.id, lang)
    out.push({ ...item, fileExists: Boolean(loaded), contentHash: loaded?.hash ?? null })
  }
  return out
}

export async function getKnowledge(id: string, lang?: string | null) {
  const index = await loadKnowledgeIndex()
  const item = index.items.find(entry => entry.id === id)
  if (!item) return null
  const loaded = await readKnowledgeContent(id, lang)
  return { ...item, content: loaded?.content ?? '', contentHash: loaded?.hash ?? null }
}

function assertId(id: string) {
  if (!KNOWLEDGE_ID_RE.test(id)) throw new Error('知识库 ID 只能包含小写字母、数字和连字符')
}

async function writeIndex(index: KnowledgeIndex) {
  await fsm().writeFile(INDEX_PATH, JSON.stringify(index, null, 2) + '\n', { recursive: true })
}

export async function saveKnowledge(id: string, input: {
  name?: string
  description?: string
  agents?: string[]
  required?: boolean
  enabled?: boolean
  content?: string
}, lang?: string | null): Promise<KnowledgeListItem> {
  assertId(id)
  const index = await loadKnowledgeIndex()
  const item = index.items.find(entry => entry.id === id)
  if (!item) throw new Error('知识库不存在')
  if (input.name !== undefined) item.name = String(input.name).trim() || item.name
  if (input.description !== undefined) item.description = String(input.description).trim()
  if (input.agents !== undefined) item.agents = [...new Set((input.agents || []).map(agent => String(agent || '').trim()).filter(Boolean))]
  if (input.required !== undefined) item.required = Boolean(input.required)
  if (input.enabled !== undefined) item.enabled = Boolean(input.enabled)
  const normalized = normalizeLang(lang)
  if (input.content !== undefined) {
    const path = normalized === 'zh' ? `knowledge/${id}.md` : `knowledge/${id}.${normalized}.md`
    await fsm().writeFile(path, String(input.content), { recursive: true })
  }
  await writeIndex(index)
  const loaded = await readKnowledgeContent(id, lang)
  return { ...item, fileExists: Boolean(loaded), contentHash: loaded?.hash ?? null }
}

export async function createKnowledge(input: {
  id: string
  name?: string
  description?: string
  agents?: string[]
  required?: boolean
  enabled?: boolean
  content?: string
}): Promise<KnowledgeListItem> {
  const id = String(input.id || '').trim()
  assertId(id)
  const index = await loadKnowledgeIndex()
  if (index.items.some(item => item.id === id)) throw new Error('知识库已存在')
  const item: KnowledgeIndexItem = {
    id,
    name: String(input.name || id).trim(),
    description: String(input.description || '').trim(),
    agents: [...new Set((input.agents || []).map(agent => String(agent || '').trim()).filter(Boolean))],
    required: input.required !== false,
    enabled: input.enabled !== false,
  }
  const content = String(input.content ?? `# ${item.name}\n\n## 适用范围\n\n## 核心规则\n\n## 交付前检查\n`)
  await fsm().writeFile(`knowledge/${id}.md`, content, { recursive: true, overwrite: false })
  index.items.push(item)
  await writeIndex(index)
  const loaded = await readKnowledgeContent(id, 'zh')
  return { ...item, fileExists: Boolean(loaded), contentHash: loaded?.hash ?? null }
}

export async function deleteKnowledge(id: string): Promise<void> {
  assertId(id)
  const index = await loadKnowledgeIndex()
  const item = index.items.find(entry => entry.id === id)
  if (!item) throw new Error('知识库不存在')
  if (item.agents.length) throw new Error('该知识库仍分配给 Agent，请先取消分配再删除')
  for (const lang of LANGS) {
    const path = lang === 'zh' ? `knowledge/${id}.md` : `knowledge/${id}.${lang}.md`
    if (await fsm().exists(path)) await fsm().deleteFile(path)
  }
  index.items = index.items.filter(entry => entry.id !== id)
  await writeIndex(index)
}

export async function setKnowledgeAgents(id: string, agents: string[]): Promise<KnowledgeListItem> {
  assertId(id)
  const index = await loadKnowledgeIndex()
  const item = index.items.find(entry => entry.id === id)
  if (!item) throw new Error('知识库不存在')
  item.agents = [...new Set((agents || []).map(agent => String(agent || '').trim()).filter(Boolean))]
  await writeIndex(index)
  const loaded = await readKnowledgeContent(id, 'zh')
  return { ...item, fileExists: Boolean(loaded), contentHash: loaded?.hash ?? null }
}
