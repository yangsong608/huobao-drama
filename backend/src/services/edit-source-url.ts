/**
 * 剪辑素材地址规范化（技术设计 §4.7、§6.3）。
 * 只允许站内相对地址与 `/static/...` 站点内部地址，拒绝远程/绝对/越界路径。
 * 纯函数、无 IO，供计划归一化与 storage 解析共用同一套校验。
 */
export class EditSourceUrlError extends Error {}

const REMOTE_SCHEME = /^(https?:|data:|blob:)/i
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/

function validate(raw: unknown): { value: string; relative: string } {
  const value = String(raw ?? '').trim()
  if (!value) throw new EditSourceUrlError('媒体地址为空')
  if (REMOTE_SCHEME.test(value)) throw new EditSourceUrlError(`不支持远程媒体：${value}`)
  // 盘符路径优先判定为绝对路径（C:\... 同时含反斜杠），再统一拒绝反斜杠
  if (WINDOWS_DRIVE.test(value)) throw new EditSourceUrlError(`不支持绝对路径：${value}`)
  if (value.includes('\\')) throw new EditSourceUrlError(`不支持的媒体路径：${value}`)

  // 站点内部地址（/static/...）允许保留一个前导斜杠，其余绝对路径一律拒绝
  let relative = value
  if (relative.startsWith('/static/')) relative = relative.slice(1)
  else if (relative.startsWith('/')) throw new EditSourceUrlError(`不支持绝对路径：${value}`)

  // 逐段校验，禁止空段、. 与 ..，防止跳出存储根目录
  const segments = relative.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new EditSourceUrlError(`不支持的媒体路径：${value}`)
  }
  return { value, relative }
}

/** 只做语法与越界校验，保留调用方原有前导斜杠形式，避免无意义哈希变化。 */
export function normalizeEditSourceUrl(raw: unknown): string {
  return validate(raw).value
}

/** 供 storage 解析使用：始终返回 `static/...` 相对路径。 */
export function editSourceRelativePath(raw: unknown): string {
  return validate(raw).relative
}
