import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { isOfficialProvider, parseConfigSettings, parseConfigTemperature } from '../services/ai.js'
import { buildCloudSpeechRequest, type CloudTtsSettings } from '../services/adapters/cloud-tts.js'
import { redactUrl, logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

/** 归一化 temperature 入参：null=未设置；合法值 0~2；非法抛错 */
function normalizeTemperature(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('invalid temperature')
  return n
}

function parseSettingsObject(raw: string | null | undefined): Record<string, any> {
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** provider 专属配置：接受对象或 JSON 字符串；限制体积，避免把整段工作流日志写爆 */
function normalizeProviderSettings(value: any): Record<string, any> {
  let obj = value
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value)
    } catch {
      throw new Error('invalid settings')
    }
  }
  if (obj === null || obj === undefined) return {}
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('invalid settings')
  const serialized = JSON.stringify(obj)
  if (serialized.length > 200_000) throw new Error('settings too large')
  return obj as Record<string, any>
}

/** 各 provider 的最低配置要求（在保存时拦截，避免生成时才报错） */
function validateProviderSettings(serviceType: string, provider: string, settings: Record<string, any>) {
  if (provider === 'comfyui' && (serviceType === 'image' || serviceType === 'video')) {
    const workflow = settings.workflow
    if (!workflow) throw new Error('ComfyUI 需要 workflow（API 格式工作流 JSON）')
    if (typeof workflow === 'string') {
      let parsed: unknown
      try {
        parsed = JSON.parse(workflow)
      } catch {
        throw new Error('ComfyUI workflow 不是合法 JSON')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('ComfyUI workflow 必须是节点对象')
      }
    } else if (typeof workflow !== 'object' || Array.isArray(workflow)) {
      throw new Error('ComfyUI workflow 必须是节点对象')
    }
  }
}

/** 把 settings JSON 中的 temperature 透出为顶层字段，便于前端直接读写 */
function withParsedFields(r: any) {
  return {
    ...toSnakeCase(r),
    model: r.model ? JSON.parse(r.model) : [],
    temperature: parseConfigTemperature(r.settings),
    provider_settings: parseConfigSettings(r.settings),
  }
}

function bearerHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function geminiHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey
  }
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

/** 语音探针成功判定：返回二进制音频或厂商 JSON 中的音频字段才算成功 */
/** 语音探针 HTTP 200 但响应体是厂商错误时，提取可读原因 */
function audioProbeFailureMessage(text: string): string | null {
  if (!text) return null
  try {
    const json = JSON.parse(text)
    const header = json?.header
    const rawCode = header?.code ?? json?.code
    const code = rawCode === undefined || rawCode === null ? null : Number(rawCode)
    const detail = header?.message ?? header?.msg ?? json?.message
    if (!Number.isFinite(code) || code === 0 || code === 20_000_000) return null
    if (code === 45_000_010) {
      return `[${code}] ${detail || '语音合成失败'}：API Key 无效或未开通豆包语音。新版控制台请使用「语音技术控制台 → API Key 管理」创建的 Key；旧版控制台请填写 App ID + Access Token`
    }
    return `[${code}] ${detail || '语音合成失败'}`
  } catch {
    return null
  }
}

function audioProbeSucceeded(contentType: string, text: string): boolean {
  if (contentType.includes('audio/')) return true

  const parse = (payload: string) => {
    try {
      return JSON.parse(payload)
    } catch {
      return null
    }
  }

  const single = parse(text)
  if (single) {
    const code = single?.code === undefined || single?.code === null ? null : Number(single.code)
    if (code !== null && code !== 0 && code !== 20_000_000) return false
    if (code === 20_000_000) return true
    if (single?.output?.audio || single?.output?.audio_url || single?.audio) return true
    if (typeof single?.data === 'string' && single.data) return true
    return false
  }

  // 豆包 v3 单向流式：多行 JSON / SSE
  let sawAudio = false
  for (const line of text.split(/\r?\n/)) {
    const payload = line.trim().replace(/^data:\s*/, '')
    if (!payload || payload === '[DONE]') continue
    const item = parse(payload)
    if (!item) continue
    const code = item?.code === undefined || item?.code === null ? null : Number(item.code)
    if (code === 20_000_000) return true
    if (code !== null && code !== 0) return false
    if (typeof item?.data === 'string' && item.data) sawAudio = true
  }
  return sawAudio
}

