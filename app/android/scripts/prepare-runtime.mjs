#!/usr/bin/env node
/**
 * 将 A2 产出的运行时清单与分卷放入 Android assets，或只做校验。
 * 用法：
 *   node app/android/scripts/prepare-runtime.mjs --check [--source <build目录>]
 *   node app/android/scripts/prepare-runtime.mjs [--source <build目录>] [--assets <目录>]
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')
const OUT_ROOT = join(REPO_ROOT, 'app/runtime/out')
const DEFAULT_ASSETS = join(REPO_ROOT, 'app/android/app/src/main/assets/runtime')
const VOLUME_PREFIX = 'runtime.tar.zst.part-'
const SPACE_MARGIN = 64 * 1024 * 1024
const SHA256_RE = /^[0-9a-f]{64}$/
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const VOLUME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MODE_RE = /^[0-7]{3,4}$/

const REQUIRED_FILE_PATHS = [
  'runtime-meta.json',
  'rootfs/opt/huobao/backend.mjs',
  'rootfs/usr/local/bin/node',
  'proot/bin/proot',
  'proot/libexec/proot/loader',
  'proot/libexec/proot/loader32',
  'proot/lib/libandroid-shmem.so',
  'licenses/THIRD-PARTY.md',
]

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const options = { check: false, source: '', assets: DEFAULT_ASSETS, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') options.check = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--source') options.source = argv[++i] ?? ''
    else if (arg === '--assets') options.assets = argv[++i] ?? ''
    else if (arg.startsWith('--source=')) options.source = arg.slice('--source='.length)
    else if (arg.startsWith('--assets=')) options.assets = arg.slice('--assets='.length)
    else fail(`未知参数：${arg}`)
  }
  return options
}

function latestBuild() {
  if (!existsSync(OUT_ROOT)) fail(`运行时输出目录不存在：${OUT_ROOT}`)
  const builds = readdirSync(OUT_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^build-\d+$/.test(entry.name))
    .map(entry => ({ name: entry.name, index: Number(entry.name.slice('build-'.length)) }))
    .filter(entry => existsSync(join(OUT_ROOT, entry.name, 'manifest.json')))
    .sort((left, right) => left.index - right.index)
  if (builds.length === 0) fail(`没有找到可用的构建产物：${OUT_ROOT}/build-*`)
  return join(OUT_ROOT, builds[builds.length - 1].name)
}

function normalizeManifestPath(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\\') || raw.includes('\u0000')) return null
  if (raw.startsWith('/')) return null
  const trimmed = raw.replace(/\/+$/, '')
  if (!trimmed) return null
  const segments = trimmed.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

function resolveUnder(base, target) {
  const stack = base ? base.split('/').filter(segment => segment && segment !== '.') : []
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (stack.length === 0) return null
      stack.pop()
    } else {
      stack.push(segment)
    }
  }
  return stack.length > 0 ? stack.join('/') : null
}

function resolveSymlinkTarget(entryPath, target) {
  if (typeof target !== 'string' || !target || target.includes('\\') || target.includes('\u0000')) return null
  if (target.startsWith('/')) {
    if (!entryPath.includes('/')) return null
    const container = entryPath.split('/')[0]
    return resolveUnder(container, target)
  }
  const parent = entryPath.split('/').slice(0, -1).join('/')
  return resolveUnder(parent, target)
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('清单不是对象')
  if (manifest.schemaVersion !== 1) fail(`不支持的清单版本：${manifest.schemaVersion}`)
  const meta = manifest.meta ?? fail('清单缺少 meta')
  if (!VERSION_RE.test(meta.runtimeVersion ?? '')) fail('meta.runtimeVersion 非法')
  if (!VERSION_RE.test(meta.appVersion ?? '')) fail('meta.appVersion 非法')
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('清单缺少 files')

  const paths = new Map()
  let fileCount = 0
  let symlinkCount = 0
  let dirCount = 0
  let totalBytes = 0

  for (const [index, item] of manifest.files.entries()) {
    const path = normalizeManifestPath(item?.path)
    if (!path) fail(`files[${index}] 路径非法：${item?.path}`)
    if (paths.has(path)) fail(`重复条目路径：${path}`)
    if (!MODE_RE.test(item.mode ?? '')) fail(`条目权限位非法：${path}`)
    if (item.type === 'dir') {
      dirCount += 1
      paths.set(path, item)
    } else if (item.type === 'file') {
      if (!Number.isSafeInteger(item.size) || item.size < 0) fail(`文件大小非法：${path}`)
      if (!SHA256_RE.test(item.sha256 ?? '')) fail(`文件哈希非法：${path}`)
      fileCount += 1
      totalBytes += item.size
      paths.set(path, item)
    } else if (item.type === 'symlink') {
      if (!resolveSymlinkTarget(path, item.target)) fail(`符号链接目标越界：${path} -> ${item.target}`)
      symlinkCount += 1
      paths.set(path, item)
    } else {
      fail(`未知条目类型：${path} -> ${item.type}`)
    }
  }

  for (const path of paths.keys()) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (parent && paths.get(parent)?.type !== 'dir') fail(`条目父目录缺失或不是目录：${path}`)
  }
  for (const path of REQUIRED_FILE_PATHS) {
    if (paths.get(path)?.type !== 'file') fail(`缺少必需文件：${path}`)
  }
  if (meta.webIncluded && paths.get('rootfs/opt/huobao/web/index.html')?.type !== 'file') {
    fail('缺少前端入口：rootfs/opt/huobao/web/index.html')
  }

  const totals = manifest.totals ?? fail('清单缺少 totals')
  if (totals.fileCount !== fileCount || totals.symlinkCount !== symlinkCount ||
      totals.dirCount !== dirCount || totals.totalBytes !== totalBytes) {
    fail('清单 totals 与实际条目不一致')
  }

  const archive = manifest.archive ?? fail('清单缺少 archive')
  if (archive.format !== 'tar+zstd') fail(`不支持的归档格式：${archive.format}`)
  const whole = archive.whole ?? fail('清单缺少 archive.whole')
  if (!VOLUME_RE.test(whole.name ?? '')) fail('archive.whole.name 非法')
  if (!Number.isSafeInteger(whole.size) || whole.size <= 0) fail('archive.whole.size 非法')
  if (!SHA256_RE.test(whole.sha256 ?? '')) fail('archive.whole.sha256 非法')
  if (!Array.isArray(archive.volumes) || archive.volumes.length === 0) fail('归档分卷为空')
  const names = new Set()
  let volumeBytes = 0
  for (const volume of archive.volumes) {
    if (!VOLUME_RE.test(volume?.name ?? '')) fail(`分卷名非法：${volume?.name}`)
    if (names.has(volume.name)) fail(`重复分卷：${volume.name}`)
    names.add(volume.name)
    if (!Number.isSafeInteger(volume.size) || volume.size <= 0) fail(`分卷大小非法：${volume.name}`)
    if (!SHA256_RE.test(volume.sha256 ?? '')) fail(`分卷哈希非法：${volume.name}`)
    volumeBytes += volume.size
  }
  if (volumeBytes !== whole.size) fail('分卷总大小与归档大小不一致')

  return { manifest, paths, fileCount, symlinkCount, dirCount, totalBytes }
}

async function verifyVolumes(manifest, source) {
  const wholeDigest = createHash('sha256')
  let wholeBytes = 0
  for (const volume of manifest.archive.volumes) {
    const filePath = join(source, volume.name)
    if (!existsSync(filePath)) fail(`缺少分卷文件：${filePath}`)
    const actualSize = statSync(filePath).size
    if (actualSize !== volume.size) fail(`分卷大小不符：${volume.name} (${actualSize} != ${volume.size})`)
    const digest = createHash('sha256')
    await new Promise((resolvePromise, rejectPromise) => {
      const stream = createReadStream(filePath)
      stream.on('error', rejectPromise)
      stream.on('data', chunk => {
        digest.update(chunk)
        wholeDigest.update(chunk)
        wholeBytes += chunk.length
      })
      stream.on('end', resolvePromise)
    })
    if (digest.digest('hex') !== volume.sha256) fail(`分卷哈希不符：${volume.name}`)
  }
  if (wholeBytes !== manifest.archive.whole.size) fail('归档整体大小不符')
  if (wholeDigest.digest('hex') !== manifest.archive.whole.sha256) fail('归档整体哈希不符')
}

function freeBytes(path) {
  let probe = resolve(path)
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
  try {
    const info = statfsSync(probe)
    return Number(info.bavail) * Number(info.bsize)
  } catch {
    return null
  }
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function cleanGeneratedAssets(assetsDir, keepNames) {
  if (!existsSync(assetsDir)) return
  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (entry.name === 'manifest.json' || entry.name.startsWith(VOLUME_PREFIX)) {
      if (!keepNames.has(entry.name)) rmSync(join(assetsDir, entry.name), { force: true })
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('用法：node app/android/scripts/prepare-runtime.mjs [--check] [--source <构建目录>] [--assets <资源目录>]')
    return
  }
  const source = options.source ? resolve(options.source) : latestBuild()
  const assetsDir = resolve(options.assets || DEFAULT_ASSETS)
  const manifestPath = join(source, 'manifest.json')
  if (!existsSync(manifestPath)) fail(`缺少运行时清单：${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const validated = validateManifest(manifest)
  await verifyVolumes(manifest, source)

  const free = freeBytes(options.check ? source : assetsDir)
  if (free !== null && free < validated.totalBytes + SPACE_MARGIN) {
    console.warn(`警告：可用空间 ${formatBytes(free)} 低于解压需求 ${formatBytes(validated.totalBytes + SPACE_MARGIN)}`)
  }

  console.log(`运行时：${manifest.meta.runtimeVersion}（应用 ${manifest.meta.appVersion}）`)
  console.log(`条目：文件 ${validated.fileCount} / 符号链接 ${validated.symlinkCount} / 目录 ${validated.dirCount}`)
  console.log(`解压大小：${formatBytes(validated.totalBytes)}；压缩包：${formatBytes(manifest.archive.whole.size)}`)
  console.log(`归档哈希：${manifest.archive.whole.sha256.slice(0, 16)}…；分卷 ${manifest.archive.volumes.length} 个`)
  console.log(`来源：${source}`)
  if (options.check) {
    console.log('校验通过（未写入 assets）')
    return
  }

  mkdirSync(assetsDir, { recursive: true })
  const keepNames = new Set(['manifest.json', ...manifest.archive.volumes.map(volume => volume.name)])
  cleanGeneratedAssets(assetsDir, keepNames)
  copyFileSync(manifestPath, join(assetsDir, 'manifest.json'))
  for (const volume of manifest.archive.volumes) {
    const target = join(assetsDir, volume.name)
    copyFileSync(join(source, volume.name), target)
    if (statSync(target).size !== volume.size) fail(`复制后分卷大小不符：${volume.name}`)
  }
  console.log(`已写入 assets：${assetsDir}`)
}

main().catch(error => {
  console.error(`错误：${error.message}`)
  process.exitCode = 1
})
