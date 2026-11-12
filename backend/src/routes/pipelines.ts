/**
 * 链式分镜流水线 API — 模板、步骤、规则包、运行与 trace。
 */
import { Hono } from 'hono'
import { success, badRequest, notFound } from '../utils/response.js'
import {
  getPipelineChainView,
  listPipelineChains,
  listPipelinePlugins,
  listPipelineRulePacks,
  resetChainOverride,
  saveChainOverride,
  type PipelineOverrideScope,
} from '../services/pipeline-chain.js'
import {
  createStoryboardPipelineJob,
  getLatestStoryboardPipelineJob,
  getStoryboardPipelineJob,
  getStoryboardPipelineTrace,
  pauseStoryboardPipelineJob,
  resumeStoryboardPipelineJob,
  rerunStoryboardPipelineSound,
  skipStoryboardPipelineShot,
} from '../services/storyboard-pipeline.js'

const app = new Hono()

function scopeFrom(value: unknown): PipelineOverrideScope {
  const scope = String(value || 'global')
  return ['global', 'project', 'episode'].includes(scope) ? scope as PipelineOverrideScope : 'global'
}

function scopeIdFrom(value: unknown): number {
  const id = Number(value || 0)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : '操作失败'
}

app.get('/chains', async (c) => {
  const scopeType = scopeFrom(c.req.query('scope_type'))
  const scopeId = scopeIdFrom(c.req.query('scope_id'))
  const list = listPipelineChains().map(item => {
    const view = getPipelineChainView(item.key, scopeType, scopeId)
    return {
      ...item,
      steps: view?.steps || [],
      parameters: view?.parameters || [],
      overrides: view?.overrides || {},
    }
  })
  return success(c, { list })
})

app.get('/chains/:key', async (c) => {
  const key = c.req.param('key')
  const scopeType = scopeFrom(c.req.query('scope_type'))
  const scopeId = scopeIdFrom(c.req.query('scope_id'))
  const view = getPipelineChainView(key, scopeType, scopeId)
  if (!view) return notFound(c, '分镜流水线模板不存在')
  return success(c, view)
})

app.put('/chains/:key/overrides', async (c) => {
  const key = c.req.param('key')
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  try {
    const saved = saveChainOverride({
      chainKey: key,
      scopeType: scopeFrom(body.scope_type),
      scopeId: scopeIdFrom(body.scope_id),
      parameters: body.parameters as Record<string, unknown> | undefined,
      stepToggles: body.step_toggles as Record<string, boolean> | undefined,
      knowledgeRefs: body.knowledge_refs as Record<string, string[]> | undefined,
    })
    const view = getPipelineChainView(key, scopeFrom(body.scope_type), scopeIdFrom(body.scope_id))
    return success(c, { overrides: saved, chain: view })
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

app.delete('/chains/:key/overrides', async (c) => {
  const key = c.req.param('key')
  const scopeType = scopeFrom(c.req.query('scope_type'))
  const scopeId = scopeIdFrom(c.req.query('scope_id'))
  resetChainOverride(key, scopeType, scopeId)
  return success(c, getPipelineChainView(key, scopeType, scopeId))
})

app.get('/plugins', async (c) => {
  return success(c, { list: listPipelinePlugins() })
})

app.get('/rule-packs', async (c) => {
  return success(c, { list: listPipelineRulePacks() })
})

app.get('/runs/latest/:episodeId', async (c) => {
  return success(c, { job: getLatestStoryboardPipelineJob(Number(c.req.param('episodeId'))) })
})

app.get('/runs/:id', async (c) => {
  const job = getStoryboardPipelineJob(Number(c.req.param('id')))
  if (!job) return notFound(c, '分镜流水线运行不存在')
  return success(c, { job })
})

app.get('/runs/:id/trace', async (c) => {
  const trace = getStoryboardPipelineTrace(Number(c.req.param('id')))
  if (!trace) return notFound(c, '分镜流水线运行不存在')
  return success(c, trace)
})

app.post('/runs', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  try {
    const result = await createStoryboardPipelineJob({
      episodeId: Number(body.episode_id),
      dramaId: Number(body.drama_id),
      message: String(body.message || ''),
      model: body.model ? String(body.model) : undefined,
      configId: body.config_id ? Number(body.config_id) : undefined,
      chainKey: body.chain_key ? String(body.chain_key) : undefined,
      parameters: body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters)
        ? body.parameters as Record<string, unknown>
        : undefined,
    })
    return success(c, { job: result.job, already_running: result.alreadyRunning })
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

app.post('/runs/:id/pause', async (c) => {
  try {
    return success(c, { job: pauseStoryboardPipelineJob(Number(c.req.param('id'))) })
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

app.post('/runs/:id/resume', async (c) => {
  try {
    return success(c, { job: await resumeStoryboardPipelineJob(Number(c.req.param('id'))) })
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

app.post('/runs/:id/continue', async (c) => {
  try {
    return success(c, { job: await resumeStoryboardPipelineJob(Number(c.req.param('id'))) })
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

app.post('/runs/:id/skip-shot', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  try {
    return success(c, {
      job: await skipStoryboardPipelineShot(
        Number(c.req.param('id')),
        Number(body.shot_number),
        body.reason ? String(body.reason) : undefined,
      ),
    })
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

app.post('/runs/:id/rerun-sound', async (c) => {
  try {
    return success(c, { job: await rerunStoryboardPipelineSound(Number(c.req.param('id'))) })
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

export default app
