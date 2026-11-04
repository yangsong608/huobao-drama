/**
 * MCP 配置路由 — 设置页读写开关、端口与访问 token
 */
import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { applyMcpConfig, getMcpStatus, rotateMcpToken } from '../services/mcp.js'

const app = new Hono()

// GET /mcp — 当前状态（enabled / running / port / url / token / tool_count / error）
app.get('/', async (c) => success(c, getMcpStatus()))

// PUT /mcp — 开关或改端口（body: { enabled?: boolean, port?: number }）
app.put('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') return badRequest(c, '请求体必须是 JSON 对象')
  const patch: { enabled?: boolean; port?: number } = {}
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
  if (body.port !== undefined) {
    const port = Number(body.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return badRequest(c, '端口必须是 1024-65535 之间的整数')
    patch.port = port
  }
  const status = await applyMcpConfig(patch)
  if (status.error) return badRequest(c, status.error)
  return success(c, status)
})

// POST /mcp/token — 重新生成访问 token（旧 token 立即失效）
app.post('/token', async (c) => {
  const token = rotateMcpToken()
  return success(c, { ...getMcpStatus(), token })
})

export default app
