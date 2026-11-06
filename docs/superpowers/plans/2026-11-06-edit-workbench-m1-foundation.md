# 剪辑工作台 M1 基础实施计划（S1：表结构 + 只读工作台）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **范围说明（2026-11-06，新设计已取代本计划的索引与工程模型）**：本计划是历史 M1 计划，正文中的“每集一份草稿”“按 episode_id 建唯一索引”“剪辑源为分镜/单片段”等约定，已被 `docs/superpowers/specs/2026-11-06-film-hub-mix-edit-redesign.md` 取代。新实施以该规格说明为准；本文件不重写历史任务，仅保留当时范围记录。

**Goal:** 在不影响现有分集、配音、混音、导出链路的前提下，完成剪辑工作台的第一块可独立验收的地基：SQLite 表/列迁移、`edit-plan` 纯函数（类型/布局/校验/哈希）、`edit-media` 媒体探测、聚合只读 API，以及 `/drama/:id/episode/:episodeNumber/edit` 只读页面。

**Architecture:** 后端新增 5 张表并给 3 张既有表幂等补列；`edit-plan.ts` 保持纯函数、无 DB/FFmpeg 依赖，时间线位置全部由 `sourceIn/sourceOut/speed/gap/transition` 派生；`edit-media.ts` 负责逻辑路径 → 本地文件 → ffprobe 元数据与指纹；`edit-service.ts` 在 `edit_workspace=readonly` 下只读当前成片单片段，不创建草稿/版本。前端新增独立 `/edit` 页面，只渲染一个 `<video>`、一个派生时间线和一个只读检查器，与现有混音工作台完全分离。

**Tech Stack:** Hono、Drizzle ORM、better-sqlite3、FFmpeg/ffprobe（`ffmpeg-static`/`ffprobe-static`）、Node test runner、tsx、Nuxt 3/Vue 3、vue-i18n。

**Spec:**
- `docs/V3-剪辑工作台产品设计.md`
- `docs/V3-剪辑工作台技术架构设计.md`（§4.2–§4.7、§5.2–§5.7、§6.1–§6.3、§7、§10、§12、§13、§16）
- `docs/V3-剪辑与混音工作台可行性与产品分析.md`

## Global Constraints

- 音频与视频必须是两个独立页面：本计划只新增 `/drama/:id/episode/:episodeNumber/edit`；`/mix` 与现有混音工作台在 S4 才迁移，M1 不碰 `MixStage.vue`、`DubbingStage.vue` 的播放与时钟。
- 每个页面只能有一个可见预览和一个播放时钟；`/edit` 的预览只允许 `EditPreview.vue` 内一个 `<video>`。
- `edit_workspace` 默认 `readonly`；M1 的 GET 不得创建 `episode_edit_drafts`、`edit_revisions`、`edit_renders` 或写回 `episodes`。
- 计划 JSON 硬上限 200 片段 / 60 分钟 / 8 MB；`MIN_CLIP_FRAMES=3`；`gapBeforeMs` 上限 300000；`tailGapMs` 上限 60000。
- 所有哈希使用 SHA-256 十六进制前 32 位；`planHash` 与导出键别名 `editPlanHash` 同值；`renderHash` 不含任何字幕字段；`editSyncHash` 不含片段级淡入淡出。
- 不修改 `dramas.aspect_ratio`；修改画幅只属于后续版本操作。
- 不改变端口 5679/3013、V3-G5、MCP 61 项、`TEMPLATE_VERSION=6`。
- 不修改用户已有模型/服务配置来绕过失败。
- 不创建 git commit；所有改动留在工作区等待用户审阅。
- 不构建/打包/安装/重启服务，除非用户明确同意。计划中的自动化门禁优先使用测试与 `tsc --noEmit`；前端 `npm run build` 属于需要单独确认的步骤。
- 新文案必须进入 `zh/en/ja/ko` 四个语言文件。
- 后续 S2–S6 在 M1 出口条件验收后另写计划；本计划不实现编辑命令、自动保存、版本、渲染、导出、字幕、混音桥。

---

### Task 1: SQLite 表、列与 Drizzle 映射

**Files:**
- Modify: `backend/src/db/sqlite-schema.ts`（新表 DDL 放在 `mix_revisions`/`episode_exports` 之后，约 586–623 行；索引追加到约 844 行；补列放在 V3-D 补列块之后，约 1127 行）
- Modify: `backend/src/db/schema.ts`（`episodes` 约 40–100 行、`mixRevisions` 约 606 行、`episodeExports` 约 618 行；新 Drizzle 表放在 `episodeExports` 之后）
- Test: `backend/tests/edit-schema.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - 新表：`episode_edit_drafts`、`edit_revisions`、`edit_renders`、`episode_media_proxies`、`episode_locks`。
  - `episodes` 新列：`edit_revision_id`、`edit_plan_hash`、`edit_sync_hash`、`edit_enabled`。
  - `mix_revisions` 新列：`edit_revision_id`、`edit_sync_hash`、`dialogue_sync_hash`、`source_kind DEFAULT 'legacy'`。
  - `episode_exports` 新列：`edit_revision_id`、`mix_revision_id`、`edit_plan_hash`、`edit_sync_hash`、`dialogue_sync_hash`、`render_mode`、`subtitle_mode`、`file_name`。
  - Drizzle 导出：`episodeEditDrafts`、`editRevisions`、`editRenders`、`episodeMediaProxies`、`episodeLocks`。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/edit-schema.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'

function tempDatabase(): { sqlite: Database.Database; close: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-schema-'))
  const sqlite = new Database(path.join(root, 'test.sqlite3'))
  return {
    sqlite,
    close: () => {
      sqlite.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function columns(sqlite: Database.Database, table: string) {
  return new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  )
}

function objects(sqlite: Database.Database, type: 'table' | 'index') {
  return new Set(
    (sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[])
      .map((row) => row.name),
  )
}

test('新建库包含剪辑工作台表、列与索引', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)

    const tables = objects(sqlite, 'table')
    for (const name of [
      'episode_edit_drafts',
      'edit_revisions',
      'edit_renders',
      'episode_media_proxies',
      'episode_locks',
    ]) {
      assert.ok(tables.has(name), `缺少表 ${name}`)
    }

    const indexes = objects(sqlite, 'index')
    for (const name of [
      'idx_edit_drafts_episode',
      'idx_edit_revisions_no',
      'idx_edit_revisions_current',
      'idx_edit_renders_cache',
      'idx_edit_renders_sync',
      'idx_edit_renders_revision',
      'idx_edit_renders_cache_key',
      'idx_media_proxies_source',
    ]) {
      assert.ok(indexes.has(name), `缺少索引 ${name}`)
    }

    for (const name of ['edit_revision_id', 'edit_plan_hash', 'edit_sync_hash', 'edit_enabled']) {
      assert.ok(columns(sqlite, 'episodes').has(name), `episodes 缺少 ${name}`)
    }
    for (const name of ['edit_revision_id', 'edit_sync_hash', 'dialogue_sync_hash', 'source_kind']) {
      assert.ok(columns(sqlite, 'mix_revisions').has(name), `mix_revisions 缺少 ${name}`)
    }
    for (const name of [
      'edit_revision_id', 'mix_revision_id', 'edit_plan_hash', 'edit_sync_hash',
      'dialogue_sync_hash', 'render_mode', 'subtitle_mode', 'file_name',
    ]) {
      assert.ok(columns(sqlite, 'episode_exports').has(name), `episode_exports 缺少 ${name}`)
    }
  } finally {
    close()
  }
})

test('旧数据默认值与重复初始化保持幂等', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    initSqliteSchema(sqlite)

    sqlite.prepare(
      "INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, '测试集', 'x', 'x')",
    ).run()
    const episode = sqlite.prepare('SELECT edit_enabled, edit_revision_id FROM episodes WHERE id = 1').get() as {
      edit_enabled: number
      edit_revision_id: number | null
    }
    assert.equal(episode.edit_enabled, 0)
    assert.equal(episode.edit_revision_id, null)

    sqlite.prepare(
      "INSERT INTO mix_revisions (episode_id, revision_no, plan_json, created_at) VALUES (1, 1, '{}', 'x')",
    ).run()
    const mix = sqlite.prepare('SELECT source_kind, edit_sync_hash FROM mix_revisions WHERE id = 1').get() as {
      source_kind: string
      edit_sync_hash: string | null
    }
    assert.equal(mix.source_kind, 'legacy')
    assert.equal(mix.edit_sync_hash, null)
  } finally {
    close()
  }
})

test('旧集已有剪辑版本时回填 edit_enabled 与当前版本指针', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.prepare(
      "INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, '旧集', 'x', 'x')",
    ).run()
    sqlite.prepare(
      `INSERT INTO edit_revisions
       (episode_id, revision_no, plan_json, plan_hash, edit_sync_hash, is_current, created_at)
       VALUES (1, 1, '{}', 'p', 's', 1, 'x')`,
    ).run()

    initSqliteSchema(sqlite)

    const episode = sqlite.prepare('SELECT edit_enabled, edit_revision_id FROM episodes WHERE id = 1').get() as {
      edit_enabled: number
      edit_revision_id: number | null
    }
    assert.equal(episode.edit_enabled, 1)
    assert.equal(episode.edit_revision_id, 1)
  } finally {
    close()
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/edit-schema.test.ts`

Expected: FAIL，提示缺少 `episode_edit_drafts` 或 `edit_enabled`。

- [ ] **Step 3: 增加新表 DDL 与索引**

在 `backend/src/db/sqlite-schema.ts` 的 `episode_exports` DDL 之后、`dubbing_jobs` 之前插入：

