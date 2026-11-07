/**
 * 智能体剪辑/混音只读路径（A2-1）与五只读工具（A2-2）：
 * - getEpisodeEditState(...,{readOnly:true}) 不建工程、不落初始计划、不补总线；
 * - compileEpisodePlan/compileMixPlan/compileMixPlanDetailed/compilePlanWithoutSource 只读时内存补默认总线；
 * - 无成片降级同样只读；
 * - 默认调用保持原行为（打开工程、落版本、补总线）；
 * - 五工具按作用域注册，只读、不含 URL/路径，片段 stale/missing、混音三态、导出软删均正确。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-agent-edit-readonly-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const { getEpisodeEditState } = await import('../src/services/edit-service.ts')
const { compileEpisodePlan, compileMixPlan } = await import('../src/services/mix-plan.ts')
const { createSingleClipPlan, projectSettingsForAspect } = await import('../src/services/edit-plan.ts')
const { getPresetTools } = await import('../src/agents/tools/read-tools.ts')
const { buildAssistantRequestContext } = await import('../src/agents/context.ts')
const { editHashesForEpisode } = await import('../src/services/edit-mix-sync.ts')
const { probeEditMedia } = await import('../src/services/edit-media.ts')

const ts = '2026-11-07T00:00:00.000Z'
setEditWorkspaceMode('on')

const drama = db.insert(schema.dramas).values({
  title: '只读路径', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const shotPath = path.join(videoDir, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2',
  '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
  '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-ar', '48000', shotPath,
])
const shotUrl = `static/projects/${drama.id}/videos/shot.mp4`
const shotFingerprint = (await probeEditMedia(shotUrl)).fingerprint

function insertEpisode(number: number, title: string) {
  return db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: number, title, createdAt: ts, updatedAt: ts,
  }).returning().get()
}

function insertFilm(episodeId: number) {
  return db.insert(schema.videoMerges).values({
    episodeId, dramaId: drama.id, title: '源成片', provider: 'ffmpeg', model: 'test',
    status: 'completed', kind: 'concat', origin: 'concat', mergedUrl: shotUrl, duration: 2,
    createdAt: ts, completedAt: ts,
  }).returning().get()
}

function insertProject(episodeId: number, sourceMergeId: number) {
  return db.insert(schema.editProjects).values({
    episodeId, dramaId: drama.id, sourceMergeId, sourceUrl: shotUrl,
    sourceFingerprint: 'fp', title: '剪辑工程', createdAt: ts, updatedAt: ts,
  }).returning().get()
}

function singleClipPlan(episodeId: number, filmId: number) {
  return createSingleClipPlan(episodeId, {
    kind: 'merge', id: filmId, url: shotUrl, durationMs: 2000,
    width: 320, height: 240, fps: 25, hasAudio: true, fingerprint: 'fp',
  }, projectSettingsForAspect('16:9', 25))
}

function insertDraft(episodeId: number, projectId: number, plan: unknown) {
  return db.insert(schema.episodeEditDrafts).values({
    episodeId, dramaId: drama.id, projectId,
    planJson: JSON.stringify(plan), version: 1, createdAt: ts, updatedAt: ts,
  }).returning().get()
}

function rowCounts() {
  return {
    projects: db.select().from(schema.editProjects).all().length,
    drafts: db.select().from(schema.episodeEditDrafts).all().length,
    revisions: db.select().from(schema.editRevisions).all().length,
    buses: db.select().from(schema.audioBuses).all().length,
  }
}

const filmOnlyEpisode = insertEpisode(1, '有成片无工程')
const filmOnly = insertFilm(filmOnlyEpisode.id)
db.update(schema.episodes).set({ currentFilmId: filmOnly.id })
  .where(eq(schema.episodes.id, filmOnlyEpisode.id)).run()

const emptyEpisode = insertEpisode(2, '无成片无工程')

const projectEpisode = insertEpisode(3, '已有工程')
const projectFilm = insertFilm(projectEpisode.id)
const project = insertProject(projectEpisode.id, projectFilm.id)
const projectPlan = singleClipPlan(projectEpisode.id, projectFilm.id)
insertDraft(projectEpisode.id, project.id, projectPlan)
db.update(schema.episodes).set({ editProjectId: project.id })
  .where(eq(schema.episodes.id, projectEpisode.id)).run()

const noBusEpisode = insertEpisode(4, '只读混音无总线')
insertFilm(noBusEpisode.id)

const defaultEpisode = insertEpisode(5, '默认写路径')
insertFilm(defaultEpisode.id)

// A2-2 工具夹具：对齐工程（指纹与文件一致 + 对齐混音版本 + 导出记录）
const toolEpisode = insertEpisode(6, '工具-对齐')
const toolFilm = insertFilm(toolEpisode.id)
const toolProject = insertProject(toolEpisode.id, toolFilm.id)
const toolSource = {
  kind: 'merge' as const, id: toolFilm.id, url: shotUrl, durationMs: 2000,
  width: 320, height: 240, fps: 25, hasAudio: true, fingerprint: shotFingerprint,
}
const toolPlan = createSingleClipPlan(toolEpisode.id, toolSource, projectSettingsForAspect('16:9', 25))
db.insert(schema.episodeEditDrafts).values({
  episodeId: toolEpisode.id, dramaId: drama.id, projectId: toolProject.id,
  planJson: JSON.stringify(toolPlan), planHash: 'tool-plan-hash', version: 1,
  createdAt: ts, updatedAt: ts,
}).run()
const toolRevision = db.insert(schema.editRevisions).values({
  episodeId: toolEpisode.id, revisionNo: 1, planJson: JSON.stringify(toolPlan),
  planHash: 'tool-plan-hash', editSyncHash: 'tool-sync-hash', isCurrent: true,
  clipCount: 1, durationMs: 2000, projectId: toolProject.id, createdAt: ts,
}).returning().get()
db.update(schema.episodes).set({ currentFilmId: toolFilm.id, editProjectId: toolProject.id })
  .where(eq(schema.episodes.id, toolEpisode.id)).run()
const toolHashes = editHashesForEpisode(toolEpisode.id)!
db.insert(schema.mixRevisions).values({
  episodeId: toolEpisode.id, revisionNo: 1, planJson: '{}', planHash: toolHashes.editPlanHash,
  note: '对齐混音', isCurrent: true, createdAt: ts,
  editRevisionId: toolHashes.editRevisionId, editSyncHash: toolHashes.editSyncHash,
  dialogueSyncHash: toolHashes.dialogueSyncHash, sourceKind: 'legacy', sourceFilmId: toolFilm.id,
}).run()

// 素材变化（指纹不一致）与素材丢失（文件不存在）
const staleEpisode = insertEpisode(7, '工具-素材变化')
const staleFilm = insertFilm(staleEpisode.id)
const staleProject = insertProject(staleEpisode.id, staleFilm.id)
insertDraft(staleEpisode.id, staleProject.id, createSingleClipPlan(staleEpisode.id, {
  ...toolSource, id: staleFilm.id, fingerprint: 'old-fingerprint',
}, projectSettingsForAspect('16:9', 25)))
db.update(schema.episodes).set({ editProjectId: staleProject.id })
  .where(eq(schema.episodes.id, staleEpisode.id)).run()
db.insert(schema.mixRevisions).values({
  episodeId: staleEpisode.id, revisionNo: 1, planJson: '{}', isCurrent: true,
  createdAt: ts, editSyncHash: 'outdated-hash', sourceKind: 'legacy',
}).run()

const missingEpisode = insertEpisode(8, '工具-素材丢失')
const missingFilm = insertFilm(missingEpisode.id)
const missingProject = insertProject(missingEpisode.id, missingFilm.id)
insertDraft(missingEpisode.id, missingProject.id, createSingleClipPlan(missingEpisode.id, {
  ...toolSource, id: missingFilm.id, url: `static/projects/${drama.id}/videos/gone.mp4`,
}, projectSettingsForAspect('16:9', 25)))
db.update(schema.episodes).set({ editProjectId: missingProject.id })
  .where(eq(schema.episodes.id, missingEpisode.id)).run()

// 导出记录：正常、失败、软删；来源成片按 (export_id, episode_id) 匹配
const otherEpisode = insertEpisode(9, '工具-其他集')
const exportOk = db.insert(schema.episodeExports).values({
  episodeId: toolEpisode.id, kind: 'edit', preset: '1080p', status: 'completed',
  progress: 100, durationMs: 2000, sizeBytes: 1024, isCurrent: true,
  renderMode: 'edit', subtitleMode: 'burned', outputUrl: shotUrl, projectId: toolProject.id,
  planRevisionId: 11, editRevisionId: 12, mixRevisionId: 13, sourceMergeId: toolFilm.id,
  createdAt: '2026-11-07T02:00:00.000Z', finishedAt: '2026-11-07T02:01:00.000Z',
}).returning().get()
const failedExport = db.insert(schema.episodeExports).values({
  episodeId: toolEpisode.id, kind: 'edit', status: 'failed', progress: 40,
  error: '/Volumes/secret/path/render.log 失败\n第二行',
  createdAt: '2026-11-07T03:00:00.000Z',
}).returning().get()
const deletedExport = db.insert(schema.episodeExports).values({
  episodeId: toolEpisode.id, kind: 'edit', status: 'completed',
  createdAt: '2026-11-07T04:00:00.000Z', deletedAt: ts,
}).returning().get()
const exportFilm = db.insert(schema.videoMerges).values({
  episodeId: toolEpisode.id, dramaId: drama.id, exportId: exportOk.id, title: '导出成片',
  provider: 'ffmpeg', model: 'test', status: 'completed', kind: 'edit', origin: 'edit',
  mergedUrl: shotUrl, duration: 2, createdAt: ts, completedAt: ts,
}).returning().get()
const otherExport = db.insert(schema.episodeExports).values({
  episodeId: otherEpisode.id, kind: 'merge', status: 'completed',
  createdAt: '2026-11-07T05:00:00.000Z',
}).returning().get()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('只读状态：有成片无工程时不建工程，返回临时成片计划', async () => {
  const before = rowCounts()
  const state = await getEpisodeEditState(filmOnlyEpisode.id, null, { readOnly: true })
  assert.equal(state.project, null)
  assert.equal(state.plan.clips.length, 1)
  assert.deepEqual(rowCounts(), before)
})

test('只读状态：无成片时返回空态，不建任何行', async () => {
  const before = rowCounts()
  const state = await getEpisodeEditState(emptyEpisode.id, null, { readOnly: true })
  assert.equal(state.project, null)
  assert.equal(state.empty_reason, 'NO_FILM')
  assert.equal(state.plan.clips.length, 0)
  assert.deepEqual(rowCounts(), before)
})

test('只读状态：已有工程与草稿原样返回，不写草稿/版本', async () => {
  const before = rowCounts()
  const state = await getEpisodeEditState(projectEpisode.id, project.id, { readOnly: true })
  assert.equal(state.project?.id, project.id)
  assert.equal(state.plan.clips.length, 1)
  assert.equal(state.draft?.version, 1)
  assert.deepEqual(rowCounts(), before)
})

test('只读编译：缺失总线在内存补齐，不写 audio_buses', async () => {
  const before = rowCounts()
  const { plan, warnings } = await compileEpisodePlan(noBusEpisode.id, drama.id, null, { readOnly: true })
  assert.deepEqual(warnings, [])
  assert.equal(plan.buses.length, 5)
  assert.deepEqual(plan.buses.map((bus) => bus.key), ['dialogue', 'original', 'sfx', 'bgm', 'master'])
  assert.ok(plan.buses.every((bus) => bus.id < 0))
  assert.equal(plan.source?.kind, 'concat')
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(plan)))
  assert.deepEqual(rowCounts(), before)
})

test('只读降级：无成片时保留 MIX_SOURCE_FALLBACK，仍不写 audio_buses', async () => {
  const before = rowCounts()
  const { plan, warnings } = await compileEpisodePlan(emptyEpisode.id, drama.id, null, { readOnly: true })
  assert.ok(warnings.some((item) => item.code === 'MIX_SOURCE_FALLBACK'), JSON.stringify(warnings))
  assert.equal(plan.buses.length, 5)
  assert.ok(plan.buses.every((bus) => bus.id < 0))
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(plan)))
  assert.deepEqual(rowCounts(), before)
})

test('默认调用保持写行为：自动开工程、落版本与草稿、补默认总线', async () => {
  const before = rowCounts()
  const state = await getEpisodeEditState(defaultEpisode.id)
  assert.ok(state.project)
  const afterState = rowCounts()
  assert.equal(afterState.projects, before.projects + 1)
  assert.equal(afterState.revisions, before.revisions + 1)
  assert.equal(afterState.drafts, before.drafts + 1)

  const beforeMix = rowCounts()
  const plan = await compileMixPlan(defaultEpisode.id, drama.id)
  assert.equal(plan.buses.length, 5)
  assert.equal(rowCounts().buses, beforeMix.buses + 5)
})

function fullCounts() {
  return {
    ...rowCounts(),
    exports: db.select().from(schema.episodeExports).all().length,
    merges: db.select().from(schema.videoMerges).all().length,
    mixRevisions: db.select().from(schema.mixRevisions).all().length,
    tracks: db.select().from(schema.episodeAudioTracks).all().length,
    clips: db.select().from(schema.episodeAudioClips).all().length,
  }
}

function rcFor(scope: any) {
  return buildAssistantRequestContext({
    sessionId: 1,
    messageId: 2,
    workspaceKey: `drama:${drama.id}`,
    scope,
    preset: 'assistant',
    language: 'zh',
  })
}

function toolsFor(scope: any) {
  return getPresetTools(rcFor(scope))
}

async function run(scope: any, name: string, input: Record<string, unknown> = {}) {
  const tools = toolsFor(scope)
  assert.ok(tools[name], `tool ${name} should be registered for ${scope.kind}`)
  return (tools[name] as any).execute(input, { requestContext: rcFor(scope) })
}

const editScope = {
  workspace_key: `drama:${drama.id}`, kind: 'edit', drama_id: drama.id,
  episode_id: toolEpisode.id, edit_project_id: toolProject.id,
}
const staleEditScope = {
  workspace_key: `drama:${drama.id}`, kind: 'edit', drama_id: drama.id,
  episode_id: staleEpisode.id, edit_project_id: staleProject.id,
}
const missingEditScope = {
  workspace_key: `drama:${drama.id}`, kind: 'edit', drama_id: drama.id,
  episode_id: missingEpisode.id, edit_project_id: missingProject.id,
}
function mixScopeFor(episodeId: number) {
  return { workspace_key: `drama:${drama.id}`, kind: 'mix', drama_id: drama.id, episode_id: episodeId }
}
const deliveryScope = {
  workspace_key: `drama:${drama.id}`, kind: 'delivery', drama_id: drama.id, episode_id: toolEpisode.id,
}

test('A2-2 工具注册：按作用域严格隔离，不跨页暴露', () => {
  assert.deepEqual(
    Object.keys(toolsFor(editScope)).sort(),
    ['propose_change', 'read_edit_clips', 'read_edit_state', 'suggest_action'],
  )
  assert.deepEqual(
    Object.keys(toolsFor(mixScopeFor(toolEpisode.id))).sort(),
    ['propose_change', 'read_mix_state', 'read_mix_tracks', 'suggest_action'],
  )
  assert.deepEqual(
    Object.keys(toolsFor(deliveryScope)).sort(),
    ['propose_change', 'read_export_history', 'suggest_action'],
  )
  assert.deepEqual(Object.keys(toolsFor({ workspace_key: 'novel-library', kind: 'novel-library' })), ['read_novel_list'])
  assert.equal((toolsFor(editScope) as any).read_mix_state, undefined)
  assert.equal((toolsFor(mixScopeFor(toolEpisode.id)) as any).read_edit_state, undefined)
  assert.equal((toolsFor(deliveryScope) as any).read_edit_clips, undefined)
})

test('read_edit_state：只读返回工程、版本、草稿、混音对齐与最新导出', async () => {
  const before = fullCounts()
  const result: any = await run(editScope, 'read_edit_state', {
    episode_id: toolEpisode.id, edit_project_id: toolProject.id,
  })
  assert.equal(result.no_edit_plan, false)
  assert.equal(result.project.id, toolProject.id)
  assert.equal(result.clip_count, 1)
  assert.equal(result.duration_ms, 2000)
  assert.equal(result.version.revision_no, 1)
  assert.equal(result.version.revision_id, toolRevision.id)
  assert.deepEqual(result.draft, { version: 1, dirty: false })
  assert.equal(result.mix_status.status, 'aligned')
  assert.deepEqual(result.mix_status.reasons, [])
  assert.equal(result.latest_export.export_id, exportOk.id)
  assert.equal(result.latest_export.status, 'completed')
  assert.ok(!('output_url' in result.latest_export))
  assert.deepEqual(fullCounts(), before)
})

test('read_edit_state：工程缺失或已删除时返回空态，不创建任何行', async () => {
  const before = fullCounts()
  const ghostScope = { ...editScope, episode_id: filmOnlyEpisode.id }
  const noProject: any = await run(ghostScope, 'read_edit_state', { episode_id: filmOnlyEpisode.id })
  assert.equal(noProject.no_edit_plan, true)
  assert.equal(noProject.empty_reason, 'NO_PROJECT')
  assert.equal(noProject.clip_count, 0)
  assert.equal(noProject.duration_ms, 0)

  const emptyScope = { ...editScope, episode_id: emptyEpisode.id }
  const emptyState: any = await run(emptyScope, 'read_edit_state', { episode_id: emptyEpisode.id })
  assert.equal(emptyState.no_edit_plan, true)
  assert.deepEqual(fullCounts(), before)
})

test('read_edit_clips：时间线顺序、来源范围、指纹现状，且不返回 URL', async () => {
  const before = fullCounts()
  const result: any = await run(editScope, 'read_edit_clips', {
    episode_id: toolEpisode.id, edit_project_id: toolProject.id,
  })
  assert.equal(result.total, 1)
  const clip = result.items[0]
  assert.equal(clip.index, 0)
  assert.equal(clip.clip_id, 'clp_1')
  assert.deepEqual(clip.source, { kind: 'merge', id: toolFilm.id, label: '' })
  assert.deepEqual(clip.source_range, { in_ms: 0, out_ms: 2000, duration_ms: 2000, speed: 1 })
  assert.equal(clip.timeline.start_ms, 0)
  assert.equal(clip.timeline.end_ms, 2000)
  assert.equal(clip.fingerprint, shotFingerprint)
  assert.equal(clip.missing, false)
  assert.equal(clip.stale, false)
  assert.equal(clip.current_fingerprint, shotFingerprint)
  assert.ok(!JSON.stringify(result).includes('shot.mp4'))
  assert.deepEqual(fullCounts(), before)
})

test('read_edit_clips：素材变化标记 stale，文件缺失标记 missing', async () => {
  const before = fullCounts()
  const stale: any = await run(staleEditScope, 'read_edit_clips', {
    episode_id: staleEpisode.id, edit_project_id: staleProject.id,
  })
  assert.equal(stale.items[0].missing, false)
  assert.equal(stale.items[0].stale, true)
  assert.equal(stale.items[0].reason, '素材文件已变化')
  assert.equal(stale.items[0].current_fingerprint, shotFingerprint)

  const missing: any = await run(missingEditScope, 'read_edit_clips', {
    episode_id: missingEpisode.id, edit_project_id: missingProject.id,
  })
  assert.equal(missing.items[0].missing, true)
  assert.equal(missing.items[0].stale, false)
  assert.equal(missing.items[0].reason, '素材文件不存在或不可读')
  assert.deepEqual(fullCounts(), before)
})

test('read_edit_clips：缺工程 ID、错工程、错分集与跨作用域均被拒绝', async () => {
  const before = fullCounts()
  const noProjectId: any = await run(editScope, 'read_edit_clips', { episode_id: toolEpisode.id })
  assert.equal(noProjectId.status, 422)

  const wrongProject: any = await run(editScope, 'read_edit_clips', {
    episode_id: toolEpisode.id, edit_project_id: project.id,
  })
  assert.equal(wrongProject.status, 422)

  const wrongEpisode: any = await run(editScope, 'read_edit_clips', {
    episode_id: staleEpisode.id, edit_project_id: toolProject.id,
  })
  assert.equal(wrongEpisode.status, 422)

  const crossScope: any = await (toolsFor(editScope) as any).read_edit_clips.execute(
    { episode_id: toolEpisode.id, edit_project_id: toolProject.id },
    { requestContext: rcFor(mixScopeFor(toolEpisode.id)) },
  )
  assert.equal(crossScope.status, 403)
  assert.deepEqual(fullCounts(), before)
})

test('read_mix_state：对齐、过期、缺失、无剪辑计划与无成片降级，均不补默认总线', async () => {
  const before = fullCounts()
  const aligned: any = await run(mixScopeFor(toolEpisode.id), 'read_mix_state', { episode_id: toolEpisode.id })
  assert.equal(aligned.mix_status.status, 'aligned')
  assert.deepEqual(aligned.mix_status.reasons, [])
  assert.equal(aligned.mix_revision.revision_no, 1)
  assert.equal(aligned.mix_revision.source_film_id, toolFilm.id)
  assert.deepEqual(aligned.buses.map((bus: any) => bus.key), ['dialogue', 'original', 'sfx', 'bgm', 'master'])
  assert.equal(aligned.source.kind, 'concat')
  assert.equal(aligned.source.film_id, toolFilm.id)
  assert.equal(aligned.source.has_audio, true)
  assert.ok(aligned.track_count >= 1)
  assert.ok(aligned.sync_hashes.edit_sync_hash)

  const stale: any = await run(mixScopeFor(staleEpisode.id), 'read_mix_state', { episode_id: staleEpisode.id })
  assert.equal(stale.mix_status.status, 'stale')
  assert.deepEqual(stale.mix_status.reasons, ['timing_changed'])

  const missing: any = await run(mixScopeFor(projectEpisode.id), 'read_mix_state', { episode_id: projectEpisode.id })
  assert.equal(missing.mix_status.status, 'missing')

  const noPlan: any = await run(mixScopeFor(noBusEpisode.id), 'read_mix_state', { episode_id: noBusEpisode.id })
  assert.equal(noPlan.mix_status.status, 'no_edit_plan')

  const fallback: any = await run(mixScopeFor(emptyEpisode.id), 'read_mix_state', { episode_id: emptyEpisode.id })
  assert.equal(fallback.mix_status.status, 'no_edit_plan')
  assert.ok(fallback.warnings.some((item: any) => item.code === 'MIX_SOURCE_FALLBACK'))
  assert.equal(fallback.source, null)
  assert.deepEqual(fullCounts(), before)
})

test('read_mix_tracks：轨道摘要与来源引用，不返回音频地址', async () => {
  const before = fullCounts()
  const result: any = await run(mixScopeFor(toolEpisode.id), 'read_mix_tracks', { episode_id: toolEpisode.id })
  assert.equal(result.total, result.items.length)
  assert.ok(result.items.length >= 1)
  assert.ok(!JSON.stringify(result).includes('shot.mp4'))
  for (const item of result.items) {
    assert.ok(!('audio_url' in item))
    assert.ok(!('audioUrl' in item))
    assert.deepEqual(Object.keys(item.source_refs).sort(), ['asset_ids', 'line_ids', 'take_ids'])
    assert.equal(typeof item.bus, 'string')
    assert.equal(typeof item.clip_count, 'number')
  }
  assert.equal(result.truncated, false)
  assert.deepEqual(fullCounts(), before)
})

test('read_export_history：软删排除、失败原因脱敏、来源成片按集匹配与截断', async () => {
  const before = fullCounts()
  const result: any = await run(deliveryScope, 'read_export_history', { episode_id: toolEpisode.id })
  assert.equal(result.total, 2)
  assert.equal(result.items.length, 2)
  assert.ok(!result.items.some((item: any) => item.export_id === deletedExport.id))

  const ok = result.items.find((item: any) => item.export_id === exportOk.id)
  assert.ok(ok)
  assert.equal(ok.is_current, true)
  assert.equal(ok.plan_revision_id, 11)
  assert.equal(ok.edit_revision_id, 12)
  assert.equal(ok.mix_revision_id, 13)
  assert.equal(ok.source_merge_id, toolFilm.id)
  assert.equal(ok.source_film.film_id, exportFilm.id)
  assert.equal(ok.source_film.kind, 'edit')
  assert.equal(ok.error, null)
  assert.ok(!('output_url' in ok))

  const failed = result.items.find((item: any) => item.export_id === failedExport.id)
  assert.ok(failed)
  assert.ok(failed.error.includes('[路径]'))
  assert.ok(!failed.error.includes('/Volumes'))
  assert.ok(!failed.error.includes('\n'))
  assert.ok(!JSON.stringify(result).includes('secret'))

  const limited: any = await run(deliveryScope, 'read_export_history', { episode_id: toolEpisode.id, limit: 1 })
  assert.equal(limited.items.length, 1)
  assert.equal(limited.total, 2)
  assert.equal(limited.truncated, true)

  const cross: any = await run(deliveryScope, 'read_export_history', {
    episode_id: toolEpisode.id, export_id: otherExport.id,
  })
  assert.deepEqual(cross.items, [])
  assert.equal(cross.total, 0)
  assert.ok(cross.hint.includes('没有这条导出记录'))

  const wrongEpisode: any = await run(deliveryScope, 'read_export_history', { episode_id: staleEpisode.id })
  assert.equal(wrongEpisode.status, 422)

  const crossScope: any = await (toolsFor(deliveryScope) as any).read_export_history.execute(
    { episode_id: toolEpisode.id },
    { requestContext: rcFor(editScope) },
  )
  assert.equal(crossScope.status, 403)
  assert.deepEqual(fullCounts(), before)
})
