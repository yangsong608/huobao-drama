import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-actions-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const { roughCutEditPlan, suggestEditSubtitles } = await import('../src/services/edit-actions-service.ts')
const { getEpisodeEditState } = await import('../src/services/edit-service.ts')
const { assembleStoryboardClips, persistInitialProjectPlan } = await import('../src/services/edit-bootstrap.ts')
const { createEmptyEditPlan, projectSettingsForAspect } = await import('../src/services/edit-plan.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '剪辑动作', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '动作集', createdAt: ts, updatedAt: ts,
}).returning().get()
const emptyEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '无分镜集', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoFile = path.join(root, 'static', 'assets', 'shot.mp4')
fs.mkdirSync(path.dirname(videoFile), { recursive: true })
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=25:d=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoFile,
], { stdio: 'ignore' })
const videoUrl = 'static/assets/shot.mp4'

const sb1 = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, title: '镜一',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()
const sb2 = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 2, title: '镜二',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.storyboardLines).values([
  {
    storyboardId: sb1.id, episodeId: episode.id, dramaId: drama.id,
    lineNo: 1, speakerType: 'dialogue', speakerName: '林晚', text: '第一句',
    status: 'ready', audioDurationMs: 1000, sortOrder: 0,
    createdAt: ts, updatedAt: ts,
  },
  {
    storyboardId: sb2.id, episodeId: episode.id, dramaId: drama.id,
    lineNo: 2, speakerType: 'narration', speakerName: '旁白', text: '第二句',
    status: 'ready', audioDurationMs: 800, sortOrder: 0,
    createdAt: ts, updatedAt: ts,
  },
]).run()

// 工程化：为两集各建旧版工程（source_merge_id 为空）；动作集落分镜初始版本 + 草稿，
// 等价于旧 bootstrap 行为（版本 v1 + 草稿 v1，含 2 个分镜片段）。
setEditWorkspaceMode('on')
const legacyProject = db.insert(schema.editProjects).values({
  episodeId: episode.id, dramaId: drama.id, sourceMergeId: null,
  title: '旧版工程', status: 'active', createdAt: ts, updatedAt: ts,
}).returning().get()
db.update(schema.episodes).set({ editProjectId: legacyProject.id })
  .where(eq(schema.episodes.id, episode.id)).run()
const assembly = await assembleStoryboardClips(episode.id, projectSettingsForAspect('16:9'))
const seedPlan = {
  ...createEmptyEditPlan(episode.id, projectSettingsForAspect('16:9')),
  clips: assembly.clips,
  transitions: assembly.transitions,
}
persistInitialProjectPlan({
  episodeId: episode.id,
  dramaId: drama.id,
  projectId: legacyProject.id,
  plan: seedPlan,
  mode: 'on',
})

const emptyProject = db.insert(schema.editProjects).values({
  episodeId: emptyEpisode.id, dramaId: drama.id, sourceMergeId: null,
  title: '无分镜工程', status: 'active', createdAt: ts, updatedAt: ts,
}).returning().get()
db.update(schema.episodes).set({ editProjectId: emptyProject.id })
  .where(eq(schema.episodes.id, emptyEpisode.id)).run()
setEditWorkspaceMode('readonly')

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function dbCounts(episodeId: number) {
  return {
    drafts: db.select().from(schema.episodeEditDrafts)
      .where(eq(schema.episodeEditDrafts.episodeId, episodeId)).all().length,
    revisions: db.select().from(schema.editRevisions)
      .where(eq(schema.editRevisions.episodeId, episodeId)).all().length,
    editRevisionId: db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId)).get()?.editRevisionId ?? null,
  }
}

test('replace 初剪按分镜重建主轨并清空字幕', async () => {
  setEditWorkspaceMode('on')
  const state = await getEpisodeEditState(episode.id)
  const plan = state.plan
  plan.subtitles.push({
    id: 'cue_manual',
    text: '手动字幕',
    startMs: 0,
    endMs: 1000,
    style: 'default',
    source: 'manual',
    follow: false,
    anchor: null,
  })

  const result = await roughCutEditPlan(episode.id, legacyProject, {
    mode: 'replace',
    plan,
    create_revision: false,
  })
  assert.equal(result.plan.clips.length, 2)
  assert.equal(result.plan.clips[0].id, `clp_sb_${sb1.id}`)
  assert.equal(result.plan.clips[1].id, `clp_sb_${sb2.id}`)
  assert.equal(result.plan.subtitles.length, 0)
  assert.ok(result.issues.some((issue: any) => issue.code === 'SUBTITLES_CLEARED'))
  assert.equal(result.applied.added, 2)
  assert.equal(result.snapshot_revision, null)
  assert.equal(result.hashes.plan_hash.length, 32)
})

