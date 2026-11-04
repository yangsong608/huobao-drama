/**
 * 流水线任务规则（提示词）读写 — 设置页「流程规则」使用
 * 规则存 app_settings（pipeline.rule.<key>），未自定义时回落到代码默认值
 */
import { Hono } from 'hono'
import { success, badRequest, notFound } from '../utils/response.js'
import { isRuleKey, listPipelineRules, resetPipelineRule, setPipelineRule } from '../services/pipeline-rules.js'

const app = new Hono()

// GET /pipeline-rules — 全部规则（含默认值与是否已自定义）
app.get('/', async (c) => {
  return success(c, listPipelineRules())
})

// PUT /pipeline-rules/:key — 保存；空字符串表示恢复默认
app.put('/:key', async (c) => {
  const key = c.req.param('key')
  if (!isRuleKey(key)) return badRequest(c, '未知的规则类型')
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.rule !== 'string' && typeof body.value !== 'string') return badRequest(c, 'rule 必须是字符串')
  try {
    const rule = setPipelineRule(key, body.rule ?? body.value)
    return success(c, { key, rule, is_default: !String(body.rule ?? body.value ?? '').trim() })
  } catch (error: any) {
    return badRequest(c, error?.message || '保存失败')
  }
})

// POST /pipeline-rules/:key/reset — 恢复默认
app.post('/:key/reset', async (c) => {
  const key = c.req.param('key')
  if (!isRuleKey(key)) return notFound(c, '未知的规则类型')
  const rule = resetPipelineRule(key)
  return success(c, { key, rule, is_default: true })
})

export default app
