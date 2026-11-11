#!/usr/bin/env node
/**
 * 运行时包禁用项扫描：FFmpeg/FFprobe 可执行文件、静态包目录、FFmpeg 动态库依赖。
 * 后端 bundle 内的相关代码字符串不算违规——能力探测据此判定不可用。
 */
import fs from 'fs'
import path from 'path'

const ROOT = process.env.STAGE_DIR
if (!ROOT) {
  console.error('缺少 STAGE_DIR')
  process.exit(2)
}

const forbiddenNames = new Set(['ffmpeg', 'ffprobe', 'ffmpeg.exe', 'ffprobe.exe'])
const forbiddenDirs = ['/node_modules/ffmpeg-static/', '/node_modules/ffprobe-static/']
const avLibs = ['libavcodec.so', 'libavformat.so', 'libavutil.so', 'libswscale.so', 'libswresample.so', 'libavfilter.so', 'libavdevice.so']
const violations = []

function checkFile(abs, rel) {
  const base = path.basename(rel).toLowerCase()
  if (forbiddenNames.has(base)) violations.push(`${rel}: 禁止的 FFmpeg/FFprobe 可执行文件`)
  if (forbiddenDirs.some(d => `/${rel}/`.includes(d))) violations.push(`${rel}: 禁止的 FFmpeg 静态包目录`)
  if (rel.startsWith('rootfs/usr/local/bin/') && /^(ffmpeg|ffprobe)/.test(base)) violations.push(`${rel}: 禁止的媒体工具`)

  const fd = fs.openSync(abs, 'r')
  const head = Buffer.alloc(4)
  fs.readSync(fd, head, 0, 4, 0)
  if (head.toString('latin1') !== '\x7fELF') {
    fs.closeSync(fd)
    return
  }
  const size = fs.statSync(abs).size
  const buf = Buffer.alloc(Math.min(size, 32 * 1024 * 1024))
  fs.readSync(fd, buf, 0, buf.length, 0)
  fs.closeSync(fd)
  const text = buf.toString('latin1')
  const hit = avLibs.find(lib => text.includes(lib))
  if (hit) violations.push(`${rel}: ELF 依赖 ${hit}`)
}

function walk(abs, rel) {
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const childAbs = path.join(abs, ent.name)
    const childRel = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isSymbolicLink()) continue
    if (ent.isDirectory()) walk(childAbs, childRel)
    else if (ent.isFile()) checkFile(childAbs, childRel)
  }
}

walk(ROOT, '')

if (violations.length) {
  console.error('禁用项扫描失败：')
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log('禁用项扫描通过：无 FFmpeg/FFprobe 可执行文件与动态库')
