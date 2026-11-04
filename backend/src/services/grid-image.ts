/**
 * 宫格图（V2 · M4-2）
 *
 * 一次生成 rows×cols 张同风格素材（角色一致性最好），再按坐标裁成单格。
 * 生成走现有图片任务（异步），切分时再同步任务结果，避免在请求里长时间等待。
 */
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { projectStorageRelative, projectSubdirPath } from './project-storage.js'
import { generateImage } from './generation.js'
import { ffmpeg } from '../utils/ffmpeg.js'

export interface GridCell {
  row: number
  col: number
  url: string
}

export interface GridSheet {
  id: number
  imageUrl: string | null
  cells: GridCell[]
  status: string
  taskId: number | null
}

function parseCells(raw: string | null | undefined): GridCell[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : (parsed.cells || [])
  } catch {
    return []
  }
}

function buildGridPrompt(kind: string, rows: number, cols: number, prompt: string | null | undefined, targets: string[]): string {
  const subject = kind === 'character' ? '角色设定图' : kind === 'prop' ? '道具设定图' : '场景设定图'
  const list = targets.length ? `按顺序：${targets.join('、')}。` : ''
  return [
    `一张 ${rows}×${cols} 的${subject}，等分为 ${rows} 行 ${cols} 列，格子之间留窄白边，不要在格内写任何文字。`,
    list,
    '同一张图内所有格保持统一的画风、光线与时代质感，主体居中等大，背景简洁。',
    prompt || '',
  ].filter(Boolean).join('\n')
}

/** 创建宫格任务：返回 sheet（status=processing，带 task_id） */
export async function createGridSheet(input: {
  dramaId: number
  episodeId?: number | null
  kind: string
  rows: number
  cols: number
  prompt?: string | null
  targets?: string[]
  model?: string
  configId?: number
  inset?: number
}): Promise<GridSheet> {
  if (!['character', 'scene', 'prop'].includes(input.kind)) throw new Error('kind 只支持 character/scene/prop')
  if (input.rows < 1 || input.rows > 5 || input.cols < 1 || input.cols > 5) throw new Error('行列数需在 1–5 之间')

  const prompt = buildGridPrompt(input.kind, input.rows, input.cols, input.prompt, input.targets || [])
  const ts = now()
  const taskId = await generateImage({
    dramaId: input.dramaId,
    prompt,
    model: input.model,
    configId: input.configId,
  })

  const res = db.insert(schema.gridSheets).values({
    dramaId: input.dramaId,
    episodeId: input.episodeId ?? null,
    kind: input.kind,
    rows: input.rows,
    cols: input.cols,
    prompt,
    cells: JSON.stringify({ task_id: taskId, targets: input.targets || [], cells: [] }),
    inset: input.inset ?? 0.015,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const id = Number((res as any).lastInsertRowid)
  return { id, imageUrl: null, cells: [], status: 'processing', taskId }
}

/** 读任务结果，把宫格图落到 grid_sheets */
export async function syncGridSheet(id: number): Promise<GridSheet> {
  const row = db.select().from(schema.gridSheets).where(eq(schema.gridSheets.id, id)).get()
  if (!row) throw new Error('宫格不存在')
  const meta = (() => {
    try { return JSON.parse(row.cells || '{}') } catch { return {} }
  })()
  let imageUrl = row.imageUrl
  let status = row.status || 'pending'

  if (status === 'processing' && meta.task_id) {
    const task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(meta.task_id))).get()
    if (task?.status === 'completed') {
      imageUrl = task.localPath || task.resultUrl || null
      status = imageUrl ? 'generated' : 'failed'
    } else if (task?.status === 'failed') {
      status = 'failed'
    }
    if (status !== 'processing') {
      db.update(schema.gridSheets).set({ imageUrl, status, updatedAt: now() }).where(eq(schema.gridSheets.id, id)).run()
    }
  }

  return { id, imageUrl, cells: parseCells(row.cells), status, taskId: meta.task_id ? Number(meta.task_id) : null }
}

export interface CropOptions {
  inset?: number
  /** 手动覆盖每格坐标（相对整图 0–1） */
  cells?: { row: number; col: number; x: number; y: number; w: number; h: number }[]
}

