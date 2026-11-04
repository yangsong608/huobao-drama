/**
 * 宫格切分：2×2 等分 + 内缩，坐标不越界
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-grid-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static')
const ffprobeBin: string = process.env.FFPROBE_BIN || require('ffprobe-static').path

const { db, schema } = await import('../src/db/index.ts')
const { splitGridSheet, computeGridCrop } = await import('../src/services/grid-image.ts')

const ts = '2026-01-01T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '宫格测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('2×2 宫格切成 4 张，文件非空且不越界', async () => {
  const dir = path.join(root, 'static', 'projects', '1', 'images')
  await fs.mkdir(dir, { recursive: true })
  const sheet = path.join(dir, 'sheet.png')
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:s=800x800', '-frames:v', '1', sheet,
  ])

  const res = db.insert(schema.gridSheets).values({
    dramaId: 1, kind: 'character', rows: 2, cols: 2,
    imageUrl: 'static/projects/1/images/sheet.png',
    status: 'generated', inset: 0.02, createdAt: ts, updatedAt: ts,
  }).run()
  const id = Number((res as any).lastInsertRowid)

  const cells = await splitGridSheet(id)
  assert.equal(cells.length, 4)
  assert.deepEqual(cells.map(c => `${c.row}-${c.col}`), ['0-0', '0-1', '1-0', '1-1'])
  for (const cell of cells) {
    const abs = path.join(root, cell.url)
    assert.ok(fsSync.existsSync(abs), `缺少切图 ${cell.url}`)
    assert.ok(fsSync.statSync(abs).size > 0, `切图为空 ${cell.url}`)
    const size = probeSize(abs)
    assert.ok(Math.abs(size.width - 384) <= 2, `切图宽度 ${size.width}，期望 384±2`)
    assert.ok(Math.abs(size.height - 384) <= 2, `切图高度 ${size.height}，期望 384±2`)
  }
})

test('坐标计算：等分 + 内缩误差 ≤2px，人工作者按比例生效', () => {
  const cases = [
    { width: 800, height: 800, rows: 2, cols: 2, inset: 0.02 },
    { width: 801, height: 799, rows: 3, cols: 2, inset: 0.015 },
    { width: 1080, height: 1920, rows: 4, cols: 3, inset: 0 },
  ]
  for (const k of cases) {
    const cellW = k.width / k.cols
    const cellH = k.height / k.rows
    for (let r = 0; r < k.rows; r += 1) {
      for (let c = 0; c < k.cols; c += 1) {
        const rect = computeGridCrop(k.width, k.height, k.rows, k.cols, r, c, k.inset)
        const idealX = c * cellW + cellW * k.inset
        const idealY = r * cellH + cellH * k.inset
        const idealW = cellW * (1 - k.inset * 2)
        const idealH = cellH * (1 - k.inset * 2)
        assert.ok(Math.abs(rect.x - idealX) <= 2, `${k.width}x${k.height} ${r}-${c} x=${rect.x} 期望 ${idealX}`)
        assert.ok(Math.abs(rect.y - idealY) <= 2, `${k.width}x${k.height} ${r}-${c} y=${rect.y} 期望 ${idealY}`)
        assert.ok(Math.abs(rect.w - idealW) <= 2, `${k.width}x${k.height} ${r}-${c} w=${rect.w} 期望 ${idealW}`)
        assert.ok(Math.abs(rect.h - idealH) <= 2, `${k.width}x${k.height} ${r}-${c} h=${rect.h} 期望 ${idealH}`)
        assert.ok(rect.x >= 0 && rect.y >= 0, `${r}-${c} 坐标为负`)
        assert.ok(rect.x + rect.w <= k.width && rect.y + rect.h <= k.height, `${r}-${c} 越界`)
      }
    }
  }

  const manual = computeGridCrop(800, 800, 2, 2, 0, 0, 0, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
  assert.deepEqual(manual, { x: 80, y: 160, w: 240, h: 320 })
})

test('2×2 四色象限：实际切图坐标误差 ≤2px', async () => {
  const dir = path.join(root, 'static', 'projects', '1', 'images')
  await fs.mkdir(dir, { recursive: true })
  const sheetAbs = path.join(dir, 'quad.png')
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=200x200:d=1',
    '-f', 'lavfi', '-i', 'color=c=lime:s=200x200:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=200x200:d=1',
    '-f', 'lavfi', '-i', 'color=c=white:s=200x200:d=1',
    '-filter_complex',
    '[0][1]hstack=inputs=2[top];[2][3]hstack=inputs=2[bottom];[top][bottom]vstack=inputs=2,format=rgb24',
    '-frames:v', '1', sheetAbs,
  ])

  const res = db.insert(schema.gridSheets).values({
    dramaId: 1, kind: 'scene', rows: 2, cols: 2,
    imageUrl: 'static/projects/1/images/quad.png',
    status: 'generated', inset: 0, createdAt: ts, updatedAt: ts,
  }).run()
  const id = Number((res as any).lastInsertRowid)
  const cells = await splitGridSheet(id)

  const expected = [
    { color: [255, 0, 0], label: '红' },
    { color: [0, 255, 0], label: '绿' },
    { color: [0, 0, 255], label: '蓝' },
    { color: [255, 255, 255], label: '白' },
  ]
  cells.forEach((cell, i) => {
    const abs = path.join(root, cell.url)
    const frame = decodeRgb(abs)
    assert.ok(Math.abs(frame.width - 200) <= 2, `${cell.row}-${cell.col} 宽 ${frame.width}，期望 200±2`)
    assert.ok(Math.abs(frame.height - 200) <= 2, `${cell.row}-${cell.col} 高 ${frame.height}，期望 200±2`)
    const tl = pixelAt(frame, 0, 0)
    const br = pixelAt(frame, frame.width - 1, frame.height - 1)
    assert.ok(nearColor(tl, expected[i].color), `${cell.row}-${cell.col} 左上角 ${tl} 不是${expected[i].label}色`)
    assert.ok(nearColor(br, expected[i].color), `${cell.row}-${cell.col} 右下角 ${br} 不是${expected[i].label}色`)
  })
})

function probeSize(file: string): { width: number; height: number } {
  const out = execFileSync(ffprobeBin, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' }).trim()
  const [width, height] = out.split(',').map(Number)
  return { width, height }
}

function decodeRgb(file: string): { width: number; height: number; data: Buffer } {
  const size = probeSize(file)
  const data = execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 64 * 1024 * 1024 })
  return { ...size, data }
}

function pixelAt(frame: { width: number; data: Buffer }, x: number, y: number): [number, number, number] {
  const offset = (y * frame.width + x) * 3
  return [frame.data[offset], frame.data[offset + 1], frame.data[offset + 2]]
}

function nearColor(actual: number[], expected: number[], tolerance = 12): boolean {
  return actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance)
}
