#!/usr/bin/env node
/**
 * 随包许可证清单：复制 rootfs 内可得的许可证文本，并生成 THIRD-PARTY.md。
 * 必须在裁剪 /usr/share/doc 之前执行。
 */
import fs from 'fs'
import path from 'path'

const STAGE = process.env.STAGE_DIR
const OUT = process.env.LICENSES_DIR
const PROOT_DIR = process.env.PROOT_DIR
const meta = JSON.parse(fs.readFileSync(process.env.META_FILE, 'utf8'))
const nodeVersion = process.env.NODE_VERSION || meta.nodeVersion
const prootVersion = meta.prootVersion

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

function copyIfExists(src, relDest) {
  if (!fs.existsSync(src)) return false
  const dest = path.join(OUT, relDest)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  return true
}

copyIfExists(path.join(STAGE, 'usr/local/LICENSE'), 'node/LICENSE')

copyIfExists(path.join(STAGE, 'usr/share/common-licenses/GPL-2'), 'proot/COPYING-GPL-2.0')
copyIfExists(path.join(STAGE, 'usr/share/common-licenses/LGPL-3'), 'talloc/COPYING-LGPL-3.0')

const docRoot = path.join(STAGE, 'usr/share/doc')
if (fs.existsSync(docRoot)) {
  const pkgs = fs.readdirSync(docRoot).sort()
  for (const pkg of pkgs) {
    const copyright = path.join(docRoot, pkg, 'copyright')
    if (fs.existsSync(copyright) && fs.statSync(copyright).isFile()) {
      copyIfExists(copyright, `debian/${pkg}.copyright`)
    }
  }
}

function copyLicenseTree(root, relPrefix) {
  if (!fs.existsSync(root)) return
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const abs = rel ? path.join(root, rel) : root
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      const childAbs = path.join(abs, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') continue
        stack.push(childRel)
      } else if (ent.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE)/i.test(ent.name)) {
        copyIfExists(childAbs, path.join(relPrefix, childRel))
      }
    }
  }
}

copyLicenseTree(path.join(STAGE, 'opt/huobao/node_modules'), 'npm')

if (PROOT_DIR) {
  copyIfExists(path.join(PROOT_DIR, 'licenses/libandroid-shmem.copyright'), 'termux/libandroid-shmem.copyright')
}

const rows = [
  ['proot', prootVersion, 'GPL-2.0-or-later', 'Termux 打包；源码 https://github.com/termux/proot'],
  ['libtalloc', '2.5.0', 'LGPL-3.0-or-later', 'Termux 打包；Samba talloc'],
  ['libandroid-shmem', '0.7', 'BSD-2-Clause', 'Termux 打包'],
  ['Debian bookworm arm64 基础包', '2026-11-10 快照', '各包自有许可证（以 debian/*.copyright 为准）', '含 glibc、libstdc++6、ca-certificates、tzdata 等'],
  ['Node.js', nodeVersion, 'MIT 及捆绑依赖许可证', 'https://nodejs.org'],
  ['better-sqlite3', meta.bundledBetterSqlite3, 'MIT', 'SQLite 为 public domain'],
  ['sharp', meta.bundledSharp, 'Apache-2.0', 'libvips 为 LGPL-2.1-or-later'],
  ['zstd-jni（APK 侧）', '随 A3 锁定', 'BSD-2-Clause', '用于解压运行时分卷'],
  ['Apache Commons Compress（APK 侧）', '随 A3 锁定', 'Apache-2.0', '用于解包 GNU tar'],
  ['ZXing（APK 侧）', '随 A3 锁定', 'Apache-2.0', '仅用于扫码'],
  ['Kotlin / AndroidX（APK 侧）', '随 A3 锁定', 'Apache-2.0', 'Android 壳'],
]

const lines = [
  '# 第三方组件与许可证清单',
  '',
  '本清单随运行时包提供。`node/`、`npm/`、`debian/`、`termux/`、`proot/`、`talloc/` 目录内为对应许可证原文或版权声明。',
  'APK 侧组件（zstd-jni、Commons Compress、ZXing、Kotlin/AndroidX）的许可证文本由 APK 构建一并提供。',
  '',
  '| 组件 | 版本 | 许可证 | 说明 |',
  '| --- | --- | --- | --- |',
  ...rows.map(r => `| ${r.join(' | ')} |`),
  '',
  '运行时包不包含 FFmpeg/FFprobe，也不设置 FFMPEG_BIN/FFPROBE_BIN。',
  '',
]
fs.writeFileSync(path.join(OUT, 'THIRD-PARTY.md'), lines.join('\n'))

const count = fs.readdirSync(OUT, { recursive: true }).filter(f => fs.statSync(path.join(OUT, f)).isFile()).length
console.log(`许可证文件 ${count} 个`)