interface ProbeSpec {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
  /** 语音探针：用真实短文本合成，校验返回音频而非只校验连通性 */
  audioProbe?: boolean
}

/** 语音探针的默认音色：用户未配置默认音色时用于验证端点/鉴权/模型 */
function audioProbeVoice(provider: string, model: string, settings: Record<string, any>): string {
  if (typeof settings.defaultVoiceId === 'string' && settings.defaultVoiceId) return settings.defaultVoiceId
  if (provider === 'aliyun') return /qwen[\w.-]*tts/i.test(model) ? 'Cherry' : 'longxiaochun_v2'
  if (provider === 'volcengine') return 'zh_female_vv_uranus_bigtts'
  return 'alloy'
}

function buildAudioProbe(
  provider: string,
  baseUrl: string,
  model: string,
  apiKey?: string,
  settings: Record<string, any> = {},
): ProbeSpec {
  const built = buildCloudSpeechRequest(
    {
      provider,
      baseUrl,
      apiKey: apiKey || '',
      model,
      settings: {
        ...(settings as CloudTtsSettings),
        defaultVoiceId: audioProbeVoice(provider, model, settings),
      },
    },
    { text: '你好' },
  )
  return {
    method: 'POST',
    url: built.url,
    headers: built.init.headers as Record<string, string>,
    body: built.init.body,
    audioProbe: true,
  }
}

function buildProbe(
  serviceType: string,
  provider: string,
  baseUrl: string,
  model?: string,
  apiKey?: string,
  settings: Record<string, any> = {},
): ProbeSpec {
  const p = provider.toLowerCase()
  const m = model || ''

  if (p === 'gemini') {
    // 探针统一走 generateContent:文本运行时(AI SDK)走的就是它,官方与中转站都支持;
    // interactions 端点很多中转站未配置,探它会误报 500。
    // 用最小合法请求体而非空体——空体在部分中转站会触发上游认证失败的误报
    const modelName = m || 'gemini-3.1-pro-preview'
    const url = new URL(joinProviderUrl(baseUrl, '/v1beta', `/models/${modelName}:generateContent`))
    if (apiKey) url.searchParams.set('key', apiKey)
    return {
      method: 'POST',
      url: url.toString(),
      headers: geminiHeaders(apiKey, true),
      body: { contents: [{ parts: [{ text: 'hi' }] }] },
    }
  }

  if (p === 'openai') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'volcengine') {
    if (serviceType === 'audio') {
      return buildAudioProbe(p, baseUrl, m, apiKey, settings)
    }
    const path = serviceType === 'video'
      ? '/contents/generations/tasks'
      : serviceType === 'text'
        ? '/chat/completions'
        : '/images/generations'
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v3', path),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'comfyui') {
    // ComfyUI 本地服务：system_stats 无副作用，可验证地址与鉴权
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '', '/system_stats'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'openai-compatible') {
    if (serviceType === 'audio') {
      // 合成走 /v1/audio/speech，探针必须打同一端点；/v1/models 不能证明语音可用
      return buildAudioProbe(p, baseUrl, m || 'tts-1', apiKey, settings)
    }
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'qwen3-tts') {
    // 本地语音服务：/health 返回模型、采样率与 clone/design 能力，不产生合成费用
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '', '/health'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'minimax') {
    // MiniMax 仅提供视频服务，空请求体探测鉴权/端点连通性
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/v2', '/video_generation'),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'aliyun') {
    if (serviceType === 'image') {
      // Qwen-Image / Wan 图片：多模态生成端点，空请求体不会产生计费
      return {
        method: 'POST',
        url: joinProviderUrl(baseUrl, '/api/v1', '/services/aigc/multimodal-generation/generation'),
        headers: bearerHeaders(apiKey, true),
        body: {},
      }
    }
    if (serviceType === 'audio') {
      // CosyVoice → SpeechSynthesizer；Qwen-TTS → 多模态生成。探针复用真实请求构建器
      return buildAudioProbe(p, baseUrl, m || 'cosyvoice-v2', apiKey, settings)
    }
    // Wan 2.x/3.0 仅支持异步提交；空请求体不会创建计费任务，仅用于验证地域端点与鉴权是否可达。
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v1', '/services/aigc/video-generation/video-synthesis'),
      headers: {
        ...bearerHeaders(apiKey, true),
        'X-DashScope-Async': 'enable',
      },
      body: {},
    }
  }

  return {
    method: 'GET',
    url: joinProviderUrl(baseUrl, '', m ? `/${m}` : '/'),
    headers: bearerHeaders(apiKey),
    body: undefined,
  }
}

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const serviceType = c.req.query('service_type')
  let rows = await db.select().from(schema.aiServiceConfigs)
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)

  const parsed = rows.map(withParsedFields)
  return success(c, parsed)
})

