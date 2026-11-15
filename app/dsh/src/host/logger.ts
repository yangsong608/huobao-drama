export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

interface HostLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

export function createLogger(ctx: unknown): Logger {
  const candidate = (ctx as { logger?: HostLogger } | null)?.logger
  const prefix = '[dsh-moss-huobao]'
  const write = (level: 'info' | 'warn' | 'error', message: string): void => {
    const fn = candidate?.[level]
    if (typeof fn === 'function') {
      try {
        fn.call(candidate, message)
        return
      } catch {
        /* fall through to console */
      }
    }
    const line = `${prefix} ${message}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    info: message => write('info', message),
    warn: message => write('warn', message),
    error: message => write('error', message),
  }
}
