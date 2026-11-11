#!/usr/bin/env node
/**
 * 后端 bundle（linux/arm64 运行时用）——与 desktop/scripts/build-backend.mjs 同一策略：
 * ESM 单文件、external 原生模块与 FFmpeg 静态包、banner 注入 require/__dirname。
 * FFmpeg 静态包不安装到运行时，external 后由后端能力探测判定不可用。
 */
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const REPO = process.env.REPO_ROOT || '/work'
const OUT_DIR = process.env.OUT_DIR || '/build/context'
const ENTRY = path.join(REPO, 'backend/src/index.ts')
const OUTFILE = path.join(OUT_DIR, 'backend.mjs')
const nodePaths = (process.env.NODE_PATHS || '').split(path.delimiter).filter(Boolean)

if (!fs.existsSync(ENTRY)) {
  console.error(`缺少后端入口: ${ENTRY}`)
  process.exit(1)
}
fs.mkdirSync(OUT_DIR, { recursive: true })

esbuild
  .build({
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: false,
    legalComments: 'eof',
    nodePaths,
    external: ['sharp', 'better-sqlite3', 'ffmpeg-static', 'ffprobe-static'],
    banner: {
      js: [
        `import { createRequire as __hbCreateRequire } from 'module'`,
        `import __hbPath from 'path'`,
        `import { fileURLToPath as __hbFileURLToPath } from 'url'`,
        `const require = __hbCreateRequire(import.meta.url)`,
        `var __filename = __hbFileURLToPath(import.meta.url)`,
        `var __dirname = __hbPath.dirname(__filename)`,
      ].join('\n'),
    },
    logLevel: 'info',
  })
  .then(() => {
    const size = fs.statSync(OUTFILE).size
    console.log(`backend.mjs ${(size / 1024 / 1024).toFixed(2)} MB`)
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
