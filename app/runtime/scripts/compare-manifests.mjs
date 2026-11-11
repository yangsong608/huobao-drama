#!/usr/bin/env node
/** 比对两次构建的清单，用于验证可复现性。 */
import fs from 'fs'

const args = process.argv.slice(2)
const filesOnly = args.includes('--files-only')
const [aPath, bPath] = args.filter(a => a !== '--files-only')
if (!aPath || !bPath) {
  console.error('用法: compare-manifests.mjs [--files-only] <manifest-a.json> <manifest-b.json>')
  process.exit(2)
}
const a = JSON.parse(fs.readFileSync(aPath, 'utf8'))
const b = JSON.parse(fs.readFileSync(bPath, 'utf8'))
const diffs = []

function compare(label, x, y) {
  if (JSON.stringify(x) !== JSON.stringify(y)) {
    if (typeof x === 'object' && x && typeof y === 'object' && y && !Array.isArray(x) && !Array.isArray(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)])
      for (const k of keys) compare(`${label}.${k}`, x[k], y[k])
    } else {
      diffs.push(`${label}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`)
    }
  }
}

compare('meta', a.meta, b.meta)
compare('totals', a.totals, b.totals)
if (!filesOnly) {
  compare('archive.whole', a.archive && a.archive.whole, b.archive && b.archive.whole)
  compare('archive.volumes', a.archive && a.archive.volumes, b.archive && b.archive.volumes)
}

const fa = new Map(a.files.map(f => [f.path, f]))
const fb = new Map(b.files.map(f => [f.path, f]))
for (const p of [...new Set([...fa.keys(), ...fb.keys()])].sort()) {
  const x = fa.get(p)
  const y = fb.get(p)
  if (!x || !y) {
    diffs.push(`${p}: 仅存在于${x ? ' A' : ' B'}`)
    continue
  }
  const ka = `${x.type}|${x.mode}|${x.size}|${x.sha256}|${x.target}`
  const kb = `${y.type}|${y.mode}|${y.size}|${y.sha256}|${y.target}`
  if (ka !== kb) diffs.push(`${p}: ${ka} != ${kb}`)
  if (diffs.length >= 50) break
}

if (diffs.length) {
  console.error(`清单不一致（${diffs.length}${diffs.length >= 50 ? '+' : ''} 处）：`)
  for (const d of diffs) console.error('  ' + d)
  process.exit(1)
}
console.log(`清单一致：${a.files.length} 个条目，${a.archive.volumes.length} 个分卷，压缩包 ${a.archive.whole.sha256.slice(0, 16)}…`)
