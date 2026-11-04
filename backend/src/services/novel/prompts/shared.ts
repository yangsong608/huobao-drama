export class NovelPromptParamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NovelPromptParamError'
  }
}

export function text(value: unknown, field: string): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new NovelPromptParamError(`${field} 必须是字符串`)
}

export function requireNumber(value: unknown, field: string): number {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    throw new NovelPromptParamError(`${field} 必须是数字`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new NovelPromptParamError(`${field} 必须是数字`)
  return parsed
}

export function formatGenre(genre: unknown): string {
  if (Array.isArray(genre)) return genre.map((item) => text(item, 'genre')).join(' / ')
  return text(genre, 'genre')
}

export function requireArray<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) throw new NovelPromptParamError(`${field} 必须是数组`)
  return value as T[]
}

/** 文风支持 {key,name,prompt} 快照或纯文本；空值返回空串，由调用方决定兜底文案 */
export function formatWritingStyle(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value !== 'object' || Array.isArray(value)) return ''
  const style = value as Record<string, unknown>
  const name = typeof style.name === 'string' ? style.name.trim() : ''
  const prompt = typeof style.prompt === 'string' ? style.prompt.trim() : ''
  if (name && prompt) return `${name}：${prompt}`
  return prompt || name
}
