/**
 * 剪辑工作台状态（S2 Task 10）
 *
 * - `plan` 是唯一可编辑数据源；命令只产出新计划，历史栈保存原始快照；
 * - 每次编辑 300ms 防抖自动保存，服务端成功后才清本地恢复记录；
 * - 版本冲突（EDIT_VERSION_CONFLICT）只标记状态交给 UI 决策，绝不静默覆盖或重载；
 * - 本地恢复记录读写失败（隐私模式、配额满）不得影响编辑与自动保存。
 *
 * 注意 Vue 响应式：`plan.value` 是深层代理，Task 9 的命令用 structuredClone 克隆入参，
 * 代理会抛 DataCloneError。因此传入命令 / 历史栈 / 队列 / 恢复记录 / 请求体的一律是
 * `toRaw(plan.value)`，空操作判定也只比较 `result.plan === current`。
 */
import { computed, ref, shallowRef, toRaw } from 'vue'
import { editAPI } from '~/composables/useApi'
import { computeLocalLayout } from '~/utils/edit-layout'
import { createEditSaveQueue } from '~/utils/edit-save'
import {
  clearRecovery,
  planFingerprint,
  readRecovery,
  shouldOfferRecovery,
  writeRecovery,
  type EditRecovery,
  type RecoveryStorage,
} from '~/utils/edit-recovery'
import {
  canRedo,
  canUndo,
  createEditHistory,
  pushEditHistory,
  redoEditHistory,
  undoEditHistory,
} from '~/utils/edit-history'
import type { EditCommandResult } from '~/utils/edit-commands'
import type {
  EditHashes,
  EditIssue,
  EditPlanV1,
  EditRevisionSummary,
  EditVersionConflictData,
  EditWorkspaceState,
} from '~/utils/edit-plan'

export interface EditMutationOptions {
  /** false 表示不改写本地恢复记录（例如接受恢复记录时记录本身就是当前计划）。 */
  remember?: boolean
}

function plainClone(plan: EditPlanV1): EditPlanV1 {
  return JSON.parse(JSON.stringify(plan)) as EditPlanV1
}

