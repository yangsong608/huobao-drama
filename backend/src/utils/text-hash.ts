import { createHash } from 'node:crypto'

/** 换行与行内空白归一，避免同内容因排版差异产生不同 hash */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim()
}

export function contentHash(input: string): string {
  return createHash('sha256').update(normalizeText(input)).digest('hex')
}

/** 中文按非空白字符计数，与导入时的 char_count 口径一致 */
export function countWords(input: string): number {
  return input.replace(/\s+/g, '').length
}
