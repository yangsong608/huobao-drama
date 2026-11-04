import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-compass-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { createNovel, getNovel, updateNovel } = await import('../src/services/novels.ts')
const { saveChapter } = await import('../src/services/novel-chapters.ts')
const { startNovelJob, getNovelJob, NovelJobError } = await import('../src/services/novel-job-runner.ts')
const {
  applyDelta,
  getNovelGraph,
  getSnapshotForChapter,
  parseCompassJson,
  saveNovelGraph,
} = await import('../src/services/novel/compass.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const BASE_GRAPH = {
  nodes: [
    { id: 'char_a', label: '甲', type: 'character', importance: 9, faction: '宗门', status: 'active', bio: '主角', traits: ['坚定'], firstAppearance: 0 },
    { id: 'char_b', label: '乙', type: 'character', importance: 7, faction: '宗门', status: 'active' },
    { id: 'fac_x', label: '宗门', type: 'faction', importance: 6 },
  ],
  edges: [
    { id: 'edge_ab', source: 'char_a', target: 'char_b', relationType: 'alliance', label: '同门', strength: 7, events: ['入门'] },
  ],
}

const DELTA_ONE = {
  newNodes: [
    { id: 'char_c', label: '丙', type: 'character', importance: 5, status: 'active' },
  ],
  updatedNodes: [],
  removedNodeIds: [],
  newEdges: [
    { source: 'char_a', target: 'char_c', relationType: 'hostile', label: '宿敌', strength: 6 },
  ],
  updatedEdges: [],
  removedEdgeIds: [],
}

const DELTA_TWO = {
  newNodes: [],
  newEdges: [],
  removedNodeIds: [],
  removedEdgeIds: [],
  updatedNodes: [
    { id: 'char_b', changes: { status: 'deceased', importance: 8 } },
  ],
  updatedEdges: [
    { id: 'edge_ab', changes: { strength: 10, events: ['牺牲'] } },
  ],
}

function compassStub(prompts: string[] = []) {
  return {
    async complete(prompt: string) {
      prompts.push(prompt)
      if (prompt.includes('提取实体关系图谱')) return JSON.stringify(BASE_GRAPH)
      if (prompt.includes('输出关系图谱的变更')) {
        if (prompt.includes('第一章正文')) return JSON.stringify(DELTA_ONE)
        if (prompt.includes('第二章正文')) return JSON.stringify(DELTA_TWO)
        throw new Error(`unexpected delta chapter: ${prompt.slice(0, 120)}`)
      }
      if (prompt.includes('逻辑不一致')) {
        return JSON.stringify({
          inconsistencies: [{
            type: 'dead_reappear',
            severity: 'error',
            nodeIds: ['char_b'],
            edgeIds: [],
            chapters: [2],
            message: '乙在第二章死亡后仍有互动',
          }],
        })
      }
      if (prompt.includes('本章涉及的人物关系图谱')) {
        return JSON.stringify({
          nodes: [
            { id: 'char_a', label: '甲', type: 'character', importance: 8, status: 'active' },
            { id: 'char_c', label: '丙', type: 'character', importance: 6, status: 'active' },
          ],
          edges: [
            { source: 'char_a', target: 'char_c', relationType: 'hostile', label: '对峙', strength: 7 },
          ],
        })
      }
      throw new Error(`unexpected compass prompt: ${prompt.slice(0, 120)}`)
    },
  }
}

function createCompassNovel(title: string) {
  const novel = createNovel({
    title,
    topic: '权谋',
    genre: ['古装'],
    number_of_chapters: 3,
    word_number: 1500,
  })
  updateNovel(novel.id, {
    character_dynamics: '甲乙同门',
    character_state: '甲活跃',
    world_building: '宗门世界',
    plot_architecture: '三幕结构',
    chapter_blueprint: '第1章 - 开端\n本章简述：入门。\n\n第2章 - 变故\n本章简述：牺牲。',
  })
  return novel
}

async function runJob(novelId: number, type: string, extra: Record<string, unknown> = {}) {
  const prompts: string[] = []
  const { job, completion } = startNovelJob({
    novelId,
    type,
    llm: compassStub(prompts),
    ...extra,
  })
  await completion
  return { job: getNovelJob(job.id), prompts }
}