export interface GridCrop {
  x: number
  y: number
  w: number
  h: number
}

/** 等分 + 内缩（或人工比例）换算为像素裁剪框 */
export function computeGridCrop(
  width: number,
  height: number,
  rows: number,
  cols: number,
  row: number,
  col: number,
  inset: number,
  override?: { x: number; y: number; w: number; h: number },
): GridCrop {
  const cellW = width / cols
  const cellH = height / rows
  const x = override ? override.x * width : col * cellW + cellW * inset
  const y = override ? override.y * height : row * cellH + cellH * inset
  const w = override ? override.w * width : cellW * (1 - inset * 2)
  const h = override ? override.h * height : cellH * (1 - inset * 2)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/**
 * 按坐标裁切宫格。默认等分 + 内缩，避免把分隔线切进画面。
 * 输出到项目 grid 目录，返回每格 URL。
 */
export async function splitGridSheet(id: number, options: CropOptions = {}): Promise<GridCell[]> {
  const sheet = await syncGridSheet(id)
  if (sheet.status !== 'generated' || !sheet.imageUrl) throw new Error('宫格图还没生成完成')
  const row = db.select().from(schema.gridSheets).where(eq(schema.gridSheets.id, id)).get()!
  const abs = getAbsolutePath(sheet.imageUrl)
  if (!fs.existsSync(abs)) throw new Error('宫格图文件不存在')

  const inset = options.inset ?? row.inset ?? 0.015
  const dir = projectSubdirPath(row.dramaId, 'grid')
  fs.mkdirSync(dir, { recursive: true })

  const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    ffmpeg.ffprobe(abs, (err, meta) => {
      if (err) return reject(new Error('无法读取宫格图尺寸'))
      const stream = (meta.streams || []).find((s) => s.codec_type === 'video')
      resolve({ width: Number(stream?.width || 0), height: Number(stream?.height || 0) })
    })
  })
  if (!size.width || !size.height) throw new Error('无法读取宫格图尺寸')

  const cells: GridCell[] = []
  // 人工校正过的坐标优先：PUT /grid/:id/cells 会存 meta.rects，重切时自动生效
  const savedRects = (() => {
    try { return JSON.parse(row.cells || '{}').rects } catch { return null }
  })()
  const manual = options.cells?.length ? options.cells : (Array.isArray(savedRects) ? savedRects : [])
  for (let r = 0; r < row.rows; r += 1) {
    for (let c = 0; c < row.cols; c += 1) {
      const rect = computeGridCrop(size.width, size.height, row.rows, row.cols, r, c, inset, manual.find((m) => m.row === r && m.col === c))
      const filename = `sheet-${id}-${r}-${c}.png`
      const target = path.join(dir, filename)
      await new Promise<void>((resolve, reject) => {
        ffmpeg(abs)
          .outputOptions(['-y', '-vf', `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`, '-frames:v', '1'])
          .output(target)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run()
      })
      cells.push({ row: r, col: c, url: projectStorageRelative(row.dramaId, 'grid', filename) })
    }
  }

  db.update(schema.gridSheets)
    .set({ cells: JSON.stringify({ task_id: (() => { try { return JSON.parse(row.cells || '{}').task_id } catch { return null } })(), cells, targets: (() => { try { return JSON.parse(row.cells || '{}').targets } catch { return [] } })(), inset }), status: 'split', updatedAt: now() })
    .where(eq(schema.gridSheets.id, id))
    .run()
  return cells
}

/** 人工校正切分坐标 */
export function updateGridCells(id: number, cells: { row: number; col: number; x: number; y: number; w: number; h: number }[], inset?: number) {
  const row = db.select().from(schema.gridSheets).where(eq(schema.gridSheets.id, id)).get()
  if (!row) throw new Error('宫格不存在')
  const meta = (() => { try { return JSON.parse(row.cells || '{}') } catch { return {} } })()
  db.update(schema.gridSheets).set({
    cells: JSON.stringify({ ...meta, rects: cells }),
    inset: inset ?? row.inset,
    updatedAt: now(),
  }).where(eq(schema.gridSheets.id, id)).run()
  return { updated: true }
}
