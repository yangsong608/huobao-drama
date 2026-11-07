import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareUserDataDir, type UserDataFs } from '../src/user-data.js'

function makeAppData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mosshuobao-user-data-'))
}

test('packaged startup migrates the legacy HuobaoDrama directory once', () => {
  const appData = makeAppData()
  try {
    const legacy = path.join(appData, 'HuobaoDrama')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'huobao.sqlite3'), 'projects')

    const prepared = prepareUserDataDir(appData, true)
    const target = path.join(appData, 'MossHuobao')
    assert.equal(prepared.dir, target)
    assert.equal(prepared.migratedFrom, legacy)
    assert.equal(prepared.retainedLegacy, undefined)
    assert.equal(fs.existsSync(legacy), false)
    assert.equal(fs.readFileSync(path.join(target, 'huobao.sqlite3'), 'utf8'), 'projects')
  } finally {
    fs.rmSync(appData, { recursive: true, force: true })
  }
})

test('existing target wins and keeps the legacy directory untouched', () => {
  const appData = makeAppData()
  try {
    const legacy = path.join(appData, 'HuobaoDrama')
    const target = path.join(appData, 'MossHuobao')
    fs.mkdirSync(legacy, { recursive: true })
    fs.mkdirSync(target, { recursive: true })

    const prepared = prepareUserDataDir(appData, true)
    assert.equal(prepared.dir, target)
    assert.equal(prepared.migratedFrom, undefined)
    assert.equal(prepared.retainedLegacy, legacy)
    assert.equal(fs.existsSync(legacy), true)
  } finally {
    fs.rmSync(appData, { recursive: true, force: true })
  }
})

test('a failed migration reports the target path instead of starting with empty data', () => {
  const appData = path.join(os.tmpdir(), 'mosshuobao-user-data-failure')
  const legacy = path.join(appData, 'HuobaoDrama')
  const fsOps: UserDataFs = {
    existsSync(target) {
      return target === legacy
    },
    mkdirSync() {
      throw new Error('should not create the target after a failed rename')
    },
    renameSync() {
      throw new Error('EPERM: operation not permitted')
    },
  }

  assert.throws(
    () => prepareUserDataDir(appData, true, fsOps),
    (error: Error) => error.message.includes(path.join(appData, 'MossHuobao')) && error.message.includes('EPERM'),
  )
})

test('dev mode migrates its own legacy directory and never touches packaged data', () => {
  const appData = makeAppData()
  try {
    const packaged = path.join(appData, 'HuobaoDrama')
    const legacyDev = path.join(appData, 'HuobaoDrama-Dev')
    fs.mkdirSync(packaged, { recursive: true })
    fs.mkdirSync(legacyDev, { recursive: true })
    fs.writeFileSync(path.join(packaged, 'huobao.sqlite3'), 'packaged')
    fs.writeFileSync(path.join(legacyDev, 'huobao.sqlite3'), 'dev')

    const prepared = prepareUserDataDir(appData, false)
    assert.equal(prepared.dir, path.join(appData, 'MossHuobao-Dev'))
    assert.equal(prepared.migratedFrom, legacyDev)
    assert.equal(prepared.retainedLegacy, undefined)
    assert.equal(fs.readFileSync(path.join(appData, 'MossHuobao-Dev', 'huobao.sqlite3'), 'utf8'), 'dev')
    assert.equal(fs.existsSync(packaged), true)
    assert.equal(fs.existsSync(legacyDev), false)
  } finally {
    fs.rmSync(appData, { recursive: true, force: true })
  }
})

test('a clean install creates the target directory', () => {
  const appData = makeAppData()
  try {
    const prepared = prepareUserDataDir(appData, true)
    assert.equal(prepared.dir, path.join(appData, 'MossHuobao'))
    assert.equal(prepared.migratedFrom, undefined)
    assert.equal(prepared.retainedLegacy, undefined)
    assert.equal(fs.existsSync(prepared.dir), true)
  } finally {
    fs.rmSync(appData, { recursive: true, force: true })
  }
})