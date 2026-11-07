import { computed, ref, shallowRef } from 'vue'
import { novelAPI } from './useNovelApi'

export interface WorkbenchChapter {
  chapter_no: number
  title: string
  status: string
  word_count: number
  has_content: boolean
  summary: string
}

export interface WorkbenchAnnotation {
  id: number
  chapter_no: number
  quote: string
  note: string
  kind: string
  status: string
  start_offset: number
  end_offset: number
  prefix: string
  suffix: string
  created_at?: string
  updated_at?: string
}

export interface NovelSelection {
  start: number
  end: number
  quote: string
  prefix: string
  suffix: string
}

type WorkbenchLayout = 'split' | 'tabs'

function normalizeLayout(value: unknown): WorkbenchLayout {
  return value === 'tabs' ? 'tabs' : 'split'
}

export function useNovelWorkbench(novelId: number) {
  const loading = ref(false)
  const error = ref('')
  const data = shallowRef<any>(null)
  const configuredLayout = ref<WorkbenchLayout | null>(null)

  const chapters = computed<WorkbenchChapter[]>(() => data.value?.chapters || [])
  const annotations = computed<WorkbenchAnnotation[]>(() => data.value?.annotations || [])
  const counts = computed(() => data.value?.counts || {})
  const settings = computed(() => data.value?.settings || {})
  const layout = computed<WorkbenchLayout>(() =>
    configuredLayout.value ?? normalizeLayout(data.value?.layout),
  )
  const layoutReady = computed(() => configuredLayout.value !== null)
  const treeVisible = computed(() => data.value?.tree !== false)

  async function resolveLayout(): Promise<WorkbenchLayout> {
    if (configuredLayout.value) return configuredLayout.value
    try {
      const payload = await novelAPI.settings()
      configuredLayout.value = normalizeLayout(payload?.settings?.workbench?.layout)
    } catch {
      // 设置读取失败时退回聚合接口自带的 layout，不阻塞写作
      configuredLayout.value = normalizeLayout(data.value?.layout)
    }
    return configuredLayout.value
  }

  function setLayout(next: WorkbenchLayout): void {
    configuredLayout.value = next
  }

  async function load() {
    if (!Number.isSafeInteger(novelId) || novelId <= 0) return
    loading.value = true
    error.value = ''
    try {
      const target = await resolveLayout()
      if (target === 'tabs') {
        data.value = null
        return
      }
      data.value = await novelAPI.workbench(novelId)
      configuredLayout.value = normalizeLayout(data.value?.layout)
    } catch (err: any) {
      error.value = err?.message || String(err)
    } finally {
      loading.value = false
    }
  }

  return {
    loading,
    error,
    data,
    chapters,
    annotations,
    counts,
    settings,
    layout,
    layoutReady,
    treeVisible,
    load,
    setLayout,
  }
}
