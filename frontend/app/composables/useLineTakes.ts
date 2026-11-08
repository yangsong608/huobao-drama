import {
  takeAPI,
  type LineContextPreview,
  type LineTake,
  type StoryboardLine,
  type TakeBatchJob,
  type TakeGenerateResult,
  type TakeOverrides,
  type TakeStatus,
} from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

/**
 * Take 的唯一前端数据源：生成阶段、字幕抽屉与行列表共用同一份状态。
 * 模块级 ref 在 SPA 内跨实例共享；切集时由调用方 loadTakes 覆盖。
 */

const takesByLine = ref<Record<number, LineTake[]>>({})
const previews = ref<Record<number, LineContextPreview>>({})
const batchJob = ref<TakeBatchJob | null>(null)
const batchRunning = ref(false)
const statusSummary = ref<TakeStatus | null>(null)
const generatingLineIds = ref<number[]>([])
const activatingTakeId = ref<number | null>(null)
const removingTakeId = ref<number | null>(null)
const loadedLineIds = new Set<number>()
let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollToken = 0
let batchResolver: ((job: TakeBatchJob | null) => void) | null = null

export interface UseLineTakesOptions {
  episodeId: () => number | null
  onChanged?: () => void
}

export interface GenerateTakeOptions {
  contextMode?: 'off' | 'light' | 'deep'
  overrides?: TakeOverrides
  voiceId?: number | null
  force?: boolean
  reuse?: boolean
  activate?: boolean
}

export interface StartBatchOptions {
  lineIds?: number[] | null
  filter?: 'pending' | 'failed' | 'audio_stale' | 'all'
  contextMode?: 'off' | 'light' | 'deep'
  concurrency?: number
}

function markGenerating(lineId: number) {
  if (!generatingLineIds.value.includes(lineId)) {
    generatingLineIds.value = [...generatingLineIds.value, lineId]
  }
}

function clearGenerating(lineId: number) {
  generatingLineIds.value = generatingLineIds.value.filter((id) => id !== lineId)
}

function settleBatch(job: TakeBatchJob | null) {
  const resolve = batchResolver
  batchResolver = null
  resolve?.(job)
}

function stopPolling() {
  pollToken += 1
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  settleBatch(null)
}

