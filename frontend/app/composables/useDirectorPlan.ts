import { computed, ref } from 'vue'
import { directorAPI, settingsAPI } from '~/composables/useApi'
import type {
  DirectorApplyField,
  DirectorApplyResult,
  DirectorPlanPayload,
  DirectorPlanShot,
  DirectorRevisionSummary,
  DirectorSaveResult,
} from '~/composables/useApi'

export type DirectorSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'
export type DirectorConflictKind = 'version' | 'shot-count' | null

export interface DirectorApplySettings {
  fields: DirectorApplyField[]
  promptAppend: boolean
  subshotSync: boolean
  fps: number
}

const STAGE_HALF_EXTENT = 20
const SUBSHOT_TOLERANCE = 0.2
const AUTO_SAVE_DELAY = 900
const DIRTY_FIELDS = ['shot_type', 'angle', 'movement', 'duration'] as const

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finiteOr(value: unknown, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function normalizeRotation(value: number): number {
  const wrapped = value % 360
  return round2(wrapped < 0 ? wrapped + 360 : wrapped)
}

export function useDirectorPlan() {
  const loadedEpisodeId = ref(0)
  const plan = ref<DirectorPlanPayload['plan'] | null>(null)
  const storyboards = ref<DirectorPlanPayload['storyboards']>([])
  const mode = ref<'off' | 'readonly' | 'on'>('readonly')
  const canEditFromServer = ref(false)
  const view3dEnabled = ref(false)
  const defaultView = ref<'2d' | '3d'>('2d')
  const previsMaxAssets = ref(20)
  const durationRange = ref({ min: 8, max: 15 })
  const loading = ref(false)
  const errorStatus = ref(0)
  const errorMessage = ref('')
  const warnings = ref<string[]>([])

  const dirty = ref(false)
  const saveStatus = ref<DirectorSaveStatus>('idle')
  const saveError = ref('')
  const lastSavedAt = ref('')
  const conflictKind = ref<DirectorConflictKind>(null)
  const conflictInfo = ref<Record<string, any> | null>(null)

  const revisions = ref<DirectorRevisionSummary[]>([])
  const revisionsLoading = ref(false)
  const revisionsError = ref('')

  const applySettings = ref<DirectorApplySettings>({
    fields: [...DIRTY_FIELDS],
    promptAppend: false,
    subshotSync: false,
    fps: 24,
  })
  const applying = ref(false)
  const applyConflictPending = ref(false)
  const staleShotIds = ref<number[]>([])
  const currentBasedOn = ref<DirectorPlanPayload['current_based_on'] | null>(null)

  const canEdit = computed(() => canEditFromServer.value && mode.value === 'on')
  const version = computed(() => Number(plan.value?.version) || 0)
  const shots = computed<DirectorPlanShot[]>(() => plan.value?.shots ?? [])
  const view = computed(() => plan.value?.view ?? { mode: '2d' as const, zoom: 1 })
  const mismatchedSubshotShots = computed(() => {
    const numbers: number[] = []
    for (const shot of shots.value) {
      const total = round2(shot.subshots.reduce((sum, item) => sum + finiteOr(item.duration_sec, 0), 0))
      if (Math.abs(total - finiteOr(shot.duration_sec, 0)) > SUBSHOT_TOLERANCE) {
        numbers.push(shot.shot_number)
      }
    }
    return numbers
  })
  const canApply = computed(() => (
    canEdit.value
    && !applying.value
    && saveStatus.value !== 'saving'
    && !conflictKind.value
    && !applyConflictPending.value
    && version.value > 0
    && mismatchedSubshotShots.value.length === 0
  ))
  const hasUnsaved = computed(() => dirty.value || saveStatus.value === 'saving')

  let savedSnapshot = ''
  let autoTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let queued: { manual: boolean; note: string } | null = null

  // dirty_fields 由分镜现状推导，不参与脏比较，避免应用后重算触发多余保存。
  function docSnapshot(): string {
    return JSON.stringify({
      view: plan.value?.view ?? { mode: '2d', zoom: 1 },
      shots: (plan.value?.shots ?? []).map(({ dirty_fields, ...shot }) => shot),
    })
  }

  function buildDoc() {
    return {
      version: 1,
      episode_id: loadedEpisodeId.value,
      based_on: plan.value?.based_on ?? { storyboard_hash: '', storyboard_count: storyboards.value.length },
      view: plan.value?.view ?? { mode: '2d', zoom: 1 },
      shots: clone(plan.value?.shots ?? []),
    }
  }

  function boardOf(storyboardId: number) {
    return storyboards.value.find((item) => Number(item.id) === Number(storyboardId)) ?? null
  }

  function syncDirtyFields(shot: DirectorPlanShot): void {
    const board = boardOf(shot.storyboard_id)
    if (!board) return
    const fields = new Set<string>(Array.isArray(shot.dirty_fields) ? shot.dirty_fields : [])
    const changed: Record<(typeof DIRTY_FIELDS)[number], boolean> = {
      shot_type: String(shot.camera.shot_type ?? '') !== String(board.shot_type ?? ''),
      angle: String(shot.camera.angle ?? '') !== String(board.angle ?? ''),
      movement: String(shot.camera.movement ?? '') !== String(board.movement ?? ''),
      duration: Math.abs(finiteOr(shot.duration_sec, 0) - finiteOr(board.duration, 0)) > 0.01,
    }
    for (const field of DIRTY_FIELDS) {
      if (changed[field]) fields.add(field)
      else fields.delete(field)
    }
    shot.dirty_fields = DIRTY_FIELDS.filter((field) => fields.has(field))
  }

  function clearAutoTimer(): void {
    if (autoTimer) {
      clearTimeout(autoTimer)
      autoTimer = null
    }
  }

  function scheduleAutoSave(): void {
    if (!canEdit.value || conflictKind.value || applyConflictPending.value) return
    clearAutoTimer()
    autoTimer = setTimeout(() => {
      autoTimer = null
      void runSave(false, '')
    }, AUTO_SAVE_DELAY)
  }

  function onEdited(): void {
    dirty.value = docSnapshot() !== savedSnapshot
    if (!dirty.value) {
      saveStatus.value = 'saved'
      return
    }
    if (saveStatus.value !== 'saving') saveStatus.value = 'dirty'
    scheduleAutoSave()
  }

  function shotOf(storyboardId: number): DirectorPlanShot | null {
    return plan.value?.shots.find((shot) => Number(shot.storyboard_id) === Number(storyboardId)) ?? null
  }

  function applyShotPatch(
    storyboardId: number,
    patch: {
      camera?: Partial<DirectorPlanShot['camera']>
      duration_sec?: number
      notes?: string
    },
  ): void {
    if (!canEdit.value) return
    const shot = shotOf(storyboardId)
    if (!shot) return
    if (patch.camera) {
      if (patch.camera.shot_type !== undefined) shot.camera.shot_type = String(patch.camera.shot_type)
      if (patch.camera.angle !== undefined) shot.camera.angle = String(patch.camera.angle)
      if (patch.camera.movement !== undefined) shot.camera.movement = String(patch.camera.movement)
      if (patch.camera.lens_mm !== undefined) {
        shot.camera.lens_mm = round2(clamp(finiteOr(patch.camera.lens_mm, shot.camera.lens_mm), 1, 300))
      }
      if (patch.camera.height_m !== undefined) {
        shot.camera.height_m = round2(clamp(finiteOr(patch.camera.height_m, shot.camera.height_m), 0, STAGE_HALF_EXTENT))
      }
      if (patch.camera.position) {
        shot.camera.position = {
          x: round2(clamp(finiteOr(patch.camera.position.x, shot.camera.position.x), -STAGE_HALF_EXTENT, STAGE_HALF_EXTENT)),
          y: round2(clamp(finiteOr(patch.camera.position.y, shot.camera.position.y), 0, STAGE_HALF_EXTENT)),
          z: round2(clamp(finiteOr(patch.camera.position.z, shot.camera.position.z), -STAGE_HALF_EXTENT, STAGE_HALF_EXTENT)),
        }
      }
      if (patch.camera.look_at) {
        shot.camera.look_at = {
          x: round2(clamp(finiteOr(patch.camera.look_at.x, shot.camera.look_at.x), -STAGE_HALF_EXTENT, STAGE_HALF_EXTENT)),
          y: round2(clamp(finiteOr(patch.camera.look_at.y, shot.camera.look_at.y), 0, STAGE_HALF_EXTENT)),
          z: round2(clamp(finiteOr(patch.camera.look_at.z, shot.camera.look_at.z), -STAGE_HALF_EXTENT, STAGE_HALF_EXTENT)),
        }
      }
    }
    if (patch.duration_sec !== undefined) {
      shot.duration_sec = round2(clamp(
        finiteOr(patch.duration_sec, shot.duration_sec),
        durationRange.value.min,
        durationRange.value.max,
      ))
    }
    if (patch.notes !== undefined) shot.notes = String(patch.notes)
    syncDirtyFields(shot)
    onEdited()
  }

  function applyBlockingPatch(
    storyboardId: number,
    characterId: number,
    patch: { x?: number; y?: number; z?: number; rotation?: number },
  ): void {
    if (!canEdit.value) return
    const shot = shotOf(storyboardId)
    const item = shot?.blocking.find((entry) => Number(entry.character_id) === Number(characterId))
    if (!shot || !item) return
    if (patch.x !== undefined) item.x = round2(clamp(finiteOr(patch.x, item.x), -STAGE_HALF_EXTENT, STAGE_HALF_EXTENT))
    if (patch.y !== undefined) item.y = round2(clamp(finiteOr(patch.y, item.y), 0, STAGE_HALF_EXTENT))
    if (patch.z !== undefined) item.z = round2(clamp(finiteOr(patch.z, item.z), -STAGE_HALF_EXTENT, STAGE_HALF_EXTENT))
    if (patch.rotation !== undefined) item.rotation = normalizeRotation(finiteOr(patch.rotation, item.rotation))
    onEdited()
  }

  function setSubshots(storyboardId: number, subshots: DirectorPlanShot['subshots']): void {
    if (!canEdit.value) return
    const shot = shotOf(storyboardId)
    if (!shot) return
    const normalized = subshots
      .filter((item) => item && typeof item === 'object')
      .map((item, index) => ({
        no: index + 1,
        description: String(item.description ?? ''),
        duration_sec: round2(Math.max(0, finiteOr(item.duration_sec, 0))),
        path_index: index,
      }))
    if (normalized.length === 0) return
    shot.subshots = normalized
    onEdited()
  }

  function resetState(): void {
    clearAutoTimer()
    queued = null
    dirty.value = false
    saveStatus.value = 'idle'
    saveError.value = ''
    lastSavedAt.value = ''
    conflictKind.value = null
    conflictInfo.value = null
  }

  async function load(episodeId: number): Promise<void> {
    const id = Number(episodeId)
    if (!Number.isSafeInteger(id) || id <= 0) return
    loadedEpisodeId.value = id
    clearAutoTimer()
    queued = null
    conflictKind.value = null
    conflictInfo.value = null
    applyConflictPending.value = false
    dirty.value = false
    saveStatus.value = 'idle'
    saveError.value = ''
    loading.value = true
    errorStatus.value = 0
    errorMessage.value = ''
    try {
      const [data, settings] = await Promise.all([
        directorAPI.get(id),
        settingsAPI.director().catch(() => null),
      ])
      if (loadedEpisodeId.value !== id) return
      const nextPlan = clone(data.plan)
      nextPlan.shots = (nextPlan.shots || []).map((shot) => ({
        ...shot,
        dirty_fields: Array.isArray(shot.dirty_fields) ? [...shot.dirty_fields] : [],
      }))
      plan.value = nextPlan
      currentBasedOn.value = data.current_based_on ?? null
      storyboards.value = Array.isArray(data.storyboards) ? data.storyboards : []
      mode.value = data.mode
      canEditFromServer.value = Boolean(data.can_edit)
      view3dEnabled.value = Boolean(data.view3d_enabled)
      defaultView.value = settings?.settings?.view?.default === '3d' ? '3d' : '2d'
      previsMaxAssets.value = clamp(finiteOr(settings?.settings?.previs?.maxAssets, 20), 1, 100)
      warnings.value = Array.isArray(data.warnings) ? data.warnings : []
      if (settings?.settings?.duration) {
        durationRange.value = {
          min: finiteOr(settings.settings.duration.min, 8),
          max: finiteOr(settings.settings.duration.max, 15),
        }
      }
      const applyConf = settings?.settings?.apply
      applySettings.value = {
        fields: Array.isArray(applyConf?.fields)
          ? applyConf.fields.filter((field): field is DirectorApplyField => DIRTY_FIELDS.includes(field as DirectorApplyField))
          : [...DIRTY_FIELDS],
        promptAppend: Boolean(applyConf?.promptAppend),
        subshotSync: Boolean(applyConf?.subshotSync),
        fps: clamp(finiteOr(settings?.settings?.duration?.fps, 24), 1, 120),
      }
      staleShotIds.value = []
      for (const shot of nextPlan.shots) syncDirtyFields(shot)
      savedSnapshot = docSnapshot()
      dirty.value = false
      saveStatus.value = version.value > 0 ? 'saved' : 'idle'
      saveError.value = ''
      lastSavedAt.value = ''
      conflictKind.value = null
      conflictInfo.value = null
      revisions.value = []
    } catch (error: any) {
      if (loadedEpisodeId.value !== id) return
      plan.value = null
      currentBasedOn.value = null
      storyboards.value = []
      errorStatus.value = Number(error?.status) || 0
      errorMessage.value = String(error?.message || '')
    } finally {
      if (loadedEpisodeId.value === id) loading.value = false
    }
  }

  async function runSave(manual: boolean, note: string): Promise<boolean> {
    if (!canEdit.value || conflictKind.value) return false
    if (!manual && (applyConflictPending.value || !dirty.value)) return true
    if (inFlight) {
      queued = { manual, note }
      return false
    }
    clearAutoTimer()
    inFlight = true
    saveStatus.value = 'saving'
    saveError.value = ''
    const sentSnapshot = docSnapshot()
    const baseVersion = version.value
    try {
      const result: DirectorSaveResult = await directorAPI.save(loadedEpisodeId.value, {
        base_version: baseVersion,
        doc: buildDoc(),
        note: note.trim() ? note.trim() : undefined,
      })
      if (plan.value) plan.value.version = result.version
      lastSavedAt.value = result.updated_at
      warnings.value = Array.isArray(result.warnings) ? result.warnings : []
      savedSnapshot = sentSnapshot
      dirty.value = docSnapshot() !== savedSnapshot
      conflictKind.value = null
      conflictInfo.value = null
      saveStatus.value = dirty.value ? 'dirty' : 'saved'
      if (dirty.value) scheduleAutoSave()
      return true
    } catch (error: any) {
      const code = String(error?.code || '')
      const status = Number(error?.status) || 0
      if (status === 409 && (code === 'DIRECTOR_VERSION_CONFLICT' || code === 'DIRECTOR_PLAN_SHOT_COUNT')) {
        conflictKind.value = code === 'DIRECTOR_PLAN_SHOT_COUNT' ? 'shot-count' : 'version'
        conflictInfo.value = error?.data || null
        saveStatus.value = 'conflict'
      } else {
        saveStatus.value = 'error'
        saveError.value = String(error?.message || '')
      }
      return false
    } finally {
      inFlight = false
      const next = queued
      queued = null
      if (next && !conflictKind.value && canEdit.value) {
        void runSave(next.manual, next.note)
      }
    }
  }

  function save(manual = false, note = ''): Promise<boolean> {
    return runSave(manual, note)
  }

  function retrySave(): Promise<boolean> {
    return runSave(true, '')
  }

  async function loadRevisions(): Promise<void> {
    if (!loadedEpisodeId.value) return
    revisionsLoading.value = true
    revisionsError.value = ''
    try {
      const data = await directorAPI.revisions(loadedEpisodeId.value)
      revisions.value = Array.isArray(data.revisions) ? data.revisions : []
    } catch (error: any) {
      revisionsError.value = String(error?.message || '')
    } finally {
      revisionsLoading.value = false
    }
  }

  async function restoreRevision(revisionId: number): Promise<DirectorSaveResult> {
    const result = await directorAPI.restore(loadedEpisodeId.value, revisionId)
    await load(loadedEpisodeId.value)
    return result
  }

  async function applyPlan(input: {
    storyboard_ids: number[]
    fields: DirectorApplyField[]
    append_prompt: boolean
    sync_subshots: boolean
  }): Promise<DirectorApplyResult> {
    if (!canEdit.value) throw new Error('DIRECTOR_READONLY')
    if (version.value <= 0) throw new Error('DIRECTOR_PLAN_NOT_FOUND')
    if (applying.value) throw new Error('DIRECTOR_APPLY_IN_FLIGHT')
    applying.value = true
    const id = loadedEpisodeId.value
    try {
      const result = await directorAPI.apply(id, {
        base_version: version.value,
        storyboard_ids: input.storyboard_ids,
        fields: input.fields,
        append_prompt: input.append_prompt,
        sync_subshots: input.sync_subshots,
      })
      // 应用不回写计划，仅刷新分镜摘要；保留本地计划、选中与未保存修改。
      const latest = await directorAPI.get(id).catch(() => null)
      if (loadedEpisodeId.value === id && latest) {
        storyboards.value = Array.isArray(latest.storyboards) ? latest.storyboards : storyboards.value
        if (plan.value) plan.value.based_on = latest.plan.based_on
        currentBasedOn.value = latest.current_based_on ?? result.based_on
      } else if (loadedEpisodeId.value === id) {
        if (plan.value) plan.value.based_on = result.based_on
        currentBasedOn.value = result.based_on
      }
      if (loadedEpisodeId.value === id) {
        applyConflictPending.value = false
        for (const shot of plan.value?.shots ?? []) syncDirtyFields(shot)
        staleShotIds.value = Array.from(new Set([...staleShotIds.value, ...result.stale]))
        warnings.value = Array.isArray(result.warnings) ? result.warnings : warnings.value
      }
      return result
    } catch (error: any) {
      if (String(error?.code || '') === 'DIRECTOR_STORYBOARD_CONFLICT') {
        applyConflictPending.value = true
        clearAutoTimer()
      }
      throw error
    } finally {
      applying.value = false
    }
  }

  /** 应用冲突后由用户显式触发：重读当前分镜指纹，更新文档 based_on 后保存一次。 */
  async function realignBaseline(): Promise<boolean> {
    if (!canEdit.value || conflictKind.value || !loadedEpisodeId.value) return false
    await load(loadedEpisodeId.value)
    if (errorStatus.value || !plan.value || !currentBasedOn.value) return false
    if (
      plan.value.based_on.storyboard_hash === currentBasedOn.value.storyboard_hash
      && plan.value.based_on.storyboard_count === currentBasedOn.value.storyboard_count
    ) {
      applyConflictPending.value = false
      return true
    }
    plan.value.based_on = { ...currentBasedOn.value }
    const ok = await runSave(true, '')
    if (ok) applyConflictPending.value = false
    return ok
  }

  function dispose(): void {
    clearAutoTimer()
    queued = null
  }

  return {
    loadedEpisodeId,
    plan,
    storyboards,
    shots,
    version,
    view,
    mode,
    canEdit,
    view3dEnabled,
    defaultView,
    previsMaxAssets,
    durationRange,
    loading,
    errorStatus,
    errorMessage,
    warnings,
    dirty,
    hasUnsaved,
    saveStatus,
    saveError,
    lastSavedAt,
    conflictKind,
    conflictInfo,
    canApply,
    mismatchedSubshotShots,
    applySettings,
    applying,
    applyConflictPending,
    currentBasedOn,
    staleShotIds,
    revisions,
    revisionsLoading,
    revisionsError,
    load,
    save,
    retrySave,
    loadRevisions,
    restoreRevision,
    applyPlan,
    realignBaseline,
    applyShotPatch,
    applyBlockingPatch,
    setSubshots,
    dispose,
  }
}
