#!/usr/bin/env node
/**
 * 运行时清单。
 *   files    遍历 stage 目录，记录类型、权限、大小、SHA-256（符号链接记录目标）。
 *   finalize 合并构建元数据与分卷信息，输出随包清单。
 * 清单不写入构建时间，保证连续构建可比对。
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const mode = process.argv[2]

function walk(root, rel = '', out = []) {
  const abs = rel ? path.join(root, rel) : root
  const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const ent of entries) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name
    const childAbs = path.join(root, childRel)
    const st = fs.lstatSync(childAbs)
    const perm = (st.mode & 0o7777).toString(8).padStart(4, '0')
    if (st.isSymbolicLink()) {
      out.push({ path: childRel, type: 'symlink', mode: perm, target: fs.readlinkSync(childAbs) })
    } else if (st.isDirectory()) {
      out.push({ path: childRel, type: 'dir', mode: perm })
      walk(root, childRel, out)
    } else if (st.isFile()) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(childAbs)).digest('hex')
      out.push({ path: childRel, type: 'file', mode: perm, size: st.size, sha256: hash })
    }
  }
  return out
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

if (mode === 'files') {
  const stage = process.env.STAGE_DIR
  const outFile = process.env.OUT_FILE
  const meta = readJson(process.env.META_FILE)
  const files = walk(stage).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const totals = {
    fileCount: files.filter(f => f.type === 'file').length,
    symlinkCount: files.filter(f => f.type === 'symlink').length,
    dirCount: files.filter(f => f.type === 'dir').length,
    totalBytes: files.filter(f => f.type === 'file').reduce((sum, f) => sum + f.size, 0),
  }
  writeJson(outFile, { schemaVersion: 1, meta, totals, files, archive: null })
  console.log(`清单文件 ${totals.fileCount} + 链接 ${totals.symlinkCount} + 目录 ${totals.dirCount}，${(totals.totalBytes / 1024 / 1024).toFixed(1)} MB`)
} else if (mode === 'finalize') {
  const manifest = readJson(process.env.FILES_MANIFEST)
  const outFile = process.env.OUT_FILE
  const archiveDir = process.env.ARCHIVE_DIR
  const prefix = process.env.VOLUME_PREFIX
  const volumes = fs
    .readdirSync(archiveDir)
    .filter(name => name.startsWith(prefix))
    .sort()
    .map(name => {
      const abs = path.join(archiveDir, name)
      const buf = fs.readFileSync(abs)
      return {
        name,
        size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      }
    })
  if (volumes.length === 0) {
    console.error(`没有找到分卷：${archiveDir}/${prefix}*`)
    process.exit(1)
  }
  manifest.archive = {
    format: 'tar+zstd',
    tarFormat: 'gnu',
    compression: 'zstd',
    zstdLevel: Number(process.env.ZSTD_LEVEL || 19),
    whole: {
      name: process.env.ARCHIVE_NAME || 'runtime.tar.zst',
      size: Number(process.env.ARCHIVE_SIZE),
      sha256: process.env.ARCHIVE_SHA256,
    },
    volumeSize: process.env.VOLUME_SIZE || '',
    volumePrefix: prefix,
    volumes,
  }
  writeJson(outFile, manifest)
  console.log(`清单完成：${volumes.length} 个分卷，压缩包 ${manifest.archive.whole.sha256.slice(0, 12)}…`)
} else {
  console.error('用法: make-manifest.mjs files|finalize')
  process.exit(2)
}
