import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { novelAPI, type NovelListParams } from '~/composables/useNovelApi'
import type { GraphSnapshot, NovelGraphData } from '~/utils/novel-graph'

/** 后端历史约定为 snake_case；小说模块统一在 store 内转 camelCase */
export function camelizeKeys<T = any>(value: any): T {
  if (Array.isArray(value)) return value.map((item) => camelizeKeys(item)) as T
  if (value && typeof value === 'object') {
    const result: Record<string, any> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())] = camelizeKeys(item)
    }
    return result as T
  }
  return value as T
}

export const useNovelStore = defineStore('novel', () => {
  const list = ref<any[]>([])
  const pagination = ref({ page: 1, pageSize: 20, total: 0, totalPages: 0 })
  const current = ref<any | null>(null)
  const graph = ref<NovelGraphData | null>(null)
  const chapterGraphs = ref<Record<string, GraphSnapshot>>({})
  const graphLoading = ref(false)
  const job = ref<any | null>(null)
  const settings = ref<any | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  const hasNovels = computed(() => list.value.length > 0)

  async function fetchList(params: NovelListParams = {}) {
    loading.value = true
    error.value = null
    try {
      const data: any = await novelAPI.list(params)
      list.value = camelizeKeys<any[]>(data?.items ?? [])
      pagination.value = camelizeKeys(data?.pagination ?? pagination.value)
      return list.value
    } catch (err: any) {
      error.value = err?.message || '加载小说列表失败'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchNovel(id: number) {
    loading.value = true
    error.value = null
    try {
      current.value = camelizeKeys(await novelAPI.get(id))
      return current.value
    } catch (err: any) {
      error.value = err?.message || '加载小说失败'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function createNovel(payload: Record<string, unknown>) {
    saving.value = true
    error.value = null
    try {
      const created = camelizeKeys(await novelAPI.create(payload))
      list.value = [created, ...list.value]
      pagination.value.total += 1
      return created
    } catch (err: any) {
      error.value = err?.message || '创建小说失败'
      throw err
    } finally {
      saving.value = false
    }
  }

  async function updateNovel(id: number, patch: Record<string, unknown>) {
    saving.value = true
    error.value = null
    try {
      const updated = camelizeKeys(await novelAPI.update(id, patch))
      const index = list.value.findIndex((item) => item.id === id)
      if (index >= 0) list.value[index] = { ...list.value[index], ...updated }
      if (current.value?.id === id) current.value = { ...current.value, ...updated }
      return updated
    } catch (err: any) {
      error.value = err?.message || '保存小说失败'
      throw err
    } finally {
      saving.value = false
    }
  }

  async function deleteNovel(id: number) {
    saving.value = true
    error.value = null
    try {
      await novelAPI.remove(id)
      list.value = list.value.filter((item) => item.id !== id)
      pagination.value.total = Math.max(0, pagination.value.total - 1)
      if (current.value?.id === id) current.value = null
    } catch (err: any) {
      error.value = err?.message || '删除小说失败'
      throw err
    } finally {
      saving.value = false
    }
  }

  async function saveChapter(id: number, chapterNo: number, patch: Record<string, unknown>) {
    saving.value = true
    error.value = null
    try {
      const saved = camelizeKeys(await novelAPI.saveChapter(id, chapterNo, patch))
      if (current.value?.id === id) {
        const chapters = Array.isArray(current.value.chapters) ? [...current.value.chapters] : []
        const index = chapters.findIndex((item) => item.chapterNo === chapterNo)
        if (index >= 0) chapters[index] = { ...chapters[index], ...saved }
        else chapters.push(saved)
        chapters.sort((a, b) => a.chapterNo - b.chapterNo)
        current.value = { ...current.value, chapters }
      }
      return saved
    } catch (err: any) {
      error.value = err?.message || '保存章节失败'
      throw err
    } finally {
      saving.value = false
    }
  }

  async function fetchGraph(id: number) {
    graphLoading.value = true
    error.value = null
    try {
      const data: any = await novelAPI.graph(id)
      const payload = camelizeKeys<any>(data || {})
      graph.value = payload?.graphData ?? null
      chapterGraphs.value = payload?.chapterGraphs ?? {}
      return { graphData: graph.value, chapterGraphs: chapterGraphs.value }
    } catch (err: any) {
      error.value = err?.message || '加载图谱失败'
      throw err
    } finally {
      graphLoading.value = false
    }
  }

  async function saveGraph(
    id: number,
    payload: { graphData?: NovelGraphData; chapterGraphs?: Record<string, GraphSnapshot> },
  ) {
    saving.value = true
    error.value = null
    try {
      const data: any = await novelAPI.saveGraph(id, payload)
      const saved = camelizeKeys<any>(data || {})
      if (saved?.graphData !== undefined) graph.value = saved.graphData
      if (saved?.chapterGraphs !== undefined) chapterGraphs.value = saved.chapterGraphs || {}
      return saved
    } catch (err: any) {
      error.value = err?.message || '保存图谱失败'
      throw err
    } finally {
      saving.value = false
    }
  }

  async function saveStoryAtlas(id: number, payload: Record<string, unknown>) {
    saving.value = true
    error.value = null
    try {
      const saved = camelizeKeys<any>(await novelAPI.saveStoryAtlas(id, payload))
      if (current.value?.id === id) {
        current.value = {
          ...current.value,
          timelineEvents: saved.timelineEvents ?? current.value.timelineEvents,
          worldMap: saved.worldMap ?? current.value.worldMap,
          updatedAt: saved.updatedAt || current.value.updatedAt,
        }
      }
      return saved
    } catch (err: any) {
      error.value = err?.message || '保存故事坐标失败'
      throw err
    } finally {
      saving.value = false
    }
  }

  async function updateNarration(id: number, chapterNo: number, narration: string) {
    saving.value = true
    try {
      const saved = camelizeKeys<any>(await novelAPI.updateBlueprintNarration(id, chapterNo, narration))
      if (current.value?.id === id) {
        const chapters = (current.value.blueprintChapters || []).map((chapter: any) =>
          chapter.number === chapterNo ? { ...chapter, narration: saved.chapter?.narration || '' } : chapter)
        current.value = {
          ...current.value,
          blueprintChapters: chapters,
          chapterBlueprint: saved.chapterBlueprint || current.value.chapterBlueprint,
          updatedAt: saved.updatedAt || current.value.updatedAt,
        }
      }
      return saved
    } finally {
      saving.value = false
    }
  }

  async function fetchSettings() {
    settings.value = camelizeKeys((await novelAPI.settings())?.settings ?? null)
    return settings.value
  }

  async function saveSettings(patch: Record<string, unknown>) {
    saving.value = true
    try {
      settings.value = camelizeKeys((await novelAPI.saveSettings(patch))?.settings ?? null)
      return settings.value
    } finally {
      saving.value = false
    }
  }

  return {
    list,
    pagination,
    current,
    graph,
    chapterGraphs,
    graphLoading,
    job,
    settings,
    loading,
    saving,
    error,
    hasNovels,
    fetchList,
    fetchNovel,
    createNovel,
    updateNovel,
    deleteNovel,
    saveChapter,
    fetchGraph,
    saveGraph,
    saveStoryAtlas,
    updateNarration,
    fetchSettings,
    saveSettings,
  }
})
