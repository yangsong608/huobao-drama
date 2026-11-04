import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const appDir = fileURLToPath(new URL('app/', root))

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

test('every app file calling useI18n imports it explicitly', () => {
  const missing = walk(appDir)
    .filter(path => /\.(?:ts|vue)$/.test(path))
    .filter((path) => {
      const source = readFileSync(path, 'utf8')
      return /\buseI18n\s*\(/.test(source) && !/import\s*\{[^}]*\buseI18n\b[^}]*\}\s*from\s*['"]vue-i18n['"]/.test(source)
    })
    .map(path => path.slice(appDir.length))

  assert.deepEqual(missing, [])
})
