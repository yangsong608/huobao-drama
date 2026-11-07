/**
 * A1-2：线程键、九类作用域、归属、软删、stage 与 focus 白名单
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-scope-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { parseWorkspaceKey, validateAgentScope, workspaceKeyAccepts } = await import('../src/agents/agent-scope.ts')
const { db, schema } = await import('../src/db/index.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ts = '2026-11-07T00:00:00.000Z'

function insertDrama(title: string, deletedAt: string | null = null) {
  return Number(db.insert(schema.dramas).values({
    title,
    createdAt: ts,
    updatedAt: ts,
    deletedAt,
  }).run().lastInsertRowid)
}

function insertEpisode(dramaId: number, number = 1) {
  return Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: number,
    title: `第${number}集`,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

function insertNovel(title: string, deletedAt: string | null = null) {
  return Number(db.insert(schema.novels).values({
    title,
    createdAt: ts,
    updatedAt: ts,
    deletedAt,
  }).run().lastInsertRowid)
}

function insertChapter(novelId: number, chapterNo = 1) {
  return Number(db.insert(schema.novelChapters).values({
    novelId,
    chapterNo,
    title: `第${chapterNo}章`,
    content: '正文',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

function insertStoryboard(episodeId: number, number = 1) {
  return Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: number,
    title: `镜头${number}`,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

function insertLine(episodeId: number, dramaId: number, lineNo = 1) {
  return Number(db.insert(schema.storyboardLines).values({
    episodeId,
    dramaId,
    lineNo,
    text: `台词${lineNo}`,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

const dramaA = insertDrama('项目A')
const dramaB = insertDrama('项目B')
const dramaDeleted = insertDrama('已删项目', ts)
const episodeA1 = insertEpisode(dramaA, 1)
const episodeB1 = insertEpisode(dramaB, 1)
const novelA = insertNovel('小说A')
const novelB = insertNovel('小说B')
const novelDeleted = insertNovel('已删小说', ts)
const chapterA = insertChapter(novelA, 1)
const chapterB = insertChapter(novelB, 1)
const storyboardA1 = insertStoryboard(episodeA1)
const storyboardB1 = insertStoryboard(episodeB1)
const lineA1 = insertLine(episodeA1, dramaA)
const editProjectA = Number(db.insert(schema.editProjects).values({
  episodeId: episodeA1,
  dramaId: dramaA,
  title: '剪辑A',
  status: 'active',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)
db.insert(schema.editRevisions).values({
  episodeId: episodeA1,
  revisionNo: 1,
  projectId: editProjectA,
  planJson: JSON.stringify({ version: 1, episodeId: episodeA1, project: {}, clips: [{ id: 'clip-1' }], transitions: [], subtitles: [], overlays: [], markers: [] }),
  planHash: 'hash',
  editSyncHash: 'sync',
  isCurrent: true,
  createdAt: ts,
}).run()
const trackA1 = Number(db.insert(schema.episodeAudioTracks).values({
  episodeId: episodeA1,
  dramaId: dramaA,
  name: '对白',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)
const exportA1 = Number(db.insert(schema.episodeExports).values({
  episodeId: episodeA1,
  kind: 'video',
  status: 'completed',
  createdAt: ts,
}).run().lastInsertRowid)

test('workspace_key 四类解析与非法值', () => {
  assert.deepEqual(parseWorkspaceKey('home'), { kind: 'home' })
  assert.deepEqual(parseWorkspaceKey('novel-library'), { kind: 'novel-library' })
  assert.deepEqual(parseWorkspaceKey('novel:12'), { kind: 'novel', id: 12 })
  assert.deepEqual(parseWorkspaceKey('drama:3'), { kind: 'drama', id: 3 })
  for (const bad of ['', 'novel:0', 'novel:-1', 'novel:abc', 'drama:1.5', 'drama:1/x', 'episode:1']) {
    assert.throws(() => parseWorkspaceKey(bad), /workspace_key|正整数/)
  }
})

test('home / novel-library / novel 作用域', () => {
  const home = validateAgentScope({ workspaceKey: 'home', scope: { kind: 'home' } })
  assert.equal(home.kind, 'home')
  assert.throws(() => validateAgentScope({ workspaceKey: 'home', scope: { kind: 'novel-library' } }), /home 线程/)

  const library = validateAgentScope({ workspaceKey: 'novel-library', scope: { kind: 'novel-library' } })
  assert.equal(library.kind, 'novel-library')

  const novel = validateAgentScope({
    workspaceKey: `novel:${novelA}`,
    scope: { kind: 'novel', novel_id: novelA, focus: { chapter_id: chapterA } },
  })
  assert.equal(novel.novel_id, novelA)
  assert.equal(novel.focus?.chapter_id, chapterA)

  assert.throws(() => validateAgentScope({
    workspaceKey: `novel:${novelA}`,
    scope: { kind: 'novel', novel_id: novelB },
  }), /小说线程与作用域小说不一致/)
  assert.throws(() => validateAgentScope({
    workspaceKey: `novel:${novelA}`,
    scope: { kind: 'novel', novel_id: novelA, focus: { chapter_id: chapterB } },
  }), /章节不属于当前小说/)
  assert.throws(() => validateAgentScope({
    workspaceKey: `novel:${novelDeleted}`,
    scope: { kind: 'novel', novel_id: novelDeleted },
  }), /小说已删除/)
  assert.throws(() => validateAgentScope({
    workspaceKey: `novel:${novelA}`,
    scope: { kind: 'novel', novel_id: novelA, focus: { storyboard_id: storyboardA1 } },
  }), /不适用于 novel/)
})

test('drama / episode / 派生作用域归属与 stage', () => {
  const drama = validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'drama', drama_id: dramaA },
  })
  assert.equal(drama.drama_id, dramaA)

  const episode = validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'episode', drama_id: dramaA, episode_id: episodeA1, stage: 'script', focus: { storyboard_id: storyboardA1, line_id: lineA1 } },
  })
  assert.equal(episode.stage, 'script')
  assert.equal(episode.focus?.storyboard_id, storyboardA1)

  assert.throws(() => validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'episode', drama_id: dramaA, episode_id: episodeB1 },
  }), /分集不属于当前项目/)
  assert.throws(() => validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'episode', drama_id: dramaA, episode_id: episodeA1, stage: 'mix' },
  }), /stage 必须是/)
  assert.throws(() => validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'episode', drama_id: dramaA, episode_id: episodeA1, focus: { storyboard_id: storyboardB1 } },
  }), /分镜不属于当前分集/)
  assert.throws(() => validateAgentScope({
    workspaceKey: `drama:${dramaB}`,
    scope: { kind: 'episode', drama_id: dramaA, episode_id: episodeA1 },
  }), /项目线程与作用域项目不一致/)
  assert.throws(() => validateAgentScope({
    workspaceKey: `drama:${dramaDeleted}`,
    scope: { kind: 'drama', drama_id: dramaDeleted },
  }), /项目已删除/)
})

test('edit / mix / delivery 的依赖 ID 与 focus', () => {
  const edit = validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'edit', drama_id: dramaA, episode_id: episodeA1, edit_project_id: editProjectA, focus: { clip_id: 'clip-1' } },
  })
  assert.equal(edit.edit_project_id, editProjectA)
  assert.throws(() => validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'edit', drama_id: dramaA, episode_id: episodeA1, edit_project_id: editProjectA, focus: { clip_id: 'missing' } },
  }), /剪辑片段不存在/)
  assert.throws(() => validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'edit', drama_id: dramaA, episode_id: episodeA1 },
  }), /edit 作用域需要 edit_project_id/)

  const mix = validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'mix', drama_id: dramaA, episode_id: episodeA1, focus: { track_id: trackA1 } },
  })
  assert.equal(mix.focus?.track_id, trackA1)

  const delivery = validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'delivery', drama_id: dramaA, episode_id: episodeA1, focus: { export_id: exportA1 } },
  })
  assert.equal(delivery.focus?.export_id, exportA1)
})

test('导演预设与作用域一致性', () => {
  const scope = validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'director', drama_id: dramaA, episode_id: episodeA1, focus: { storyboard_id: storyboardA1 } },
    preset: 'director',
  })
  assert.equal(scope.kind, 'director')
  assert.throws(() => validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'episode', drama_id: dramaA, episode_id: episodeA1 },
    preset: 'director',
  }), /导演专员只接受 director 作用域/)
  assert.throws(() => validateAgentScope({
    workspaceKey: `drama:${dramaA}`,
    scope: { kind: 'director', drama_id: dramaA, episode_id: episodeA1 },
    preset: 'director',
    allowDirector: false,
  }), /导演专员已关闭/)
})

test('workspaceKeyAccepts 不查库判断线程与作用域一致性', () => {
  const novelScope = { workspace_key: 'novel:1', kind: 'novel' as const, novel_id: 1 }
  assert.equal(workspaceKeyAccepts('novel:1', novelScope), true)
  assert.equal(workspaceKeyAccepts('novel:2', novelScope), false)
  const episodeScope = { workspace_key: 'drama:1', kind: 'episode' as const, drama_id: 1, episode_id: 2 }
  assert.equal(workspaceKeyAccepts('drama:1', episodeScope), true)
  assert.equal(workspaceKeyAccepts('home', episodeScope), false)
})
