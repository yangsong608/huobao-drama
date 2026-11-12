/**
 * Agent 专用知识库管理路由（按 Agent 分配，不做全员共读）
 */
import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { validAgentTypes } from '../agents/index.js'
import {
  createKnowledge,
  deleteKnowledge,
  getKnowledge,
  listKnowledge,
  saveKnowledge,
  setKnowledgeAgents,
} from '../agents/knowledge.js'

const app = new Hono()
const LANGS = ['zh', 'en', 'ja', 'ko']
const normalizeLang = (v?: string) => (v && LANGS.includes(v) ? v : 'zh')

function validateAgents(agents: unknown): string[] {
  if (agents === undefined) return []
  if (!Array.isArray(agents)) throw new Error('agents 必须是数组')
  const unique = [...new Set(agents.map(agent => String(agent || '').trim()).filter(Boolean))]
  const invalid = unique.filter(agent => !validAgentTypes.includes(agent))
  if (invalid.length) throw new Error(`未知的 Agent 类型：${invalid.join('、')}`)
  return unique
}

app.get('/', async (c) => {
  return success(c, await listKnowledge(normalizeLang(c.req.query('lang'))))
})

app.get('/:id', async (c) => {
  const item = await getKnowledge(c.req.param('id'), normalizeLang(c.req.query('lang')))
  if (!item) return badRequest(c, '知识库不存在')
  return success(c, { ...item, lang: normalizeLang(c.req.query('lang')) })
})

app.post('/', async (c) => {
  const body = await c.req.json()
  try {
    return success(c, await createKnowledge({
      id: String(body.id || '').trim(),
      name: body.name,
      description: body.description,
      agents: validateAgents(body.agents),
      required: body.required,
      enabled: body.enabled,
      content: body.content,
    }))
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
})

app.put('/:id', async (c) => {
  const body = await c.req.json()
  const lang = normalizeLang(c.req.query('lang') ?? body.lang)
  try {
    return success(c, await saveKnowledge(c.req.param('id'), {
      name: body.name,
      description: body.description,
      agents: body.agents === undefined ? undefined : validateAgents(body.agents),
      required: body.required,
      enabled: body.enabled,
      content: body.content,
    }, lang))
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
})

app.put('/:id/agents', async (c) => {
  const body = await c.req.json()
  try {
    return success(c, await setKnowledgeAgents(c.req.param('id'), validateAgents(body.agents)))
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
})

app.delete('/:id', async (c) => {
  try {
    await deleteKnowledge(c.req.param('id'))
    return success(c, { id: c.req.param('id') })
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
})

export default app