test('parseCompassJson accepts fenced JSON and applyDelta appends events once', () => {
  const parsed = parseCompassJson('```json\n{"nodes":[{"id":"char_a"}]}\n```')
  assert.equal((parsed as any)?.nodes?.[0]?.id, 'char_a')
  assert.equal(parseCompassJson('not json'), null)

  const snapshot = {
    nodes: [
      { id: 'char_a', label: '甲', type: 'character', importance: 8, status: 'active' },
      { id: 'char_b', label: '乙', type: 'character', importance: 6, status: 'active' },
    ],
    edges: [
      { id: 'edge_ab', source: 'char_a', target: 'char_b', relationType: 'alliance', label: '同门', strength: 7, events: ['入门'] },
    ],
  }
  const next = applyDelta(snapshot, DELTA_TWO)
  assert.equal(next.nodes.find((node) => node.id === 'char_b')?.status, 'deceased')
  assert.equal(next.nodes.find((node) => node.id === 'char_b')?.importance, 8)
  const edge = next.edges.find((item) => item.id === 'edge_ab')
  assert.equal(edge?.strength, 10)
  assert.deepEqual(edge?.events, ['入门', '牺牲'])

  const removed = applyDelta(snapshot, {
    newNodes: [],
    updatedNodes: [],
    removedNodeIds: ['char_b'],
    newEdges: [],
    updatedEdges: [],
    removedEdgeIds: ['edge_ab'],
  })
  assert.equal(removed.nodes.length, 1)
  assert.equal(removed.edges.length, 0)
})

test('getSnapshotForChapter picks the nearest earlier snapshot', () => {
  const snapshots = {
    '0': { nodes: [], edges: [] },
    '2': { nodes: [{ id: 'char_a', label: '甲', type: 'character' }], edges: [] },
    '5': { nodes: [], edges: [] },
  }
  assert.equal(getSnapshotForChapter(snapshots, 0), snapshots['0'])
  assert.equal(getSnapshotForChapter(snapshots, 1), snapshots['0'])
  assert.equal(getSnapshotForChapter(snapshots, 2), snapshots['2'])
  assert.equal(getSnapshotForChapter(snapshots, 4), snapshots['2'])
  assert.equal(getSnapshotForChapter(snapshots, 99), snapshots['5'])
  assert.equal(getSnapshotForChapter({}, 3), null)
})

test('graph_base job stores the baseline snapshot and generated meta', async () => {
  const novel = createCompassNovel('基线书')
  const { job, prompts } = await runJob(novel.id, 'graph_base')

  assert.equal(job?.status, 'done')
  const result = JSON.parse(job?.result || '{}')
  assert.equal(result.nodes, 3)
  assert.equal(result.edges, 1)
  assert.match(prompts[0], /甲乙同门/)

  const graph = getNovelGraph(novel.id)
  assert.ok(graph)
  assert.equal(graph.graphData.graphGenerated, true)
  assert.ok(graph.graphData.generatedAt)
  assert.equal(graph.graphData.snapshots['0'].nodes.length, 3)
  assert.equal(graph.graphData.snapshots['0'].edges.length, 1)
  assert.deepEqual(graph.graphData.audit.inconsistencies, [])
  assert.deepEqual(graph.chapterGraphs, {})
})

test('graph_snapshots job applies deltas per chapter and skips unchanged chapters', async () => {
  const novel = createCompassNovel('快照书')
  await runJob(novel.id, 'graph_base')
  saveChapter(novel.id, 1, { content: '第一章正文', title: '开端' })
  saveChapter(novel.id, 2, { content: '第二章正文', title: '变故' })

  const { job } = await runJob(novel.id, 'graph_snapshots')
  assert.equal(job?.status, 'done')
  const result = JSON.parse(job?.result || '{}')
  assert.equal(result.generated, 2)
  assert.equal(result.failed, 0)

  const graph = getNovelGraph(novel.id)
  assert.ok(graph)
  assert.deepEqual(Object.keys(graph.graphData.snapshots).sort(), ['0', '1', '2'])
  assert.equal(graph.graphData.snapshots['1'].nodes.length, 4)
  assert.equal(graph.graphData.snapshots['2'].nodes.find((node) => node.id === 'char_b')?.status, 'deceased')
  assert.deepEqual(
    graph.graphData.snapshots['2'].edges.find((edge) => edge.id === 'edge_ab')?.events,
    ['入门', '牺牲'],
  )
})

