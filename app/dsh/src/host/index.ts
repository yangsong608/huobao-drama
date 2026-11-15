import { ensureConfig, tasksFile } from '../shared/config.js'
import { startAgentTask, getAgentTask, listAgentTasks, cancelAgentTask, type AgentsService } from './agent-bridge.js'
import { buildHealth } from './health.js'
import { startBridgeServer, type BridgeServer, type BridgeHandlers } from './bridge-server.js'
import { createBridgeToken, removeBridgeDescriptor, writeBridgeDescriptor } from './descriptor.js'
import { createLogger, type Logger } from './logger.js'
import { handleLlmChat, type LlmService } from './llm-bridge.js'
import { TaskRegistry } from './task-registry.js'

export const PLUGIN_VERSION = '0.1.0'

/** 服务通过 ctx.get(name, false) 可选获取；没有 LLM/Agent 时插件仍可加载并报告健康状态。 */
export const inject: string[] = []

interface HostContext {
  effect?: (callback: () => (() => void) | void, label?: string) => unknown
  get?: (name: string, strict?: boolean) => unknown
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
    error?: (message: string) => void
  }
  llm?: unknown
  agents?: unknown
  tools?: unknown
}

function getService<T>(ctx: HostContext, name: string): T | undefined {
  const fromGet = typeof ctx.get === 'function' ? ctx.get(name, false) : undefined
  if (fromGet !== undefined && fromGet !== null) return fromGet as T
  const direct = (ctx as unknown as Record<string, unknown>)[name]
  return direct === undefined || direct === null ? undefined : direct as T
}

function dshVersion(ctx: HostContext): string {
  const fromGet = typeof ctx.get === 'function' ? ctx.get('version', false) : undefined
  if (typeof fromGet === 'string' && fromGet.trim() !== '') return fromGet
  if (typeof process.env.DSH_VERSION === 'string' && process.env.DSH_VERSION.trim() !== '') {
    return process.env.DSH_VERSION
  }
  return 'unknown'
}

function registerCleanup(ctx: HostContext, logger: Logger, cleanup: () => Promise<void>): void {
  let done = false
  const run = (): void => {
    if (done) return
    done = true
    void cleanup().catch(cause => logger.warn(`清理失败：${cause instanceof Error ? cause.message : String(cause)}`))
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        run()
      }, 'moss-huobao: bridge')
      return
    } catch (cause) {
      logger.warn(`ctx.effect 注册失败，改用进程退出清理：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  process.once('exit', run)
}

export async function apply(ctx: HostContext, rawConfig?: unknown): Promise<void> {
  void rawConfig
  const logger = createLogger(ctx)
  const loaded = ensureConfig()
  for (const warning of loaded.warnings) logger.warn(`配置告警：${warning}`)
  const config = loaded.config

  const registry = new TaskRegistry(tasksFile(), logger)
  registry.load()

  const llm = getService<LlmService>(ctx, 'llm')
  const agents = getService<AgentsService>(ctx, 'agents')
  if (llm === undefined) logger.warn('DSH LLM 服务不可用；LLM 桥将返回 BRIDGE_UNAVAILABLE')
  if (agents === undefined) logger.warn('DSH Agent 服务不可用；Agent 桥将返回 BRIDGE_UNAVAILABLE')

  const token = createBridgeToken()
  let server: BridgeServer | null = null
  const handlers: BridgeHandlers = {
    health: () => buildHealth({
      registry,
      config,
      llm,
      agents,
      port: server?.port ?? 0,
      pluginVersion: PLUGIN_VERSION,
      dshVersion: dshVersion(ctx),
    }),
    llmChat: body => handleLlmChat(body, { llm, config }),
    startAgentTask: body => startAgentTask(body, { agents, config, registry, logger }),
    getAgentTask: id => getAgentTask(id, registry),
    cancelAgentTask: id => cancelAgentTask(id, registry),
    listAgentTasks: () => listAgentTasks(registry),
  }

  try {
    server = await startBridgeServer({ token, logger, handlers })
  } catch (cause) {
    logger.error(`桥接服务启动失败，插件不提供桥接：${cause instanceof Error ? cause.message : String(cause)}`)
    return
  }

  try {
    writeBridgeDescriptor({
      bridgeBaseUrl: `http://127.0.0.1:${server.port}/moss-huobao`,
      token,
      pluginVersion: PLUGIN_VERSION,
      dshVersion: dshVersion(ctx),
      startedAt: new Date().toISOString(),
    })
  } catch (cause) {
    logger.error(`桥描述文件写入失败，插件不提供桥接：${cause instanceof Error ? cause.message : String(cause)}`)
    await server.close()
    return
  }
  logger.info(`桥接已启动：http://127.0.0.1:${server.port}/moss-huobao`)

  registerCleanup(ctx, logger, async () => {
    await registry.disposeHandles()
    registry.persist()
    removeBridgeDescriptor()
    if (server !== null) await server.close()
    logger.info('桥接已停止')
  })
}
