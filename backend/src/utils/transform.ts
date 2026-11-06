/**
 * 将 Drizzle 返回的 camelCase 对象转换为 snake_case
 * 保持前端 API 兼容（和旧 Go 后端一致）
 */
export function toSnakeCase(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    result[snakeKey] = value
  }
  return result
}

export function toSnakeCaseArray(arr: Record<string, any>[]): Record<string, any>[] {
  return arr.map(toSnakeCase)
}

/**
 * ComfyUI 整集任务的 params 内嵌完整工作流与时间线（数十 KB），
 * 而任务列表/轮询只需 comfyTimeline 标记与轻量元数据。
 * 返回副本，不影响数据库中的原始 params。
 */
export function slimTaskParams<T extends { params?: string | null }>(task: T): T {
  if (!task?.params) return task
  let parsed: any
  try {
    parsed = JSON.parse(task.params)
  } catch {
    return task
  }
  const timeline = parsed?.comfyTimeline
  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) return task
  const slim = { ...timeline }
  delete slim.workflow
  delete slim.timelineData
  return { ...task, params: JSON.stringify({ ...parsed, comfyTimeline: slim }) }
}
