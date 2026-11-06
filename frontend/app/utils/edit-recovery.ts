import type { EditPlanV1 } from './edit-plan'

export interface EditRecovery {
  episodeId: number
  plan: EditPlanV1
  baseVersion: number
  planHash: string
  savedAt: string
}

export interface RecoveryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function recoveryKey(episodeId: number): string {
  return `huobao.edit.recovery.${episodeId}`
}

export function planFingerprint(plan: EditPlanV1): string {
  const text = JSON.stringify(plan)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function writeRecovery(
  storage: RecoveryStorage,
  episodeId: number,
  plan: EditPlanV1,
  baseVersion: number,
  savedAt = new Date().toISOString(),
): EditRecovery {
  const record: EditRecovery = {
    episodeId,
    plan,
    baseVersion,
    planHash: planFingerprint(plan),
    savedAt,
  }
  storage.setItem(recoveryKey(episodeId), JSON.stringify(record))
  return record
}

export function readRecovery(storage: RecoveryStorage, episodeId: number): EditRecovery | null {
  const raw = storage.getItem(recoveryKey(episodeId))
  if (!raw) return null
  try {
    const record = JSON.parse(raw) as EditRecovery
    if (!record || record.episodeId !== episodeId) return null
    if (!Number.isInteger(record.baseVersion) || record.baseVersion < 0) return null
    if (!record.plan || record.plan.version !== 1 || !Array.isArray(record.plan.clips)) return null
    if (typeof record.planHash !== 'string' || !record.planHash) return null
    return record
  } catch {
    return null
  }
}

export function clearRecovery(storage: RecoveryStorage, episodeId: number): void {
  storage.removeItem(recoveryKey(episodeId))
}

export function shouldOfferRecovery(
  recovery: EditRecovery | null,
  serverPlan: EditPlanV1,
): boolean {
  return Boolean(recovery && recovery.planHash !== planFingerprint(serverPlan))
}
