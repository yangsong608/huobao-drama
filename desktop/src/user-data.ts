import fs from 'node:fs'
import path from 'node:path'

export const PRODUCT_DIR_NAME = 'MossHuobao'
export const DEV_DIR_NAME = 'MossHuobao-Dev'
export const LEGACY_DIR_NAME = 'HuobaoDrama'
export const LEGACY_DEV_DIR_NAME = 'HuobaoDrama-Dev'

export interface UserDataPreparation {
  dir: string
  migratedFrom?: string
  retainedLegacy?: string
}

export interface UserDataFs {
  existsSync(target: string): boolean
  mkdirSync(target: string, options: { recursive: true }): unknown
  renameSync(from: string, to: string): void
}

export function prepareUserDataDir(
  appData: string,
  isPackaged: boolean,
  fsOps: UserDataFs = fs,
): UserDataPreparation {
  const dir = path.join(appData, isPackaged ? PRODUCT_DIR_NAME : DEV_DIR_NAME)
  const legacy = path.join(appData, isPackaged ? LEGACY_DIR_NAME : LEGACY_DEV_DIR_NAME)
  const targetExists = fsOps.existsSync(dir)
  const legacyExists = fsOps.existsSync(legacy)

  if (!targetExists && legacyExists) {
    try {
      fsOps.renameSync(legacy, dir)
      return { dir, migratedFrom: legacy }
    } catch (error) {
      throw new Error(`无法把旧数据目录迁移到 ${dir}：${(error as Error).message}`)
    }
  }

  fsOps.mkdirSync(dir, { recursive: true })
  return targetExists && legacyExists ? { dir, retainedLegacy: legacy } : { dir }
}