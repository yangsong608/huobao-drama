import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getReadableEpisode } from './edit-access.js'
import { editSourceFromUrl } from './edit-media.js'

export interface EditMediaStoryboardResponse {
  id: number
  number: number
  title: string | null
  thumbnail_url: string | null
  video_url: string | null
  source: Awaited<ReturnType<typeof editSourceFromUrl>> | null
  playable: boolean
  error: string | null
}

export async function getEditMediaLibrary(episodeId: number) {
  getReadableEpisode(episodeId)

  const storyboardRows = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()

  const storyboards: EditMediaStoryboardResponse[] = []
  for (const row of storyboardRows) {
    const url = row.videoUrl || row.composedVideoUrl || ''
    let source: EditMediaStoryboardResponse['source'] = null
    let error: string | null = null
    if (url) {
      try {
        source = await editSourceFromUrl({
          kind: 'storyboard',
          id: row.id,
          url,
          label: `分镜 ${row.storyboardNumber}`,
        })
      } catch (cause) {
        error = cause instanceof Error ? cause.message : '素材不可读'
      }
    } else {
      error = '分镜没有视频'
    }
    storyboards.push({
      id: row.id,
      number: row.storyboardNumber,
      title: row.title,
      thumbnail_url: row.firstFrameImage || row.composedImage || null,
      video_url: url || null,
      source,
      playable: Boolean(source),
      error,
    })
  }

  const lineRows = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .all()
  const lineMap = new Map(lineRows.map((row) => [row.id, row]))
  const lines = lineRows.map((row) => ({
    id: row.id,
    line_no: row.lineNo,
    storyboard_id: row.storyboardId,
    speaker_name: row.speakerName,
    speaker_type: row.speakerType,
    text: row.text,
    subtitle_text: row.subtitleText,
    status: row.status,
    audio_url: row.audioUrl,
    duration_ms: row.voiceDurationMs ?? row.audioDurationMs,
    voice_start_ms: row.voiceStartMs,
    anchor_type: row.anchorType,
  }))

  const takeRows = db.select().from(schema.lineTakes)
    .where(and(
      eq(schema.lineTakes.episodeId, episodeId),
      isNull(schema.lineTakes.deletedAt),
    ))
    .all()
  const videoTakes = takeRows
    .filter((row) => row.status === 'ready' && Boolean(row.audioUrl))
    .map((row) => ({
      id: row.id,
      line_id: row.lineId,
      take_no: row.takeNo,
      audio_url: row.audioUrl,
      duration_ms: row.durationMs,
      hash: row.hash,
      is_active: row.isActive,
      status: row.status,
      text: lineMap.get(row.lineId)?.text ?? '',
      speaker_name: lineMap.get(row.lineId)?.speakerName ?? null,
    }))

  return {
    storyboards,
    video_takes: videoTakes,
    lines,
    audio: { mix: null, audio_ref: null },
    import_enabled: false,
  }
}