test('append 跳过已存在的分镜并统计 skipped', async () => {
  setEditWorkspaceMode('on')
  const state = await getEpisodeEditState(episode.id)
  const result = await roughCutEditPlan(episode.id, legacyProject, {
    mode: 'append',
    plan: state.plan,
    create_revision: false,
  })
  assert.equal(result.applied.added, 0)
  assert.equal(result.applied.skipped, 2)
  assert.equal(result.plan.clips.length, 2)
})

test('create_revision=true 在替换前创建快照版本', async () => {
  setEditWorkspaceMode('on')
  const state = await getEpisodeEditState(episode.id)
  const draftBefore = db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episode.id))
    .get()
  const result = await roughCutEditPlan(episode.id, legacyProject, {
    mode: 'replace',
    plan: state.plan,
    create_revision: true,
    base_version: state.draft?.version ?? 0,
  })
  assert.ok(result.snapshot_revision)
  assert.equal(result.snapshot_revision.note, '初剪前快照')
  assert.equal(result.snapshot_revision.is_current, true)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === episode.id)
  assert.ok(revisions.length >= 2)
  // 裁定 2：快照必须只建版本不写草稿，否则前端随后带 base_version 的自动保存会立刻 409。
  const draftAfter = db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episode.id))
    .get()
  assert.ok(draftBefore)
  assert.equal(draftAfter?.version, draftBefore.version)
  assert.equal(draftAfter?.planJson, draftBefore.planJson)
})

test('无可用分镜时初剪返回 ROUGH_CUT_NO_MATERIAL', async () => {
  setEditWorkspaceMode('on')
  await assert.rejects(
    () => roughCutEditPlan(emptyEpisode.id, emptyProject, { mode: 'replace' }),
    (error: any) => error.code === 'ROUGH_CUT_NO_MATERIAL' && error.status === 400,
  )
})

test('fill 只补缺失字幕，replace 保留手动字幕', async () => {
  setEditWorkspaceMode('on')
  const state = await getEpisodeEditState(episode.id)
  const manual = {
    id: 'cue_manual',
    text: '手动字幕',
    startMs: 0,
    endMs: 500,
    style: 'default',
    source: 'manual',
    follow: false,
    anchor: null,
    lineId: null,
  }
  const base = { ...state.plan, subtitles: [manual] }

  const filled = suggestEditSubtitles(episode.id, legacyProject, { mode: 'fill', plan: base })
  assert.equal(filled.added, 2)
  assert.equal(filled.updated, 0)
  assert.ok(filled.plan.subtitles.some((cue: any) => cue.id === 'cue_manual'))
  assert.equal(filled.plan.subtitles.filter((cue: any) => cue.source === 'line').length, 2)

  const filledAgain = suggestEditSubtitles(episode.id, legacyProject, { mode: 'fill', plan: filled.plan })
  assert.equal(filledAgain.added, 0)
  assert.equal(filledAgain.skipped, 2)

  const replaced = suggestEditSubtitles(episode.id, legacyProject, { mode: 'replace', plan: filled.plan })
  assert.equal(replaced.updated, 2)
  assert.equal(replaced.added, 2)
  assert.equal(replaced.skipped, 1)
  assert.equal(replaced.plan.subtitles.filter((cue: any) => cue.id === 'cue_manual').length, 1)
  assert.equal(replaced.plan.subtitles.length, 3)
})

