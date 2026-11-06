/**
 * 源成片初始计划（设计 §6.1）：
 * - 单片段 `source.kind='merge'`，画幅取成片宽高比、帧率取成片帧率（兜底 30）；
 * - 外挂 SRT（未烧录）导入为 import 字幕；烧录/历史混音给出常驻提示；
 * - 不按台词本生成字幕，避免时间轴错位。
 */
import fs from 'node:fs'
import {
  bootstrapFps,
  createSingleClipPlan,
  projectSettingsForAspect,
  type EditIssue,
  type EditPlanV1,
} from './edit-plan.js'
import { editSourceFromUrl } from './edit-media.js'
import { getAbsolutePath } from '../utils/storage.js'

export interface FilmRowLike {
  id: number
  title: string | null
  mergedUrl: string | null
  subtitleUrl: string | null
  subtitleBurned: boolean | number | null
  kind: string | null
}

function srtTimeToMs(raw: string): number {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/)
  if (!match) return NaN
  const [, h, m, s, ms] = match
  return (
    Number(h) * 3_600_000
    + Number(m) * 60_000
    + Number(s) * 1000
    + Number(ms.padEnd(3, '0'))
  )
}

export function parseSrtCues(text: string): { startMs: number; endMs: number; text: string }[] {
  const cues: { startMs: number; endMs: number; text: string }[] = []
  const blocks = text.replace(/\r\n/g, '\n').trim().split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex < 0) continue
    const [rawStart, rawEnd] = lines[timeIndex].split('-->')
    const startMs = srtTimeToMs(rawStart)
    const endMs = srtTimeToMs(rawEnd)
    const body = lines.slice(timeIndex + 1).join('\n').trim()
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !body || endMs <= startMs) continue
    cues.push({ startMs, endMs, text: body })
  }
  return cues
}

function aspectFor(width: number, height: number): '9:16' | '16:9' | '1:1' {
  if (Math.abs(width - height) <= 2) return '1:1'
  return width > height ? '16:9' : '9:16'
}

export async function buildFilmEditPlan(input: {
  episodeId: number
  film: FilmRowLike
  warnings: EditIssue[]
}): Promise<EditPlanV1 | null> {
  const url = input.film.mergedUrl
  if (!url) return null
  let source
  try {
    source = await editSourceFromUrl({
      kind: 'merge',
      id: input.film.id,
      url,
      label: input.film.title?.trim() || `成片 ${input.film.id}`,
    })
  } catch (error) {
    input.warnings.push({
      severity: 'warning',
      code: 'MEDIA_MISSING',
      path: 'video_merges.merged_url',
      message: error instanceof Error ? error.message : '成片不可读',
    })
    return null
  }

  const fps = bootstrapFps(source.fps ?? 30)
  const plan = createSingleClipPlan(
    input.episodeId,
    source,
    projectSettingsForAspect(aspectFor(source.width, source.height), fps),
  )
  plan.project.fps = fps

  const burned = Boolean(input.film.subtitleBurned)
  if (input.film.subtitleUrl && !burned) {
    // 字幕文件缺失/不可读不应让整个初始计划 500：给出告警并继续返回可用计划。
    try {
      const abs = getAbsolutePath(input.film.subtitleUrl)
      const text = fs.readFileSync(abs, 'utf8')
      for (const [index, cue] of parseSrtCues(text).entries()) {
        plan.subtitles.push({
          id: `cue_import_${index + 1}`,
          text: cue.text,
          startMs: cue.startMs,
          endMs: cue.endMs,
          style: 'default',
          role: null,
          source: 'import',
          follow: false,
          anchor: null,
          lineId: null,
          warnings: [],
        })
      }
    } catch (error) {
      input.warnings.push({
        severity: 'warning',
        code: 'SUBTITLE_IMPORT_FAILED',
        path: 'video_merges.subtitle_url',
        message: error instanceof Error ? `字幕文件不可读，已跳过导入（${error.message}）` : '字幕文件不可读，已跳过导入',
      })
    }
  } else if (burned) {
    input.warnings.push({
      severity: 'warning',
      code: 'SUBTITLE_BURNED',
      path: 'video_merges.subtitle_burned',
      message: '这部成片已包含烧录字幕，新增字幕会叠加，请确认后再添加',
    })
  } else if ((input.film.kind ?? '') === 'mix') {
    input.warnings.push({
      severity: 'warning',
      code: 'MIX_FILM_SUBTITLE_UNKNOWN',
      path: 'video_merges.kind',
      message: '历史混音成片可能已烧录字幕，叠加字幕前请确认',
    })
  } else {
    input.warnings.push({
      severity: 'warning',
      code: 'SUBTITLE_EMPTY',
      path: 'subtitles',
      message: '可手动添加字幕，或去配音页生成台词',
    })
  }
  return plan
}