```ts
  // 每集一份可变剪辑草稿
  `CREATE TABLE IF NOT EXISTS episode_edit_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    drama_id INTEGER,
    plan_json TEXT NOT NULL,
    plan_hash TEXT,
    edit_sync_hash TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    base_revision_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 不可变剪辑版本快照
  `CREATE TABLE IF NOT EXISTS edit_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    revision_no INTEGER NOT NULL,
    plan_json TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    edit_sync_hash TEXT NOT NULL,
    render_hash TEXT,
    duration_ms INTEGER,
    clip_count INTEGER,
    note TEXT,
    is_current INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,

  // 剪辑轨 / 原声参考 / 精确预览 / 缩略图缓存
  `CREATE TABLE IF NOT EXISTS edit_renders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    edit_revision_id INTEGER,
    render_hash TEXT,
    edit_sync_hash TEXT,
    dialogue_sync_hash TEXT,
    subtitle_hash TEXT,
    mix_revision_id INTEGER,
    audio_version INTEGER,
    cache_key TEXT,
    range_start_ms INTEGER,
    range_end_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    progress INTEGER NOT NULL DEFAULT 0,
    output_url TEXT,
    output_path TEXT,
    duration_ms INTEGER,
    size_bytes INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    deleted_at TEXT
  )`,

  // 预览代理：低码率/低分辨率源，按源指纹失效
  `CREATE TABLE IF NOT EXISTS episode_media_proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    drama_id INTEGER,
    source_url TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    progress INTEGER NOT NULL DEFAULT 0,
    output_url TEXT,
    width INTEGER,
    height INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  )`,

  // 编辑 / 导出互斥锁
  `CREATE TABLE IF NOT EXISTS episode_locks (
    episode_id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    owner TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
```

在索引声明区（`idx_mix_revisions_current` 之后）追加：

```ts
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_drafts_episode ON episode_edit_drafts (episode_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_revisions_no ON edit_revisions (episode_id, revision_no)`,
  `CREATE INDEX IF NOT EXISTS idx_edit_revisions_current ON edit_revisions (episode_id, is_current)`,
  `CREATE INDEX IF NOT EXISTS idx_edit_renders_cache ON edit_renders (episode_id, kind, status, render_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_edit_renders_sync ON edit_renders (episode_id, kind, status, edit_sync_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_edit_renders_revision ON edit_renders (edit_revision_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_renders_cache_key ON edit_renders (episode_id, kind, cache_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_media_proxies_source ON episode_media_proxies (episode_id, source_url, source_fingerprint)`,
```

- [ ] **Step 4: 增加幂等补列**

在 `initSqliteSchema` 的 V3-D 补列块之后追加：

```ts
  // ===== V3 剪辑工作台：旧库幂等补列，默认只读且不影响既有数据 =====
  const editEpisodeColumns: Record<string, string> = {
    edit_revision_id: 'INTEGER',
    edit_plan_hash: 'TEXT',
    edit_sync_hash: 'TEXT',
    edit_enabled: 'INTEGER DEFAULT 0',
  }
  for (const [name, type] of Object.entries(editEpisodeColumns)) {
    if (!episodeColumns.has(name)) sqlite.exec(`ALTER TABLE episodes ADD COLUMN ${name} ${type}`)
  }

  const mixRevisionColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(mix_revisions)').all() as { name: string }[]).map((row) => row.name),
  )
  const mixEditColumns: Record<string, string> = {
    edit_revision_id: 'INTEGER',
    edit_sync_hash: 'TEXT',
    dialogue_sync_hash: 'TEXT',
    source_kind: "TEXT DEFAULT 'legacy'",
  }
  for (const [name, type] of Object.entries(mixEditColumns)) {
    if (!mixRevisionColumns.has(name)) sqlite.exec(`ALTER TABLE mix_revisions ADD COLUMN ${name} ${type}`)
  }

  const exportColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(episode_exports)').all() as { name: string }[]).map((row) => row.name),
  )
  const exportEditColumns: Record<string, string> = {
    edit_revision_id: 'INTEGER',
    mix_revision_id: 'INTEGER',
    edit_plan_hash: 'TEXT',
    edit_sync_hash: 'TEXT',
    dialogue_sync_hash: 'TEXT',
    render_mode: 'TEXT',
    subtitle_mode: 'TEXT',
    file_name: 'TEXT',
  }
  for (const [name, type] of Object.entries(exportEditColumns)) {
    if (!exportColumns.has(name)) sqlite.exec(`ALTER TABLE episode_exports ADD COLUMN ${name} ${type}`)
  }

  // 旧库回填：已有剪辑版本的分集标记为启用，并指向当前版本；无版本保持默认 0。
  sqlite.exec(`
    UPDATE episodes
    SET edit_enabled = 1,
        edit_revision_id = COALESCE(edit_revision_id, (
          SELECT id FROM edit_revisions
          WHERE edit_revisions.episode_id = episodes.id AND is_current = 1
          LIMIT 1
        ))
    WHERE EXISTS (
      SELECT 1 FROM edit_revisions WHERE edit_revisions.episode_id = episodes.id
    )
  `)
```

- [ ] **Step 5: 增加 Drizzle 字段**

`backend/src/db/schema.ts` 的 `episodes` 中，在 `mixVirtualTracks`/`lastExtractAt` 附近加入：

```ts
  /** 当前剪辑版本（edit_revisions.id）；null 表示尚未建立剪辑版本 */
  editRevisionId: integer('edit_revision_id'),
  /** 当前剪辑计划哈希，用于混音桥快速比较 */
  editPlanHash: text('edit_plan_hash'),
  /** 时间/源素材同步哈希 */
  editSyncHash: text('edit_sync_hash'),
  /** 是否已纳入剪辑工作台（V3）；M1 只读不写 */
  editEnabled: integer('edit_enabled', { mode: 'boolean' }).default(false),
```

`mixRevisions` 增加：

```ts
  editRevisionId: integer('edit_revision_id'),
  editSyncHash: text('edit_sync_hash'),
  dialogueSyncHash: text('dialogue_sync_hash'),
  sourceKind: text('source_kind').default('legacy'),
```

`episodeExports` 增加：

```ts
  editRevisionId: integer('edit_revision_id'),
  mixRevisionId: integer('mix_revision_id'),
  editPlanHash: text('edit_plan_hash'),
  editSyncHash: text('edit_sync_hash'),
  dialogueSyncHash: text('dialogue_sync_hash'),
  renderMode: text('render_mode'),
  subtitleMode: text('subtitle_mode'),
  fileName: text('file_name'),
```

在 `episodeExports` 定义之后追加新表：

```ts
/** 剪辑草稿：每集最多一份，可变 */
export const episodeEditDrafts = sqliteTable('episode_edit_drafts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id'),
  planJson: text('plan_json').notNull(),
  planHash: text('plan_hash'),
  editSyncHash: text('edit_sync_hash'),
  version: integer('version').notNull().default(0),
  baseRevisionId: integer('base_revision_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 不可变剪辑版本 */
export const editRevisions = sqliteTable('edit_revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  revisionNo: integer('revision_no').notNull(),
  planJson: text('plan_json').notNull(),
  planHash: text('plan_hash').notNull(),
  editSyncHash: text('edit_sync_hash').notNull(),
  renderHash: text('render_hash'),
  durationMs: integer('duration_ms'),
  clipCount: integer('clip_count'),
  note: text('note'),
  isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
})

/** 剪辑渲染缓存 */
export const editRenders = sqliteTable('edit_renders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  kind: text('kind').notNull(),
  editRevisionId: integer('edit_revision_id'),
  renderHash: text('render_hash'),
  editSyncHash: text('edit_sync_hash'),
  dialogueSyncHash: text('dialogue_sync_hash'),
  subtitleHash: text('subtitle_hash'),
  mixRevisionId: integer('mix_revision_id'),
  audioVersion: integer('audio_version'),
  cacheKey: text('cache_key'),
  rangeStartMs: integer('range_start_ms'),
  rangeEndMs: integer('range_end_ms'),
  status: text('status').notNull().default('pending'),
  progress: integer('progress').notNull().default(0),
  outputUrl: text('output_url'),
  outputPath: text('output_path'),
  durationMs: integer('duration_ms'),
  sizeBytes: integer('size_bytes'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
  deletedAt: text('deleted_at'),
})

/** 预览代理 */
export const episodeMediaProxies = sqliteTable('episode_media_proxies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id'),
  sourceUrl: text('source_url').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  status: text('status').notNull().default('pending'),
  progress: integer('progress').notNull().default(0),
  outputUrl: text('output_url'),
  width: integer('width'),
  height: integer('height'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
})

/** 编辑 / 导出互斥锁 */
export const episodeLocks = sqliteTable('episode_locks', {
  episodeId: integer('episode_id').primaryKey(),
  kind: text('kind').notNull(),
  owner: text('owner').notNull(),
  acquiredAt: text('acquired_at').notNull(),
  expiresAt: text('expires_at').notNull(),
})
```

- [ ] **Step 6: 运行测试与类型检查**

Run:
```bash
cd backend
npx tsx --test tests/edit-schema.test.ts
npx tsx --test tests/dubbing-schema.test.ts
npx tsc --noEmit
```

Expected: 两个测试文件 PASS；`tsc --noEmit` 退出码 0。

---

### Task 2: 项目存储 `edit` 子目录

**Files:**
- Modify: `backend/src/services/project-storage.ts`（`PROJECT_SUBDIRS` 第 20 行、`ensureStorageLayoutAt` 第 122–126 行）
- Test: `backend/tests/edit-storage.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `PROJECT_SUBDIRS` 包含 `'edit'`。
  - `EDIT_SUBDIRS = ['cut','audio-ref','preview','proxy','tmp'] as const`。
  - `ensureStorageLayoutAt(root)` 同时创建 `edit/` 与 5 个嵌套子目录。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/edit-storage.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EDIT_SUBDIRS, PROJECT_SUBDIRS, ensureStorageLayoutAt } from '../src/services/project-storage.ts'

test('项目目录包含 edit 及嵌套渲染子目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-edit-storage-'))
  try {
    assert.ok(PROJECT_SUBDIRS.includes('edit'))
    assert.deepEqual([...EDIT_SUBDIRS], ['cut', 'audio-ref', 'preview', 'proxy', 'tmp'])

    await ensureStorageLayoutAt(root)
    for (const sub of PROJECT_SUBDIRS) {
      const stat = await fs.stat(path.join(root, sub))
      assert.ok(stat.isDirectory(), `缺少目录 ${sub}`)
    }
    for (const sub of EDIT_SUBDIRS) {
      const stat = await fs.stat(path.join(root, 'edit', sub))
      assert.ok(stat.isDirectory(), `缺少目录 edit/${sub}`)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/edit-storage.test.ts`

Expected: FAIL，`PROJECT_SUBDIRS` 不含 `edit`。

- [ ] **Step 3: 实现**

```ts
export const PROJECT_SUBDIRS = ['images', 'videos', 'uploads', 'merged', 'temp', 'audio', 'transitions', 'edit'] as const
export type ProjectSubdir = typeof PROJECT_SUBDIRS[number]

/** 剪辑工作台的嵌套目录：cut/audio-ref/preview/proxy/tmp */
export const EDIT_SUBDIRS = ['cut', 'audio-ref', 'preview', 'proxy', 'tmp'] as const
```

```ts
export async function ensureStorageLayoutAt(root: string): Promise<string> {
  await fsp.mkdir(root, { recursive: true })
  await Promise.all([
    ...PROJECT_SUBDIRS.map(sub => fsp.mkdir(path.join(root, sub), { recursive: true })),
    ...EDIT_SUBDIRS.map(sub => fsp.mkdir(path.join(root, 'edit', sub), { recursive: true })),
  ])
  return root
}
```

- [ ] **Step 4: 运行测试**

Run: `cd backend && npx tsx --test tests/edit-storage.test.ts`

Expected: PASS。

---

### Task 3: `edit-plan.ts` 类型、默认值与布局

**Files:**
- Create: `backend/src/services/edit-plan.ts`
- Test: `backend/tests/edit-plan.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces（后续任务与 S2 依赖的精确签名）：
  - 常量：`EDIT_PLAN_VERSION=1`、`MIN_CLIP_FRAMES=3`、`MAX_CLIPS=200`、`MAX_SUBTITLES=2000`、`MAX_PLAN_BYTES=8*1024*1024`、`MAX_FADE_MS=1500`、`MIN_TRANSITION_MS=100`、`MAX_TRANSITION_MS=1500`、`MAX_GAP_MS=300000`、`MAX_TAIL_GAP_MS=60000`。
  - 类型：`EditAspect`、`EditFit`、`EditFilterPreset`、`EditSubtitleStyle`、`EditTransitionType`、`EditSourceKind`、`EditProjectSettings`、`EditClipSource`、`EditTransform`、`EditFilter`、`EditClip`、`EditTransition`、`EditSubtitleCue`、`EditTextStyle`、`EditOverlay`、`EditMarker`、`EditLayoutClip`、`EditLayout`、`EditPlanV1`、`EditIssue`。
  - `aspectOf(value: unknown): EditAspect`
  - `bootstrapFps(value: unknown): number`
  - `minimumClipMs(fps: number): number`
  - `projectSettingsForAspect(aspect: EditAspect, fps?: number): EditProjectSettings`
  - `clipContentDurationMs(clip: EditClip): number`
  - `createEmptyEditPlan(episodeId: number, project: EditProjectSettings): EditPlanV1`
  - `createSingleClipPlan(episodeId: number, source: EditClipSource, project: EditProjectSettings): EditPlanV1`
  - `computeLayout(plan: EditPlanV1): EditLayout`

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/edit-plan.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_CLIP_FRAMES,
  aspectOf,
  bootstrapFps,
  clipContentDurationMs,
  computeLayout,
  createEmptyEditPlan,
  createSingleClipPlan,
  minimumClipMs,
  projectSettingsForAspect,
  type EditClip,
  type EditClipSource,
  type EditOverlay,
  type EditPlanV1,
  type EditProjectSettings,
} from '../src/services/edit-plan.ts'

const project: EditProjectSettings = projectSettingsForAspect('9:16', 30)

function source(id = 1, durationMs = 60000): EditClipSource {
  return {
    kind: 'episode-video',
    id,
    url: `static/projects/1/videos/${id}.mp4`,
    durationMs,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    fingerprint: `${durationMs}:1000`,
    label: `片段 ${id}`,
  }
}

function clip(id: string, durationMs: number, patch: Partial<EditClip> = {}): EditClip {
  return {
    id,
    kind: 'video',
    source: source(1, 60000),
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
    gapBeforeMs: 0,
    videoFadeInMs: 0,
    videoFadeOutMs: 0,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    filter: { preset: 'none', intensity: 100 },
    ...patch,
  }
}

function textOverlay(endMs: number): EditOverlay {
  return {
    id: 'ov_1',
    kind: 'text',
    text: {
      text: '标题',
      preset: 'title',
      fontFamily: 'sans-serif',
      fontSize: 48,
      color: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 0,
      backgroundColor: null,
      align: 'center',
      x: 0.5,
      y: 0.2,
    },
    startMs: 0,
    endMs,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    opacity: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    track: 0,
  }
}

test('工程默认值、画幅与帧率归一', () => {
  assert.equal(aspectOf('9:16'), '9:16')
  assert.equal(aspectOf('4:3'), '16:9')

  assert.equal(bootstrapFps(23.976), 24)
  assert.equal(bootstrapFps(25), 25)
  assert.equal(bootstrapFps(29.97), 30)
  assert.equal(bootstrapFps(60), 30)
  assert.equal(bootstrapFps(12), 30)
  assert.equal(bootstrapFps(null), 30)

  assert.equal(minimumClipMs(30), 100)
  assert.equal(minimumClipMs(24), 125)
  assert.equal(MIN_CLIP_FRAMES, 3)

  const vertical = projectSettingsForAspect('9:16', 60)
  assert.deepEqual(
    { aspect: vertical.aspect, width: vertical.width, height: vertical.height, fps: vertical.fps, preset: vertical.defaultExportPreset },
    { aspect: '9:16', width: 1080, height: 1920, fps: 30, preset: 'edit-vertical-hd' },
  )
  const horizontal = projectSettingsForAspect('16:9', 24)
  assert.deepEqual(
    { width: horizontal.width, height: horizontal.height, fps: horizontal.fps, preset: horizontal.defaultExportPreset },
    { width: 1920, height: 1080, fps: 24, preset: 'edit-horizontal-hd' },
  )
  const square = projectSettingsForAspect('1:1', 25)
  assert.deepEqual(
    { width: square.width, height: square.height, preset: square.defaultExportPreset },
    { width: 1080, height: 1080, preset: 'edit-source' },
  )
})

test('空计划与单片段计划', () => {
  const empty = createEmptyEditPlan(42, project)
  assert.equal(empty.version, 1)
  assert.equal(empty.episodeId, 42)
  assert.deepEqual(empty.clips, [])
  assert.deepEqual(empty.transitions, [])
  assert.deepEqual(computeLayout(empty), { contentEndMs: 0, durationMs: 0, clips: [], transitions: [] })

  const single = createSingleClipPlan(42, source(7, 12000), project)
  assert.equal(single.clips.length, 1)
  assert.equal(single.clips[0].source.kind, 'episode-video')
  assert.equal(single.clips[0].source.id, 7)
  assert.equal(single.clips[0].sourceInMs, 0)
  assert.equal(single.clips[0].sourceOutMs, 12000)
  assert.equal(single.clips[0].speed, 1)
  assert.equal(clipContentDurationMs(single.clips[0]), 12000)

  const layout = computeLayout(single)
  assert.equal(layout.contentEndMs, 12000)
  assert.equal(layout.durationMs, 12000)
})

test('布局：片头空档、转场重叠、片段空档、尾段与叠加轨', () => {
  const plan = createEmptyEditPlan(1, { ...project, tailGapMs: 500 })
  plan.clips = [
    clip('clp_a', 5000, { gapBeforeMs: 1000 }),
    clip('clp_b', 4000, { gapBeforeMs: 300, source: source(2, 60000) }),
  ]
  plan.transitions = [{
    id: 'tr_1',
    fromClipId: 'clp_a',
    toClipId: 'clp_b',
    type: 'dissolve',
    durationMs: 400,
  }]
  plan.overlays = [textOverlay(9600)]

  const layout = computeLayout(plan)
  assert.deepEqual(layout.clips, [
    { clipId: 'clp_a', timelineStartMs: 1000, timelineEndMs: 6000, contentDurationMs: 5000 },
    { clipId: 'clp_b', timelineStartMs: 5900, timelineEndMs: 9900, contentDurationMs: 4000 },
  ])
  assert.equal(layout.contentEndMs, 9900)
  assert.equal(layout.durationMs, 10400)
  assert.deepEqual(layout.transitions, [{
    id: 'tr_1',
    fromClipId: 'clp_a',
    toClipId: 'clp_b',
    overlapMs: 400,
  }])
})

test('布局：变速改变内容时长', () => {
  const plan = createEmptyEditPlan(1, project)
  plan.clips = [clip('clp_a', 10000, { speed: 2 })]
  const layout = computeLayout(plan)
  assert.equal(layout.contentEndMs, 5000)
  assert.equal(layout.durationMs, 5000)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/edit-plan.test.ts`

Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: 创建 `backend/src/services/edit-plan.ts`**

写入完整类型与默认值/布局实现：

```ts
/**
 * 剪辑计划纯函数核心（技术设计 §4.2–§4.6、§6.2）。
 * 本文件不得 import DB / FFmpeg / 路由，便于测试与后续前端类型共享。
 */
import { createHash } from 'node:crypto'

export const EDIT_PLAN_VERSION = 1 as const
export const MIN_CLIP_FRAMES = 3
export const MAX_CLIPS = 200
export const MAX_SUBTITLES = 2000
export const MAX_PLAN_BYTES = 8 * 1024 * 1024
export const MAX_FADE_MS = 1500
export const MIN_TRANSITION_MS = 100
export const MAX_TRANSITION_MS = 1500
export const MAX_GAP_MS = 300_000
export const MAX_TAIL_GAP_MS = 60_000

export type EditAspect = '9:16' | '16:9' | '1:1'
export type EditFit = 'fill' | 'fit'
export type EditFilterPreset =
  | 'none' | 'clear' | 'warm' | 'cool' | 'cinematic' | 'mono' | 'vintage'
export type EditSubtitleStyle = 'default' | 'outline' | 'box'
export type EditTransitionType = 'dissolve' | 'white' | 'push-left' | 'blur'
export type EditSourceKind =
  | 'storyboard'
  | 'take'
  | 'asset'
  | 'merge'
  | 'episode-video'
  | 'import'

export interface EditProjectSettings {
  aspect: EditAspect
  width: number
  height: number
  fps: number
  background: 'black' | 'blur'
  defaultFit: EditFit
  defaultTransition: 'cut' | 'dissolve'
  defaultSubtitleStyle: EditSubtitleStyle
  defaultExportPreset: string
  tailGapMs: number
}

export interface EditClipSource {
  kind: EditSourceKind
  id: number | string
  url: string
  durationMs: number
  width: number
  height: number
  fps: number | null
  hasAudio: boolean
  fingerprint: string
  label?: string
  thumbnailUrl?: string | null
}

export interface EditTransform {
  scale: number
  x: number
  y: number
  rotation: 0 | 90 | 180 | 270
  flipH: boolean
  flipV: boolean
}

export interface EditFilter {
  preset: EditFilterPreset
  intensity: number
}

export interface EditClip {
  id: string
  kind: 'video' | 'image'
  source: EditClipSource
  sourceInMs: number
  sourceOutMs: number
  speed: number
  gapBeforeMs: number
  videoFadeInMs: number
  videoFadeOutMs: number
  transform: EditTransform
  filter: EditFilter
  lineId?: number | null
  videoTakeAssetId?: number | null
}

export interface EditTransition {
  id: string
  fromClipId: string
  toClipId: string
  type: EditTransitionType
  durationMs: number
}

export interface EditSubtitleCue {
  id: string
  text: string
  startMs: number
  endMs: number
  style: EditSubtitleStyle
  role?: string | null
  source: 'line' | 'manual' | 'import'
  follow: boolean
  anchor?: { clipId: string; offsetMs: number } | null
  lineId?: number | null
  warnings?: string[]
}

export interface EditTextStyle {
  text: string
  preset: 'title' | 'subtitle' | 'name' | 'place'
  fontFamily: string
  fontSize: number
  color: string
  strokeColor: string
  strokeWidth: number
  backgroundColor: string | null
  align: 'left' | 'center' | 'right'
  x: number
  y: number
}

export interface EditOverlay {
  id: string
  kind: 'video' | 'image' | 'text'
  source?: EditClipSource
  text?: EditTextStyle
  startMs: number
  endMs: number
  transform: EditTransform
  opacity: number
  fadeInMs: number
  fadeOutMs: number
  track: 0
}

export interface EditMarker {
  id: string
  atMs: number
  label: string
  color: string
}

export interface EditLayoutClip {
  clipId: string
  timelineStartMs: number
  timelineEndMs: number
  contentDurationMs: number
}

export interface EditLayout {
  contentEndMs: number
  durationMs: number
  clips: EditLayoutClip[]
  transitions: { id: string; fromClipId: string; toClipId: string; overlapMs: number }[]
}

export interface EditPlanV1 {
  version: typeof EDIT_PLAN_VERSION
  episodeId: number
  project: EditProjectSettings
  clips: EditClip[]
  transitions: EditTransition[]
  subtitles: EditSubtitleCue[]
  overlays: EditOverlay[]
  markers: EditMarker[]
  layout?: EditLayout
}

export interface EditIssue {
  severity: 'error' | 'warning'
  code: string
  path: string
  message: string
}

export function aspectOf(value: unknown): EditAspect {
  return value === '9:16' || value === '16:9' || value === '1:1' ? value : '16:9'
}

export function bootstrapFps(value: unknown): number {
  const fps = Number(value)
  if (!Number.isFinite(fps) || fps <= 0) return 30
  const rounded = Math.round(fps)
  return rounded >= 24 && rounded <= 30 ? rounded : 30
}

export function minimumClipMs(fps: number): number {
  return Math.ceil((MIN_CLIP_FRAMES * 1000) / Math.max(1, fps))
}

export function projectSettingsForAspect(aspect: EditAspect, fps = 30): EditProjectSettings {
  const width = aspect === '16:9' ? 1920 : 1080
  const height = aspect === '16:9' ? 1080 : aspect === '9:16' ? 1920 : 1080
  return {
    aspect,
    width,
    height,
    fps: bootstrapFps(fps),
    background: 'black',
    defaultFit: aspect === '16:9' ? 'fit' : 'fill',
    defaultTransition: 'cut',
    defaultSubtitleStyle: 'default',
    defaultExportPreset: aspect === '9:16'
      ? 'edit-vertical-hd'
      : aspect === '16:9'
        ? 'edit-horizontal-hd'
        : 'edit-source',
    tailGapMs: 0,
  }
}

function defaultTransform(): EditTransform {
  return { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false }
}

function defaultFilter(): EditFilter {
  return { preset: 'none', intensity: 100 }
}

export function createEmptyEditPlan(episodeId: number, project: EditProjectSettings): EditPlanV1 {
  return {
    version: EDIT_PLAN_VERSION,
    episodeId,
    project: { ...project },
    clips: [],
    transitions: [],
    subtitles: [],
    overlays: [],
    markers: [],
  }
}

export function createSingleClipPlan(
  episodeId: number,
  source: EditClipSource,
  project: EditProjectSettings,
): EditPlanV1 {
  return {
    ...createEmptyEditPlan(episodeId, { ...project, fps: bootstrapFps(source.fps ?? project.fps) }),
    clips: [{
      id: 'clp_1',
      kind: 'video',
      source,
      sourceInMs: 0,
      sourceOutMs: source.durationMs,
      speed: 1,
      gapBeforeMs: 0,
      videoFadeInMs: 0,
      videoFadeOutMs: 0,
      transform: defaultTransform(),
      filter: defaultFilter(),
    }],
  }
}

export function clipContentDurationMs(clip: EditClip): number {
  if (!Number.isFinite(clip.speed) || clip.speed <= 0) return 0
  return Math.round((clip.sourceOutMs - clip.sourceInMs) / clip.speed)
}

function findTransition(plan: EditPlanV1, fromClipId: string, toClipId: string): EditTransition | null {
  return plan.transitions.find((item) => item.fromClipId === fromClipId && item.toClipId === toClipId) ?? null
}

export function computeLayout(plan: EditPlanV1): EditLayout {
  const clips: EditLayoutClip[] = []
  const transitions: EditLayout['transitions'] = []
  let cursor = 0

  plan.clips.forEach((clip, index) => {
    const content = clipContentDurationMs(clip)
    const previous = index === 0 ? null : plan.clips[index - 1]
    const transition = previous ? findTransition(plan, previous.id, clip.id) : null
    const overlap = transition?.durationMs ?? 0
    const start = index === 0 ? clip.gapBeforeMs : cursor - overlap + clip.gapBeforeMs
    const end = start + content
    clips.push({
      clipId: clip.id,
      timelineStartMs: start,
      timelineEndMs: end,
      contentDurationMs: content,
    })
    if (transition && overlap > 0) {
      transitions.push({
        id: transition.id,
        fromClipId: previous!.id,
        toClipId: clip.id,
        overlapMs: overlap,
      })
    }
    cursor = end
  })

  const contentEndMs = clips.length ? clips[clips.length - 1].timelineEndMs : 0
  const overlayEnd = plan.overlays.reduce((max, overlay) => Math.max(max, overlay.endMs), 0)
  return {
    contentEndMs,
    durationMs: Math.max(contentEndMs, overlayEnd) + Math.max(0, plan.project.tailGapMs || 0),
    clips,
    transitions,
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `cd backend && npx tsx --test tests/edit-plan.test.ts`

Expected: PASS。

---

### Task 4: 校验与哈希（含拆分不变性）

**Files:**
- Modify: `backend/src/services/edit-plan.ts`
- Test: `backend/tests/edit-hashes.test.ts`

**Interfaces:**
- Consumes: Task 3 的全部类型与 `computeLayout`、`clipContentDurationMs`、`findTransition`、常量。
- Produces:
  - `DialoguePlacement`（`lineId`、`voiceTakeId`、`takeUrl`、`takeFingerprint`、`durationMs`）。
  - `validateEditPlan(plan: EditPlanV1): EditIssue[]`
  - `stableStringify(value: unknown): string`
  - `shortHash(value: unknown): string`
  - `planHashOf(plan: EditPlanV1): string`
  - `renderHashOf(plan: EditPlanV1): string`
  - `editSyncHashOf(plan: EditPlanV1): string`
  - `dialogueSyncHashOf(placements: DialoguePlacement[]): string`
  - `subtitleHashOf(plan: EditPlanV1): string`

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/edit-hashes.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_TAIL_GAP_MS,
  createSingleClipPlan,
  dialogueSyncHashOf,
  editSyncHashOf,
  planHashOf,
  projectSettingsForAspect,
  renderHashOf,
  shortHash,
  subtitleHashOf,
  validateEditPlan,
  type EditClip,
  type EditClipSource,
  type EditOverlay,
  type EditPlanV1,
  type EditSubtitleCue,
} from '../src/services/edit-plan.ts'

const project = projectSettingsForAspect('9:16', 30)

function source(id = 1, durationMs = 10000): EditClipSource {
  return {
    kind: 'storyboard',
    id,
    url: `static/projects/1/videos/${id}.mp4`,
    durationMs,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    fingerprint: `${durationMs}:1000`,
    label: '镜头',
  }
}

function clip(id: string, patch: Partial<EditClip> = {}): EditClip {
  return {
    id,
    kind: 'video',
    source: source(1, 10000),
    sourceInMs: 0,
    sourceOutMs: 10000,
    speed: 1,
    gapBeforeMs: 0,
    videoFadeInMs: 0,
    videoFadeOutMs: 0,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    filter: { preset: 'none', intensity: 100 },
    ...patch,
  }
}

function overlay(endMs: number): EditOverlay {
  return {
    id: 'ov_1',
    kind: 'text',
    text: {
      text: '标题', preset: 'title', fontFamily: 'sans-serif', fontSize: 48,
      color: '#ffffff', strokeColor: '#000000', strokeWidth: 0, backgroundColor: null,
      align: 'center', x: 0.5, y: 0.2,
    },
    startMs: 0,
    endMs,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    opacity: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    track: 0,
  }
}

function basePlan(): EditPlanV1 {
  const plan = createSingleClipPlan(7, source(), project)
  plan.clips = [clip('clp_1')]
  return plan
}

test('校验：空计划无问题，非法结构产生 error/warning', () => {
  assert.deepEqual(validateEditPlan(basePlan()), [])

  const plan = basePlan()
  plan.version = 2 as any
  plan.clips.push(clip('clp_1'))
  plan.clips[0].source.url = ''
  plan.clips[0].sourceOutMs = 2000
  plan.clips[0].videoFadeInMs = 1200
  plan.clips[0].videoFadeOutMs = 1200
  const issues = validateEditPlan(plan)
  assert.ok(issues.some((item) => item.severity === 'error' && item.code === 'VERSION'))
  assert.ok(issues.some((item) => item.severity === 'error' && item.code === 'CLIP_ID_DUPLICATE'))
  assert.ok(issues.some((item) => item.severity === 'error' && item.code === 'CLIP_SOURCE_URL'))
  assert.ok(issues.some((item) => item.severity === 'warning' && item.code === 'CLIP_FADE_SUM'))

  const badProject = basePlan()
  badProject.project.aspect = '4:3' as any
  badProject.project.tailGapMs = MAX_TAIL_GAP_MS + 1
  const projectIssues = validateEditPlan(badProject)
  assert.ok(projectIssues.some((item) => item.code === 'PROJECT_ASPECT'))
  assert.ok(projectIssues.some((item) => item.code === 'PROJECT_TAIL_GAP'))

  const subtitled = basePlan()
  subtitled.subtitles = [
    { id: 'cue_1', text: '第一句', startMs: 0, endMs: 2000, style: 'default', source: 'manual', follow: false },
    { id: 'cue_2', text: '第二句', startMs: 1000, endMs: 12000, style: 'default', source: 'manual', follow: false },
  ]
  const subtitleIssues = validateEditPlan(subtitled)
  assert.ok(subtitleIssues.some((item) => item.code === 'SUBTITLE_OVERLAP'))
  assert.ok(subtitleIssues.some((item) => item.code === 'SUBTITLE_BEYOND_END'))
})

test('哈希：稳定、忽略非渲染元数据、字幕只进 plan/subtitle', () => {
  const plan = basePlan()
  assert.equal(planHashOf(plan), planHashOf(basePlan()))
  assert.equal(shortHash({ b: 1, a: [2, 3] }), shortHash({ a: [2, 3], b: 1 }))
  assert.equal(shortHash({ a: 1 }).length, 32)

  const meta = basePlan()
  meta.markers = [{ id: 'm1', atMs: 500, label: '看这里', color: '#ff0' }]
  meta.clips[0].source.label = '改了标签'
  meta.clips[0].lineId = 99
  meta.layout = { contentEndMs: 1, durationMs: 1, clips: [], transitions: [] }
  assert.equal(planHashOf(meta), planHashOf(plan))

  const cue: EditSubtitleCue = {
    id: 'cue_1', text: '你好', startMs: 0, endMs: 1000,
    style: 'default', source: 'manual', follow: false,
  }
  const subtitled = basePlan()
  subtitled.subtitles = [cue]
  assert.notEqual(planHashOf(subtitled), planHashOf(plan))
  assert.notEqual(subtitleHashOf(subtitled), subtitleHashOf(plan))
  assert.equal(renderHashOf(subtitled), renderHashOf(plan))
})

test('哈希：淡入淡出只影响 renderHash，不影响 editSyncHash', () => {
  const plain = basePlan()
  const faded = basePlan()
  faded.clips[0].videoFadeInMs = 300
  faded.clips[0].videoFadeOutMs = 200
  assert.notEqual(renderHashOf(faded), renderHashOf(plain))
  assert.equal(editSyncHashOf(faded), editSyncHashOf(plain))
  assert.notEqual(planHashOf(faded), planHashOf(plain))
})

test('哈希：拆分片段不改变 editSyncHash', () => {
  const single = basePlan()
  const split = basePlan()
  split.clips = [
    { ...single.clips[0], id: 'clp_1', sourceOutMs: 4000 },
    { ...single.clips[0], id: 'clp_2', sourceInMs: 4000, sourceOutMs: 10000 },
  ]
  assert.equal(editSyncHashOf(split), editSyncHashOf(single))
  assert.notEqual(renderHashOf(split), renderHashOf(single))
})

test('哈希：换源、转场、叠加轨延长总时长会改变 editSyncHash', () => {
  const a = basePlan()
  const b = basePlan()
  b.clips[0].source = source(2, 10000)
  assert.notEqual(editSyncHashOf(a), editSyncHashOf(b))

  const two = basePlan()
  two.clips = [
    clip('clp_1', { source: source(1, 5000), sourceOutMs: 5000 }),
    clip('clp_2', { source: source(2, 5000), sourceOutMs: 5000, gapBeforeMs: 0 }),
  ]
  const cut = editSyncHashOf(two)
  two.transitions = [{ id: 'tr_1', fromClipId: 'clp_1', toClipId: 'clp_2', type: 'dissolve', durationMs: 400 }]
  assert.notEqual(editSyncHashOf(two), cut)

  const withOverlay = basePlan()
  withOverlay.overlays = [overlay(5000)]
  const short = editSyncHashOf(withOverlay)
  withOverlay.overlays = [overlay(9000)]
  assert.equal(editSyncHashOf(withOverlay), short, '叠加轨未超过主轨，不应影响混音')

  const longer = basePlan()
  longer.overlays = [overlay(12000)]
  assert.notEqual(editSyncHashOf(longer), short, '叠加轨延长总时长必须影响混音')
})

test('哈希：配音 Take 顺序、URL、指纹与时长变化均失效', () => {
  const first = dialogueSyncHashOf([
    { lineId: 1, voiceTakeId: 10, takeUrl: 'static/a.wav', takeFingerprint: '1:1', durationMs: 1000 },
    { lineId: 2, voiceTakeId: 20, takeUrl: 'static/b.wav', takeFingerprint: '2:2', durationMs: 1200 },
  ])
  const same = dialogueSyncHashOf([
    { lineId: 1, voiceTakeId: 10, takeUrl: 'static/a.wav', takeFingerprint: '1:1', durationMs: 1000 },
    { lineId: 2, voiceTakeId: 20, takeUrl: 'static/b.wav', takeFingerprint: '2:2', durationMs: 1200 },
  ])
  const changedTake = dialogueSyncHashOf([
    { lineId: 1, voiceTakeId: 11, takeUrl: 'static/a.wav', takeFingerprint: '1:1', durationMs: 1000 },
    { lineId: 2, voiceTakeId: 20, takeUrl: 'static/b.wav', takeFingerprint: '2:2', durationMs: 1200 },
  ])
  const reordered = dialogueSyncHashOf([
    { lineId: 2, voiceTakeId: 20, takeUrl: 'static/b.wav', takeFingerprint: '2:2', durationMs: 1200 },
    { lineId: 1, voiceTakeId: 10, takeUrl: 'static/a.wav', takeFingerprint: '1:1', durationMs: 1000 },
  ])
  assert.equal(first, same)
  assert.notEqual(first, changedTake)
  assert.notEqual(first, reordered)
  assert.equal(first.length, 32)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/edit-hashes.test.ts`

Expected: FAIL，`validateEditPlan` / `planHashOf` 未导出。

- [ ] **Step 3: 在 `edit-plan.ts` 追加实现**

在文件末尾追加：

```ts
export interface DialoguePlacement {
  lineId: number
  voiceTakeId: number | null
  takeUrl: string | null
  takeFingerprint: string | null
  durationMs: number
}

export function validateEditPlan(plan: EditPlanV1): EditIssue[] {
  const issues: EditIssue[] = []
  const error = (code: string, path: string, message: string) => {
    issues.push({ severity: 'error', code, path, message })
  }
  const warning = (code: string, path: string, message: string) => {
    issues.push({ severity: 'warning', code, path, message })
  }

  if (plan.version !== EDIT_PLAN_VERSION) error('VERSION', 'version', '计划版本必须为 1')
  if (!Number.isInteger(plan.project.width) || plan.project.width < 16 || plan.project.width > 7680 || plan.project.width % 2 !== 0) {
    error('PROJECT_WIDTH', 'project.width', '输出宽度必须为 16–7680 的偶数')
  }
  if (!Number.isInteger(plan.project.height) || plan.project.height < 16 || plan.project.height > 7680 || plan.project.height % 2 !== 0) {
    error('PROJECT_HEIGHT', 'project.height', '输出高度必须为 16–7680 的偶数')
  }
  if (!Number.isFinite(plan.project.fps) || plan.project.fps < 1 || plan.project.fps > 120) {
    error('PROJECT_FPS', 'project.fps', '帧率必须在 1–120')
  }
  if (!['9:16', '16:9', '1:1'].includes(plan.project.aspect)) {
    error('PROJECT_ASPECT', 'project.aspect', '画幅必须为 9:16、16:9 或 1:1')
  }
  if (!Number.isFinite(plan.project.tailGapMs) || plan.project.tailGapMs < 0 || plan.project.tailGapMs > MAX_TAIL_GAP_MS) {
    error('PROJECT_TAIL_GAP', 'project.tailGapMs', '尾段空档必须在 0–60000ms')
  }
  if (plan.clips.length > MAX_CLIPS) error('CLIP_LIMIT', 'clips', `片段数不能超过 ${MAX_CLIPS}`)
  if (plan.subtitles.length > MAX_SUBTITLES) error('SUBTITLE_LIMIT', 'subtitles', `字幕数不能超过 ${MAX_SUBTITLES}`)
  if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > MAX_PLAN_BYTES) {
    error('PLAN_BYTES', '', '计划 JSON 不能超过 8 MB')
  }

  const clipIds = new Set<string>()
  const minMs = minimumClipMs(plan.project.fps)
  for (const [index, clip] of plan.clips.entries()) {
    const path = `clips[${index}]`
    if (!clip.id || clipIds.has(clip.id)) error('CLIP_ID_DUPLICATE', `${path}.id`, '片段 ID 必须唯一且非空')
    clipIds.add(clip.id)
    if (!clip.source.url.trim()) error('CLIP_SOURCE_URL', `${path}.source.url`, '源素材地址不能为空')
    if (!Number.isFinite(clip.sourceInMs) || clip.sourceInMs < 0 || clip.sourceOutMs <= clip.sourceInMs) {
      error('CLIP_SOURCE_RANGE', `${path}.sourceInMs`, '源入点/出点无效')
    }
    if (!Number.isFinite(clip.speed) || clip.speed < 0.25 || clip.speed > 4) {
      error('CLIP_SPEED', `${path}.speed`, '变速必须在 0.25–4.0')
    }
    if (!Number.isFinite(clip.gapBeforeMs) || clip.gapBeforeMs < 0 || clip.gapBeforeMs > MAX_GAP_MS) {
      error('CLIP_GAP', `${path}.gapBeforeMs`, '片段空档必须在 0–300000ms')
    }
    if (clip.sourceOutMs - clip.sourceInMs < minMs || clipContentDurationMs(clip) < minMs) {
      error('CLIP_TOO_SHORT', path, `片段不得短于 ${minMs}ms（3 帧）`)
    }
    if (clip.videoFadeInMs < 0 || clip.videoFadeInMs > MAX_FADE_MS
      || clip.videoFadeOutMs < 0 || clip.videoFadeOutMs > MAX_FADE_MS) {
      error('CLIP_FADE_RANGE', path, '淡入淡出必须在 0–1500ms')
    } else if (clip.videoFadeInMs + clip.videoFadeOutMs > clipContentDurationMs(clip)) {
      warning('CLIP_FADE_SUM', path, '淡入淡出之和超过片段时长，导出时会等比缩短')
    }
  }

  const clipIndex = new Map(plan.clips.map((clip, index) => [clip.id, index]))
  const usedBoundaries = new Set<number>()
  for (const [index, transition] of plan.transitions.entries()) {
    const path = `transitions[${index}]`
    const from = clipIndex.get(transition.fromClipId)
    const to = clipIndex.get(transition.toClipId)
    if (from === undefined || to === undefined || to !== from + 1) {
      error('TRANSITION_ADJACENCY', path, '转场只能位于主轨相邻片段之间')
      continue
    }
    if (usedBoundaries.has(to)) error('TRANSITION_DUPLICATE', path, '一个交界最多一个转场')
    usedBoundaries.add(to)
    if (plan.clips[to].gapBeforeMs > 0) warning('TRANSITION_GAP', path, '有间隙的交界不允许转场，保存时会移除')
    if (transition.durationMs < MIN_TRANSITION_MS || transition.durationMs > MAX_TRANSITION_MS) {
      warning('TRANSITION_RANGE', path, '转场时长必须在 100–1500ms')
    }
    const spare = Math.min(clipContentDurationMs(plan.clips[from]), clipContentDurationMs(plan.clips[to]))
      - 1000 / Math.max(1, plan.project.fps)
    if (transition.durationMs > spare) {
      warning('TRANSITION_OVERFLOW', path, `转场超过可用余量 ${Math.max(0, Math.round(spare))}ms`)
    }
  }

  const totalDurationMs = computeLayout(plan).durationMs
  for (const [index, cue] of plan.subtitles.entries()) {
    const path = `subtitles[${index}]`
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs >= cue.endMs) {
      error('SUBTITLE_RANGE', path, '字幕开始时间必须早于结束时间')
    }
    if (cue.endMs > totalDurationMs) {
      warning('SUBTITLE_BEYOND_END', path, '字幕超出总时长，导出时会截断')
    }
    if (cue.text.length > 500) warning('SUBTITLE_TEXT', path, '单条字幕建议不超过 500 字符')
    if (cue.follow && (!cue.anchor || !clipIndex.has(cue.anchor.clipId))) {
      warning('SUBTITLE_ANCHOR', path, '跟随字幕缺少有效片段锚点，保存时会转为固定字幕')
    }
  }

  const orderedCues = plan.subtitles
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.startMs - b.cue.startMs || a.cue.endMs - b.cue.endMs)
  for (let index = 1; index < orderedCues.length; index += 1) {
    if (orderedCues[index].cue.startMs < orderedCues[index - 1].cue.endMs) {
      warning(
        'SUBTITLE_OVERLAP',
        `subtitles[${orderedCues[index].index}]`,
        '字幕时间重叠，导出前请确认',
      )
    }
  }

  for (const [index, overlay] of plan.overlays.entries()) {
    const path = `overlays[${index}]`
    if (!Number.isFinite(overlay.startMs) || !Number.isFinite(overlay.endMs) || overlay.endMs <= overlay.startMs) {
      error('OVERLAY_RANGE', path, '叠加轨结束时间必须晚于开始时间')
    }
    if ((overlay.text?.text.length ?? 0) > 500) warning('OVERLAY_TEXT', path, '单条文案建议不超过 500 字符')
  }

  return issues
}

export function stableStringify(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .filter((key) => record[key] !== undefined)
          .map((key) => [key, canonical(record[key])]),
      )
    }
    return input
  }
  return JSON.stringify(canonical(value))
}

export function shortHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32)
}

function clipSourceHash(source: EditClipSource) {
  return {
    kind: source.kind,
    id: source.id,
    url: source.url,
    durationMs: source.durationMs,
    width: source.width,
    height: source.height,
    fps: source.fps,
    hasAudio: source.hasAudio,
    fingerprint: source.fingerprint,
  }
}

function clipVisualHash(clip: EditClip) {
  return {
    kind: clip.kind,
    source: {
      kind: clip.source.kind,
      id: clip.source.id,
      fingerprint: clip.source.fingerprint,
    },
    sourceInMs: clip.sourceInMs,
    sourceOutMs: clip.sourceOutMs,
    speed: clip.speed,
    gapBeforeMs: clip.gapBeforeMs,
    videoFadeInMs: clip.videoFadeInMs,
    videoFadeOutMs: clip.videoFadeOutMs,
    transform: clip.transform,
    filter: clip.filter,
  }
}

function transitionRows(plan: EditPlanV1) {
  const index = new Map(plan.clips.map((clip, position) => [clip.id, position]))
  return plan.transitions
    .map((transition) => ({
      at: (index.get(transition.fromClipId) ?? -1) + 1,
      type: transition.type,
      durationMs: transition.durationMs,
    }))
    .sort((a, b) => a.at - b.at)
}

function subtitleRows(plan: EditPlanV1) {
  const index = new Map(plan.clips.map((clip, position) => [clip.id, position]))
  return [...plan.subtitles]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.text.localeCompare(b.text))
    .map((cue) => ({
      text: cue.text,
      startMs: cue.startMs,
      endMs: cue.endMs,
      style: cue.style,
      role: cue.role ?? null,
      source: cue.source,
      follow: cue.follow,
      anchor: cue.anchor ? { clip: index.get(cue.anchor.clipId) ?? -1, offsetMs: cue.anchor.offsetMs } : null,
    }))
}

function overlayRows(plan: EditPlanV1, textOnly: boolean) {
  return [...plan.overlays]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((item) => ({
      kind: item.kind,
      source: item.source
        ? { kind: item.source.kind, id: item.source.id, fingerprint: item.source.fingerprint }
        : null,
      text: textOnly ? item.text : null,
      startMs: item.startMs,
      endMs: item.endMs,
      transform: item.transform,
      opacity: item.opacity,
      fadeInMs: item.fadeInMs,
      fadeOutMs: item.fadeOutMs,
      track: item.track,
    }))
}

export function planHashOf(plan: EditPlanV1): string {
  return shortHash({
    version: plan.version,
    episodeId: plan.episodeId,
    project: plan.project,
    clips: plan.clips.map((clip) => ({
      ...clipVisualHash(clip),
      source: clipSourceHash(clip.source),
    })),
    transitions: transitionRows(plan),
    subtitles: subtitleRows(plan),
    overlays: overlayRows(plan, true),
  })
}

export function renderHashOf(plan: EditPlanV1): string {
  return shortHash({
    version: plan.version,
    project: {
      aspect: plan.project.aspect,
      width: plan.project.width,
      height: plan.project.height,
      fps: plan.project.fps,
      background: plan.project.background,
      tailGapMs: plan.project.tailGapMs,
    },
    clips: plan.clips.map(clipVisualHash),
    transitions: transitionRows(plan),
    overlays: overlayRows(plan, true),
  })
}

export function subtitleHashOf(plan: EditPlanV1): string {
  return shortHash({ version: plan.version, cues: subtitleRows(plan) })
}

export function editSyncHashOf(plan: EditPlanV1): string {
  interface SyncSegment {
    source: { kind: EditClipSource['kind']; id: EditClipSource['id']; fingerprint: string }
    sourceInMs: number
    sourceOutMs: number
    speed: number
    gapBeforeMs: number
    startIndex: number
    endIndex: number
  }

  const segments: SyncSegment[] = []
  plan.clips.forEach((clip, index) => {
    const previous = index === 0 ? null : plan.clips[index - 1]
    const last = segments[segments.length - 1]
    const merge = Boolean(
      previous && last && last.endIndex === index - 1
      && previous.source.kind === clip.source.kind
      && previous.source.id === clip.source.id
      && previous.source.fingerprint === clip.source.fingerprint
      && previous.sourceOutMs === clip.sourceInMs
      && previous.speed === clip.speed
      && clip.gapBeforeMs === 0
      && !findTransition(plan, previous.id, clip.id),
    )
    if (merge && last) {
      last.sourceOutMs = clip.sourceOutMs
      last.endIndex = index
      return
    }
    segments.push({
      source: { kind: clip.source.kind, id: clip.source.id, fingerprint: clip.source.fingerprint },
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
      speed: clip.speed,
      gapBeforeMs: clip.gapBeforeMs,
      startIndex: index,
      endIndex: index,
    })
  })

  const boundaries: { at: number; type: EditTransitionType; durationMs: number }[] = []
  for (let index = 1; index < segments.length; index += 1) {
    const fromClip = plan.clips[segments[index - 1].endIndex]
    const toClip = plan.clips[segments[index].startIndex]
    const transition = findTransition(plan, fromClip.id, toClip.id)
    if (transition) boundaries.push({ at: index, type: transition.type, durationMs: transition.durationMs })
  }

  const layout = computeLayout(plan)
  const overlayEnd = plan.overlays.reduce((max, item) => Math.max(max, item.endMs), 0)
  return shortHash({
    version: plan.version,
    fps: plan.project.fps,
    tailGapMs: plan.project.tailGapMs,
    segments: segments.map((item) => ({
      source: item.source,
      sourceInMs: item.sourceInMs,
      sourceOutMs: item.sourceOutMs,
      speed: item.speed,
      gapBeforeMs: item.gapBeforeMs,
    })),
    transitions: boundaries,
    overlayExtensionMs: Math.max(0, overlayEnd - layout.contentEndMs),
  })
}

export function dialogueSyncHashOf(placements: DialoguePlacement[]): string {
  return shortHash({
    version: EDIT_PLAN_VERSION,
    placements: placements.map((item) => ({
      lineId: item.lineId,
      voiceTakeId: item.voiceTakeId,
      takeUrl: item.takeUrl,
      takeFingerprint: item.takeFingerprint,
      durationMs: item.durationMs,
    })),
  })
}
```

- [ ] **Step 4: 运行测试**

Run:
```bash
cd backend
npx tsx --test tests/edit-plan.test.ts
npx tsx --test tests/edit-hashes.test.ts
npx tsc --noEmit
```

Expected: PASS；`tsc --noEmit` 退出码 0。

---

### Task 5: `edit-media.ts` 媒体探测与指纹

**Files:**
- Modify: `backend/src/services/export-validation.ts`（`MediaProbe.video` 与 `probeMedia`，约 9–74 行）
- Create: `backend/src/services/edit-media.ts`
- Test: `backend/tests/edit-media.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `EditClipSource`、`EditSourceKind`；`utils/storage.ts` 的 `getAbsolutePath`；`export-validation.ts` 的 `probeMedia`。
- Produces:
  - `MediaProbe.video.fps: number | null`。
  - `EditMediaProbe`：`durationMs`、`width`、`height`、`fps`、`hasAudio`、`sizeBytes`、`fingerprint`。
  - `fingerprintOfFile(file: string): Promise<string>`
  - `probeEditMedia(url: string): Promise<EditMediaProbe>`
  - `editSourceFromUrl(input): Promise<EditClipSource>`
  - `clearEditMediaProbeCache(): void`

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/edit-media.test.ts`：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-edit-media-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  clearEditMediaProbeCache,
  editSourceFromUrl,
  fingerprintOfFile,
  probeEditMedia,
} = await import('../src/services/edit-media.ts')

const videoDir = path.join(root, 'static', 'projects', '1', 'videos')
await fs.mkdir(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'fixture.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac',
  videoFile,
], { stdio: 'ignore' })

const sourceUrl = 'static/projects/1/videos/fixture.mp4'

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('探测本地视频的时长、尺寸、帧率、音轨与指纹', async () => {
  clearEditMediaProbeCache()
  const probe = await probeEditMedia(sourceUrl)
  assert.ok(Math.abs(probe.durationMs - 2000) <= 200, `duration=${probe.durationMs}`)
  assert.equal(probe.width, 320)
  assert.equal(probe.height, 240)
  assert.equal(probe.fps, 25)
  assert.equal(probe.hasAudio, true)
  assert.ok(probe.sizeBytes > 0)
  assert.match(probe.fingerprint, /^\d+:\d+$/)
})

test('源指纹随文件 mtime 改变', async () => {
  const first = await fingerprintOfFile(videoFile)
  await fs.utimes(videoFile, new Date(), new Date(Date.now() + 5000))
  const second = await fingerprintOfFile(videoFile)
  assert.notEqual(first, second)
})

test('从逻辑路径构建 EditClipSource', async () => {
  const source = await editSourceFromUrl({
    kind: 'episode-video',
    id: 1,
    url: sourceUrl,
    label: '当前成片',
  })
  assert.equal(source.kind, 'episode-video')
  assert.equal(source.id, 1)
  assert.equal(source.url, sourceUrl)
  assert.equal(source.width, 320)
  assert.equal(source.height, 240)
  assert.equal(source.fps, 25)
  assert.equal(source.hasAudio, true)
  assert.equal(source.label, '当前成片')
  assert.match(source.fingerprint, /^\d+:\d+$/)
})

test('拒绝远程 URL 与不存在的文件', async () => {
  await assert.rejects(
    () => probeEditMedia('https://example.com/a.mp4'),
    /不支持远程媒体/,
  )
  await assert.rejects(
    () => probeEditMedia('static/projects/1/videos/missing.mp4'),
    /媒体文件不存在/,
  )
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/edit-media.test.ts`

Expected: FAIL，`edit-media` 不存在。

- [ ] **Step 3: 扩展 `probeMedia` 的 fps**

`MediaProbe` 改为：

```ts
export interface MediaProbe {
  durationMs: number
  sizeBytes: number
  video: { codec: string; width: number; height: number; fps: number | null } | null
  audio: { codec: string; sampleRate: number; channels: number } | null
  subtitleStreams: number
}
```

在 `probeMedia` 内、返回对象之前加入：

```ts
      const parseFps = (raw: unknown): number | null => {
        const text = String(raw ?? '').trim()
        if (!text) return null
        const [numerator, denominator] = text.split('/').map(Number)
        if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
          const fraction = numerator / denominator
          return Number.isFinite(fraction) && fraction > 0 ? fraction : null
        }
        const value = Number(text)
        return Number.isFinite(value) && value > 0 ? value : null
      }
      const fps = video ? parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate) : null
```

并把 video 返回对象改为：

```ts
        video: video
          ? {
              codec: String(video.codec_name || ''),
              width: Number(video.width) || 0,
              height: Number(video.height) || 0,
              fps,
            }
          : null,
```

- [ ] **Step 4: 创建 `backend/src/services/edit-media.ts`**

```ts
/**
 * 剪辑素材解析（技术设计 §4.7、§6.3）：
 * 逻辑 URL → 本地文件 → ffprobe 元数据 + size/mtime 指纹。
 * 远程 URL 不进入渲染链路；导入素材必须先落 project storage。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getAbsolutePath } from '../utils/storage.js'
import { probeMedia } from './export-validation.js'
import type { EditClipSource, EditSourceKind } from './edit-plan.js'

export interface EditMediaProbe {
  durationMs: number
  width: number
  height: number
  fps: number | null
  hasAudio: boolean
  sizeBytes: number
  fingerprint: string
}

const probeCache = new Map<string, EditMediaProbe>()

export function clearEditMediaProbeCache(): void {
  probeCache.clear()
}

export async function fingerprintOfFile(file: string): Promise<string> {
  const stat = await fsp.stat(file)
  return `${stat.size}:${Math.round(stat.mtimeMs)}`
}

function resolveLocalMediaPath(raw: string): string {
  const value = String(raw || '').trim()
  if (!value) throw new Error('媒体地址为空')
  if (/^(https?:|data:|blob:)/i.test(value)) throw new Error(`不支持远程媒体：${value}`)
  if (path.isAbsolute(value)) throw new Error(`不支持绝对路径：${value}`)
  if (value.startsWith('/')) {
    if (!value.startsWith('/static/')) throw new Error(`不支持的媒体路径：${value}`)
    return getAbsolutePath(value.slice(1))
  }
  return getAbsolutePath(value)
}

export async function probeEditMedia(url: string): Promise<EditMediaProbe> {
  const file = resolveLocalMediaPath(url)
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error(`媒体文件不存在：${url}`)

  const fingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}`
  const cacheKey = `${url}|${fingerprint}`
  const cached = probeCache.get(cacheKey)
  if (cached) return cached

  const probe = await probeMedia(file)
  if (probe.durationMs <= 0 || !probe.video) {
    throw new Error(`媒体不可用于剪辑：${url}`)
  }
  const result: EditMediaProbe = {
    durationMs: probe.durationMs,
    width: probe.video.width,
    height: probe.video.height,
    fps: probe.video.fps,
    hasAudio: Boolean(probe.audio),
    sizeBytes: stat.size,
    fingerprint,
  }
  probeCache.set(cacheKey, result)
  return result
}

export async function editSourceFromUrl(input: {
  kind: EditSourceKind
  id: number | string
  url: string
  label?: string | null
}): Promise<EditClipSource> {
  const probe = await probeEditMedia(input.url)
  return {
    kind: input.kind,
    id: input.id,
    url: input.url,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    hasAudio: probe.hasAudio,
    fingerprint: probe.fingerprint,
    ...(input.label ? { label: input.label } : {}),
  }
}
```

- [ ] **Step 5: 运行测试与导出校验回归**

Run:
```bash
cd backend
npx tsx --test tests/edit-media.test.ts
npx tsx --test tests/export-validation.test.ts
npx tsc --noEmit
```

Expected: PASS；新增 `fps` 字段不破坏既有导出校验断言。

---

### Task 6: `edit_workspace` 开关、聚合服务与只读路由

**Files:**
- Modify: `backend/src/services/app-settings.ts`（在 `setDubbingEnabled` 之后追加）
- Create: `backend/src/services/edit-service.ts`
- Create: `backend/src/routes/edit.ts`
- Modify: `backend/src/index.ts`（import 区约 37 行；挂载区约 110 行）
- Test: `backend/tests/edit-route.test.ts`

**Interfaces:**
- Consumes: Task 1 的 Drizzle 表/列；Task 3/4 的 plan、layout、hash、validate；Task 5 的 `editSourceFromUrl`。
- Produces:
  - `EDIT_WORKSPACE_MODES`、`EditWorkspaceMode`、`getEditWorkspaceMode()`、`setEditWorkspaceMode(mode)`。
  - `EditWorkspaceError`（`status`、`code`）。
  - `getEpisodeEditState(episodeId: number)`，返回聚合状态（顶层 snake_case，`plan` 保持 camelCase）。
  - `GET /api/v1/episodes/:id/edit`。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/edit-route.test.ts`：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-route-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const {
  createEmptyEditPlan,
  editSyncHashOf,
  planHashOf,
  projectSettingsForAspect,
} = await import('../src/services/edit-plan.ts')

const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '剪辑只读', aspectRatio: '9:16', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'film.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  videoFile,
], { stdio: 'ignore' })
const sourceUrl = `static/projects/${drama.id}/videos/film.mp4`

const emptyEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '空集', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '有成片', videoUrl: sourceUrl, createdAt: ts, updatedAt: ts,
}).returning().get()
const missingEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 3, title: '媒体缺失',
  videoUrl: `static/projects/${drama.id}/videos/missing.mp4`, createdAt: ts, updatedAt: ts,
}).returning().get()
const draftEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 4, title: '草稿优先', createdAt: ts, updatedAt: ts,
}).returning().get()
const offEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 5, title: '开关关闭', createdAt: ts, updatedAt: ts,
}).returning().get()

const revisionPlan = createEmptyEditPlan(draftEpisode.id, projectSettingsForAspect('16:9'))
db.insert(schema.editRevisions).values({
  episodeId: draftEpisode.id,
  revisionNo: 1,
  planJson: JSON.stringify(revisionPlan),
  planHash: planHashOf(revisionPlan),
  editSyncHash: editSyncHashOf(revisionPlan),
  isCurrent: true,
  createdAt: ts,
}).run()
const draftPlan = createEmptyEditPlan(draftEpisode.id, {
  ...projectSettingsForAspect('16:9'),
  tailGapMs: 300,
})
db.insert(schema.episodeEditDrafts).values({
  episodeId: draftEpisode.id,
  dramaId: drama.id,
  planJson: JSON.stringify(draftPlan),
  planHash: planHashOf(draftPlan),
  editSyncHash: editSyncHashOf(draftPlan),
  version: 2,
  createdAt: ts,
  updatedAt: ts,
}).run()

setEditWorkspaceMode('readonly')

function json(response: Response): Promise<any> {
  return response.json()
}

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('空集返回空计划且不创建草稿/版本', async () => {
  const response = await app.request(`/episodes/${emptyEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.episode_id, emptyEpisode.id)
  assert.equal(data.enabled, true)
  assert.equal(data.mode, 'readonly')
  assert.deepEqual(data.plan.clips, [])
  assert.equal(data.layout.duration_ms, 0)
  assert.equal(data.current_revision, null)
  assert.equal(data.draft, null)
  assert.equal(data.capabilities.can_edit, false)
  assert.equal(data.capabilities.can_export, false)

  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === emptyEpisode.id)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === emptyEpisode.id)
  assert.equal(drafts.length, 0)
  assert.equal(revisions.length, 0)
})

test('当前成片 bootstrap 为单片段并返回原声预览', async () => {
  const response = await app.request(`/episodes/${videoEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.plan.clips[0].source.kind, 'episode-video')
  assert.equal(data.plan.clips[0].source.url, sourceUrl)
  assert.equal(data.plan.clips[0].source.width, 320)
  assert.equal(data.plan.clips[0].source.height, 240)
  assert.equal(data.plan.clips[0].source.fps, 25)
  assert.equal(data.plan.project.aspect, '9:16')
  assert.equal(data.plan.project.width, 1080)
  assert.equal(data.plan.project.height, 1920)
  assert.ok(Math.abs(data.layout.duration_ms - 2000) <= 200)
  assert.equal(data.audio.mode, 'video')
  assert.equal(data.audio.url, sourceUrl)
  assert.equal(data.hashes.plan_hash.length, 32)
  assert.equal(data.hashes.edit_sync_hash.length, 32)
  assert.equal(data.draft_dirty, false)

  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === videoEpisode.id)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === videoEpisode.id)
  assert.equal(drafts.length, 0)
  assert.equal(revisions.length, 0)
})

test('缺失媒体不抛错，提示 MEDIA_MISSING 并返回空计划', async () => {
  const response = await app.request(`/episodes/${missingEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.deepEqual(data.plan.clips, [])
  assert.ok(data.media_warnings.some((item: any) => item.code === 'MEDIA_MISSING'))
})

test('已有草稿时草稿优先，并返回版本指针与 dirty 标记', async () => {
  const response = await app.request(`/episodes/${draftEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.plan.project.tailGapMs, 300)
  assert.equal(data.draft.version, 2)
  assert.equal(data.current_revision.revision_no, 1)
  assert.equal(data.current_revision.id, 1)
  assert.equal(data.draft_dirty, true)
})

test('legacy 混音记录显示 stale 与 legacy_mix 原因', async () => {
  db.insert(schema.mixRevisions).values({
    episodeId: videoEpisode.id,
    revisionNo: 1,
    planJson: '{}',
    planHash: 'legacy-mix',
    isCurrent: true,
    createdAt: ts,
  }).run()
  const response = await app.request(`/episodes/${videoEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.mix_status.status, 'stale')
  assert.ok(data.mix_status.reasons.includes('legacy_mix'))
  assert.equal(data.mix_status.mix_revision_id, 1)
})

test('开关 off 返回 403，非法与大编号返回 400/404', async () => {
  setEditWorkspaceMode('off')
  const off = await app.request(`/episodes/${offEpisode.id}/edit`)
  assert.equal(off.status, 403)
  assert.equal((await json(off)).code, 'EDIT_WORKSPACE_OFF')
  setEditWorkspaceMode('readonly')

  const invalid = await app.request('/episodes/abc/edit')
  assert.equal(invalid.status, 400)
  const missing = await app.request('/episodes/99999/edit')
  assert.equal(missing.status, 404)
})

test('on 模式只提升 can_edit，不会在 M1 写草稿', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${emptyEpisode.id}/edit`)
  assert.equal(response.status, 200)
  const data = (await json(response)).data
  assert.equal(data.mode, 'on')
  assert.equal(data.capabilities.can_edit, true)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === emptyEpisode.id)
  assert.equal(drafts.length, 0)
  setEditWorkspaceMode('readonly')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/edit-route.test.ts`

Expected: FAIL，`routes/edit.ts` 不存在。

- [ ] **Step 3: 在 `app-settings.ts` 增加开关**

```ts
export const EDIT_WORKSPACE_MODES = ['off', 'readonly', 'on'] as const
export type EditWorkspaceMode = typeof EDIT_WORKSPACE_MODES[number]

const EDIT_WORKSPACE_KEY = 'edit_workspace'

function isEditWorkspaceMode(value: unknown): value is EditWorkspaceMode {
  return typeof value === 'string' && (EDIT_WORKSPACE_MODES as readonly string[]).includes(value)
}

/**
 * 剪辑工作台开关：环境变量 EDIT_WORKSPACE 优先（仅调试/紧急回滚），
 * 其次 app_settings，未设置时默认 readonly，保证 M1 不会写入任何计划。
 */
export function getEditWorkspaceMode(): EditWorkspaceMode {
  const fromEnv = String(process.env.EDIT_WORKSPACE || '').trim().toLowerCase()
  if (isEditWorkspaceMode(fromEnv)) return fromEnv
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, EDIT_WORKSPACE_KEY))
    .get()
  return isEditWorkspaceMode(row?.value) ? row.value : 'readonly'
}

export function setEditWorkspaceMode(mode: EditWorkspaceMode): EditWorkspaceMode {
  if (!isEditWorkspaceMode(mode)) throw new Error(`Invalid edit workspace mode: ${mode}`)
  db.insert(schema.appSettings)
    .values({ key: EDIT_WORKSPACE_KEY, value: mode, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: mode, updatedAt: now() },
    })
    .run()
  return mode
}
```

- [ ] **Step 4: 创建 `backend/src/services/edit-service.ts`**

```ts
/**
 * 剪辑工作台聚合服务（M1 只读）。
 * 只读优先级：草稿 → 当前版本 → episodes.video_url 单片段 bootstrap → 空计划。
 * readonly/off 下绝不创建草稿或版本。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getEditWorkspaceMode } from './app-settings.js'
import {
  aspectOf,
  computeLayout,
  createEmptyEditPlan,
  createSingleClipPlan,
  dialogueSyncHashOf,
  editSyncHashOf,
  planHashOf,
  projectSettingsForAspect,
  renderHashOf,
  validateEditPlan,
  type DialoguePlacement,
  type EditIssue,
  type EditLayout,
  type EditPlanV1,
} from './edit-plan.js'
import { editSourceFromUrl } from './edit-media.js'

export class EditWorkspaceError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

function parsePlanJson(raw: string | null | undefined): EditPlanV1 | null {
  if (!raw) return null
  try {
    const plan = JSON.parse(raw) as EditPlanV1
    if (!plan || plan.version !== 1 || !plan.project || !Array.isArray(plan.clips)) return null
    return {
      ...plan,
      transitions: Array.isArray(plan.transitions) ? plan.transitions : [],
      subtitles: Array.isArray(plan.subtitles) ? plan.subtitles : [],
      overlays: Array.isArray(plan.overlays) ? plan.overlays : [],
      markers: Array.isArray(plan.markers) ? plan.markers : [],
    }
  } catch {
    return null
  }
}

function layoutResponse(layout: EditLayout) {
  return {
    content_end_ms: layout.contentEndMs,
    duration_ms: layout.durationMs,
    clips: layout.clips.map((clip) => ({
      clip_id: clip.clipId,
      timeline_start_ms: clip.timelineStartMs,
      timeline_end_ms: clip.timelineEndMs,
      content_duration_ms: clip.contentDurationMs,
    })),
    transitions: layout.transitions.map((transition) => ({
      id: transition.id,
      from_clip_id: transition.fromClipId,
      to_clip_id: transition.toClipId,
      overlap_ms: transition.overlapMs,
    })),
  }
}

function revisionResponse(row: typeof schema.editRevisions.$inferSelect | null) {
  if (!row) return null
  return {
    id: row.id,
    revision_no: row.revisionNo,
    note: row.note,
    duration_ms: row.durationMs,
    clip_count: row.clipCount,
    created_at: row.createdAt,
  }
}

export async function getEpisodeEditState(episodeId: number) {
  const episode = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .get()
  if (!episode) throw new EditWorkspaceError(404, 'EPISODE_NOT_FOUND', '分集不存在')

  const mode = getEditWorkspaceMode()
  if (mode === 'off') throw new EditWorkspaceError(403, 'EDIT_WORKSPACE_OFF', '剪辑工作台已关闭')

  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId))
    .get()

  const draft = db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
    .get()
  const revision = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.episodeId, episodeId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.editRevisions.createdAt))
    .get()

  const warnings: EditIssue[] = []
  let plan = parsePlanJson(draft?.planJson)
  if (draft && !plan) {
    warnings.push({ severity: 'warning', code: 'DRAFT_INVALID', path: 'draft.plan_json', message: '草稿计划损坏，已忽略' })
  }
  const revisionPlan = parsePlanJson(revision?.planJson)
  if (revision && !revisionPlan) {
    warnings.push({ severity: 'warning', code: 'REVISION_INVALID', path: 'revision.plan_json', message: '版本计划损坏，已忽略' })
  }
  if (!plan) plan = revisionPlan

  if (!plan) {
    const project = projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30)
    if (episode.videoUrl) {
      try {
        const source = await editSourceFromUrl({
          kind: 'episode-video',
          id: episode.id,
          url: episode.videoUrl,
        })
        plan = createSingleClipPlan(episode.id, source, project)
      } catch (error) {
        warnings.push({
          severity: 'warning',
          code: 'MEDIA_MISSING',
          path: 'episode.video_url',
          message: error instanceof Error ? error.message : '当前成片不可读',
        })
      }
    }
    if (!plan) plan = createEmptyEditPlan(episode.id, project)
  } else {
    warnings.push(...validateEditPlan(plan))
  }

  const layout = computeLayout(plan)
  const planHash = planHashOf(plan)
  const renderHash = renderHashOf(plan)
  const editSyncHash = editSyncHashOf(plan)
  const emptyPlacements: DialoguePlacement[] = []
  const dialogueSyncHash = dialogueSyncHashOf(emptyPlacements)

  const draftDirty = Boolean(draft) && (
    !revision
    || !revision.planHash
    || draft.planHash !== revision.planHash
  )

  const mixRevision = db.select().from(schema.mixRevisions)
    .where(and(
      eq(schema.mixRevisions.episodeId, episodeId),
      eq(schema.mixRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.mixRevisions.createdAt))
    .get()

  const mixReasons: string[] = []
  if (mixRevision) {
    if (!mixRevision.editSyncHash) mixReasons.push('legacy_mix')
    else if (mixRevision.editSyncHash !== editSyncHash) mixReasons.push('timing_changed')
    if (mixRevision.dialogueSyncHash && mixRevision.dialogueSyncHash !== dialogueSyncHash) {
      mixReasons.push('dialogue_changed')
    }
  }

  const lockRow = db.select().from(schema.episodeLocks)
    .where(eq(schema.episodeLocks.episodeId, episodeId))
    .get()
  const lock = lockRow && Date.parse(lockRow.expiresAt) > Date.now()
    ? { kind: lockRow.kind, owner: lockRow.owner, expires_at: lockRow.expiresAt }
    : null

  const singleSource = plan.clips.length === 1 && plan.clips[0].source.kind === 'episode-video'
    ? plan.clips[0]
    : null
  const audio = singleSource
    ? { mode: 'video' as const, url: singleSource.source.url, duration_ms: layout.durationMs }
    : { mode: 'none' as const }

  return {
    episode_id: episode.id,
    episode_number: episode.episodeNumber,
    enabled: true,
    mode,
    draft: draft
      ? {
          plan: parsePlanJson(draft.planJson),
          version: draft.version,
          updated_at: draft.updatedAt,
        }
      : null,
    current_revision: revisionResponse(revision ?? null),
    plan,
    layout: layoutResponse(layout),
    hashes: {
      plan_hash: planHash,
      render_hash: renderHash,
      edit_sync_hash: editSyncHash,
      dialogue_sync_hash: dialogueSyncHash,
    },
    draft_dirty: draftDirty,
    mix_status: {
      status: !mixRevision ? 'missing' : mixReasons.length ? 'stale' : 'aligned',
      reasons: mixReasons,
      edit_revision_id: revision?.id ?? null,
      mix_revision_id: mixRevision?.id ?? null,
      summary: null,
    },
    renders: { cut: null, audio_ref: null },
    audio,
    media_warnings: warnings.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path,
    })),
    line_placements: [],
    capabilities: {
      can_edit: mode === 'on',
      can_export: false,
      lock,
    },
  }
}
```

- [ ] **Step 5: 创建路由并挂载**

创建 `backend/src/routes/edit.ts`：

```ts
/**
 * 剪辑工作台聚合路由（M1 只读）。
 * 所有写操作在 S2 之后新增；本路由只有 GET。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, notFound, serverError, success } from '../utils/response.js'
import { EditWorkspaceError, getEpisodeEditState } from '../services/edit-service.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function handleError(c: Context, error: unknown) {
  if (error instanceof EditWorkspaceError) {
    if (error.status === 404) return notFound(c, error.message)
    if (error.status === 400) return badRequest(c, error.message)
    return c.json({ code: error.code, message: error.message }, error.status as any)
  }
  return serverError(c, error instanceof Error ? error.message : '读取剪辑工作台失败')
}

app.get('/episodes/:id/edit', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, await getEpisodeEditState(episodeId))
  } catch (error) {
    return handleError(c, error)
  }
})

export default app
```

在 `backend/src/index.ts` import 区加入：

```ts
import edit from './routes/edit.js'
```

在 `api.route('/', exportsRoute)` 之后加入：

```ts
// 剪辑工作台聚合状态：GET /episodes/:id/edit（M1 只读）
api.route('/', edit)
```

- [ ] **Step 6: 运行测试**

Run:
```bash
cd backend
npx tsx --test tests/edit-route.test.ts
npx tsx --test tests/edit-schema.test.ts
npx tsx --test tests/export-routes.test.ts
npx tsc --noEmit
```

Expected: PASS；既有导出路由不受影响。

---

### Task 7: 前端只读工作台、路由、入口与四语文案

**Files:**
- Modify: `frontend/nuxt.config.ts`（`pages:extend`，第 19–37 行）
- Modify: `frontend/app/composables/useApi.ts`（`episodeAPI` 之后，约 72 行）
- Modify: `frontend/app/views/drama/episode.vue`（lucide import 约 2066 行、`openDubbingStage` 约 2181 行、topbar 按钮约 68 行）
- Modify: `frontend/app/locales/zh.json`、`en.json`、`ja.json`、`ko.json`（文件末尾 `mix` 之后）
- Create: `frontend/app/utils/edit-plan.ts`
- Create: `frontend/app/views/drama/edit.vue`
- Create: `frontend/app/components/edit/EditWorkbench.vue`
- Create: `frontend/app/components/edit/EditTopBar.vue`
- Create: `frontend/app/components/edit/EditPreview.vue`
- Create: `frontend/app/components/edit/EditTimeline.vue`
- Create: `frontend/app/components/edit/EditClipInspector.vue`
- Create: `frontend/app/components/edit/EditEmptyState.vue`
- Test: `frontend/tests/edit-structure.test.mjs`

**Interfaces:**
- Consumes: Task 6 的 `GET /episodes/:id/edit` 响应（`plan` camelCase；顶层 snake_case）。
- Produces:
  - 路由 `/drama/:id/episode/:episodeNumber/edit`（name `drama-episode-edit`）。
  - `editAPI.get(episodeId)`。
  - `formatClock(ms)`、`mediaUrl(raw)`。
  - 只读页面组件树；整个剪辑组件目录只有一个 `<video>`。
  - 分集页入口按钮 `openEditWorkspace()`。

- [ ] **Step 1: 写失败测试**

创建 `frontend/tests/edit-structure.test.mjs`：

```js
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('剪辑页路由、页面与单预览结构', () => {
  const nuxt = read('nuxt.config.ts')
  assert.match(nuxt, /name:\s*'drama-episode-edit'/)
  assert.match(nuxt, /views\/drama\/edit\.vue/)

  const page = read('app/views/drama/edit.vue')
  assert.match(page, /EditWorkbench/)
  assert.match(page, /editAPI\.get/)
  assert.match(page, /definePageMeta\(\{\s*layout:\s*'studio'\s*\}\)/)
  assert.doesNotMatch(page, /MixStage/)

  const names = ['EditWorkbench', 'EditTopBar', 'EditPreview', 'EditTimeline', 'EditClipInspector', 'EditEmptyState']
  const components = names.map((name) => read(`app/components/edit/${name}.vue`))
  const videos = components.join('\n').match(/<video\b/g) || []
  assert.equal(videos.length, 1, '剪辑组件只允许一个 <video>')
  assert.match(components[2], /defineExpose/)
  assert.match(components[3], /timeline_start_ms/)
  assert.match(components[4], /hashes\.plan_hash/)
})

test('剪辑 API、分集入口与 zh/en/ja/ko 文案', () => {
  const api = read('app/composables/useApi.ts')
  assert.match(api, /export const editAPI/)
  assert.match(api, /\/episodes\/\$\{episodeId\}\/edit/)

  const episode = read('app/views/drama/episode.vue')
  assert.match(episode, /openEditWorkspace/)
  assert.match(episode, /edit\.entry/)
  assert.match(episode, /Scissors/)

  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    assert.equal(typeof locale.edit?.entry, 'string', `${lang} 缺少 edit.entry`)
    assert.equal(typeof locale.edit?.readonlyHint, 'string', `${lang} 缺少 edit.readonlyHint`)
    assert.equal(typeof locale.edit?.emptyTitle, 'string', `${lang} 缺少 edit.emptyTitle`)
    assert.equal(typeof locale.edit?.mixStale, 'string', `${lang} 缺少 edit.mixStale`)
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && node --test tests/edit-structure.test.mjs`

Expected: FAIL，`drama-episode-edit` 不存在。

- [ ] **Step 3: 注册路由与 API**

`frontend/nuxt.config.ts` 的 `drama-episode` 之后加入：

```ts
        {
          name: 'drama-episode-edit',
          path: '/drama/:id/episode/:episodeNumber/edit',
          file: fileURLToPath(new URL('./app/views/drama/edit.vue', import.meta.url)),
        },
```

`frontend/app/composables/useApi.ts` 的 `episodeAPI` 之后加入：

```ts
export const editAPI = {
  get: (episodeId: number) => api.get(`/episodes/${episodeId}/edit`),
}
```

- [ ] **Step 4: 创建前端纯工具 `frontend/app/utils/edit-plan.ts`**

```ts
export type EditAspect = '9:16' | '16:9' | '1:1'
export type EditSourceKind = 'storyboard' | 'take' | 'asset' | 'merge' | 'episode-video' | 'import'

export interface EditProjectSettings {
  aspect: EditAspect
  width: number
  height: number
  fps: number
  background: 'black' | 'blur'
  defaultFit: 'fill' | 'fit'
  defaultTransition: 'cut' | 'dissolve'
  defaultSubtitleStyle: 'default' | 'outline' | 'box'
  defaultExportPreset: string
  tailGapMs: number
}

export interface EditClipSource {
  kind: EditSourceKind
  id: number | string
  url: string
  durationMs: number
  width: number
  height: number
  fps: number | null
  hasAudio: boolean
  fingerprint: string
  label?: string
  thumbnailUrl?: string | null
}

export interface EditTransform {
  scale: number
  x: number
  y: number
  rotation: 0 | 90 | 180 | 270
  flipH: boolean
  flipV: boolean
}

export interface EditClip {
  id: string
  kind: 'video' | 'image'
  source: EditClipSource
  sourceInMs: number
  sourceOutMs: number
  speed: number
  gapBeforeMs: number
  videoFadeInMs: number
  videoFadeOutMs: number
  transform: EditTransform
  filter: { preset: string; intensity: number }
  lineId?: number | null
  videoTakeAssetId?: number | null
}

export interface EditTransition {
  id: string
  fromClipId: string
  toClipId: string
  type: string
  durationMs: number
}

export interface EditSubtitleCue {
  id: string
  text: string
  startMs: number
  endMs: number
  style: string
  follow: boolean
  anchor?: { clipId: string; offsetMs: number } | null
  source: string
  role?: string | null
}

export interface EditOverlay {
  id: string
  kind: 'video' | 'image' | 'text'
  startMs: number
  endMs: number
  track: 0
  opacity: number
}

export interface EditMarker {
  id: string
  atMs: number
  label: string
  color: string
}

export interface EditLayoutClip {
  clip_id: string
  timeline_start_ms: number
  timeline_end_ms: number
  content_duration_ms: number
}

export interface EditLayout {
  content_end_ms: number
  duration_ms: number
  clips: EditLayoutClip[]
  transitions: { id: string; from_clip_id: string; to_clip_id: string; overlap_ms: number }[]
}

export interface EditPlanV1 {
  version: 1
  episodeId: number
  project: EditProjectSettings
  clips: EditClip[]
  transitions: EditTransition[]
  subtitles: EditSubtitleCue[]
  overlays: EditOverlay[]
  markers: EditMarker[]
}

export interface EditWorkspaceState {
  episode_id: number
  episode_number: number
  enabled: boolean
  mode?: 'off' | 'readonly' | 'on'
  draft: { version: number; updated_at: string } | null
  current_revision: {
    id: number
    revision_no: number
    note: string | null
    duration_ms: number | null
    clip_count: number | null
    created_at: string
  } | null
  plan: EditPlanV1
  layout: EditLayout
  hashes: {
    plan_hash: string
    render_hash: string
    edit_sync_hash: string
    dialogue_sync_hash: string
  }
  draft_dirty: boolean
  mix_status: {
    status: 'missing' | 'stale' | 'aligned'
    reasons: string[]
    edit_revision_id: number | null
    mix_revision_id: number | null
    summary: unknown
  }
  renders: { cut: unknown; audio_ref: unknown }
  audio: { mode: 'video' | 'mix' | 'none'; url?: string; duration_ms?: number }
  media_warnings: { code: string; message: string; path?: string }[]
  line_placements: unknown[]
  capabilities: {
    can_edit: boolean
    can_export: boolean
    lock: { kind: string; owner: string; expires_at: string } | null
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = Math.floor(total % 60)
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

export function mediaUrl(raw: string | null | undefined): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^(https?:|blob:|data:|\/)/i.test(value)) return value
  return `/${value}`
}
```

- [ ] **Step 5: 创建页面与组件**

`frontend/app/views/drama/edit.vue`：

```vue
<template>
  <div class="edit-page">
    <div v-if="loading" class="edit-state">
      <Loader2 :size="22" class="edit-spin" />
      <p>{{ t('edit.loading') }}</p>
    </div>
    <div v-else-if="error" class="edit-state">
      <h2>{{ t('edit.loadFailed') }}</h2>
      <p>{{ error }}</p>
      <button class="edit-btn is-primary" type="button" @click="load">{{ t('edit.retry') }}</button>
    </div>
    <EditWorkbench
      v-else-if="state"
      :state="state"
      :episode-label="episodeLabel"
      @back="goBack"
    />
  </div>
</template>

<script setup>
import { Loader2 } from 'lucide-vue-next'
import { dramaAPI, editAPI } from '~/composables/useApi'
import EditWorkbench from '~/components/edit/EditWorkbench.vue'

definePageMeta({ layout: 'studio' })

const route = useRoute()
const { t } = useI18n()
const dramaId = Number(route.params.id)
const episodeNumber = Number(route.params.episodeNumber)

const loading = ref(true)
const error = ref('')
const state = ref(null)
const episode = ref(null)

const episodeLabel = computed(() => {
  const n = episode.value?.episode_number ?? episode.value?.episodeNumber ?? episodeNumber
  const title = episode.value?.title || ''
  return title
    ? `${t('episode.topbar.episodeN', { n })} · ${title}`
    : t('episode.topbar.episodeN', { n })
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const drama = await dramaAPI.get(dramaId)
    const found = drama.episodes?.find(
      (item) => (item.episode_number || item.episodeNumber) === episodeNumber,
    )
    if (!found) throw new Error(t('edit.episodeNotFound'))
    episode.value = found
    state.value = await editAPI.get(found.id)
  } catch (cause) {
    state.value = null
    error.value = cause instanceof Error ? cause.message : t('edit.loadFailed')
  } finally {
    loading.value = false
  }
}

function goBack() {
  navigateTo(`/drama/${dramaId}/episode/${episodeNumber}`)
}

onMounted(load)

defineExpose({ load })
</script>

<style scoped>
.edit-page { flex: 1; min-height: 0; display: flex; background: var(--bg-base); }
.edit-state {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; color: var(--text-2); text-align: center; padding: 32px;
}
.edit-state h2 { color: var(--text-0); font-size: 18px; }
.edit-state p { max-width: 560px; line-height: 1.6; }
.edit-btn {
  height: 34px; padding: 0 16px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--bg-1); color: var(--text-0); cursor: pointer;
}
.edit-btn.is-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.edit-spin { animation: edit-spin 1s linear infinite; }
@keyframes edit-spin { to { transform: rotate(360deg); } }
</style>
```

`frontend/app/components/edit/EditWorkbench.vue`：

```vue
<template>
  <div class="ed-workbench">
    <EditTopBar :state="state" :episode-label="episodeLabel" @back="$emit('back')" />
    <div v-if="!state.plan.clips.length" class="ed-empty-wrap">
      <EditEmptyState @back="$emit('back')" />
    </div>
    <div v-else class="ed-main">
      <section class="ed-stage">
        <EditPreview
          ref="previewRef"
          :src="previewSrc"
          :poster="poster"
          @time="currentMs = $event"
        />
        <EditTimeline
          :plan="state.plan"
          :layout="state.layout"
          :current-ms="currentMs"
          @seek="seek"
        />
      </section>
      <EditClipInspector :state="state" />
    </div>
  </div>
</template>

<script setup>
import EditTopBar from '~/components/edit/EditTopBar.vue'
import EditPreview from '~/components/edit/EditPreview.vue'
import EditTimeline from '~/components/edit/EditTimeline.vue'
import EditClipInspector from '~/components/edit/EditClipInspector.vue'
import EditEmptyState from '~/components/edit/EditEmptyState.vue'
import { mediaUrl } from '~/utils/edit-plan'

const props = defineProps({
  state: { type: Object, required: true },
  episodeLabel: { type: String, default: '' },
})
defineEmits(['back'])

const previewRef = ref(null)
const currentMs = ref(0)

const previewSrc = computed(() => mediaUrl(
  props.state.audio?.url || props.state.plan.clips[0]?.source?.url || '',
))
const poster = computed(() => mediaUrl(props.state.plan.clips[0]?.source?.thumbnailUrl || ''))

function seek(ms) {
  previewRef.value?.seek(ms)
}
</script>

<style scoped>
.ed-workbench {
  flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  background: var(--bg-base); color: var(--text-0);
}
.ed-empty-wrap { flex: 1; min-height: 0; display: flex; }
.ed-main {
  flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 320px;
}
.ed-stage {
  min-width: 0; min-height: 0; display: flex; flex-direction: column;
  gap: 12px; padding: 14px 16px 16px;
}
@media (max-width: 900px) {
  .ed-main { grid-template-columns: minmax(0, 1fr); }
}
</style>
```

`frontend/app/components/edit/EditTopBar.vue`：

```vue
<template>
  <header class="ed-top">
    <div class="ed-top-left">
      <button class="ed-icon" type="button" :title="t('edit.back')" @click="$emit('back')">
        <ArrowLeft :size="16" />
      </button>
      <span class="ed-brand"><Scissors :size="14" /> {{ t('edit.title') }}</span>
      <span class="ed-episode">{{ episodeLabel }}</span>
      <span :class="['ed-chip', readonly ? 'is-muted' : 'is-on']">
        {{ readonly ? t('edit.readonly') : t('edit.on') }}
      </span>
      <span :class="['ed-chip', `is-${state.mix_status.status}`]">{{ mixLabel }}</span>
    </div>
    <span v-if="readonly" class="ed-hint">{{ t('edit.readonlyHint') }}</span>
  </header>
</template>

<script setup>
import { ArrowLeft, Scissors } from 'lucide-vue-next'

const props = defineProps({
  state: { type: Object, required: true },
  episodeLabel: { type: String, default: '' },
})
defineEmits(['back'])

const { t } = useI18n()
const readonly = computed(() => !props.state.capabilities?.can_edit)
const mixLabel = computed(() => {
  if (props.state.mix_status?.status === 'aligned') return t('edit.mixAligned')
  if (props.state.mix_status?.status === 'stale') return t('edit.mixStale')
  return t('edit.mixMissing')
})
</script>

<style scoped>
.ed-top {
  flex: 0 0 auto; height: 52px; padding: 0 14px; display: flex; align-items: center;
  justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--border);
  background: var(--bg-1);
}
.ed-top-left { min-width: 0; display: flex; align-items: center; gap: 10px; }
.ed-icon {
  width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 8px; background: transparent;
  color: var(--text-1); cursor: pointer;
}
.ed-icon:hover { background: var(--bg-hover); }
.ed-brand { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 650; }
.ed-episode {
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; color: var(--text-2);
}
.ed-chip {
  height: 22px; padding: 0 8px; display: inline-flex; align-items: center; border-radius: 999px;
  font-size: 11px; font-weight: 600; white-space: nowrap;
}
.ed-chip.is-muted { background: var(--bg-2); color: var(--text-2); }
.ed-chip.is-on { background: var(--accent-bg); color: var(--accent-text); }
.ed-chip.is-aligned { background: var(--success-bg); color: var(--success); }
.ed-chip.is-missing { background: var(--bg-2); color: var(--text-2); }
.ed-chip.is-stale { background: var(--warning-bg); color: var(--warning); }
.ed-hint { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-3); }
@media (max-width: 900px) {
  .ed-hint { display: none; }
}
</style>
```

`frontend/app/components/edit/EditPreview.vue`：

```vue
<template>
  <figure class="ed-preview">
    <div class="ed-preview-frame">
      <video
        ref="videoRef"
        :src="src"
        :poster="poster || undefined"
        controls
        playsinline
        preload="metadata"
        @timeupdate="onTimeUpdate"
        @seeked="onTimeUpdate"
      />
    </div>
    <figcaption>{{ t('edit.previewTitle') }}</figcaption>
  </figure>
</template>

<script setup>
defineProps({
  src: { type: String, default: '' },
  poster: { type: String, default: '' },
})
const emit = defineEmits(['time'])
const { t } = useI18n()
const videoRef = ref(null)

function onTimeUpdate() {
  const video = videoRef.value
  if (!video) return
  emit('time', Math.round((video.currentTime || 0) * 1000))
}

function seek(ms) {
  const video = videoRef.value
  if (!video) return
  const seconds = Math.max(0, Number(ms) || 0) / 1000
  const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : seconds
  video.currentTime = Math.min(seconds, limit)
}

defineExpose({ seek })
</script>

<style scoped>
.ed-preview { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; margin: 0; }
.ed-preview-frame {
  flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: 12px; background: #0b0c0e; overflow: hidden;
}
.ed-preview video { width: 100%; height: 100%; max-height: 100%; object-fit: contain; background: #0b0c0e; }
.ed-preview figcaption { flex: 0 0 auto; font-size: 11px; letter-spacing: .04em; color: var(--text-3); }
</style>
```

`frontend/app/components/edit/EditTimeline.vue`：

```vue
<template>
  <section class="ed-timeline">
    <header class="ed-timeline-head">
      <b>{{ t('edit.timeline') }}</b>
      <span>{{ t('edit.clipCount', { n: plan.clips.length }) }}</span>
      <span>{{ t('edit.duration') }} {{ formatClock(layout.duration_ms) }}</span>
    </header>
    <div ref="trackRef" class="ed-track" @click="onTrackClick">
      <div class="ed-ruler">
        <span v-for="tick in ticks" :key="tick.pct" :style="{ left: `${tick.pct}%` }">{{ tick.label }}</span>
      </div>
      <div
        v-for="clip in layout.clips"
        :key="clip.clip_id"
        class="ed-clip"
        :style="clipStyle(clip)"
        @click.stop="emit('seek', clip.timeline_start_ms)"
      >
        <span class="ed-clip-label">{{ clipLabel(clip.clip_id) }}</span>
        <span class="ed-clip-time">{{ formatClock(clip.content_duration_ms) }}</span>
      </div>
      <div class="ed-playhead" :style="{ left: `${playhead}%` }"></div>
    </div>
  </section>
</template>

<script setup>
import { formatClock } from '~/utils/edit-plan'

const props = defineProps({
  plan: { type: Object, required: true },
  layout: { type: Object, required: true },
  currentMs: { type: Number, default: 0 },
})
const emit = defineEmits(['seek'])
const { t } = useI18n()
const trackRef = ref(null)

const duration = computed(() => Math.max(1, props.layout.duration_ms || 0))
const playhead = computed(() => Math.min(100, Math.max(0, (props.currentMs / duration.value) * 100)))
const ticks = computed(() => Array.from({ length: 11 }, (_, index) => ({
  pct: index * 10,
  label: formatClock((duration.value * index) / 10),
})))

function clipStyle(clip) {
  const left = Math.max(0, (clip.timeline_start_ms / duration.value) * 100)
  const width = Math.max(0.5, ((clip.timeline_end_ms - clip.timeline_start_ms) / duration.value) * 100)
  return { left: `${left}%`, width: `${width}%` }
}

function clipLabel(clipId) {
  const clip = props.plan.clips.find((item) => item.id === clipId)
  if (!clip) return t('edit.clip')
  return clip.source?.label || (clip.source?.kind === 'episode-video' ? t('edit.sourceEpisodeVideo') : t('edit.clip'))
}

function onTrackClick(event) {
  const element = trackRef.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  emit('seek', ratio * duration.value)
}
</script>

<style scoped>
.ed-timeline {
  flex: 0 0 auto; height: 132px; display: flex; flex-direction: column; gap: 8px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-1);
}
.ed-timeline-head { display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--text-3); }
.ed-timeline-head b { color: var(--text-1); font-size: 12px; }
.ed-track {
  position: relative; flex: 1; min-height: 0; border-radius: 8px;
  background: var(--bg-2); overflow: hidden; cursor: crosshair;
}
.ed-ruler { position: absolute; inset: 0 0 auto; height: 20px; border-bottom: 1px solid var(--border); }
.ed-ruler span {
  position: absolute; top: 4px; transform: translateX(-50%);
  font-size: 9px; color: var(--text-3); white-space: nowrap;
}
.ed-clip {
  position: absolute; top: 28px; bottom: 8px; min-width: 2px; overflow: hidden;
  display: flex; flex-direction: column; justify-content: space-between; gap: 2px;
  padding: 5px 7px; border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
  border-radius: 7px; background: color-mix(in srgb, var(--accent) 16%, var(--bg-1));
  color: var(--text-0); cursor: pointer;
}
.ed-clip:hover { border-color: var(--accent); }
.ed-clip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 600; }
.ed-clip-time { font-size: 9px; color: var(--text-2); }
.ed-playhead {
  position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px;
  background: var(--accent); pointer-events: none;
}
</style>
```

`frontend/app/components/edit/EditClipInspector.vue`：

```vue
<template>
  <aside class="ed-inspector">
    <section class="ed-inspector-section">
      <h3>{{ t('edit.project') }}</h3>
      <dl>
        <div><dt>{{ t('edit.aspect') }}</dt><dd>{{ project.aspect }}</dd></div>
        <div><dt>{{ t('edit.resolution') }}</dt><dd>{{ project.width }} × {{ project.height }}</dd></div>
        <div><dt>{{ t('edit.fps') }}</dt><dd>{{ project.fps }}</dd></div>
        <div><dt>{{ t('edit.duration') }}</dt><dd>{{ formatClock(state.layout.duration_ms) }}</dd></div>
      </dl>
    </section>

    <section class="ed-inspector-section">
      <h3>{{ t('edit.source') }}</h3>
      <dl v-if="clip">
        <div><dt>{{ sourceLabel }}</dt><dd>{{ formatClock(clip.source.durationMs) }}</dd></div>
        <div><dt>{{ t('edit.inOut') }}</dt><dd>{{ formatClock(clip.sourceInMs) }} – {{ formatClock(clip.sourceOutMs) }}</dd></div>
        <div><dt>{{ t('edit.speed') }}</dt><dd>{{ clip.speed }}×</dd></div>
        <div><dt>{{ t('edit.audioModeVideo') }}</dt><dd>{{ audioLabel }}</dd></div>
      </dl>
      <p v-else class="ed-muted">{{ t('edit.emptyTitle') }}</p>
    </section>

    <section class="ed-inspector-section">
      <h3>{{ t('edit.hashes') }}</h3>
      <dl class="ed-hashes">
        <div><dt>{{ t('edit.planHash') }}</dt><dd :title="state.hashes.plan_hash">{{ state.hashes.plan_hash }}</dd></div>
        <div><dt>{{ t('edit.editSyncHash') }}</dt><dd :title="state.hashes.edit_sync_hash">{{ state.hashes.edit_sync_hash }}</dd></div>
        <div><dt>{{ t('edit.renderHash') }}</dt><dd :title="state.hashes.render_hash">{{ state.hashes.render_hash }}</dd></div>
        <div><dt>{{ t('edit.dialogueSyncHash') }}</dt><dd :title="state.hashes.dialogue_sync_hash">{{ state.hashes.dialogue_sync_hash }}</dd></div>
      </dl>
    </section>

    <section class="ed-inspector-section">
      <h3>{{ t('edit.warnings') }}</h3>
      <ul v-if="state.media_warnings.length" class="ed-warnings">
        <li v-for="warning in state.media_warnings" :key="`${warning.code}:${warning.path || ''}`">
          <b>{{ warning.code }}</b>
          <span>{{ warning.message }}</span>
        </li>
      </ul>
      <p v-else class="ed-muted">{{ t('edit.noWarnings') }}</p>
    </section>
  </aside>
</template>

<script setup>
import { formatClock } from '~/utils/edit-plan'

const props = defineProps({
  state: { type: Object, required: true },
})
const { t } = useI18n()

const project = computed(() => props.state.plan.project)
const clip = computed(() => props.state.plan.clips[0] || null)
const sourceLabel = computed(() => {
  if (!clip.value) return ''
  if (clip.value.source.label) return clip.value.source.label
  return clip.value.source.kind === 'episode-video'
    ? t('edit.sourceEpisodeVideo')
    : clip.value.source.kind
})
const audioLabel = computed(() => (
  props.state.audio?.mode === 'video' ? t('edit.audioModeVideo') : t('edit.audioModeNone')
))
</script>

<style scoped>
.ed-inspector {
  min-height: 0; overflow: auto; padding: 14px; border-left: 1px solid var(--border);
  background: var(--bg-1); display: flex; flex-direction: column; gap: 16px;
}
.ed-inspector-section h3 {
  margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: .06em;
  text-transform: uppercase; color: var(--text-3);
}
.ed-inspector-section dl { display: flex; flex-direction: column; gap: 7px; margin: 0; }
.ed-inspector-section dl > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.ed-inspector-section dt { font-size: 11px; color: var(--text-3); white-space: nowrap; }
.ed-inspector-section dd {
  min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; color: var(--text-1); text-align: right;
}
.ed-hashes dd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.ed-muted { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-3); }
.ed-warnings { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.ed-warnings li { display: flex; flex-direction: column; gap: 3px; font-size: 11px; line-height: 1.45; }
.ed-warnings b { color: var(--warning); font-size: 10px; }
.ed-warnings span { color: var(--text-2); }
@media (max-width: 900px) {
  .ed-inspector { border-left: 0; border-top: 1px solid var(--border); }
}
</style>
```

`frontend/app/components/edit/EditEmptyState.vue`：

```vue
<template>
  <div class="ed-empty">
    <Clapperboard :size="34" />
    <h2>{{ t('edit.emptyTitle') }}</h2>
    <p>{{ t('edit.emptyHint') }}</p>
    <button class="ed-empty-btn" type="button" @click="$emit('back')">{{ t('edit.back') }}</button>
  </div>
</template>

<script setup>
import { Clapperboard } from 'lucide-vue-next'

defineEmits(['back'])
const { t } = useI18n()
</script>

<style scoped>
.ed-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 32px; color: var(--text-3); text-align: center;
}
.ed-empty h2 { margin: 0; font-size: 18px; color: var(--text-0); }
.ed-empty p { margin: 0; max-width: 420px; line-height: 1.6; color: var(--text-2); }
.ed-empty-btn {
  height: 34px; padding: 0 16px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--bg-1); color: var(--text-0); cursor: pointer;
}
</style>
```

- [ ] **Step 6: 分集页入口**

`frontend/app/views/drama/episode.vue` 的 lucide import 增加 `Scissors`：

```vue
  Plus, X, ListTodo, CircleHelp, Mic, AudioLines, SlidersHorizontal, Trash2, Scissors,
```

在「配音」按钮之后加入：

```vue
          <button v-if="hasEditEntry" class="btn" @click="openEditWorkspace">
            <Scissors :size="12" />
            {{ t('edit.entry') }}
          </button>
```

在 `openDubbingStage` 附近加入：

```ts
const hasEditEntry = computed(() => Boolean(episode.value?.video_url || episode.value?.videoUrl))

function openEditWorkspace() {
  if (!episode.value) return
  const n = episode.value.episode_number || episode.value.episodeNumber || episodeNumber
  navigateTo(`/drama/${dramaId}/episode/${n}/edit`)
}
```

- [ ] **Step 7: 增加四语文案**

在每个 locale 文件末尾把 `"presetTitle"` 所在对象闭合后追加 `edit`。zh：

```json
    "presetTitle": "预设"
  },
  "edit": {
    "entry": "剪辑",
    "title": "剪辑工作台",
    "back": "返回分集",
    "readonly": "只读预览",
    "readonlyHint": "M1 只读：可预览成片与时间线，编辑与导出将在后续阶段开放",
    "on": "可编辑",
    "loading": "加载剪辑计划…",
    "loadFailed": "剪辑工作台加载失败",
    "episodeNotFound": "未找到该分集",
    "retry": "重试",
    "emptyTitle": "还没有可预览的成片",
    "emptyHint": "完成视频生成或合片后，再回到这里预览与剪辑",
    "timeline": "时间线",
    "clipCount": "{n} 个片段",
    "duration": "时长",
    "fps": "帧率",
    "resolution": "分辨率",
    "aspect": "画幅",
    "project": "工程设置",
    "source": "源素材",
    "sourceEpisodeVideo": "当前成片",
    "inOut": "入点 / 出点",
    "speed": "变速",
    "hashes": "同步指纹",
    "planHash": "计划哈希",
    "editSyncHash": "时间同步",
    "renderHash": "画面",
    "dialogueSyncHash": "配音同步",
    "warnings": "提示",
    "noWarnings": "无异常",
    "mixAligned": "混音已对齐",
    "mixMissing": "尚未混音",
    "mixStale": "混音已过期",
    "audioModeVideo": "播放成片原声",
    "audioModeNone": "无可播放音频",
    "previewTitle": "预览",
    "clip": "片段"
  }
}
```

en：

```json
    "presetTitle": "Preset"
  },
  "edit": {
    "entry": "Edit",
    "title": "Edit workspace",
    "back": "Back to episode",
    "readonly": "Read-only preview",
    "readonlyHint": "M1 read-only: preview the film and timeline; editing and export arrive in later stages",
    "on": "Editable",
    "loading": "Loading edit plan…",
    "loadFailed": "Failed to load edit workspace",
    "episodeNotFound": "Episode not found",
    "retry": "Retry",
    "emptyTitle": "No film to preview yet",
    "emptyHint": "Generate videos or merge the episode first, then return here",
    "timeline": "Timeline",
    "clipCount": "{n} clips",
    "duration": "Duration",
    "fps": "FPS",
    "resolution": "Resolution",
    "aspect": "Aspect",
    "project": "Project",
    "source": "Source",
    "sourceEpisodeVideo": "Current film",
    "inOut": "In / Out",
    "speed": "Speed",
    "hashes": "Sync hashes",
    "planHash": "Plan hash",
    "editSyncHash": "Timing sync",
    "renderHash": "Picture",
    "dialogueSyncHash": "Dialogue sync",
    "warnings": "Notices",
    "noWarnings": "No issues",
    "mixAligned": "Mix aligned",
    "mixMissing": "Not mixed",
    "mixStale": "Mix stale",
    "audioModeVideo": "Playing film audio",
    "audioModeNone": "No playable audio",
    "previewTitle": "Preview",
    "clip": "Clip"
  }
}
```

ja：

```json
    "presetTitle": "プリセット"
  },
  "edit": {
    "entry": "編集",
    "title": "編集ワークスペース",
    "back": "エピソードに戻る",
    "readonly": "読み取り専用プレビュー",
    "readonlyHint": "M1 は読み取り専用です。成片とタイムラインを確認でき、編集と書き出しは後続段階で開放されます",
    "on": "編集可能",
    "loading": "編集プランを読み込み中…",
    "loadFailed": "編集ワークスペースの読み込みに失敗しました",
    "episodeNotFound": "エピソードが見つかりません",
    "retry": "再試行",
    "emptyTitle": "プレビューできる成片がありません",
    "emptyHint": "動画生成または合片を完了してから、ここに戻ってください",
    "timeline": "タイムライン",
    "clipCount": "{n} クリップ",
    "duration": "長さ",
    "fps": "フレームレート",
    "resolution": "解像度",
    "aspect": "アスペクト",
    "project": "プロジェクト",
    "source": "ソース",
    "sourceEpisodeVideo": "現在の成片",
    "inOut": "イン / アウト",
    "speed": "速度",
    "hashes": "同期ハッシュ",
    "planHash": "プランハッシュ",
    "editSyncHash": "タイミング同期",
    "renderHash": "映像",
    "dialogueSyncHash": "配音同期",
    "warnings": "通知",
    "noWarnings": "問題なし",
    "mixAligned": "ミックス同期済み",
    "mixMissing": "未ミックス",
    "mixStale": "ミックスが古い",
    "audioModeVideo": "成片の音声を再生",
    "audioModeNone": "再生可能な音声なし",
    "previewTitle": "プレビュー",
    "clip": "クリップ"
  }
}
```

ko：

```json
    "presetTitle": "프리셋"
  },
  "edit": {
    "entry": "편집",
    "title": "편집 작업대",
    "back": "에피소드로 돌아가기",
    "readonly": "읽기 전용 미리보기",
    "readonlyHint": "M1은 읽기 전용입니다. 완성본과 타임라인을 미리 볼 수 있으며 편집과 내보내기는 이후 단계에서 열립니다",
    "on": "편집 가능",
    "loading": "편집 계획을 불러오는 중…",
    "loadFailed": "편집 작업대를 불러오지 못했습니다",
    "episodeNotFound": "에피소드를 찾을 수 없습니다",
    "retry": "다시 시도",
    "emptyTitle": "미리 볼 완성본이 없습니다",
    "emptyHint": "영상 생성 또는 합편을 완료한 뒤 다시 돌아오세요",
    "timeline": "타임라인",
    "clipCount": "{n}개 클립",
    "duration": "길이",
    "fps": "프레임레이트",
    "resolution": "해상도",
    "aspect": "화면 비율",
    "project": "프로젝트",
    "source": "소스",
    "sourceEpisodeVideo": "현재 완성본",
    "inOut": "인 / 아웃",
    "speed": "속도",
    "hashes": "동기화 해시",
    "planHash": "계획 해시",
    "editSyncHash": "타이밍 동기화",
    "renderHash": "화면",
    "dialogueSyncHash": "대사 동기화",
    "warnings": "알림",
    "noWarnings": "문제 없음",
    "mixAligned": "믹스 정렬됨",
    "mixMissing": "믹스 없음",
    "mixStale": "믹스 만료",
    "audioModeVideo": "완성본 원음 재생",
    "audioModeNone": "재생 가능한 오디오 없음",
    "previewTitle": "미리보기",
    "clip": "클립"
  }
}
```

- [ ] **Step 8: 运行结构测试**

Run: `cd frontend && node --test tests/edit-structure.test.mjs`

Expected: PASS。

- [ ] **Step 9: 检查无并行播放器/无混音耦合**

Run:
```bash
cd frontend
grep -R "<video" app/components/edit
grep -R "MixStage\|useMixStage\|useMixPlayback" app/components/edit app/views/drama/edit.vue || true
```

Expected: 只出现 `EditPreview.vue` 一处 `<video>`；第二条无输出。

---

### Task 8: 全量验证与 M1 验收

**Files:**
- 不新增文件；只运行验证并记录结果。

**Interfaces:**
- Consumes: Task 1–7 全部产物。
- Produces: M1 出口证据。

- [ ] **Step 1: 后端剪辑测试全绿**

Run:
```bash
cd backend
npx tsx --test tests/edit-schema.test.ts tests/edit-storage.test.ts tests/edit-plan.test.ts tests/edit-hashes.test.ts tests/edit-media.test.ts tests/edit-route.test.ts
```

Expected: 全部 PASS，0 fail。

- [ ] **Step 2: 后端类型与回归**

Run:
```bash
cd backend
npx tsc --noEmit
npx tsx --test tests/dubbing-schema.test.ts tests/export-routes.test.ts tests/export-validation.test.ts
```

Expected: `tsc --noEmit` 退出码 0；既有测试 PASS。

- [ ] **Step 3: 前端结构测试**

Run: `cd frontend && node --test tests/edit-structure.test.mjs`

Expected: PASS。

- [ ] **Step 4: 前端 SFC 构建门禁（需用户明确同意）**

只有用户在执行阶段明确同意构建时才运行：

```bash
cd frontend
npm run build
```

Expected: Nuxt build 成功，无 SFC 编译错误。

若用户未同意构建，本步骤标记为“未执行（等待授权）”，不得声称构建通过。

- [ ] **Step 5: 手工冒烟（不重启现有服务）**

若开发服务已在运行，直接访问；若未运行，先询问用户是否允许启动，不自行重启：

1. 打开 `http://localhost:3013/drama/<id>/episode/<n>`，确认旧的配音、交付、刷新、任务按钮仍在。
2. 对已有当前成片的分集，确认出现“剪辑”按钮；点击后 URL 变为 `/drama/<id>/episode/<n>/edit`。
3. 确认页面显示“只读预览”徽标、一个视频、一个时间线片段和右侧检查器；播放视频时时间线播放头随动。
4. 对没有成片的分集，确认分集页不显示“剪辑”入口；直接打开 `/edit` 显示空态而不是报错。
5. 打开浏览器 Network，确认 `GET /api/v1/episodes/<id>/edit` 返回 200，响应含 `plan`、`layout`、`hashes`、`mix_status`。
6. 回到分集页，确认原有导出检查、交付对话框、配音工作台均可正常打开，未被剪辑页影响。

- [ ] **Step 6: 只读保证检查**

Run:
```bash
cd backend
npx tsx --test tests/edit-route.test.ts
```

Expected: `空集返回空计划且不创建草稿/版本`、`当前成片 bootstrap 为单片段并返回原声预览`、`on 模式只提升 can_edit，不会在 M1 写草稿` 三条均 PASS。

- [ ] **Step 7: 记录结果，不提交**

在最终回复中列出：
- 通过的测试命令与数量；
- 未执行/需授权的构建或冒烟项；
- 已知边界（M1 只读、编辑/导出/字幕/混音桥未实现、`/mix` 未迁移）。

不要创建 git commit。

---

## M1 出口条件

- `GET /episodes/:id/edit` 在 `readonly` 下返回当前成片单片段或空计划，且不产生任何写操作。
- 剪辑页可打开、可播放、时间线可点击跳转、哈希与混音状态可见。
- 旧分集页、配音工作台、导出检查、混音工作台零回归。
- 后端 `tsc --noEmit` 通过；剪辑相关测试全绿；前端结构测试通过。
- 构建与手工冒烟按用户授权执行并记录。

## 后续计划边界

以下内容不属于本计划，M1 验收通过后分别另写计划：

- S2：时间线编辑、素材库、检查器编辑、命令/撤销/自动保存、版本与草稿写入、bootstrap 分镜多片段、字幕建议、冲突处理。
- S3：`cut`/`audio-ref` 渲染、混音桥、导出与当前成片指针、并发/恢复。
- S4：`/mix` 独立页面迁移与跨页一致性。
- S5：P1 能力（叠加轨、滤镜、标题、Take、精确预览、版本对比、批量导出、标记、SRT、帧率、复制粘贴、图片片段、旋转翻转、更多转场、全屏/I/O、对比原片、分轨参考、片段列表）。
- S6：M4 收敛、旧入口跳转、旧最终导出下线。

