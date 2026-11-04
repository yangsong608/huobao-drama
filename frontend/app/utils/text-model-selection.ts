interface TextModelOption {
  key: string
  model: string
  configId: number
  provider?: string
}

/** 默认项显示 options[0]，请求也必须使用同一模型及其配置，避免后端再次选型。 */
export function resolveTextModelSelection(options: TextModelOption[], selectedKey: string) {
  const legacy = String(selectedKey || '').split('#')[0]
  const bare = legacy.includes('/') ? legacy.slice(legacy.indexOf('/') + 1) : legacy
  const selected = options.find(option => option.key === selectedKey)
    ?? options.find(option => option.model === selectedKey) // 兼容旧版存储的裸模型名
    ?? options.find(option => `${option.provider}/${option.model}` === legacy) // 兼容旧版 'provider/model'
    ?? options.find(option => option.model === bare)
    ?? options[0]
  return { model: selected?.model, configId: selected?.configId }
}
