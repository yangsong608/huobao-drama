import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateChapterBlueprint,
  resolveBlueprintChunkSize,
  limitChapterBlueprint,
} from '../src/services/novel/blueprint.js'

function chapterText(no: number, title = `标题${no}`): string {
  return `第${no}章 - ${title}
本章定位：定位${no}
核心作用：推进${no}
情感强度：★★★☆☆
伏笔操作：伏笔${no}
情节张力：★★☆☆☆
本章简述：简述${no}`
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    topic: '长夜',
    genre: ['悬疑', '科幻'],
    numberOfChapters: 5,
    wordNumber: 2000,
    userGuidance: '节奏明快',
    coreSeed: '种子',
    characterDynamics: '角色',
    worldBuilding: '世界',
    plotArchitecture: '情节',
    ...overrides,
  }
}

test('resolves chunk size from max tokens like the original algorithm', () => {
  assert.equal(resolveBlueprintChunkSize(8192, 5), 5)
  assert.equal(resolveBlueprintChunkSize(8192, 100), 30)
  assert.equal(resolveBlueprintChunkSize(1000, 10), 1)
  assert.equal(resolveBlueprintChunkSize(Number.NaN, 7), 7)
})

test('generates a short blueprint in one request', async () => {
  const blueprint = [1, 2, 3, 4, 5].map((no) => chapterText(no)).join('\n\n')
  const prompts: string[] = []
  const chunks: number[] = []

  const result = await generateChapterBlueprint({
    project: project(),
    maxTokens: 8192,
    generate: async (prompt) => {
      prompts.push(prompt)
      return blueprint
    },
    onChunk: (state) => { chunks.push(state.chapters.length) },
  })

  assert.equal(result.requests, 1)
  assert.equal(result.cancelled, false)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /设计5章的节奏分布/)
  assert.match(prompts[0], /#=== 4\) 三幕式情节架构 ===/)
  assert.equal(result.chapters.length, 5)
  assert.equal(result.chapterBlueprint, blueprint)
  assert.deepEqual(chunks, [5])
})

test('continues from the last existing chapter in chunks', async () => {
  const existing = [1, 2].map((no) => chapterText(no)).join('\n\n')
  const calls: { start: number; end: number; prompt: string }[] = []
  const progress: number[] = []

  const result = await generateChapterBlueprint({
    project: project({ numberOfChapters: 6, chapterBlueprint: existing }),
    maxTokens: 1000,
    generate: async (prompt, meta) => {
      calls.push({ ...meta, prompt })
      return chapterText(meta.startChapter)
    },
    onProgress: (state) => { progress.push(state.current) },
  })

  assert.equal(result.requests, 4)
  assert.deepEqual(calls.map((call) => [call.startChapter, call.endChapter]), [[3, 3], [4, 4], [5, 5], [6, 6]])
  assert.match(calls[0].prompt, /当前已有章节目录/)
  assert.match(calls[0].prompt, /第1章 - 标题1/)
  assert.deepEqual(result.chapters.map((chapter) => chapter.number), [1, 2, 3, 4, 5, 6])
  assert.equal(result.chapterBlueprint, [1, 2, 3, 4, 5, 6].map((no) => chapterText(no)).join('\n\n'))
  assert.deepEqual(progress, [3, 4, 5, 6, 6])
})

test('only feeds the latest chapters back to the model', async () => {
  const existing = Array.from({ length: 102 }, (_, i) => chapterText(i + 1)).join('\n\n')
  let captured = ''

  const result = await generateChapterBlueprint({
    project: project({ numberOfChapters: 103, chapterBlueprint: existing }),
    maxTokens: 1000,
    generate: async (prompt, meta) => {
      captured = prompt
      return chapterText(meta.startChapter)
    },
  })

  assert.equal(result.requests, 1)
  assert.match(captured, /第102章 - 标题102/)
  assert.doesNotMatch(captured, /第1章 - 标题1\n/)
  assert.equal(result.chapters.length, 103)

  const limited = limitChapterBlueprint(existing, 100)
  assert.doesNotMatch(limited, /第1章 - 标题1\n/)
  assert.match(limited, /第3章 - 标题3/)
  assert.match(limited, /第102章 - 标题102/)
})

test('merges parsed chunks and drops duplicate chapter blocks', async () => {
  const existing = chapterText(1)
  const saved: number[][] = []

  const result = await generateChapterBlueprint({
    project: project({ numberOfChapters: 4, chapterBlueprint: existing }),
    maxTokens: 4000,
    generate: async () => `${chapterText(2)}\n\n${chapterText(2)}\n\n${chapterText(3)}`,
    onChunk: (state) => { saved.push(state.chapters.map((chapter) => chapter.number)) },
  })

  assert.equal(result.requests, 1)
  assert.deepEqual(result.chapters.map((chapter) => chapter.number), [1, 2, 3])
  assert.equal(result.chapterBlueprint.match(/第2章 - 标题2/g)?.length, 1)
  assert.deepEqual(saved, [[1, 2, 3]])
})

test('stops before the next chunk when cancellation is requested', async () => {
  let calls = 0
  let cancelled = false

  const result = await generateChapterBlueprint({
    project: project({ numberOfChapters: 4, chapterBlueprint: chapterText(1) }),
    maxTokens: 1000,
    generate: async () => {
      calls += 1
      cancelled = true
      return chapterText(2)
    },
    shouldCancel: () => cancelled,
  })

  assert.equal(calls, 1)
  assert.equal(result.cancelled, true)
  assert.deepEqual(result.chapters.map((chapter) => chapter.number), [1, 2])
})

test('rejects a non-positive chapter count', async () => {
  await assert.rejects(
    generateChapterBlueprint({
      project: project({ numberOfChapters: 0 }),
      generate: async () => chapterText(1),
    }),
    /numberOfChapters/,
  )
})
