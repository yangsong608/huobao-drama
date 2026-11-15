export type BridgeErrorCode =
  | 'BRIDGE_UNAVAILABLE'
  | 'MODEL_NOT_CONFIGURED'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'INVALID_REQUEST'
  | 'UPSTREAM_ERROR'
  | 'INVALID_OUTPUT'
  | 'INCOMPLETE_OUTPUT'
  | 'BUSY'
  | 'NOT_FOUND'
  | 'ABORTED'

const STATUS_BY_CODE: Record<BridgeErrorCode, number> = {
  BRIDGE_UNAVAILABLE: 503,
  MODEL_NOT_CONFIGURED: 503,
  AUTH: 401,
  RATE_LIMIT: 429,
  TIMEOUT: 504,
  INVALID_REQUEST: 400,
  UPSTREAM_ERROR: 502,
  INVALID_OUTPUT: 502,
  INCOMPLETE_OUTPUT: 502,
  BUSY: 429,
  NOT_FOUND: 404,
  ABORTED: 499,
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode
  readonly status: number

  constructor(code: BridgeErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.status = status ?? STATUS_BY_CODE[code]
  }
}

export function asBridgeError(cause: unknown, fallback: BridgeErrorCode = 'UPSTREAM_ERROR'): BridgeError {
  if (cause instanceof BridgeError) return cause
  return new BridgeError(fallback, cause instanceof Error ? cause.message : String(cause))
}