export function useEditPlan(initial: EditWorkspaceState) {
  const episodeId = initial.episode_id
  const plan = ref<EditPlanV1>(structuredClone(initial.plan))
  const version = ref(initial.draft?.version ?? 0)
  const dirty = ref(Boolean(initial.draft_dirty))
  const saveStatus = ref<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>(
    initial.draft ? 'saved' : 'idle',
  )
  const saveError = ref('')
  const lastSavedAt = ref(initial.draft?.updated_at ?? '')
  const hashes = ref<EditHashes>(initial.hashes)
  const conflict = ref<EditVersionConflictData | null>(null)
  const issues = ref<EditIssue[]>([])
  // shallowRef：历史栈里都是普通 JSON 快照，不需要（也不应该）被深度代理包装。
  const history = shallowRef(createEditHistory(toRaw(plan.value)))
  const layout = computed(() => computeLocalLayout(toRaw(plan.value)))
  // capabilities 放进 ref：reload/resetFrom 可能带来新的权限位（锁定/解锁），canEdit 必须跟着变。
  const capabilities = ref(initial.capabilities)
  const canEdit = computed(() => Boolean(capabilities.value.can_edit))

  /** 本地恢复记录：localStorage 在隐私模式/沙箱里可能直接抛异常，一律降级为 null。 */
  function storage(): RecoveryStorage | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
      return null
    }
  }

  function readStoredRecovery() {
    const target = storage()
    if (!target) return null
    try {
      return readRecovery(target, episodeId)
    } catch {
      return null
    }
  }

  function clearStoredRecovery(): void {
    const target = storage()
    if (!target) return
    try {
      clearRecovery(target, episodeId)
    } catch {
      /* 清不掉只是残留一条过期记录，不影响编辑 */
    }
  }

  const restored = readStoredRecovery()
  const recovery = ref<EditRecovery | null>(
    shouldOfferRecovery(restored, initial.plan) ? restored : null,
  )

  function remember(nextPlan: EditPlanV1): void {
    if (!canEdit.value) return
    const target = storage()
    if (!target) return
    try {
      writeRecovery(target, episodeId, nextPlan, version.value)
    } catch {
      /* 配额满/不可写：放弃本地恢复记录，编辑与自动保存照常 */
    }
  }

  const queue = createEditSaveQueue({
    delayMs: 300,
    save: async (nextPlan) => {
      if (!canEdit.value) return
      saveStatus.value = 'saving'
      saveError.value = ''
      try {
        const result = await editAPI.saveDraft(episodeId, {
          base_version: version.value,
          plan: nextPlan,
        })
        const unchanged = planFingerprint(toRaw(plan.value)) === planFingerprint(nextPlan)
        version.value = result.version
        lastSavedAt.value = result.updated_at
        hashes.value = result.hashes
        dirty.value = unchanged ? result.draft_dirty : true
        saveStatus.value = unchanged ? 'saved' : 'idle'
        if (unchanged) {
          clearStoredRecovery()
          recovery.value = null
        }
      } catch (cause: any) {
        if (cause?.code === 'EDIT_VERSION_CONFLICT') {
          // 先丢弃已排队的计划：它们带着检测到冲突之前抓取的过期 base_version，重发只会继续 409。
          queue.cancel()
          conflict.value = cause.data as EditVersionConflictData
          saveStatus.value = 'conflict'
          return
        }
        saveStatus.value = 'error'
        saveError.value = cause?.message || '保存失败'
        // 请求在途期间用户可能又改过：恢复记录必须存当前计划，而不是已发送的旧快照。
        remember(toRaw(plan.value))
      }
    },
    onError: (error: any) => {
      saveStatus.value = 'error'
      saveError.value = error?.message || '保存失败'
    },
  })

  /**
   * 冲突未解决前不再向服务端发保存：base_version 已过期，重试只会继续 409。
   * 本地编辑照常保留在内存与恢复记录里，等 UI 决策（重载或覆盖）。
   */
  function scheduleSave(nextPlan: EditPlanV1): void {
    if (conflict.value) return
    queue.schedule(nextPlan)
  }

  function applyResult(
    result: EditCommandResult,
    options: EditMutationOptions = {},
  ): boolean {
    if (!canEdit.value) return false
    issues.value = result.issues
    if (result.issues.some((issue) => issue.severity === 'error')) return false
    const current = toRaw(plan.value)
    if (result.plan === current) return false
    // 部分命令（如 setClipGap）总会克隆出新对象，等价计划要靠 JSON 指纹兜住：
    // 不记历史、不置脏、不触发保存。
    if (planFingerprint(result.plan) === planFingerprint(current)) return false
    // pushEditHistory 的入参是"新的 present"：它会把旧的 present 压入 past。
    history.value = pushEditHistory(history.value, result.plan)
    plan.value = result.plan
    const next = toRaw(plan.value)
    dirty.value = true
    saveStatus.value = conflict.value ? 'conflict' : 'idle'
    if (options.remember !== false) remember(next)
    scheduleSave(next)
    return true
  }

  function applyCommand(command: (value: EditPlanV1) => EditCommandResult): boolean {
    if (!canEdit.value) return false
    const current = toRaw(plan.value)
    return applyResult(command(current))
  }

  /**
   * 一键初剪 / 字幕建议都是无状态接口：返回的 envelope 只是"归一化后的计划"，
   * 不落库。因此按本地编辑处理（历史 + dirty + 自动保存），同时采纳服务端 hashes/issues。
   */
  function applyExternalPlan(
    nextPlan: EditPlanV1,
    nextHashes?: EditHashes,
    nextIssues?: EditIssue[],
  ): boolean {
    if (!canEdit.value) return false
    const current = toRaw(plan.value)
    const next = plainClone(toRaw(nextPlan))
    if (planFingerprint(next) === planFingerprint(current)) {
      // 服务端没有改出任何差异：只采纳提示，不制造脏状态与多余的保存。
      issues.value = nextIssues ?? []
      if (nextHashes) hashes.value = nextHashes
      return false
    }
    const applied = applyResult({ plan: next, issues: nextIssues ?? [], focusClipId: null })
    if (nextHashes) hashes.value = nextHashes
    return applied
  }

  function undo() {
    if (!canEdit.value || !canUndo(history.value)) return
    history.value = undoEditHistory(history.value)
    plan.value = history.value.present
    const next = toRaw(plan.value)
    dirty.value = true
    saveStatus.value = conflict.value ? 'conflict' : 'idle'
    remember(next)
    scheduleSave(next)
  }

  function redo() {
    if (!canEdit.value || !canRedo(history.value)) return
    history.value = redoEditHistory(history.value)
    plan.value = history.value.present
    const next = toRaw(plan.value)
    dirty.value = true
    saveStatus.value = conflict.value ? 'conflict' : 'idle'
    remember(next)
    scheduleSave(next)
  }

  async function saveNow() {
    // 冲突未解决时 base_version 已过期，无条件重发只会继续 409。
    if (!canEdit.value || conflict.value) return
    await queue.flush()
  }

  function resetFrom(state: EditWorkspaceState): void {
    plan.value = structuredClone(state.plan)
    version.value = state.draft?.version ?? 0
    dirty.value = Boolean(state.draft_dirty)
    lastSavedAt.value = state.draft?.updated_at ?? ''
    hashes.value = state.hashes
    capabilities.value = state.capabilities
    history.value = createEditHistory(toRaw(plan.value))
    conflict.value = null
    issues.value = []
    saveStatus.value = state.draft ? 'saved' : 'idle'
    saveError.value = ''
  }

  async function reload() {
    queue.cancel()
    await queue.idle()
    const state = await editAPI.get(episodeId) as EditWorkspaceState
    resetFrom(state)
    recovery.value = null
    clearStoredRecovery()
  }

  async function discard() {
    if (!canEdit.value) return
    queue.cancel()
    // 等未完成的保存落地，避免丢弃后又被旧请求写回草稿。
    await queue.idle()
    await editAPI.discardDraft(episodeId)
    await reload()
  }

  async function createVersion(note: string): Promise<EditRevisionSummary | null> {
    if (!canEdit.value) return null
    await queue.flush()
    if (conflict.value) return null
    const sentPlan = plainClone(toRaw(plan.value))
    try {
      const result = await editAPI.createRevision(episodeId, {
        base_version: version.value,
        note,
        plan: sentPlan,
        update_draft: true,
      })
      const unchanged = planFingerprint(toRaw(plan.value)) === planFingerprint(sentPlan)
      const nextVersion = result.draft_version
      if (typeof nextVersion === 'number' && Number.isSafeInteger(nextVersion) && nextVersion >= 0) {
        version.value = nextVersion
      }
      dirty.value = unchanged ? Boolean(result.draft_dirty) : true
      saveStatus.value = unchanged ? 'saved' : 'idle'
      if (unchanged) {
        saveError.value = ''
        clearStoredRecovery()
        recovery.value = null
      }
      return result.revision as EditRevisionSummary
    } catch (cause: any) {
      if (cause?.code === 'EDIT_VERSION_CONFLICT') {
        conflict.value = cause.data as EditVersionConflictData
        saveStatus.value = 'conflict'
        return null
      }
      saveStatus.value = 'error'
      saveError.value = cause?.message || '创建版本失败'
      throw cause
    }
  }

  async function restoreRevision(revisionId: number) {
    if (!canEdit.value) return
    queue.cancel()
    await queue.idle()
    try {
      await editAPI.restoreRevision(episodeId, revisionId, { base_version: version.value })
    } catch (cause: any) {
      if (cause?.code === 'EDIT_VERSION_CONFLICT') {
        // 不 reload：重载会丢掉本地未保存的改动，冲突交给 UI 决策。
        conflict.value = cause.data as EditVersionConflictData
        saveStatus.value = 'conflict'
        return
      }
      saveStatus.value = 'error'
      saveError.value = cause?.message || '恢复版本失败'
      // 未保存的本地改动交给自动保存重试（restore 失败是暂时性的，冲突不在此分支）。
      scheduleSave(toRaw(plan.value))
      throw cause
    }
    await reload()
  }

  async function resolveConflict(mode: 'reload' | 'overwrite') {
    if (!canEdit.value) return
    if (mode === 'reload') {
      await reload()
      return
    }
    queue.cancel()
    // 等在途的旧保存落地，否则它可能在强制 PUT 之后才返回，把本地状态改回冲突版本。
    await queue.idle()
    const sentPlan = plainClone(toRaw(plan.value))
    try {
      const result = await editAPI.saveDraft(episodeId, {
        base_version: version.value,
        plan: sentPlan,
        force: true,
      })
      const unchanged = planFingerprint(toRaw(plan.value)) === planFingerprint(sentPlan)
      version.value = result.version
      lastSavedAt.value = result.updated_at
      hashes.value = result.hashes
      dirty.value = unchanged ? result.draft_dirty : true
      conflict.value = null
      saveStatus.value = unchanged ? 'saved' : 'idle'
      saveError.value = ''
      if (unchanged) {
        recovery.value = null
        clearStoredRecovery()
      } else {
        // 覆盖保存期间用户又改了：恢复记录保留（当前计划还没落库），继续走自动保存（此时冲突已解除）。
        scheduleSave(toRaw(plan.value))
      }
    } catch (cause: any) {
      saveStatus.value = 'error'
      saveError.value = cause?.message || '覆盖保存失败'
      throw cause
    }
  }

  function acceptRecovery() {
    if (!canEdit.value || !recovery.value) return
    // recovery 是 ref，嵌套的 plan 也是代理；这里用 JSON 快照，避免 structuredClone 抛 DataCloneError。
    const restored = plainClone(toRaw(recovery.value).plan)
    history.value = pushEditHistory(history.value, restored)
    plan.value = restored
    const next = toRaw(plan.value)
    dirty.value = true
    saveStatus.value = conflict.value ? 'conflict' : 'idle'
    recovery.value = null
    scheduleSave(next)
  }

  function dismissRecovery() {
    clearStoredRecovery()
    recovery.value = null
  }

  function retrySave() {
    if (!canEdit.value || conflict.value) return
    saveError.value = ''
    saveStatus.value = 'idle'
    queue.schedule(toRaw(plan.value))
  }

  return {
    plan,
    layout,
    hashes,
    version,
    dirty,
    canEdit,
    saveStatus,
    saveError,
    lastSavedAt,
    conflict,
    recovery,
    issues,
    history,
    canUndo: computed(() => canUndo(history.value)),
    canRedo: computed(() => canRedo(history.value)),
    applyCommand,
    applyExternalPlan,
    undo,
    redo,
    saveNow,
    reload,
    discard,
    createVersion,
    restoreRevision,
    resolveConflict,
    acceptRecovery,
    dismissRecovery,
    retrySave,
    planHash: computed(() => planFingerprint(toRaw(plan.value))),
  }
}