test('归一化失败时不写初剪前快照，也不移动分集指针', async () => {
  setEditWorkspaceMode('on')
  const state = await getEpisodeEditState(episode.id)
  // 基础计划里的片段 id 与待追加的分镜片段 id 相同（但来源不同，不会被 append 排重跳过），
  // 使 next 计划出现重复 clip id，归一化在快照之后才抛错时会暴露“先写库后失败”的顺序问题。
  const collidingPlan = {
    ...state.plan,
    clips: [{
      id: `clp_sb_${sb2.id}`,
      kind: 'video',
      source: {
        kind: 'import',
        id: 9001,
        url: videoUrl,
        durationMs: 2000,
        width: 320,
        height: 240,
        fps: 25,
        hasAudio: false,
      },
      sourceInMs: 0,
      sourceOutMs: 2000,
      speed: 1,
      gapBeforeMs: 0,
    }],
    transitions: [],
    subtitles: [],
    overlays: [],
    markers: [],
  }
  const before = dbCounts(episode.id)
  await assert.rejects(
    () => roughCutEditPlan(episode.id, legacyProject, {
      mode: 'append',
      plan: collidingPlan,
      create_revision: true,
    }),
    (error: any) => error.code === 'CLIP_ID_DUPLICATE',
  )
  assert.deepEqual(dbCounts(episode.id), before)
})

async function routeJson(response: Response): Promise<any> {
  return response.json()
}

function postAction(path: string, body: string) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

test('readonly 下初剪与字幕建议路由返回 403 且不写库', async () => {
  setEditWorkspaceMode('readonly')
  const before = dbCounts(episode.id)
  try {
    for (const routePath of [
      `/episodes/${episode.id}/edit/rough-cut`,
      `/episodes/${episode.id}/edit/subtitles/suggest`,
    ]) {
      // 非法 JSON 请求体：写闸门必须先于 readBody 返回 403，而不是先解析请求体。
      const response = await postAction(routePath, 'not-json')
      assert.equal(response.status, 403)
      assert.equal((await routeJson(response)).code, 'EDIT_READONLY')
    }
  } finally {
    setEditWorkspaceMode('on')
  }
  assert.deepEqual(dbCounts(episode.id), before)
})

test('off 下初剪与字幕建议路由返回 403 且不写库', async () => {
  setEditWorkspaceMode('off')
  const before = dbCounts(episode.id)
  try {
    for (const routePath of [
      `/episodes/${episode.id}/edit/rough-cut`,
      `/episodes/${episode.id}/edit/subtitles/suggest`,
    ]) {
      const response = await postAction(routePath, 'not-json')
      assert.equal(response.status, 403)
      assert.equal((await routeJson(response)).code, 'EDIT_WORKSPACE_OFF')
    }
  } finally {
    setEditWorkspaceMode('on')
  }
  assert.deepEqual(dbCounts(episode.id), before)
})

test('非法集编号返回 400 集编号无效', async () => {
  setEditWorkspaceMode('on')
  const response = await postAction('/episodes/abc/edit/rough-cut', '{}')
  assert.equal(response.status, 400)
  assert.equal((await routeJson(response)).message, '集编号无效')
})

test('route 正常路径 replace 初剪返回 2 个片段且不写草稿/版本', async () => {
  setEditWorkspaceMode('on')
  const stateResponse = await app.request(`/episodes/${episode.id}/edit`)
  assert.equal(stateResponse.status, 200, await stateResponse.clone().text())
  const state = (await routeJson(stateResponse)).data
  const before = dbCounts(episode.id)
  const response = await app.request(`/episodes/${episode.id}/edit/rough-cut`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'replace', plan: state.plan, create_revision: false }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await routeJson(response)).data
  assert.equal(data.plan.clips.length, 2)
  assert.equal(data.applied.added, 2)
  assert.equal(data.snapshot_revision, null)
  assert.deepEqual(dbCounts(episode.id), before)
})

test('字幕建议非法集编号返回 400 集编号无效', async () => {
  setEditWorkspaceMode('on')
  const response = await postAction('/episodes/abc/edit/subtitles/suggest', '{}')
  assert.equal(response.status, 400)
  assert.equal((await routeJson(response)).message, '集编号无效')
})

test('route 正常路径字幕建议 fill 补 2 条 line 字幕且不写库', async () => {
  setEditWorkspaceMode('on')
  const stateResponse = await app.request(`/episodes/${episode.id}/edit`)
  assert.equal(stateResponse.status, 200, await stateResponse.clone().text())
  const state = (await routeJson(stateResponse)).data
  const before = dbCounts(episode.id)
  const response = await postAction(
    `/episodes/${episode.id}/edit/subtitles/suggest`,
    JSON.stringify({ mode: 'fill', plan: state.plan }),
  )
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await routeJson(response)).data
  assert.equal(data.added, 2)
  assert.equal(data.updated, 0)
  assert.equal(data.plan.subtitles.filter((cue: any) => cue.source === 'line').length, 2)
  assert.deepEqual(dbCounts(episode.id), before)
})
