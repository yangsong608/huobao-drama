/**
 * 每标签页客户端标识：只用于同步事件来源与自事件忽略，不作为鉴权。
 *
 * 优先 sessionStorage；不可用（隐私模式/存储被禁用）时回退模块级内存。
 * 不写 localStorage，也不进入 URL；服务端只接受 [A-Za-z0-9._:-]{1,64}。
 */
const STORAGE_KEY = 'huobao:client-id'
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/

let memoryClientId: string | null = null

function createClientId(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function getClientId(): string {
  if (memoryClientId) return memoryClientId

  try {
    const stored = sessionStorage.getItem(STORAGE_KEY)
    if (stored && CLIENT_ID_RE.test(stored)) {
      memoryClientId = stored
      return stored
    }
  } catch {
    /* sessionStorage 不可用时回退内存 */
  }

  memoryClientId = createClientId()
  try {
    sessionStorage.setItem(STORAGE_KEY, memoryClientId)
  } catch {
    /* 忽略持久化失败 */
  }
  return memoryClientId
}

export function useClientId(): string {
  return getClientId()
}

/** 测试用：重置内存缓存（sessionStorage 中的值仍会被重新读取） */
export function __resetClientIdForTests(): void {
  memoryClientId = null
}