test('graph_audit job persists inconsistencies and timestamp', async () => {
  const novel = createCompassNovel('审计书')
  await runJob(novel.id, 'graph_base')
  saveChapter(novel.id, 1, { content: '第一章正文' })
  saveChapter(novel.id, 2, { content: '第二章正文' })
  await runJob(novel.id, 'graph_snapshots')

  const { job, prompts } = await runJob(novel.id, 'graph_audit')
  assert.equal(job?.status, 'done')
  assert.match(prompts[0], /第 2 章快照/)
  const result = JSON.parse(job?.result || '{}')
  assert.equal(result.inconsistencies, 1)

  const graph = getNovelGraph(novel.id)
  assert.ok(graph)
  assert.equal(graph.graphData.audit.inconsistencies.length, 1)
  assert.equal(graph.graphData.audit.inconsistencies[0].type, 'dead_reappear')
  assert.ok(graph.graphData.audit.lastAuditAt)
})

test('graph_chapter job stores a per-chapter graph and requires saved content', async () => {
  const novel = createCompassNovel('单章图书')
  saveChapter(novel.id, 1, { content: '第一章正文' })

  const { job } = await runJob(novel.id, 'graph_chapter', { chapterNo: 1 })
  assert.equal(job?.status, 'done')
  const graph = getNovelGraph(novel.id)
  assert.ok(graph)
  assert.equal(graph.chapterGraphs['1'].nodes.length, 2)
  assert.equal(graph.chapterGraphs['1'].edges.length, 1)

  assert.throws(
    () => startNovelJob({ novelId: novel.id, type: 'graph_chapter', chapterNo: 2, llm: compassStub() }),
    (error: unknown) => error instanceof NovelJobError && error.status === 400,
  )
})

test('invalid model JSON fails the graph job with protocol', async () => {
  const novel = createCompassNovel('坏格式书')
  const { job } = await runJob(novel.id, 'graph_base')
  assert.equal(job?.status, 'done')

  const malformed = {
    async complete() { return '不是 JSON' },
  }
  const { job: failed, completion } = startNovelJob({
    novelId: novel.id,
    type: 'graph_base',
    llm: malformed,
  })
  await completion
  const row = getNovelJob(failed.id)
  assert.equal(row?.status, 'failed')
  assert.equal(row?.errorCode, 'protocol')
  assert.match(row?.error || '', /格式/)
})

test('base regeneration replaces chapter snapshots but keeps chapter graphs', async () => {
  const novel = createCompassNovel('重生成书')
  await runJob(novel.id, 'graph_base')
  saveChapter(novel.id, 1, { content: '第一章正文' })
  await runJob(novel.id, 'graph_snapshots')
  await runJob(novel.id, 'graph_chapter', { chapterNo: 1 })

  let graph = getNovelGraph(novel.id)
  assert.ok(graph)
  assert.deepEqual(Object.keys(graph.graphData.snapshots).sort(), ['0', '1'])
  assert.ok(graph.chapterGraphs['1'])

  await runJob(novel.id, 'graph_base')
  graph = getNovelGraph(novel.id)
  assert.ok(graph)
  assert.deepEqual(Object.keys(graph.graphData.snapshots), ['0'])
  assert.ok(graph.chapterGraphs['1'])
})

test('saveNovelGraph replaces audit, snapshots and chapter graphs', () => {
  const novel = createCompassNovel('保存书')
  const saved = saveNovelGraph(novel.id, {
    graphData: {
      version: 1,
      generatedAt: '2026-11-03T00:00:00.000Z',
      snapshots: {
        '0': {
          nodes: [{ id: 'char_x', label: '某', type: 'character', importance: 6 }],
          edges: [],
        },
      },
      audit: {
        inconsistencies: [{ type: 'weight_imbalance', severity: 'info', nodeIds: ['char_x'], edgeIds: [], chapters: [1], message: '权重异常' }],
        lastAuditAt: '2026-11-03T01:00:00.000Z',
      },
      graphGenerated: true,
    },
    chapterGraphs: {
      '3': {
        nodes: [{ id: 'char_x', label: '某', type: 'character' }],
        edges: [],
      },
    },
  })
  assert.ok(saved)
  assert.equal(saved.graphData.snapshots['0'].nodes[0].id, 'char_x')
  assert.equal(saved.graphData.audit.inconsistencies[0].severity, 'info')
  assert.equal(saved.graphData.audit.lastAuditAt, '2026-11-03T01:00:00.000Z')
  assert.equal(saved.chapterGraphs['3'].nodes.length, 1)

  const partial = saveNovelGraph(novel.id, {
    chapterGraphs: {
      '4': {
        nodes: [{ id: 'char_y', label: '另', type: 'character' }],
        edges: [],
      },
    },
  })
  assert.ok(partial)
  assert.ok(partial.graphData.snapshots['0'])
  assert.deepEqual(Object.keys(partial.chapterGraphs), ['4'])
  assert.equal(getNovel(novel.id)?.graphMeta?.includes('char_x'), true)
})