// POST /ai-configs
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type || !body.provider) {
    return badRequest(c, '需要 service_type 与 provider')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  let temperature: number | null = null
  if ('temperature' in body) {
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
  }

  let providerSettings: Record<string, any>
  try {
    providerSettings = normalizeProviderSettings(body.provider_settings ?? body.settings)
    validateProviderSettings(body.service_type, body.provider, providerSettings)
  } catch (error: any) {
    return badRequest(c, error.message || 'provider_settings 不合法')
  }
  if (temperature !== null) providerSettings.temperature = temperature

  const res = await db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: body.provider,
    name: body.name || `${body.provider}-${body.service_type}`,
    baseUrl: body.base_url || '',
    apiKey: body.api_key || '',
    model: JSON.stringify(body.model || []),
    priority: body.priority || 0,
    isActive: true,
    settings: Object.keys(providerSettings).length ? JSON.stringify(providerSettings) : null,
    createdAt: ts,
    updatedAt: ts,
  })

  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, getInsertId(res)))

  return created(c, withParsedFields(row))
})

// POST /ai-configs/test
app.post('/test', async (c) => {
  const body = await c.req.json()
  if (!body.service_type || !body.provider || !body.base_url) {
    return badRequest(c, '需要 service_type、provider 与 base_url')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const model = Array.isArray(body.model) ? body.model[0] : body.model
  let providerSettings: Record<string, any>
  try {
    providerSettings = normalizeProviderSettings(body.provider_settings ?? body.settings)
  } catch {
    return badRequest(c, 'provider_settings 须为 JSON 对象')
  }
  let probe: ProbeSpec
  try {
    probe = buildProbe(
      body.service_type,
      body.provider,
      body.base_url,
      model,
      body.api_key,
      providerSettings,
    )
  } catch (error: any) {
    logTaskError('AIConfig', 'probe-config-invalid', {
      provider: body.provider,
      error: error.message,
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: 'POST',
      url: redactUrl(body.base_url),
      message: error.message || '配置不完整',
      response_preview: '',
    })
  }
  const probeUrl = redactUrl(probe.url)

  logTaskProgress('AIConfig', 'probe-start', {
    serviceType: body.service_type,
    provider: body.provider,
    method: probe.method,
    url: probeUrl,
  })

  try {
    const resp = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: typeof probe.body === 'string' ? probe.body : probe.body ? JSON.stringify(probe.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    const contentType = (resp.headers.get('content-type') || '').toLowerCase()
    const buffer = Buffer.from(await resp.arrayBuffer())
    const isText = contentType.includes('json') || contentType.includes('text') || contentType.includes('stream')
    const text = isText ? buffer.toString('utf8') : ''
    const authFailed = resp.status === 401 || resp.status === 403
    const reachable = !authFailed && resp.status !== 404
    const audioOk = probe.audioProbe ? audioProbeSucceeded(contentType, text) : true
    const ok = resp.ok && audioOk
    let message: string
    if (authFailed) {
      message = `鉴权失败（HTTP ${resp.status}），请检查 API Key`
    } else if (!reachable) {
      message = '端点未按预期响应，请检查 Base URL 和代理前缀'
    } else if (probe.audioProbe && !audioOk) {
      message = audioProbeFailureMessage(text) || '端点已响应，但未返回可用音频，请检查模型、音色 ID 与资源 ID'
    } else if (probe.audioProbe) {
      message = '语音合成成功，认证与模型配置正常'
    } else if (resp.ok) {
      message = '端点可访问，认证与路径基本正常'
    } else {
      message = '端点已响应，请根据状态码判断认证或路径是否正确'
    }
    const payload = {
      ok,
      reachable,
      status: resp.status,
      status_text: resp.statusText,
      method: probe.method,
      url: probeUrl,
      message,
      response_preview: isText ? text.slice(0, 240) : `<${contentType || 'binary'}> ${buffer.length} bytes`,
    }
    if (reachable) {
      logTaskSuccess('AIConfig', 'probe-done', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    } else {
      logTaskError('AIConfig', 'probe-unexpected', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    }
    return success(c, payload)
  } catch (error: any) {
    logTaskError('AIConfig', 'probe-failed', {
      provider: body.provider,
      url: probeUrl,
      error: error.message,
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: probe.method,
      url: probeUrl,
      message: error.message || '请求失败',
      response_preview: '',
    })
  }
})

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!row) return notFound(c)
  return success(c, withParsedFields(row))
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [existing] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!existing) return notFound(c)

  const serviceType = 'service_type' in body ? body.service_type : existing.serviceType
  const provider = 'provider' in body ? body.provider : existing.provider
  if (!isOfficialProvider(serviceType, provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const updates: Record<string, any> = { updatedAt: now() }

  if ('service_type' in body) updates.serviceType = body.service_type
  if ('provider' in body) updates.provider = body.provider
  if ('name' in body) updates.name = body.name
  if ('base_url' in body) updates.baseUrl = body.base_url
  if ('api_key' in body) updates.apiKey = body.api_key
  if ('model' in body) updates.model = JSON.stringify(body.model)
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active

  const hasTemperature = 'temperature' in body
  const hasProviderSettings = 'provider_settings' in body || 'settings' in body
  const identityChanged =
    (updates.serviceType !== undefined && updates.serviceType !== existing.serviceType) ||
    (updates.provider !== undefined && updates.provider !== existing.provider)

  if (hasTemperature || hasProviderSettings || identityChanged) {
    let settings = parseSettingsObject(existing.settings)
    if (hasProviderSettings) {
      let incoming: Record<string, any>
      try {
        incoming = normalizeProviderSettings(body.provider_settings ?? body.settings)
      } catch (error: any) {
        return badRequest(c, error.message || 'provider_settings 不合法')
      }
      // 整包替换 provider 配置，但未显式传入 temperature 时保留原值
      const preservedTemperature = settings.temperature
      settings = incoming
      if (!hasTemperature && preservedTemperature !== undefined) settings.temperature = preservedTemperature
    }
    if (hasTemperature) {
      let temperature: number | null
      try {
        temperature = normalizeTemperature(body.temperature)
      } catch {
        return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
      }
      // 清空的 temperature 从 JSON 中移除
      if (temperature === null) delete settings.temperature
      else settings.temperature = temperature
    }
    try {
      validateProviderSettings(serviceType, provider, settings)
    } catch (error: any) {
      return badRequest(c, error.message || 'provider_settings 不合法')
    }
    updates.settings = Object.keys(settings).length ? JSON.stringify(settings) : null
  }

  await db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = await db.select().from(schema.aiServiceProviders)
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