export function useLineTakes(options: UseLineTakesOptions) {
  function notify() {
    options.onChanged?.()
  }

  function mergeTake(lineId: number, take: LineTake) {
    const list = [...(takesByLine.value[lineId] || [])]
    const index = list.findIndex((item) => item.id === take.id)
    if (index >= 0) list[index] = take
    else list.push(take)
    if (take.isActive) {
      for (const item of list) {
        if (item.id !== take.id) item.isActive = false
      }
    }
    list.sort((a, b) => b.takeNo - a.takeNo)
    takesByLine.value = { ...takesByLine.value, [lineId]: list }
  }

  function takesFor(lineId: number): LineTake[] {
    return takesByLine.value[lineId] || []
  }

  function previewFor(lineId: number): LineContextPreview | null {
    return previews.value[lineId] || null
  }

  function isGenerating(lineId: number): boolean {
    return generatingLineIds.value.includes(lineId)
  }

  async function loadTakes(lineId: number) {
    try {
      const result = await takeAPI.list(lineId)
      takesByLine.value = { ...takesByLine.value, [lineId]: result.items }
      loadedLineIds.add(lineId)
      return result.items
    } catch (error) {
      toastError(error)
      return []
    }
  }

  async function loadTakesForLines(lineIds: number[], concurrency = 4) {
    const pending = [...new Set(lineIds)].filter(id => !loadedLineIds.has(id))
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= pending.length) return
        await loadTakes(pending[index])
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))
  }

  async function loadStatus() {
    const episodeId = options.episodeId()
    if (!episodeId) return null
    try {
      const result = await takeAPI.status(episodeId)
      statusSummary.value = result
      return result
    } catch (error) {
      toastError(error)
      return null
    }
  }

  async function previewContext(
    lineId: number,
    mode: 'off' | 'light' | 'deep' = 'light',
    overrides?: TakeOverrides,
  ): Promise<LineContextPreview | null> {
    try {
      const preview = await takeAPI.previewContext(lineId, { mode, overrides })
      previews.value = { ...previews.value, [lineId]: preview }
      return preview
    } catch (error) {
      toastError(error)
      return null
    }
  }

  async function generate(lineId: number, opts: GenerateTakeOptions = {}): Promise<TakeGenerateResult | null> {
    markGenerating(lineId)
    try {
      const result = await takeAPI.generate(lineId, {
        context_mode: opts.contextMode || 'light',
        ...(opts.overrides ? { overrides: opts.overrides } : {}),
        ...(opts.voiceId !== undefined ? { voice_id: opts.voiceId } : {}),
        ...(opts.force !== undefined ? { force: opts.force } : {}),
        ...(opts.reuse !== undefined ? { reuse: opts.reuse } : {}),
        ...(opts.activate !== undefined ? { activate: opts.activate } : {}),
      })
      mergeTake(lineId, result.take)
      if (result.context) {
        previews.value = {
          ...previews.value,
          [lineId]: {
            context: result.context,
            params: result.params,
            source: result.source,
            capability: previews.value[lineId]?.capability || {
              provider: result.take.provider || 'none',
              model: result.take.model,
              voicePrompt: false,
              designInstruct: false,
              emotion: false,
              speed: false,
              seed: false,
              refAudio: false,
              maxInputChars: 0,
              maxAuditionChars: 0,
              maxSpeechChars: 0,
              ignored: result.take.ignored || [],
              note: null,
            },
            ignored: result.take.ignored || [],
          },
        }
      }
      await Promise.all([loadStatus(), loadTakes(lineId)])
      notify()
      return result
    } catch (error) {
      toastError(error)
      return null
    } finally {
      clearGenerating(lineId)
    }
  }

  async function activate(takeId: number): Promise<LineTake | null> {
    activatingTakeId.value = takeId
    try {
      const result = await takeAPI.activate(takeId)
      mergeTake(result.take.lineId, result.take)
      await Promise.all([loadStatus(), loadTakes(result.take.lineId)])
      notify()
      return result.take
    } catch (error) {
      toastError(error)
      return null
    } finally {
      activatingTakeId.value = null
    }
  }

  async function remove(takeId: number): Promise<boolean> {
    removingTakeId.value = takeId
    try {
      const result = await takeAPI.remove(takeId)
      const list = (takesByLine.value[result.lineId] || []).filter((item) => item.id !== takeId)
      takesByLine.value = { ...takesByLine.value, [result.lineId]: list }
      await Promise.all([loadStatus(), loadTakes(result.lineId)])
      notify()
      return true
    } catch (error) {
      toastError(error)
      return false
    } finally {
      removingTakeId.value = null
    }
  }

  async function pollBatch(episodeId: number, jobId: string) {
    const token = ++pollToken
    const tick = async () => {
      if (token !== pollToken) return
      try {
        const job = await takeAPI.batchStatus(episodeId, jobId)
        batchJob.value = job
        if (job.status === 'running') {
          pollTimer = setTimeout(tick, 800)
          return
        }
        batchRunning.value = false
        pollTimer = null
        await Promise.all([loadStatus(), loadTakesAfterBatch()])
        notify()
        settleBatch(job)
      } catch (error) {
        if (token !== pollToken) return
        batchRunning.value = false
        pollTimer = null
        toastError(error)
        settleBatch(null)
      }
    }
    pollTimer = setTimeout(tick, 800)
  }

  async function loadTakesAfterBatch() {
    const ids = Object.keys(takesByLine.value).map(Number)
    for (const lineId of ids) await loadTakes(lineId)
  }

  async function startBatch(opts: StartBatchOptions = {}): Promise<TakeBatchJob | null> {
    const episodeId = options.episodeId()
    if (!episodeId) return null
    stopPolling()
    try {
      const started = await takeAPI.batch(episodeId, {
        ...(opts.lineIds ? { line_ids: opts.lineIds } : {}),
        filter: opts.filter || 'pending',
        context_mode: opts.contextMode || 'light',
        ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
      })
      batchJob.value = {
        id: started.job_id,
        episodeId,
        status: 'running',
        total: 0,
        done: 0,
        ok: 0,
        failed: 0,
        skipped: 0,
        currentLineId: null,
        errors: [],
        cancelRequested: false,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      }
      batchRunning.value = true
      const completion = new Promise<TakeBatchJob | null>((resolve) => {
        batchResolver = resolve
      })
      void pollBatch(episodeId, started.job_id)
      return completion
    } catch (error) {
      batchRunning.value = false
      toastError(error)
      return null
    }
  }

  async function cancelBatch(): Promise<void> {
    const episodeId = options.episodeId()
    const job = batchJob.value
    if (!episodeId || !job || job.status !== 'running') return
    try {
      batchJob.value = await takeAPI.cancelBatch(episodeId, job.id)
    } catch (error) {
      toastError(error)
    }
  }

  function resetBatch() {
    stopPolling()
    batchRunning.value = false
    batchJob.value = null
  }

  function dispose() {
    stopPolling()
  }

  const batchProgress = computed(() => {
    const job = batchJob.value
    if (!job || !job.total) return 0
    return Math.min(100, Math.round((job.done / job.total) * 100))
  })

  return {
    takesByLine,
    previews,
    batchJob,
    batchRunning,
    statusSummary,
    generatingLineIds,
    activatingTakeId,
    removingTakeId,
    batchProgress,
    takesFor,
    previewFor,
    isGenerating,
    loadTakes,
    loadTakesForLines,
    loadStatus,
    previewContext,
    generate,
    activate,
    remove,
    startBatch,
    cancelBatch,
    resetBatch,
    refreshAfterExternal: loadTakesAfterBatch,
    dispose,
  }
}

export type LineTakeStore = ReturnType<typeof useLineTakes>
