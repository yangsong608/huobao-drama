# 成片中心、混音接入与剪辑工作台重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 `video_merges` 为唯一成片目录，让混音页与剪辑页都能选择“拼接导出”的成片、编辑后导出为新成片，并把混音属性面板改成新手可用、剪辑补上右键菜单/帧级操作/字幕样式与时间编辑。

**Architecture:** 数据层新增 `episodes.current_film_id` 作为当前成片的唯一权威指针，所有写入收敛到 `setCurrentFilm`；视频导出成功后投影为 `video_merges` 新行，`episode_exports` 只做渲染任务台账。混音计划改为源成片感知；剪辑从“按分镜铺轨”改为“一部成片一个工程”，新增受限但真实的 FFmpeg 渲染器。

**Tech Stack:** Nuxt 3 SPA + Vue 3.5 + Vue I18n；Hono；Drizzle ORM + better-sqlite3；FFmpeg/ffprobe（ffmpeg-static / ffprobe-static）；Node `node:test` 测试。

**Spec:** `docs/superpowers/specs/2026-11-06-film-hub-mix-edit-redesign.md`（下称“规格”；规格与计划冲突时以规格为准）

## Global Constraints

- 所有命令在仓库根目录 `/Volumes/软件目录/comfyui/工具/huobao-drama` 执行；后端命令先 `cd backend`，前端命令先 `cd frontend`。
- **不执行 git commit**；每个任务最后一步只运行 `git status --short` 记录改动，全部改动留在工作区等待用户审阅。
- **不构建、不打包、不安装、不启动/重启应用**；不占用、不修改端口 `5679`、`3013`、`8192`、`8193`、`8188`、`8189`、`18190`。测试只使用临时目录和 Hono 内存请求。
- 不暴露 API key、token、密码、私钥、公网 IP；不打印 DSH 密码；不把 V3-G5 标记为通过；MCP 工具数保持 61；`TEMPLATE_VERSION` 保持 6。
- 不改 ComfyUI 工作流注册表、网关协议、TTS 链路、模板与现有用户配置。
- 所有用户可见文案必须中文；`frontend/app/locales/{zh,en,ja,ko}.json` 四份同步新增 key。
- 后端测试必须设置独立 `SQLITE_PATH`、`HUOBAO_DATA_DIR`、`STORAGE_PATH`、`MYSQL_AUTO_IMPORT=false` 后再动态 import 服务。
- `video_merges.duration` 单位是**秒**；对外 API 的 `duration_ms` 是毫秒（`duration × 1000`）。
- 后端 ESM 相对导入必须带 `.js` 后缀；前端纯 TS 工具测试直接 `await import('../app/utils/xxx.ts')`。
- 前端没有 vitest；测试文件放 `frontend/tests/*.test.mjs`，用 `node --test` 运行。
- 任何“设为当前成片”只能通过 `setCurrentFilm`；任何模块不得直接写 `episodes.video_url` / `episodes.current_film_id`。

---

## 文件结构总览

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `backend/src/db/schema.ts` | Drizzle 表定义 | 修改 |
| `backend/src/db/sqlite-schema.ts` | 建表、补列、索引迁移、历史回填 | 修改 |
| `backend/src/services/film-hub.ts` | 成片列表/详情/当前指针/删除/重命名/导出投影 | 新建 |
| `backend/src/routes/films.ts` | 成片 API、投影重试 API | 新建 |
| `backend/src/services/export-service.ts` | 导出完成投影、当前导出改为走成片指针 | 修改 |
| `backend/src/services/ffmpeg-merge.ts` | 拼接成片写 `kind='concat'`、`origin='concat'`、bootstrap | 修改 |
| `backend/src/services/motion-post.ts` | 同上；`setAsEpisodeVideo` 改调 `setCurrentFilm` | 修改 |
| `backend/src/services/generation.ts` | 时间线合片写 `kind='concat'`、`origin='concat'` | 修改 |
| `backend/src/services/dubbing.ts` | 不再直接写 `episodes.video_url`，由投影负责 | 修改 |
| `backend/src/routes/dubbing.ts` | 旧 `video-version` 别名改调 `setCurrentFilm` | 修改 |
| `backend/src/services/mix-source.ts` | 源成片解析、默认选择、警告、持久化 | 新建 |
| `backend/src/services/mix-plan.ts` | `MixPlan.source`、源感知编译、虚拟轨默认开关 | 修改 |
| `backend/src/routes/mix.ts` | GET 查询参数、`PUT /mix/source`、版本写入源 | 修改 |
| `backend/src/services/export-service.ts` | 混音导出 `source_film_id`、字幕 `copy`、投影 `kind='mix'` | 修改 |
| `backend/src/routes/exports.ts` | 导出请求透传源成片/工程 | 修改 |
| `backend/src/services/edit-projects.ts` | 工程查找/创建/列表/按成片打开 | 新建 |
| `backend/src/services/edit-service.ts` | 按工程读取、成片打开顺序、空态 | 修改 |
| `backend/src/services/edit-draft-service.ts` | 草稿按 `project_id` | 修改 |
| `backend/src/services/edit-revision-service.ts` | 版本按 `project_id` | 修改 |
| `backend/src/services/edit-bootstrap.ts` | 单成片工程初始化 + 字幕导入 | 修改 |
| `backend/src/services/edit-subtitle.ts` | 字幕外观默认值、归一化、ASS/SRT 生成、字体回退 | 新建 |
| `backend/src/services/edit-frame-ops.ts` | 帧操作纯函数（删除/复制/插入/拉长） | 新建 |
| `backend/src/services/edit-frame-extract.ts` | FFmpeg 抽帧与缓存 | 新建 |
| `backend/src/services/edit-assets.ts` | 图片上传校验、去重、素材列表 | 新建 |
| `backend/src/services/edit-renderer.ts` | 逐片段 FFmpeg 渲染、拼接、字幕烧录/软字幕 | 新建 |
| `backend/src/services/edit-export-service.ts` | 剪辑导出编排、版本、冲突、投影 | 新建 |
| `backend/src/routes/edit.ts` | 工程/帧/素材/导出路由 | 修改 |
| `backend/src/index.ts` | 注册 `films` 路由 | 修改 |
| `frontend/app/composables/useApi.ts` | `filmAPI`、混音/剪辑/导出新参数 | 修改 |
| `frontend/app/components/ContextMenu.vue` | 通用右键菜单 | 新建 |
| `frontend/app/components/FilmPicker.vue` | 三处复用的成片选择器 | 新建 |
| `frontend/app/views/drama/episode.vue` | 拼接导出页成片卡片动作 | 修改 |
| `frontend/app/components/MixStage.vue` | 源成片、检查器重排、背景声入口、素材库、导出 | 修改 |
| `frontend/app/views/drama/edit.vue` | 读取 `?film=`，传入工程 | 修改 |
| `frontend/app/components/edit/EditWorkbench.vue` | 工程切换、保存、导出入口 | 修改 |
| `frontend/app/components/edit/EditSidebar.vue` | 左侧成片列表（替换分镜列表） | 新建/替换 |
| `frontend/app/components/edit/EditTimeline.vue` | 右键菜单、帧操作工具栏、可见按钮 | 修改 |
| `frontend/app/components/edit/EditClipInspector.vue` | 字幕页、帧/图片属性、拉长 | 修改 |
| `frontend/app/components/edit/EditSubtitleOverlay.vue` | 字幕 HTML 覆盖层与安全区 | 新建 |
| `frontend/app/components/edit/EditSubtitleList.vue` | 字幕抽屉 | 新建 |
| `frontend/app/components/edit/EditImagePicker.vue` | 图片素材选择与上传 | 新建 |
| `frontend/app/components/edit/EditExportDialog.vue` | 剪辑导出确认、降级提示、进度 | 新建 |
| `frontend/app/utils/edit-plan.ts` | 前端字幕外观/工程默认类型 | 修改 |
| `frontend/app/utils/edit-commands.ts` | 帧命令、字幕命令、图片命令 | 修改 |
| `frontend/app/composables/useEditPlan.ts` | 工程化草稿、自动保存、冲突 | 修改 |
| `frontend/tests/*.test.mjs` | 前端纯函数与结构测试 | 新建/修改 |
| `backend/tests/*.test.ts` | 后端单元/路由测试 | 新建/修改 |
| `docs/superpowers/specs/...`、`docs/ADR-05`、`docs/ADR-12` | 收口文档 | 修改（Task 24） |

---

# 阶段 A：成片中心地基

### Task 1: 数据库 schema、补列、索引迁移与历史回填

**Files:**
- Modify: `backend/src/db/schema.ts`
- Modify: `backend/src/db/sqlite-schema.ts`
- Modify: `backend/tests/edit-schema.test.ts`
- Create: `backend/tests/film-schema.test.ts`

**Interfaces:**
- Produces: `schema.editProjects`，字段 `id/episodeId/dramaId/sourceMergeId/sourceUrl/sourceFingerprint/title/status/createdAt/updatedAt/deletedAt`。
- Produces: `episodes.currentFilmId/mixSourceMergeId/editProjectId`。
- Produces: `videoMerges.origin/sourceMergeId/exportId/editRevisionId/mixRevisionId/planHash/subtitleBurned`。
- Produces: `mixRevisions.sourceFilmId`；`episodeExports.sourceMergeId/filmId/projectId`；`episodeEditDrafts/editRevisions/editRenders.projectId`。
- Produces 索引：`idx_edit_drafts_project`、`idx_edit_revisions_project_no`、`idx_edit_revisions_project_current`、`idx_edit_renders_project_cache`、`idx_films_export`、`idx_films_episode`、`idx_edit_projects_source`、`idx_edit_projects_legacy`。

- [ ] **Step 1: 写失败测试**

在 `backend/tests/film-schema.test.ts` 写入：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'

function tempDatabase(): { sqlite: Database.Database; close: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-film-schema-'))
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

function indexes(sqlite: Database.Database) {
  return new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
      .map((row) => row.name),
  )
}

test('新建库包含成片中心表、列与索引', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)

    const tables = new Set(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((row) => row.name),
    )
    assert.ok(tables.has('edit_projects'), '缺少 edit_projects')

    for (const name of ['origin', 'source_merge_id', 'export_id', 'edit_revision_id', 'mix_revision_id', 'plan_hash', 'subtitle_burned']) {
      assert.ok(columns(sqlite, 'video_merges').has(name), `video_merges 缺少 ${name}`)
    }
    for (const name of ['current_film_id', 'mix_source_merge_id', 'edit_project_id']) {
      assert.ok(columns(sqlite, 'episodes').has(name), `episodes 缺少 ${name}`)
    }
    for (const name of ['source_merge_id', 'film_id', 'project_id']) {
      assert.ok(columns(sqlite, 'episode_exports').has(name), `episode_exports 缺少 ${name}`)
    }
    assert.ok(columns(sqlite, 'mix_revisions').has('source_film_id'))
    for (const table of ['episode_edit_drafts', 'edit_revisions', 'edit_renders']) {
      assert.ok(columns(sqlite, table).has('project_id'), `${table} 缺少 project_id`)
    }

    const names = indexes(sqlite)
    for (const name of [
      'idx_edit_drafts_project',
      'idx_edit_revisions_project_no',
      'idx_edit_revisions_project_current',
      'idx_edit_renders_project_cache',
      'idx_films_export',
      'idx_films_episode',
      'idx_edit_projects_source',
      'idx_edit_projects_legacy',
    ]) {
      assert.ok(names.has(name), `缺少索引 ${name}`)
    }
    for (const name of [
      'idx_edit_drafts_episode',
      'idx_edit_revisions_no',
      'idx_edit_revisions_current',
      'idx_edit_renders_cache_key',
    ]) {
      assert.ok(!names.has(name), `旧索引仍存在：${name}`)
    }
  } finally {
    close()
  }
})

test('历史 kind 归并为 concat，origin 回填 legacy，重复执行幂等', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.prepare(
      "INSERT INTO video_merges (episode_id, provider, model, status, merged_url, kind, created_at) VALUES (1, 'ffmpeg', 'm', 'completed', 'a.mp4', 'comfyui', 'x')",
    ).run()
    sqlite.prepare(
      "INSERT INTO video_merges (episode_id, provider, model, status, merged_url, kind, created_at) VALUES (1, 'ffmpeg', 'm', 'completed', 'b.mp4', NULL, 'x')",
    ).run()
    sqlite.prepare(
      "INSERT INTO video_merges (episode_id, provider, model, status, merged_url, kind, origin, created_at) VALUES (1, 'ffmpeg', 'm', 'completed', 'c.mp4', 'mix', 'export', 'x')",
    ).run()

    initSqliteSchema(sqlite)
    initSqliteSchema(sqlite)

    const rows = sqlite.prepare('SELECT merged_url, kind, origin FROM video_merges ORDER BY id').all() as {
      merged_url: string; kind: string; origin: string
    }[]
    assert.deepEqual(rows.map((row) => [row.merged_url, row.kind, row.origin]), [
      ['a.mp4', 'concat', 'legacy'],
      ['b.mp4', 'concat', 'legacy'],
      ['c.mp4', 'mix', 'export'],
    ])
  } finally {
    close()
  }
})

test('同一集可以保存多份工程草稿，同一工程仍唯一', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.exec("INSERT INTO dramas (title, created_at, updated_at) VALUES ('剧', 'x', 'x')")
    sqlite.exec("INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, '集', 'x', 'x')")
    sqlite.prepare(
      "INSERT INTO edit_projects (episode_id, drama_id, title, created_at, updated_at) VALUES (1, 1, 'A', 'x', 'x')",
    ).run()
    sqlite.prepare(
      "INSERT INTO edit_projects (episode_id, drama_id, title, created_at, updated_at) VALUES (1, 1, 'B', 'x', 'x')",
    ).run()

    sqlite.prepare(
      "INSERT INTO episode_edit_drafts (episode_id, project_id, plan_json, version, created_at, updated_at) VALUES (1, 1, '{}', 1, 'x', 'x')",
    ).run()
    sqlite.prepare(
      "INSERT INTO episode_edit_drafts (episode_id, project_id, plan_json, version, created_at, updated_at) VALUES (1, 2, '{}', 1, 'x', 'x')",
    ).run()
    assert.throws(() => sqlite.prepare(
      "INSERT INTO episode_edit_drafts (episode_id, project_id, plan_json, version, created_at, updated_at) VALUES (1, 1, '{}', 2, 'x', 'x')",
    ).run(), /UNIQUE/)
  } finally {
    close()
  }
})

test('current_film_id 按 URL 回填，同 URL 取最新未删除成片', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.exec("INSERT INTO dramas (title, created_at, updated_at) VALUES ('剧', 'x', 'x')")
    sqlite.exec("INSERT INTO episodes (drama_id, episode_number, title, video_url, created_at, updated_at) VALUES (1, 1, '集', 'same.mp4', 'x', 'x')")
    sqlite.exec("INSERT INTO video_merges (episode_id, provider, model, status, merged_url, kind, created_at) VALUES (1, 'f', 'm', 'completed', 'same.mp4', 'concat', '2026-01-01')")
    sqlite.exec("INSERT INTO video_merges (episode_id, provider, model, status, merged_url, kind, created_at) VALUES (1, 'f', 'm', 'completed', 'same.mp4', 'concat', '2026-02-01')")

    initSqliteSchema(sqlite)

    const episode = sqlite.prepare('SELECT current_film_id FROM episodes WHERE id = 1').get() as { current_film_id: number }
    assert.equal(episode.current_film_id, 2)
  } finally {
    close()
  }
})

test('旧草稿回填到 source_merge_id 为空的旧工程', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.exec("INSERT INTO dramas (title, created_at, updated_at) VALUES ('剧', 'x', 'x')")
    sqlite.exec("INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, '老集', 'x', 'x')")
    sqlite.exec("INSERT INTO episode_edit_drafts (episode_id, plan_json, version, created_at, updated_at) VALUES (1, '{}', 0, 'x', 'x')")

    initSqliteSchema(sqlite)

    const project = sqlite.prepare('SELECT id, source_merge_id, source_url FROM edit_projects WHERE episode_id = 1').get() as {
      id: number; source_merge_id: number | null; source_url: string | null
    }
    assert.ok(project.id)
    assert.equal(project.source_merge_id, null)
    const draft = sqlite.prepare('SELECT project_id FROM episode_edit_drafts WHERE episode_id = 1').get() as { project_id: number }
    assert.equal(draft.project_id, project.id)
  } finally {
    close()
  }
})
```

同时把 `backend/tests/edit-schema.test.ts` 的索引期望改为：

```ts
for (const name of [
  'idx_edit_drafts_project',
  'idx_edit_revisions_project_no',
  'idx_edit_revisions_project_current',
  'idx_edit_renders_project_cache',
  'idx_edit_renders_sync',
  'idx_edit_renders_revision',
  'idx_media_proxies_source',
]) {
  assert.ok(indexes.has(name), `缺少索引 ${name}`)
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/film-schema.test.ts
```

预期：`edit_projects` 不存在，`video_merges` 缺少 `origin`。

- [ ] **Step 3: 实现 schema 与迁移**

在 `backend/src/db/schema.ts` 中：

```ts
/** 剪辑工程：一部源成片一个工程 */
export const editProjects = sqliteTable('edit_projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id').notNull(),
  sourceMergeId: integer('source_merge_id'),
  sourceUrl: text('source_url'),
  sourceFingerprint: text('source_fingerprint'),
  title: text('title').notNull(),
  status: text('status').default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})
```

在 `episodes` 增加：

```ts
  /** 当前成片指针（权威字段） */
  currentFilmId: integer('current_film_id'),
  /** 混音页上次选择的源成片 */
  mixSourceMergeId: integer('mix_source_merge_id'),
  /** 剪辑页上次打开的工程 */
  editProjectId: integer('edit_project_id'),
```

在 `videoMerges` 增加：

```ts
  origin: text('origin').default('legacy'),
  sourceMergeId: integer('source_merge_id'),
  exportId: integer('export_id'),
  editRevisionId: integer('edit_revision_id'),
  mixRevisionId: integer('mix_revision_id'),
  planHash: text('plan_hash'),
  subtitleBurned: integer('subtitle_burned', { mode: 'boolean' }).default(false),
```

在 `mixRevisions` 增加：

```ts
  sourceFilmId: integer('source_film_id'),
```

在 `episodeExports` 增加：

```ts
  sourceMergeId: integer('source_merge_id'),
  filmId: integer('film_id'),
  projectId: integer('project_id'),
```

在 `episodeEditDrafts`、`editRevisions`、`editRenders` 各增加：

```ts
  projectId: integer('project_id'),
```

在 `backend/src/db/sqlite-schema.ts` 中：

1. 删除 `schemaStatements` 里 930–936 行的 7 条旧剪辑索引（`idx_edit_drafts_episode` … `idx_edit_renders_cache_key`）。
2. 在 `initSqliteSchema` 的 `edit_enabled` 回填之后、小说列扩展之前插入 `migrateFilmHub(sqlite)`。
3. 新增函数（放在 `initSqliteSchema` 之前）：

```ts
function migrateFilmHub(sqlite: Database.Database): void {
  const episodeColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(episodes)').all() as { name: string }[]).map((row) => row.name),
  )
  const episodeFilmColumns: Record<string, string> = {
    current_film_id: 'INTEGER',
    mix_source_merge_id: 'INTEGER',
    edit_project_id: 'INTEGER',
  }
  for (const [name, type] of Object.entries(episodeFilmColumns)) {
    if (!episodeColumns.has(name)) sqlite.exec(`ALTER TABLE episodes ADD COLUMN ${name} ${type}`)
  }

  const mergeColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(video_merges)').all() as { name: string }[]).map((row) => row.name),
  )
  const mergeFilmColumns: Record<string, string> = {
    origin: "TEXT DEFAULT 'legacy'",
    source_merge_id: 'INTEGER',
    export_id: 'INTEGER',
    edit_revision_id: 'INTEGER',
    mix_revision_id: 'INTEGER',
    plan_hash: 'TEXT',
    subtitle_burned: 'INTEGER DEFAULT 0',
  }
  for (const [name, type] of Object.entries(mergeFilmColumns)) {
    if (!mergeColumns.has(name)) sqlite.exec(`ALTER TABLE video_merges ADD COLUMN ${name} ${type}`)
  }

  const mixColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(mix_revisions)').all() as { name: string }[]).map((row) => row.name),
  )
  if (!mixColumns.has('source_film_id')) sqlite.exec('ALTER TABLE mix_revisions ADD COLUMN source_film_id INTEGER')

  const exportColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(episode_exports)').all() as { name: string }[]).map((row) => row.name),
  )
  const exportFilmColumns: Record<string, string> = {
    source_merge_id: 'INTEGER',
    film_id: 'INTEGER',
    project_id: 'INTEGER',
  }
  for (const [name, type] of Object.entries(exportFilmColumns)) {
    if (!exportColumns.has(name)) sqlite.exec(`ALTER TABLE episode_exports ADD COLUMN ${name} ${type}`)
  }

  for (const table of ['episode_edit_drafts', 'edit_revisions', 'edit_renders']) {
    const columns = new Set(
      (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
    )
    if (!columns.has('project_id')) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN project_id INTEGER`)
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS edit_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      drama_id INTEGER NOT NULL,
      source_merge_id INTEGER,
      source_url TEXT,
      source_fingerprint TEXT,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `)

  sqlite.exec(`
    UPDATE video_merges SET kind = 'concat'
    WHERE kind IS NULL OR kind IN ('comfyui', 'motion')
  `)
  sqlite.exec("UPDATE video_merges SET origin = 'legacy' WHERE origin IS NULL")

  sqlite.exec(`
    UPDATE episodes SET current_film_id = (
      SELECT vm.id FROM video_merges vm
      WHERE vm.episode_id = episodes.id
        AND vm.merged_url = episodes.video_url
        AND vm.status = 'completed'
        AND vm.deleted_at IS NULL
      ORDER BY vm.id DESC
      LIMIT 1
    )
    WHERE current_film_id IS NULL
      AND video_url IS NOT NULL AND video_url <> ''
  `)

  sqlite.exec(`
    INSERT INTO edit_projects (episode_id, drama_id, source_merge_id, source_url, title, status, created_at, updated_at)
    SELECT e.id, e.drama_id, NULL, e.video_url,
           '第 ' || e.episode_number || ' 集（旧版剪辑）', 'active', e.updated_at, e.updated_at
    FROM episodes e
    WHERE (
      EXISTS (SELECT 1 FROM episode_edit_drafts d WHERE d.episode_id = e.id)
      OR EXISTS (SELECT 1 FROM edit_revisions r WHERE r.episode_id = e.id)
      OR EXISTS (SELECT 1 FROM edit_renders x WHERE x.episode_id = e.id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM edit_projects p
      WHERE p.episode_id = e.id AND p.source_merge_id IS NULL AND p.deleted_at IS NULL
    )
  `)

  sqlite.exec(`
    UPDATE episode_edit_drafts SET project_id = (
      SELECT p.id FROM edit_projects p
      WHERE p.episode_id = episode_edit_drafts.episode_id
        AND p.source_merge_id IS NULL AND p.deleted_at IS NULL
      LIMIT 1
    ) WHERE project_id IS NULL
  `)
  sqlite.exec(`
    UPDATE edit_revisions SET project_id = (
      SELECT p.id FROM edit_projects p
      WHERE p.episode_id = edit_revisions.episode_id
        AND p.source_merge_id IS NULL AND p.deleted_at IS NULL
      LIMIT 1
    ) WHERE project_id IS NULL
  `)
  sqlite.exec(`
    UPDATE edit_renders SET project_id = (
      SELECT p.id FROM edit_projects p
      WHERE p.episode_id = edit_renders.episode_id
        AND p.source_merge_id IS NULL AND p.deleted_at IS NULL
      LIMIT 1
    ) WHERE project_id IS NULL
  `)
  sqlite.exec(`
    UPDATE episodes SET edit_project_id = (
      SELECT p.id FROM edit_projects p
      WHERE p.episode_id = episodes.id
        AND p.source_merge_id IS NULL AND p.deleted_at IS NULL
      LIMIT 1
    )
    WHERE edit_project_id IS NULL AND edit_revision_id IS NOT NULL
  `)
  sqlite.exec(`
    UPDATE episode_exports SET project_id = (
      SELECT r.project_id FROM edit_revisions r WHERE r.id = episode_exports.edit_revision_id
    )
    WHERE project_id IS NULL AND edit_revision_id IS NOT NULL
  `)

  for (const name of [
    'idx_edit_drafts_episode',
    'idx_edit_revisions_no',
    'idx_edit_revisions_current',
    'idx_edit_renders_cache_key',
  ]) {
    sqlite.exec(`DROP INDEX IF EXISTS ${name}`)
  }
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_drafts_project ON episode_edit_drafts (project_id) WHERE project_id IS NOT NULL')
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_revisions_project_no ON edit_revisions (project_id, revision_no) WHERE project_id IS NOT NULL')
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_edit_revisions_project_current ON edit_revisions (project_id, is_current) WHERE project_id IS NOT NULL')
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_renders_project_cache ON edit_renders (project_id, kind, cache_key) WHERE project_id IS NOT NULL AND cache_key IS NOT NULL')
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_films_export ON video_merges (export_id) WHERE export_id IS NOT NULL AND deleted_at IS NULL')
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_films_episode ON video_merges (episode_id, created_at)')
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_projects_source ON edit_projects (episode_id, source_merge_id) WHERE source_merge_id IS NOT NULL AND deleted_at IS NULL')
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_projects_legacy ON edit_projects (episode_id) WHERE source_merge_id IS NULL AND deleted_at IS NULL')
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/film-schema.test.ts tests/edit-schema.test.ts
cd backend && npm run typecheck
```

预期：全部通过；旧库重复初始化不报唯一索引错误。

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 2: 成片中心服务（列表、详情、当前指针、删除、重命名、导出投影）

**Files:**
- Create: `backend/src/services/film-hub.ts`
- Create: `backend/tests/film-hub.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `video_merges` / `episodes` / `edit_projects` / `episode_exports` 列。
- Produces: `listFilms(episodeId, limit?)`、`getFilmDetail(filmId)`、`setCurrentFilm(episodeId, filmId)`、`deleteFilm(filmId)`、`renameFilm(filmId, title)`、`bootstrapCurrentFilmIfEmpty(episodeId, filmId)`、`projectFilmFromExport(exportId)`。
- Produces: `FilmError`（`status` + `code`）、`FilmKind`、`FilmOrigin`、`FilmSummary`。

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/film-hub.test.ts`：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-film-hub-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  bootstrapCurrentFilmIfEmpty,
  deleteFilm,
  listFilms,
  projectFilmFromExport,
  renameFilm,
  setCurrentFilm,
} = await import('../src/services/film-hub.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '成片测试', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const outputUrl = `static/projects/${drama.id}/videos/out.mp4`
fs.writeFileSync(path.join(root, outputUrl), Buffer.from('fake-video'))

const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 3, title: '第三集', createdAt: ts, updatedAt: ts,
}).returning().get()

function film(values: Partial<typeof schema.videoMerges.$inferInsert> = {}) {
  return db.insert(schema.videoMerges).values({
    episodeId: episode.id,
    dramaId: drama.id,
    provider: 'ffmpeg',
    model: 'test',
    status: 'completed',
    kind: 'concat',
    origin: 'concat',
    mergedUrl: outputUrl,
    duration: 12,
    createdAt: ts,
    ...values,
  }).returning().get()
}

after(() => fs.rmSync(root, { recursive: true, force: true }))

test('列表只返回已完成、未删除成片，并换算 duration_ms', () => {
  const concat = film({ title: '拼接 A' })
  film({ title: '处理中', status: 'processing' })
  film({ title: '已删除', deletedAt: ts })

  const result = listFilms(episode.id)
  assert.equal(result.current_film_id, null)
  assert.equal(result.films.length, 1)
  assert.equal(result.films[0].id, concat.id)
  assert.equal(result.films[0].duration_ms, 12000)
  assert.equal(result.films[0].duration_unknown, false)
  assert.equal(result.films[0].kind, 'concat')
  assert.equal(result.films[0].is_current, false)
})

test('设为当前成片写入权威指针与兼容镜像，烧录字幕不回写 subtitle_url', () => {
  const concat = film({ title: '拼接 B', subtitleUrl: 'static/x.srt', subtitleBurned: false })
  const burned = film({ title: '烧录 C', subtitleUrl: 'static/y.srt', subtitleBurned: true })

  const first = setCurrentFilm(episode.id, concat.id)
  assert.equal(first.current_film_id, concat.id)
  assert.equal(first.video_url, outputUrl)
  assert.equal(first.subtitle_url, 'static/x.srt')

  const second = setCurrentFilm(episode.id, burned.id)
  assert.equal(second.subtitle_url, null)
  const row = db.select().from(schema.episodes).where(eqId(schema.episodes.id, episode.id)).get()!
  assert.equal(row.currentFilmId, burned.id)
  assert.equal(row.subtitleUrl, null)
  assert.equal(row.duration, 12)
})

test('删除当前成片返回 FILM_IS_CURRENT；删除其他成片软删除并级联软删除工程', () => {
  const current = film({ title: '当前' })
  setCurrentFilm(episode.id, current.id)
  assert.throws(() => deleteFilm(current.id), (error: any) => error.code === 'FILM_IS_CURRENT' && error.status === 409)

  const other = film({ title: '可删除' })
  const project = db.insert(schema.editProjects).values({
    episodeId: episode.id, dramaId: drama.id, sourceMergeId: other.id,
    sourceUrl: outputUrl, title: '工程', status: 'active', createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.update(schema.episodes).set({ editProjectId: project.id }).where(eqId(schema.episodes.id, episode.id)).run()

  const result = deleteFilm(other.id)
  assert.equal(result.deleted, true)
  assert.equal(result.deleted_project_id, project.id)
  const deleted = db.select().from(schema.videoMerges).where(eqId(schema.videoMerges.id, other.id)).get()!
  assert.ok(deleted.deletedAt)
  const deletedProject = db.select().from(schema.editProjects).where(eqId(schema.editProjects.id, project.id)).get()!
  assert.ok(deletedProject.deletedAt)
  const episodeRow = db.select().from(schema.episodes).where(eqId(schema.episodes.id, episode.id)).get()!
  assert.equal(episodeRow.editProjectId, null)
})

test('重命名只接受 1–80 字', () => {
  const target = film({ title: '旧标题' })
  assert.equal(renameFilm(target.id, '  新标题  ').title, '新标题')
  assert.throws(() => renameFilm(target.id, '   '), (error: any) => error.code === 'FILM_TITLE_INVALID')
  assert.throws(() => renameFilm(target.id, 'x'.repeat(81)), (error: any) => error.code === 'FILM_TITLE_INVALID')
})

test('导出投影幂等：同一 export 只生成一部成片，剪辑导出为 edit', () => {
  const exportRow = db.insert(schema.episodeExports).values({
    episodeId: episode.id, kind: 'video', status: 'completed', outputUrl,
    durationMs: 12_345, paramsJson: JSON.stringify({ setCurrent: false }),
    projectId: 99, createdAt: ts,
  }).returning().get()

  const firstId = projectFilmFromExport(exportRow.id)
  const secondId = projectFilmFromExport(exportRow.id)
  assert.equal(firstId, secondId)

  const saved = db.select().from(schema.videoMerges).where(eqId(schema.videoMerges.id, firstId)).get()!
  assert.equal(saved.kind, 'edit')
  assert.equal(saved.origin, 'export')
  assert.equal(saved.exportId, exportRow.id)
  assert.equal(saved.duration, 12)
  const exportAfter = db.select().from(schema.episodeExports).where(eqId(schema.episodeExports.id, exportRow.id)).get()!
  assert.equal(exportAfter.filmId, firstId)
})

test('bootstrap 只在 current_film_id 为空时建立初始当前成片', () => {
  db.update(schema.episodes).set({ currentFilmId: null, videoUrl: null }).where(eqId(schema.episodes.id, episode.id)).run()
  const target = film({ title: '初始' })
  assert.equal(bootstrapCurrentFilmIfEmpty(episode.id, target.id), true)
  assert.equal(bootstrapCurrentFilmIfEmpty(episode.id, target.id), false)
})

// 文件顶部：import { eq } from 'drizzle-orm'
const eqId = eq
```

> 测试文件顶部 `import { eq } from 'drizzle-orm'`，`eqId` 只是别名，避免测试内与局部变量重名。不要用 `require('drizzle-orm')` 动态取。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/film-hub.test.ts
```

预期：模块 `film-hub.ts` 不存在。

- [ ] **Step 3: 实现 `film-hub.ts`**

```ts
import fs from 'node:fs'
import path from 'node:path'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { probeMedia } from './export-validation.js'

export type FilmKind = 'concat' | 'mix' | 'edit' | 'import'
export type FilmOrigin = 'concat' | 'export' | 'import' | 'legacy'

export class FilmError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface FilmSummary {
  id: number
  title: string
  kind: FilmKind
  origin: FilmOrigin
  url: string
  subtitle_url: string | null
  duration_ms: number
  duration_unknown: boolean
  created_at: string
  is_current: boolean
  source_merge_id: number | null
  export_id: number | null
  edit_revision_id: number | null
  mix_revision_id: number | null
  edit_project_id: number | null
}

export interface FilmDetail extends FilmSummary {
  has_audio: boolean
  width: number | null
  height: number | null
  subtitle_burned: boolean
  subtitle_cues: number | null
  edit_project: { id: number; updated_at: string } | null
}

const FILM_KINDS: FilmKind[] = ['concat', 'mix', 'edit', 'import']
const FILM_ORIGINS: FilmOrigin[] = ['concat', 'export', 'import', 'legacy']

function kindOf(value: unknown): FilmKind {
  return FILM_KINDS.includes(value as FilmKind) ? value as FilmKind : 'concat'
}

function originOf(value: unknown): FilmOrigin {
  return FILM_ORIGINS.includes(value as FilmOrigin) ? value as FilmOrigin : 'legacy'
}

export function filmKindOf(value: unknown): FilmKind {
  return kindOf(value)
}

function requireFilm(filmId: number) {
  const row = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, filmId)).get()
  if (!row || row.deletedAt) throw new FilmError(404, 'FILM_NOT_FOUND', '成片不存在或已删除')
  return row
}

function activeProjectsOf(episodeId: number, filmIds: number[]) {
  if (filmIds.length === 0) return new Map<number, { id: number; updated_at: string }>()
  const rows = db.select().from(schema.editProjects)
    .where(and(
      eq(schema.editProjects.episodeId, episodeId),
      inArray(schema.editProjects.sourceMergeId, filmIds),
      isNull(schema.editProjects.deletedAt),
    ))
    .all()
  return new Map(rows.map((row) => [row.sourceMergeId!, { id: row.id, updated_at: row.updatedAt }]))
}

export function listFilms(episodeId: number, limit = 50) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new FilmError(404, 'EPISODE_NOT_FOUND', '集不存在')
  const rows = db.select().from(schema.videoMerges)
    .where(and(
      eq(schema.videoMerges.episodeId, episodeId),
      eq(schema.videoMerges.status, 'completed'),
      isNull(schema.videoMerges.deletedAt),
    ))
    .orderBy(desc(schema.videoMerges.createdAt), desc(schema.videoMerges.id))
    .limit(Math.min(100, Math.max(1, limit)))
    .all()
    .filter((row) => Boolean(row.mergedUrl))
  const projects = activeProjectsOf(episodeId, rows.map((row) => row.id))
  return {
    episode_id: episodeId,
    current_film_id: episode.currentFilmId ?? null,
    films: rows.map((row) => ({
      id: row.id,
      title: row.title || `第 ${episode.episodeNumber} 集成片`,
      kind: kindOf(row.kind),
      origin: originOf(row.origin),
      url: row.mergedUrl!,
      subtitle_url: row.subtitleUrl ?? null,
      duration_ms: Math.max(0, Math.round((row.duration || 0) * 1000)),
      duration_unknown: !row.duration || row.duration <= 0,
      created_at: row.createdAt,
      is_current: episode.currentFilmId === row.id,
      source_merge_id: row.sourceMergeId ?? null,
      export_id: row.exportId ?? null,
      edit_revision_id: row.editRevisionId ?? null,
      mix_revision_id: row.mixRevisionId ?? null,
      edit_project_id: projects.get(row.id)?.id ?? null,
    })) satisfies FilmSummary[],
  }
}

function countSrtCues(file: string): number | null {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const matches = text.match(/-->/g)
    return matches ? matches.length : 0
  } catch {
    return null
  }
}

export async function getFilmDetail(filmId: number): Promise<FilmDetail> {
  const row = requireFilm(filmId)
  if (!row.mergedUrl) throw new FilmError(404, 'FILM_NOT_FOUND', '成片不存在或已删除')
  const abs = getAbsolutePath(row.mergedUrl)
  if (!fs.existsSync(abs)) throw new FilmError(422, 'FILM_UNREADABLE', '成片文件无法读取，请重新生成')
  const probe = await probeMedia(abs).catch(() => null)
  const project = row.episodeId
    ? db.select().from(schema.editProjects)
        .where(and(
          eq(schema.editProjects.episodeId, row.episodeId),
          eq(schema.editProjects.sourceMergeId, row.id),
          isNull(schema.editProjects.deletedAt),
        ))
        .get()
    : undefined
  return {
    id: row.id,
    title: row.title || `成片 ${row.id}`,
    kind: kindOf(row.kind),
    origin: originOf(row.origin),
    url: row.mergedUrl,
    subtitle_url: row.subtitleUrl ?? null,
    duration_ms: Math.max(0, Math.round((row.duration || 0) * 1000)),
    duration_unknown: !row.duration || row.duration <= 0,
    created_at: row.createdAt,
    is_current: Boolean(row.episodeId && db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, row.episodeId)).get()?.currentFilmId === row.id),
    source_merge_id: row.sourceMergeId ?? null,
    export_id: row.exportId ?? null,
    edit_revision_id: row.editRevisionId ?? null,
    mix_revision_id: row.mixRevisionId ?? null,
    edit_project_id: project?.id ?? null,
    has_audio: Boolean(probe?.audio),
    width: probe?.video?.width || null,
    height: probe?.video?.height || null,
    subtitle_burned: Boolean(row.subtitleBurned),
    subtitle_cues: row.subtitleUrl && !row.subtitleBurned
      ? countSrtCues(getAbsolutePath(row.subtitleUrl))
      : null,
    edit_project: project ? { id: project.id, updated_at: project.updatedAt } : null,
  }
}

export function setCurrentFilm(episodeId: number, filmId: number) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode || episode.deletedAt) throw new FilmError(404, 'EPISODE_NOT_FOUND', '集不存在')
  const film = requireFilm(filmId)
  if (film.episodeId !== episodeId) throw new FilmError(400, 'FILM_EPISODE_MISMATCH', '成片不属于该集')
  if (film.status !== 'completed' || !film.mergedUrl) {
    throw new FilmError(409, 'FILM_NOT_READY', '成片尚未完成')
  }
  if (!fs.existsSync(getAbsolutePath(film.mergedUrl))) {
    throw new FilmError(422, 'FILM_UNREADABLE', '成片文件无法读取，请重新生成')
  }
  const subtitleUrl = film.subtitleBurned ? null : (film.subtitleUrl ?? null)
  const duration = film.duration && film.duration > 0
    ? film.duration
    : Math.round((episode.duration || 0))
  db.transaction((tx) => {
    tx.update(schema.episodes).set({
      currentFilmId: film.id,
      videoUrl: film.mergedUrl,
      subtitleUrl,
      duration,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.episodes.id, episodeId)).run()
    if (film.exportId) {
      tx.update(schema.episodeExports).set({ isCurrent: false })
        .where(and(
          eq(schema.episodeExports.episodeId, episodeId),
          eq(schema.episodeExports.kind, 'video'),
          eq(schema.episodeExports.isCurrent, true),
        )).run()
      tx.update(schema.episodeExports).set({ isCurrent: true })
        .where(eq(schema.episodeExports.id, film.exportId)).run()
    }
  }, { behavior: 'immediate' })
  return { current_film_id: film.id, video_url: film.mergedUrl, subtitle_url: subtitleUrl }
}

export function bootstrapCurrentFilmIfEmpty(episodeId: number, filmId: number): boolean {
  const film = requireFilm(filmId)
  if (film.status !== 'completed' || !film.mergedUrl) return false
  const result = db.update(schema.episodes).set({
    currentFilmId: film.id,
    videoUrl: film.mergedUrl,
    subtitleUrl: film.subtitleBurned ? null : (film.subtitleUrl ?? null),
    duration: film.duration && film.duration > 0 ? film.duration : undefined,
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(schema.episodes.id, episodeId),
    isNull(schema.episodes.currentFilmId),
  )).run()
  return result.changes > 0
}

export function deleteFilm(filmId: number) {
  const film = requireFilm(filmId)
  if (film.episodeId) {
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, film.episodeId)).get()
    if (episode?.currentFilmId === filmId) {
      throw new FilmError(409, 'FILM_IS_CURRENT', '这是当前成片，请先把其他成片设为当前')
    }
  }
  const ts = new Date().toISOString()
  let deletedProjectId: number | null = null
  db.transaction((tx) => {
    tx.update(schema.videoMerges).set({ deletedAt: ts }).where(eq(schema.videoMerges.id, filmId)).run()
    if (film.episodeId) {
      const project = tx.select().from(schema.editProjects)
        .where(and(
          eq(schema.editProjects.episodeId, film.episodeId),
          eq(schema.editProjects.sourceMergeId, filmId),
          isNull(schema.editProjects.deletedAt),
        ))
        .get()
      if (project) {
        deletedProjectId = project.id
        tx.update(schema.editProjects).set({ status: 'deleted', deletedAt: ts, updatedAt: ts })
          .where(eq(schema.editProjects.id, project.id)).run()
        tx.update(schema.episodes).set({ editProjectId: null, updatedAt: ts })
          .where(and(
            eq(schema.episodes.id, film.episodeId),
            eq(schema.episodes.editProjectId, project.id),
          )).run()
      }
    }
  }, { behavior: 'immediate' })
  return { deleted: true, deleted_project_id: deletedProjectId }
}

export function renameFilm(filmId: number, rawTitle: unknown) {
  const film = requireFilm(filmId)
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  if (title.length < 1 || title.length > 80) {
    throw new FilmError(400, 'FILM_TITLE_INVALID', '标题需要 1–80 个字')
  }
  db.update(schema.videoMerges).set({ title }).where(eq(schema.videoMerges.id, film.id)).run()
  return { id: film.id, title }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function localMinute(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function exportKindOf(record: typeof schema.episodeExports.$inferSelect): FilmKind {
  return record.projectId ? 'edit' : 'mix'
}

export function projectFilmFromExport(exportId: number): number {
  const record = db.select().from(schema.episodeExports).where(eq(schema.episodeExports.id, exportId)).get()
  if (!record) throw new FilmError(404, 'EXPORT_NOT_FOUND', '导出记录不存在')
  if (record.filmId) {
    const existing = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, record.filmId)).get()
    if (existing && !existing.deletedAt) return existing.id
  }
  if (record.status !== 'completed' || !record.outputUrl) {
    throw new FilmError(409, 'EXPORT_NOT_COMPLETED', '导出尚未完成')
  }
  if (!fs.existsSync(getAbsolutePath(record.outputUrl))) {
    throw new FilmError(422, 'FILM_UNREADABLE', '成片文件无法读取，请重新生成')
  }
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, record.episodeId)).get()
  if (!episode) throw new FilmError(404, 'EPISODE_NOT_FOUND', '集不存在')
  const params = (() => {
    try { return JSON.parse(record.paramsJson || '{}') } catch { return {} }
  })() as Record<string, unknown>
  const kind = exportKindOf(record)
  const title = kind === 'edit'
    ? `第 ${episode.episodeNumber} 集 剪辑成片（${localMinute()}）`
    : `第 ${episode.episodeNumber} 集 混音成片（${localMinute()}）`
  const subtitleMode = String(params.subtitleMode ?? record.subtitleMode ?? 'none')
  const subtitleBurned = subtitleMode === 'burn' || subtitleMode === 'hard'
  const durationSeconds = Math.max(0, Math.round((record.durationMs || 0) / 1000))
  try {
    const filmId = db.transaction((tx) => {
      const inserted = tx.insert(schema.videoMerges).values({
        episodeId: record.episodeId,
        dramaId: episode.dramaId,
        title,
        provider: 'ffmpeg',
        model: 'ffmpeg-export',
        status: 'completed',
        mergedUrl: record.outputUrl!,
        duration: durationSeconds,
        kind,
        origin: 'export',
        sourceMergeId: record.sourceMergeId ?? null,
        exportId: record.id,
        editRevisionId: record.editRevisionId ?? null,
        mixRevisionId: record.mixRevisionId ?? null,
        planHash: record.planHash ?? null,
        subtitleBurned,
        subtitleUrl: subtitleBurned ? null : (typeof params.subtitleUrl === 'string' ? params.subtitleUrl : null),
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }).returning().get()
      tx.update(schema.episodeExports).set({ filmId: inserted.id })
        .where(eq(schema.episodeExports.id, record.id)).run()
      return inserted.id
    }, { behavior: 'immediate' })
    if (params.setCurrent === true) setCurrentFilm(record.episodeId, filmId)
    return filmId
  } catch (error) {
    if (error instanceof FilmError) throw error
    throw new FilmError(500, 'FILM_PROJECTION_FAILED', '成片入库失败，可重试')
  }
}
```

注意：`params.subtitleUrl` 由导出任务写入；硬字幕永远为 `null`。投影不探测成片，避免阻塞导出完成；详情接口才探测。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/film-hub.test.ts
cd backend && npm run typecheck
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 3: 成片 API 与投影重试路由

**Files:**
- Create: `backend/src/routes/films.ts`
- Modify: `backend/src/index.ts`
- Create: `backend/tests/film-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `film-hub.ts`。
- Produces HTTP：
  - `GET /api/v1/episodes/:id/films?limit=50`
  - `GET /api/v1/films/:filmId`
  - `POST /api/v1/episodes/:id/films/:filmId/current`
  - `DELETE /api/v1/films/:filmId`
  - `PATCH /api/v1/films/:filmId`
  - `POST /api/v1/episodes/:id/exports/:exportId/project-film`

- [ ] **Step 1: 写失败测试**

`backend/tests/film-routes.test.ts`：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-film-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/films.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({ title: '剧', createdAt: ts, updatedAt: ts }).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const url = `static/projects/${drama.id}/videos/f.mp4`
fs.writeFileSync(path.join(root, url), Buffer.from('x'))
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '集', createdAt: ts, updatedAt: ts,
}).returning().get()
const film = db.insert(schema.videoMerges).values({
  episodeId: episode.id, dramaId: drama.id, provider: 'ffmpeg', model: 'm',
  status: 'completed', kind: 'concat', origin: 'concat', mergedUrl: url, duration: 5,
  title: '拼接一', createdAt: ts,
}).returning().get()

after(() => fs.rmSync(root, { recursive: true, force: true }))

async function body(response: Response) {
  return response.json() as Promise<any>
}

test('GET /episodes/:id/films 返回成片与当前指针', async () => {
  const response = await app.request(`/episodes/${episode.id}/films`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await body(response)).data
  assert.equal(data.current_film_id, null)
  assert.equal(data.films[0].id, film.id)
  assert.equal(data.films[0].duration_ms, 5000)
})

test('POST current 写入指针；DELETE 当前返回 409；PATCH 改名', async () => {
  const current = await app.request(`/episodes/${episode.id}/films/${film.id}/current`, { method: 'POST' })
  assert.equal(current.status, 200, await current.clone().text())
  assert.equal((await body(current)).data.current_film_id, film.id)

  const remove = await app.request(`/films/${film.id}`, { method: 'DELETE' })
  assert.equal(remove.status, 409)
  assert.equal((await body(remove)).code, 'FILM_IS_CURRENT')

  const patch = await app.request(`/films/${film.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '新名字' }),
  })
  assert.equal(patch.status, 200)
  assert.equal((await body(patch)).data.title, '新名字')
})

test('GET /films/:id 返回详情与是否含音轨', async () => {
  const response = await app.request(`/films/${film.id}`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await body(response)).data
  assert.equal(data.id, film.id)
  assert.equal(data.subtitle_burned, false)
  assert.equal(data.duration_ms, 5000)
})

test('投影重试只对已完成视频导出生效', async () => {
  const exportRow = db.insert(schema.episodeExports).values({
    episodeId: episode.id, kind: 'video', status: 'completed', outputUrl: url,
    durationMs: 5000, createdAt: ts,
  }).returning().get()
  const response = await app.request(`/episodes/${episode.id}/exports/${exportRow.id}/project-film`, { method: 'POST' })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await body(response)).data
  assert.ok(data.film_id)

  const pending = db.insert(schema.episodeExports).values({
    episodeId: episode.id, kind: 'video', status: 'running', outputUrl: url, createdAt: ts,
  }).returning().get()
  const rejected = await app.request(`/episodes/${episode.id}/exports/${pending.id}/project-film`, { method: 'POST' })
  assert.equal(rejected.status, 409)
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/film-routes.test.ts
```

预期：`routes/films.ts` 不存在。

- [ ] **Step 3: 实现路由并注册**

`backend/src/routes/films.ts`：

```ts
import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, serverError, success } from '../utils/response.js'
import {
  FilmError,
  deleteFilm,
  getFilmDetail,
  listFilms,
  projectFilmFromExport,
  renameFilm,
  setCurrentFilm,
} from '../services/film-hub.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function handleFilmError(c: Context, error: unknown) {
  if (error instanceof FilmError) {
    return c.json({ code: error.code, message: error.message }, error.status as any)
  }
  return serverError(c, error instanceof Error ? error.message : '成片操作失败')
}

app.get('/episodes/:id/films', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    const limit = Number(c.req.query('limit') || 50)
    return success(c, listFilms(episodeId, Number.isFinite(limit) ? limit : 50))
  } catch (error) {
    return handleFilmError(c, error)
  }
})

app.get('/films/:filmId', async (c) => {
  const filmId = parseId(c.req.param('filmId'))
  if (!filmId) return badRequest(c, '成片编号无效')
  try {
    return success(c, await getFilmDetail(filmId))
  } catch (error) {
    return handleFilmError(c, error)
  }
})

app.post('/episodes/:id/films/:filmId/current', (c) => {
  const episodeId = parseId(c.req.param('id'))
  const filmId = parseId(c.req.param('filmId'))
  if (!episodeId || !filmId) return badRequest(c, '编号无效')
  try {
    return success(c, setCurrentFilm(episodeId, filmId))
  } catch (error) {
    return handleFilmError(c, error)
  }
})

app.delete('/films/:filmId', (c) => {
  const filmId = parseId(c.req.param('filmId'))
  if (!filmId) return badRequest(c, '成片编号无效')
  try {
    return success(c, deleteFilm(filmId))
  } catch (error) {
    return handleFilmError(c, error)
  }
})

app.patch('/films/:filmId', async (c) => {
  const filmId = parseId(c.req.param('filmId'))
  if (!filmId) return badRequest(c, '成片编号无效')
  const raw = await c.req.json().catch(() => ({}))
  try {
    return success(c, renameFilm(filmId, (raw as Record<string, unknown>).title))
  } catch (error) {
    return handleFilmError(c, error)
  }
})

app.post('/episodes/:id/exports/:exportId/project-film', (c) => {
  const episodeId = parseId(c.req.param('id'))
  const exportId = parseId(c.req.param('exportId'))
  if (!episodeId || !exportId) return badRequest(c, '编号无效')
  try {
    const filmId = projectFilmFromExport(exportId)
    return success(c, { film_id: filmId })
  } catch (error) {
    return handleFilmError(c, error)
  }
})

export default app
```

在 `backend/src/index.ts` 增加：

```ts
import films from './routes/films.js'
// 在 app.route('/api/v1', api) 之前
api.route('/', films)
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/film-routes.test.ts
cd backend && npm run typecheck
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 4: 导出完成投影、当前导出兼容与配音链路收口

**Files:**
- Modify: `backend/src/services/export-service.ts`
- Modify: `backend/src/services/dubbing.ts`
- Modify: `backend/src/routes/dubbing.ts`
- Create: `backend/tests/export-projection.test.ts`

**Interfaces:**
- Consumes: `projectFilmFromExport`、`setCurrentFilm`（Task 2）。
- Produces: `executeExport` 成功后自动投影；`setCurrentExport` 通过成片指针；`deleteExport` 不再直接写 `episodes.video_url`；`runDubbing` 不再直接写 `episodes.video_url/duration`。

- [ ] **Step 1: 写失败测试**

`backend/tests/export-projection.test.ts` 用真实 1 秒样片跑一次视频导出，断言：

```ts
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-export-projection-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { startEpisodeExport, getExport } = await import('../src/services/export-service.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({ title: '导出投影', aspectRatio: '16:9', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '第一集', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoUrl = `static/projects/${drama.id}/videos/source.mp4`
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=1',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  path.join(root, videoUrl),
], { stdio: 'ignore' })
const merge = db.insert(schema.videoMerges).values({
  episodeId: episode.id, dramaId: drama.id, provider: 'ffmpeg', model: 'm',
  status: 'completed', kind: 'concat', origin: 'concat', mergedUrl: videoUrl,
  duration: 1, title: '拼接源', createdAt: ts,
}).returning().get()
db.update(schema.episodes).set({ currentFilmId: merge.id, videoUrl }).where(eq(schema.episodes.id, episode.id)).run()

after(() => fs.rmSync(root, { recursive: true, force: true }))

async function waitExport(id: number) {
  for (let i = 0; i < 200; i += 1) {
    const record = getExport(id)
    if (record && ['completed', 'failed', 'cancelled'].includes(String(record.status))) return record
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('导出超时')
}

test('视频导出成功后投影成 mix 成片并回写 film_id', async () => {
  const { record } = await startEpisodeExport(episode.id, {
    kind: 'video', preset: 'horizontal-hd', subtitleMode: 'none', setCurrent: false,
  })
  const done = await waitExport(record.id)
  assert.equal(done.status, 'completed', done.error || '')
  assert.ok(done.filmId, '导出记录缺少 film_id')
  const film = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, done.filmId!)).get()!
  assert.equal(film.kind, 'mix')
  assert.equal(film.origin, 'export')
  assert.equal(film.exportId, done.id)
  assert.equal(film.sourceMergeId, merge.id)
})
```

> 该测试沿用 `export-service.test.ts` 的真实渲染方式；若导出预设不同，以 `backend/src/services/export-presets.ts` 中实际 key 为准。测试必须设置 `setCurrent: false`，避免抢占当前成片。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/export-projection.test.ts
```

预期：`done.filmId` 为空。

- [ ] **Step 3: 实现投影与指针收口**

`export-service.ts`：

1. 在文件顶部导入：

```ts
import { FilmError, projectFilmFromExport, setCurrentFilm } from './film-hub.js'
```

2. `executeExport` 完成记录后（`status: 'completed'` 更新之后）插入：

```ts
    // 只有视频导出投影为成片；音频/分轨不进入成片中心
    if (row.kind === 'video') {
      try {
        const filmId = projectFilmFromExport(recordId)
        const film = db.select().from(schema.videoMerges)
          .where(eq(schema.videoMerges.id, filmId)).get()
        // 投影函数已按 params.setCurrent 处理；这里只记录失败不改变导出成功状态
        void film
      } catch (error) {
        const message = error instanceof FilmError ? error.message : '成片入库失败，可重试'
        db.update(schema.episodeExports)
          .set({ error: message })
          .where(eq(schema.episodeExports.id, recordId))
          .run()
      }
    }
```

3. 删除原有 `if (result.subtitleUrl && context.setCurrent) { ... episodes.subtitleUrl ... }` 整段；字幕镜像由 `projectFilmFromExport` → `setCurrentFilm` 统一处理。

4. `setCurrentExport` 改为：

```ts
export async function setCurrentExport(id: number, options: { episodeId?: number } = {}): Promise<ExportRecord> {
  const record = requireExport(id)
  if (options.episodeId && options.episodeId !== record.episodeId) {
    throw new ExportError('导出记录不属于该集', 400)
  }
  if (record.kind !== 'video') throw new ExportError('只有视频导出可以设为当前成片', 400)
  if (record.status !== 'completed' || !record.outputUrl) {
    throw new ExportError('导出尚未完成，不能设为当前成片', 409)
  }
  let filmId = record.filmId
  if (!filmId) filmId = projectFilmFromExport(record.id)
  try {
    setCurrentFilm(record.episodeId, filmId)
  } catch (error) {
    if (error instanceof FilmError) throw new ExportError(error.message, error.status)
    throw error
  }
  return getExport(id)!
}
```

5. `deleteExport` 中删除回退写 `episodes.videoUrl` 的分支；若删除的是当前导出，先清 `episode_exports.is_current`，若其成片是当前成片则拒绝或提示先切换。实现：

```ts
  const record = requireExport(id)
  const film = record.filmId
    ? db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, record.filmId)).get()
    : undefined
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, record.episodeId)).get()
  if (film && episode?.currentFilmId === film.id) {
    throw new ExportError('这是当前成片的导出记录，请先把其他成片设为当前', 409)
  }
  db.update(schema.episodeExports)
    .set({ deletedAt: now(), isCurrent: false })
    .where(eq(schema.episodeExports.id, id))
    .run()
  if (film && !film.deletedAt) {
    db.update(schema.videoMerges).set({ deletedAt: now() }).where(eq(schema.videoMerges.id, film.id)).run()
  }
  return getExport(id)!
```

`dubbing.ts` 的 `runDubbing`：删除完成后的 `updateEpisode({ videoUrl: outputUrl, duration })` 中 `videoUrl` 与 `duration` 两个字段，只保留 `dubStatus/dubProgress/dubNote`。导出投影会按 `setCurrent: true` 更新指针。

`routes/dubbing.ts` 的 `POST /episodes/:id/video-version`：

```ts
    const filmId = Number(body.merge_id ?? body.mergeId)
    if (!Number.isSafeInteger(filmId) || filmId <= 0) return badRequest(c, '成片编号无效')
    const result = setCurrentFilm(episodeId, filmId)
    return success(c, result)
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/export-projection.test.ts
cd backend && npx tsx --test tests/dubbing-merge-reuse.test.ts tests/export-service.test.ts
cd backend && npm run typecheck
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 5: 拼接成片写入方统一（ffmpeg-merge / motion-post / generation）

**Files:**
- Modify: `backend/src/services/ffmpeg-merge.ts`
- Modify: `backend/src/services/motion-post.ts`
- Modify: `backend/src/services/generation.ts`
- Create: `backend/tests/concat-film-writers.test.mjs`

**Interfaces:**
- Consumes: `bootstrapCurrentFilmIfEmpty`、`setCurrentFilm`。
- Produces: 所有拼接成片新行 `kind='concat'`、`origin='concat'`；不再直接写 `episodes.video_url`。

- [ ] **Step 1: 写结构测试**

`backend/tests/concat-film-writers.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const merge = fs.readFileSync(new URL('../src/services/ffmpeg-merge.ts', import.meta.url), 'utf8')
const motion = fs.readFileSync(new URL('../src/services/motion-post.ts', import.meta.url), 'utf8')
const generation = fs.readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')

test('拼接写手都显式写 kind=concat 与 origin=concat', () => {
  for (const [name, source] of [['ffmpeg-merge', merge], ['motion-post', motion], ['generation', generation]]) {
    assert.match(source, /kind:\s*'concat'/, `${name} 缺少 kind:'concat'`)
    assert.match(source, /origin:\s*'concat'/, `${name} 缺少 origin:'concat'`)
  }
})

test('拼接完成不再直接写 episodes.video_url', () => {
  assert.doesNotMatch(merge, /update\(schema\.episodes\)[\s\S]{0,120}videoUrl/)
  assert.doesNotMatch(motion, /update\(schema\.episodes\)[\s\S]{0,120}videoUrl/)
})

test('motion-post 显式设为当前调用 setCurrentFilm', () => {
  assert.match(motion, /setCurrentFilm/)
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && node --test tests/concat-film-writers.test.mjs
```

- [ ] **Step 3: 修改三个写入方**

`ffmpeg-merge.ts` 插入行（约 112–129）增加：

```ts
      kind: 'concat',
      origin: 'concat',
```

完成回调（约 246–253）把：

```ts
    db.update(schema.episodes).set({ videoUrl: merge.mergedUrl, ... }).where(...).run()
```

替换为：

```ts
    bootstrapCurrentFilmIfEmpty(episodeId, mergeId)
```

顶部导入：

```ts
import { bootstrapCurrentFilmIfEmpty } from './film-hub.js'
```

`motion-post.ts` 插入行（约 317–342）：

```ts
      kind: 'concat',
      origin: 'concat',
```

把 `options.setAsEpisodeVideo` 分支里的 `update(schema.episodes).set({ videoUrl, subtitleUrl, duration })` 替换为：

```ts
      setCurrentFilm(episodeId, mergeId)
```

顶部导入 `setCurrentFilm`。

`generation.ts` 时间线合片 upsert（约 738–768）的 `values` 与 `set` 都增加：

```ts
      kind: 'concat',
      origin: 'concat',
```

事务提交后若新建行：

```ts
    bootstrapCurrentFilmIfEmpty(episodeId, mergeId)
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && node --test tests/concat-film-writers.test.mjs
cd backend && npx tsx --test tests/merge-bridge.test.ts tests/comfyui-timeline.test.ts
cd backend && npm run typecheck
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 6: 前端成片 API、通用右键菜单、成片选择器与拼接页接入

**Files:**
- Modify: `frontend/app/composables/useApi.ts`
- Create: `frontend/app/components/ContextMenu.vue`
- Create: `frontend/app/components/FilmPicker.vue`
- Modify: `frontend/app/views/drama/episode.vue`
- Create: `frontend/tests/film-ui-structure.test.mjs`
- Modify: `frontend/app/locales/{zh,en,ja,ko}.json`

**Interfaces:**
- Produces `filmAPI`：
  ```ts
  filmAPI.list(episodeId, limit?)
  filmAPI.get(filmId)
  filmAPI.setCurrent(episodeId, filmId)
  filmAPI.remove(filmId)
  filmAPI.rename(filmId, title)
  filmAPI.projectExport(episodeId, exportId)
  ```
- Produces `ContextMenu` props：`items: MenuItem[]`、`x`、`y`；`MenuItem`：`{ key, label, icon?, shortcut?, danger?, disabled?, reason?, separator?, action }`。
- Produces `FilmPicker` props：`show: boolean`、`episodeId`、`modelValue`、`mode: 'mix' | 'edit' | 'list'`；emits `update:show`、`update:modelValue`、`select`、`set-current`、`open-mix`、`open-edit`、`rename`、`delete`。FilmPicker 用 `NModal :show` 承载，调用方以 `v-model:show` 控制开合；关闭时必须 emit `update:show(false)`。

- [ ] **Step 1: 写结构测试**

`frontend/tests/film-ui-structure.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const api = fs.readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const context = fs.readFileSync(new URL('../app/components/ContextMenu.vue', import.meta.url), 'utf8')
const picker = fs.readFileSync(new URL('../app/components/FilmPicker.vue', import.meta.url), 'utf8')
const episode = fs.readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const zh = JSON.parse(fs.readFileSync(new URL('../app/locales/zh.json', import.meta.url), 'utf8'))

test('useApi 暴露 filmAPI 与成片动作', () => {
  assert.match(api, /export const filmAPI/)
  for (const key of ['list', 'get', 'setCurrent', 'remove', 'rename', 'projectExport']) {
    assert.match(api, new RegExp(`${key}\\s*\\(`), `filmAPI 缺少 ${key}`)
  }
})

test('ContextMenu 支持键盘、Teleport 与危险项', () => {
  assert.match(context, /<Teleport to="body">/)
  assert.match(context, /ArrowDown/)
  assert.match(context, /Escape/)
  assert.match(context, /danger/)
})

test('FilmPicker 展示类型、当前、已剪辑与右键菜单', () => {
  for (const text of ['拼接成片', '混音成片', '剪辑成片', '当前', '已剪辑']) {
    assert.match(picker, new RegExp(text))
  }
})

test('拼接导出页接入成片动作', () => {
  assert.match(episode, /filmAPI/)
  for (const text of ['设为当前', '在混音中打开', '在剪辑中打开']) {
    assert.match(episode, new RegExp(text))
  }
})

test('中文文案包含成片中心 key', () => {
  for (const key of ['films.kind.concat', 'films.kind.mix', 'films.kind.edit', 'films.current', 'films.edited']) {
    assert.ok(key.split('.').reduce((obj, part) => obj?.[part], zh) !== undefined, `缺少 ${key}`)
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test frontend/tests/film-ui-structure.test.mjs
```

- [ ] **Step 3: 实现前端基础设施**

`useApi.ts` 增加：

```ts
export const filmAPI = {
  list: (episodeId: number, limit = 50) => req(`/episodes/${episodeId}/films?limit=${limit}`),
  get: (filmId: number) => req(`/films/${filmId}`),
  setCurrent: (episodeId: number, filmId: number) =>
    req(`/episodes/${episodeId}/films/${filmId}/current`, { method: 'POST' }),
  remove: (filmId: number) => req(`/films/${filmId}`, { method: 'DELETE' }),
  rename: (filmId: number, title: string) =>
    req(`/films/${filmId}`, { method: 'PATCH', body: { title } }),
  projectExport: (episodeId: number, exportId: number) =>
    req(`/episodes/${episodeId}/exports/${exportId}/project-film`, { method: 'POST' }),
}
```

`ContextMenu.vue` 核心结构：

```vue
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface MenuItem {
  key: string
  label: string
  icon?: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  reason?: string
  separator?: boolean
  action?: () => void | Promise<void>
}

const props = defineProps<{ show: boolean; x: number; y: number; items: MenuItem[] }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()
const root = ref<HTMLElement | null>(null)
const active = ref(0)

function close() { emit('update:show', false) }
function run(item: MenuItem) {
  if (item.disabled || !item.action) return
  close()
  void item.action()
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') return close()
  if (event.key === 'ArrowDown') { event.preventDefault(); active.value = (active.value + 1) % props.items.length }
  if (event.key === 'ArrowUp') { event.preventDefault(); active.value = (active.value - 1 + props.items.length) % props.items.length }
  if (event.key === 'Enter') { event.preventDefault(); const item = props.items[active.value]; if (item) run(item) }
}
function onPointerDown(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) close()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('scroll', close, true)
  window.addEventListener('resize', close)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('scroll', close, true)
  window.removeEventListener('resize', close)
})
watch(() => props.show, async (show) => {
  if (show) { active.value = 0; await nextTick() }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="show" ref="root" class="context-menu" :style="{ left: `${x}px`, top: `${y}px` }" role="menu">
      <template v-for="(item, index) in items" :key="item.key">
        <div v-if="item.separator" class="separator" />
        <button
          v-else
          type="button"
          class="item"
          :class="{ danger: item.danger, active: index === active, disabled: item.disabled }"
          :title="item.disabled ? item.reason : ''"
          :disabled="item.disabled"
          @mouseenter="active = index"
          @click="run(item)"
        >
          <span>{{ item.label }}</span>
          <span v-if="item.shortcut" class="shortcut">{{ item.shortcut }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>
```

`FilmPicker.vue`：用 `NModal :show="props.show"` 承载、`@update:show="$emit('update:show', $event)"`。卡片展示标题、类型徽标、时长、创建时间、`当前`/`已剪辑`；右键调用 `ContextMenu`。选择后 `emit('select', film)` 并 `emit('update:show', false)`；混音模式按钮文案 `t('films.changeSource')`（更换源成片），剪辑模式 `t('films.openInEdit')`（在剪辑中打开）。时长格式化用组件内局部 `formatDuration(ms)`（秒→`1分23秒` 风格）——仓库中没有共享的时长工具函数（ExportStage/TakeInspector 均为局部实现），不要 import 不存在的工具。

`episode.vue` 的拼接导出条（约 1050 行）增加三个动作：

```vue
<n-button size="tiny" @click="setFilmCurrent(m.id)">设为当前</n-button>
<n-button size="tiny" @click="openFilmInMix(m.id)">在混音中打开</n-button>
<n-button size="tiny" @click="openFilmInEdit(m.id)">在剪辑中打开</n-button>
```

脚本：

```ts
async function setFilmCurrent(filmId: number) {
  await filmAPI.setCurrent(epId.value!, filmId)
  await loadExportMerges()
  message.success('已设为当前成片')
}
async function openFilmInMix(filmId: number) {
  await filmAPI.setCurrent(epId.value!, filmId)
  router.push({ path: route.path, query: { ...route.query, panel: 'dubbing', step: '3', film: String(filmId) } })
}
async function openFilmInEdit(filmId: number) {
  router.push(`/drama/${dramaId.value}/episode/${episode.value?.episode_number}/edit?film=${filmId}`)
}
```

四语言新增：

```json
"films": {
  "kind": { "concat": "拼接成片", "mix": "混音成片", "edit": "剪辑成片", "import": "导入成片" },
  "current": "当前",
  "edited": "已剪辑",
  "setCurrent": "设为当前",
  "openMix": "在混音中打开",
  "openEdit": "在剪辑中打开",
  "rename": "重命名",
  "delete": "删除",
  "deleteConfirm": "删除后不可恢复，关联的剪辑工程也会被关闭。确定删除吗？",
  "empty": "本集还没有成片，先去拼接导出一版吧"
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test frontend/tests/film-ui-structure.test.mjs
cd frontend && npm run build
```

> 前端 `build` 只作为 SFC 编译门禁，不做打包安装。

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

## Phase B：混音接入源成片

### Task 7: 混音源成片解析与源感知编译

**Files:**
- Create: `backend/src/services/mix-source.ts`
- Modify: `backend/src/services/mix-plan.ts`
- Create: `backend/tests/mix-source.test.ts`
- Modify: `backend/tests/mix-plan.test.ts`

**Interfaces:**
- Consumes: `video_merges`（Task 1 的 `origin/kind/source_merge_id`）、`episodes.mix_source_merge_id/current_film_id`。
- Produces:
  ```ts
  type MixSourceKind = 'concat' | 'mix' | 'edit' | 'import'
  interface MixPlanSource {
    filmId: number
    kind: MixSourceKind
    url: string
    durationMs: number
    hasAudio: boolean
    containsDialogue: boolean
    containsBgm: boolean
  }
  interface MixSourceWarning {
    code: 'MIX_SOURCE_NON_CONCAT' | 'MIX_SOURCE_NO_AUDIO' | 'MIX_SOURCE_FALLBACK'
    message: string
  }
  resolveMixSource(episodeId, requestedFilmId?): Promise<{ source: MixPlanSource; warnings: MixSourceWarning[] }>
  persistMixSource(episodeId, filmId): Promise<{ source: MixPlanSource; warnings: MixSourceWarning[] }>
  compileMixPlanDetailed(episodeId, dramaId, options?: { sourceFilmId?: number | null }): Promise<{ plan: MixPlan; source: MixPlanSource; warnings: MixSourceWarning[] }>
  compileMixPlan(episodeId, dramaId, options?: { sourceFilmId?: number | null }): Promise<MixPlan>
  MixPlan.source?: MixPlanSource
  ```

- [ ] **Step 1: 写失败测试**

`backend/tests/mix-source.test.ts`：

```ts
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-mix-source-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { compileMixPlan, compileMixPlanDetailed } = await import('../src/services/mix-plan.ts')
const { resolveMixSource, MixSourceError } = await import('../src/services/mix-source.ts')

const ts = '2026-11-06T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '混音源', aspectRatio: '16:9', createdAt: ts, updatedAt: ts }).run()
const videoDir = path.join(root, 'static', 'projects', '1', 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const withAudio = path.join(videoDir, 'with-audio.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', withAudio,
], { stdio: 'ignore' })
const withoutAudio = path.join(videoDir, 'without-audio.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', withoutAudio,
], { stdio: 'ignore' })
const tonePath = path.join(root, 'static', 'projects', '1', 'bgm.wav')
execFileSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', tonePath], { stdio: 'ignore' })
const withAudioUrl = 'static/projects/1/videos/with-audio.mp4'
const withoutAudioUrl = 'static/projects/1/videos/without-audio.mp4'

function episode(title: string) {
  return db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: Math.floor(Math.random() * 100000), title,
    bgmUrl: 'static/projects/1/bgm.wav', createdAt: ts, updatedAt: ts,
  }).returning().get()
}

function film(episodeId: number, kind: string, url = withAudioUrl, id?: number) {
  return db.insert(schema.videoMerges).values({
    ...(id ? { id } : {}), episodeId, dramaId: 1, title: `${kind} 成片`,
    provider: 'ffmpeg', model: 'test', status: 'completed', kind, origin: 'legacy',
    mergedUrl: url, duration: 2, createdAt: ts, completedAt: ts,
  }).returning().get()
}

after(() => fs.rmSync(root, { recursive: true, force: true }))

test('持久化选择优先于当前成片', async () => {
  const ep = episode('持久化优先')
  const older = film(ep.id, 'concat', withAudioUrl)
  const newer = film(ep.id, 'concat', withAudioUrl)
  db.update(schema.episodes).set({ mixSourceMergeId: older.id, currentFilmId: newer.id })
    .where(eq(schema.episodes.id, ep.id)).run()
  const { source, warnings } = await resolveMixSource(ep.id)
  assert.equal(source.filmId, older.id)
  assert.equal(warnings.length, 0)
})

test('没有持久化选择时优先当前 concat 成片', async () => {
  const ep = episode('当前优先')
  const older = film(ep.id, 'concat')
  const newer = film(ep.id, 'concat')
  db.update(schema.episodes).set({ currentFilmId: newer.id }).where(eq(schema.episodes.id, ep.id)).run()
  const { source } = await resolveMixSource(ep.id)
  assert.equal(source.filmId, newer.id)
  assert.notEqual(source.filmId, older.id)
})

test('只有混音成片时仍可混音，虚拟对白与配乐默认静音', async () => {
  const ep = episode('只有混音')
  const mixFilm = film(ep.id, 'mix')
  db.update(schema.episodes).set({ currentFilmId: mixFilm.id }).where(eq(schema.episodes.id, ep.id)).run()
  const { source, warnings } = await resolveMixSource(ep.id)
  assert.equal(source.kind, 'mix')
  assert.equal(source.containsDialogue, true)
  assert.equal(warnings.some((item) => item.code === 'MIX_SOURCE_NON_CONCAT'), true)

  const { plan } = await compileMixPlanDetailed(ep.id, 1)
  assert.equal(plan.source?.filmId, mixFilm.id)
  assert.equal(plan.tracks.find((track) => track.role === 'voice')!.muted, true)
  assert.equal(plan.tracks.find((track) => track.role === 'bgm')!.muted, true)
  assert.equal(plan.tracks.find((track) => track.role === 'original')!.muted, false)
  assert.equal(plan.durationMs, 2000)
})

test('没有任何成片时返回 MIX_SOURCE_MISSING', async () => {
  const ep = episode('没有成片')
  await assert.rejects(
    () => compileMixPlan(ep.id, 1),
    (error: any) => error instanceof MixSourceError
      && error.code === 'MIX_SOURCE_MISSING'
      && error.status === 400,
  )
})

test('无音轨成片不生成原声床并给出警告', async () => {
  const ep = episode('无声成片')
  const silent = film(ep.id, 'concat', withoutAudioUrl)
  db.update(schema.episodes).set({ currentFilmId: silent.id }).where(eq(schema.episodes.id, ep.id)).run()
  const { source, warnings } = await resolveMixSource(ep.id)
  assert.equal(source.hasAudio, false)
  assert.equal(warnings.some((item) => item.code === 'MIX_SOURCE_NO_AUDIO'), true)

  const { plan } = await compileMixPlanDetailed(ep.id, 1)
  assert.equal(plan.tracks.some((track) => track.role === 'original'), false)
  assert.equal(plan.durationMs, 2000)
})

test('显式选择其他集的成片返回不可读/不存在错误', async () => {
  const ep = episode('显式选择')
  const other = episode('其他集')
  const otherFilm = film(other.id, 'concat')
  await assert.rejects(
    () => resolveMixSource(ep.id, otherFilm.id),
    (error: any) => error instanceof MixSourceError && error.status === 404,
  )
})

test('计划时长取源成片、时间线与片段的最大值', async () => {
  const ep = episode('时长')
  const sourceFilm = film(ep.id, 'concat')
  db.update(schema.episodes).set({ currentFilmId: sourceFilm.id }).where(eq(schema.episodes.id, ep.id)).run()
  const track = db.insert(schema.episodeAudioTracks).values({
    episodeId: ep.id, dramaId: 1, kind: 'sfx', role: 'sfx', name: '长音效',
    volume: 1, pan: 0, muted: false, solo: false, ducking: false, loop: false,
    locked: false, hidden: false, color: '#0ea5e9', height: 72, sortOrder: 1,
    createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.episodeAudioClips).values({
    trackId: track.id, episodeId: ep.id, startMs: 0, endMs: 5000,
    sourceStartMs: 0, gainDb: 0, pan: 0, fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear',
    sourceUrl: 'static/projects/1/bgm.wav', audioUrl: 'static/projects/1/bgm.wav',
    status: 'ready', createdAt: ts, updatedAt: ts,
  }).run()
  const plan = await compileMixPlan(ep.id, 1)
  assert.equal(plan.durationMs, 5000)
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/mix-source.test.ts
```

预期：`Cannot find module '../src/services/mix-source.ts'` 或 `compileMixPlanDetailed` 未导出。

- [ ] **Step 3: 实现 `mix-source.ts`**

```ts
import fs from 'fs'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { now } from '../utils/response.js'
import { hasAudioStream, probeDurationMs } from './audio-mix.js'

export type MixSourceKind = 'concat' | 'mix' | 'edit' | 'import'

export interface MixPlanSource {
  filmId: number
  kind: MixSourceKind
  url: string
  durationMs: number
  hasAudio: boolean
  containsDialogue: boolean
  containsBgm: boolean
}

export type MixSourceWarningCode = 'MIX_SOURCE_NON_CONCAT' | 'MIX_SOURCE_NO_AUDIO' | 'MIX_SOURCE_FALLBACK'

export interface MixSourceWarning {
  code: MixSourceWarningCode
  message: string
}

export interface ResolvedMixSource {
  source: MixPlanSource
  warnings: MixSourceWarning[]
}

export class MixSourceError extends Error {
  status: 400 | 404 | 422
  code: 'MIX_SOURCE_MISSING' | 'MIX_SOURCE_UNREADABLE' | 'EPISODE_NOT_FOUND'

  constructor(status: 400 | 404 | 422, code: MixSourceError['code'], message: string) {
    super(message)
    this.name = 'MixSourceError'
    this.status = status
    this.code = code
  }
}

const SOURCE_KINDS: MixSourceKind[] = ['concat', 'mix', 'edit', 'import']

export function normalizeMixSourceKind(raw: unknown): MixSourceKind {
  const value = String(raw ?? '').trim()
  return SOURCE_KINDS.includes(value as MixSourceKind) ? value as MixSourceKind : 'concat'
}

type FilmRow = typeof schema.videoMerges.$inferSelect

function usableFilms(episodeId: number): FilmRow[] {
  return db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .all()
    .filter((row) => row.status === 'completed' && Boolean(row.mergedUrl) && !row.deletedAt)
    .sort((a, b) => (b.id || 0) - (a.id || 0))
}

async function readSource(row: FilmRow): Promise<MixPlanSource> {
  const url = String(row.mergedUrl || '').trim()
  if (!url || row.status !== 'completed' || row.deletedAt) {
    throw new MixSourceError(422, 'MIX_SOURCE_UNREADABLE', '所选成片文件无法读取')
  }
  let absolute: string
  try {
    absolute = getAbsolutePath(url)
  } catch {
    throw new MixSourceError(422, 'MIX_SOURCE_UNREADABLE', '所选成片文件无法读取')
  }
  if (!fs.existsSync(absolute)) {
    throw new MixSourceError(422, 'MIX_SOURCE_UNREADABLE', '所选成片文件无法读取')
  }
  const probed = await probeDurationMs(absolute).catch(() => 0)
  const fallback = Math.max(0, Math.round((row.duration || 0) * 1000))
  const durationMs = Math.round(probed > 0 ? probed : fallback)
  if (durationMs <= 0) {
    throw new MixSourceError(422, 'MIX_SOURCE_UNREADABLE', '所选成片文件无法读取')
  }
  const hasAudio = await hasAudioStream(absolute).catch(() => false)
  const kind = normalizeMixSourceKind(row.kind)
  return {
    filmId: row.id,
    kind,
    url,
    durationMs,
    hasAudio,
    containsDialogue: kind !== 'concat',
    containsBgm: kind !== 'concat',
  }
}

export async function resolveMixSource(
  episodeId: number,
  requestedFilmId?: number | null,
): Promise<ResolvedMixSource> {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new MixSourceError(404, 'EPISODE_NOT_FOUND', '集不存在')
  const films = usableFilms(episodeId)
  const warnings: MixSourceWarning[] = []

  let chosen: FilmRow | undefined
  if (requestedFilmId != null) {
    chosen = films.find((row) => row.id === requestedFilmId)
    if (!chosen) {
      const exists = db.select().from(schema.videoMerges)
        .where(eq(schema.videoMerges.id, requestedFilmId)).get()
      if (exists && exists.episodeId === episodeId) {
        throw new MixSourceError(422, 'MIX_SOURCE_UNREADABLE', '所选成片文件无法读取')
      }
      throw new MixSourceError(404, 'MIX_SOURCE_MISSING', '所选成片不存在')
    }
  } else if (episode.mixSourceMergeId) {
    chosen = films.find((row) => row.id === episode.mixSourceMergeId)
    if (!chosen) {
      warnings.push({ code: 'MIX_SOURCE_FALLBACK', message: '上次选择的源成片已不可用，已自动改用其他成片' })
    }
  }
  if (!chosen && episode.currentFilmId) {
    chosen = films.find((row) => row.id === episode.currentFilmId && normalizeMixSourceKind(row.kind) === 'concat')
  }
  if (!chosen) chosen = films.find((row) => normalizeMixSourceKind(row.kind) === 'concat')
  if (!chosen) chosen = films[0]
  if (!chosen) {
    throw new MixSourceError(400, 'MIX_SOURCE_MISSING', '请先在拼接导出生成一部成片')
  }

  const source = await readSource(chosen)
  if (source.kind !== 'concat') {
    warnings.push({
      code: 'MIX_SOURCE_NON_CONCAT',
      message: '这部成片已经包含配音或配乐。为避免人声重复，对白和配乐轨已默认关闭。',
    })
  }
  if (!source.hasAudio) {
    warnings.push({
      code: 'MIX_SOURCE_NO_AUDIO',
      message: '这部成片没有声音，你仍可以添加配音或背景声。',
    })
  }
  return { source, warnings }
}

export async function persistMixSource(
  episodeId: number,
  filmId: number,
): Promise<ResolvedMixSource> {
  const resolved = await resolveMixSource(episodeId, filmId)
  db.update(schema.episodes)
    .set({ mixSourceMergeId: resolved.source.filmId, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
    .run()
  return resolved
}
```

- [ ] **Step 4: 让 `compileMixPlan` 感知源成片**

`backend/src/services/mix-plan.ts`：

1. 顶部导入：

```ts
import {
  resolveMixSource,
  type MixPlanSource,
  type MixSourceWarning,
} from './mix-source.js'
```

2. `MixPlan` 增加字段：

```ts
export interface MixPlan {
  version: 1
  episodeId: number
  durationMs: number
  sampleRate: number
  buses: MixBus[]
  tracks: MixTrack[]
  master: { lufs: number; truePeak: number; limiter: string }
  source?: MixPlanSource
}
```

3. 删除 `latestMergeBed` 整个函数（约 342–362 行），保留 `readableDurationMs` 供 BGM 使用。

4. 将 `compileMixPlan` 替换为详细版 + 包装：

```ts
export async function compileMixPlanDetailed(
  episodeId: number,
  dramaId: number,
  options: { sourceFilmId?: number | null } = {},
): Promise<{ plan: MixPlan; source: MixPlanSource; warnings: MixSourceWarning[] }> {
  const episode = requireEpisode(episodeId)
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  const resolved = await resolveMixSource(episodeId, options.sourceFilmId)
  const source = resolved.source
  const busRows = ensureDefaultBuses(episodeId)
  const buses: MixBus[] = busRows.map((row) => ({
    id: row.id,
    key: busKeyOf(row.key)!,
    name: row.name,
    volume: row.volume ?? 1,
    muted: Boolean(row.muted),
    solo: Boolean(row.solo),
    effectiveMuted: false,
    ducking: Boolean(row.ducking),
    duckRatio: row.duckRatio ?? 6,
    duckAttackMs: row.duckAttackMs ?? 20,
    duckReleaseMs: row.duckReleaseMs ?? 250,
    lufsTarget: row.lufsTarget ?? null,
    limiterCeiling: row.limiterCeiling ?? null,
  }))
  const busByKey = new Map(buses.map((bus) => [bus.key, bus]))

  const trackRows = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episodeId))
    .orderBy(asc(schema.episodeAudioTracks.sortOrder), asc(schema.episodeAudioTracks.id))
    .all()
  const clipRows = db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.episodeId, episodeId))
    .orderBy(asc(schema.episodeAudioClips.startMs), asc(schema.episodeAudioClips.id))
    .all()

  const { previewTimeline: readTimeline } = await import('./dubbing.js')
  const timeline = await readTimeline(episodeId, dramaId)

  const tracks: MixTrack[] = trackRows.map((row) => {
    const role = resolveTrackRole(row)
    const explicitBus = row.busId
      ? buses.find((bus) => bus.id === row.busId)?.key
      : undefined
    return {
      id: row.id,
      role,
      name: row.name,
      busId: explicitBus ?? ROLE_BUS[role] ?? 'sfx',
      virtual: false,
      volume: row.volume ?? 1,
      pan: row.pan ?? 0,
      muted: Boolean(row.muted),
      solo: Boolean(row.solo),
      effectiveMuted: false,
      ducking: Boolean(row.ducking),
      locked: Boolean(row.locked),
      hidden: Boolean(row.hidden),
      loop: Boolean(row.loop),
      color: row.color ?? null,
      height: row.height ?? 72,
      sortOrder: row.sortOrder ?? 0,
      origin: row.origin ?? null,
      stemAssetId: row.stemAssetId ?? null,
      clips: clipRows.filter((clip) => clip.trackId === row.id).map(toClip),
    }
  })

  const dbClipEnd = tracks.reduce(
    (max, track) => track.clips.reduce((inner, clip) => Math.max(inner, clip.endMs), max),
    0,
  )
  const hasOriginalUserTrack = tracks.some((track) => (
    track.origin !== 'soundscape'
    && (track.role === 'original' || track.role === 'ambience' || track.busId === 'original')
  ))
  const hasBgmUserTrack = tracks.some((track) => (
    (track.role === 'bgm' || track.busId === 'bgm')
    && (track.origin !== 'soundscape' || track.clips.length > 0)
  ))
  const silentEpisode = normalizeVideoAudioMode(episode.videoAudioMode) === 'silent'
  const bed = hasOriginalUserTrack || silentEpisode || !source.hasAudio
    ? null
    : { url: source.url, durationMs: source.durationMs }
  const targetDurationMs = Math.max(0, source.durationMs, timeline.totalDurationMs, dbClipEnd)
  const excludedCrowdLineIds = soundscapeCrowdLineIds(episodeId)
  const virtualTracks: MixTrack[] = [
    buildVirtualDialogueTrack(episodeId, timeline, excludedCrowdLineIds),
  ]
  if (bed) virtualTracks.push(buildVirtualBedTrack(bed))
  if (!hasBgmUserTrack) {
    const bgmTrack = await buildVirtualBgmTrack(episode, drama, targetDurationMs)
    if (bgmTrack) virtualTracks.push(bgmTrack)
  }
  // 非拼接成片已含配音/配乐：默认关闭虚拟对白与 BGM，用户显式覆盖才开启
  if (source.kind !== 'concat') {
    for (const track of virtualTracks) {
      if (track.role === 'voice' || track.role === 'bgm') track.muted = true
    }
  }
  applyVirtualOverrides(virtualTracks, readVirtualOverrides(episode.mixVirtualTracks))
  tracks.unshift(...virtualTracks)

  const soloActive = tracks.some((track) => track.solo)
    || buses.some((bus) => bus.key !== 'master' && bus.solo)
  const soloedBusKeys = new Set<string>()
  for (const track of tracks) {
    const bus = busByKey.get(track.busId)!
    if (!soloActive) {
      track.effectiveMuted = track.muted || bus.muted
      continue
    }
    if (track.solo) {
      track.effectiveMuted = false
      if (bus.key !== 'master') soloedBusKeys.add(bus.key)
      continue
    }
    track.effectiveMuted = bus.solo ? track.muted : true
  }
  for (const bus of buses) {
    bus.effectiveMuted = bus.key === 'master'
      ? bus.muted
      : soloActive ? !(bus.solo || soloedBusKeys.has(bus.key)) : bus.muted
  }

  const clipEnd = tracks.reduce(
    (max, track) => track.clips.reduce((inner, clip) => Math.max(inner, clip.endMs), max),
    0,
  )
  const durationMs = Math.max(0, source.durationMs, timeline.totalDurationMs, clipEnd)
  const master = busByKey.get('master')!

  return {
    plan: {
      version: 1,
      episodeId: episode.id,
      durationMs,
      sampleRate: 48000,
      buses,
      tracks,
      master: {
        lufs: master.lufsTarget ?? -16,
        truePeak: master.limiterCeiling ?? -1.5,
        limiter: 'alimiter',
      },
      source,
    },
    source,
    warnings: resolved.warnings,
  }
}

export async function compileMixPlan(
  episodeId: number,
  dramaId: number,
  options: { sourceFilmId?: number | null } = {},
): Promise<MixPlan> {
  return (await compileMixPlanDetailed(episodeId, dramaId, options)).plan
}
```

5. `createMixRevision` 插入 `sourceFilmId`：

```ts
      sourceFilmId: plan.source?.filmId ?? null,
```

6. `restoreMixRevision` 恢复源指针（在原有 `tx.update(schema.episodes).set({ mixRevisionId... })` 上追加）：

```ts
    tx.update(schema.episodes).set({
      mixRevisionId: revisionId,
      mixVirtualTracks: virtualOverridesJson,
      ...(row.sourceFilmId ? { mixSourceMergeId: row.sourceFilmId } : {}),
      updatedAt: now(),
    })
      .where(eq(schema.episodes.id, episodeId))
      .run()
```

- [ ] **Step 5: 调整既有测试的空集用例**

`backend/tests/mix-plan.test.ts` 的「空轨道也生成默认总线与虚拟对白轨」在创建 `emptyEpisode` 后补一部真实成片：

```ts
  db.insert(schema.videoMerges).values({
    episodeId: emptyEpisode.id, dramaId: 1, title: '空集成片', provider: 'ffmpeg', model: 'test',
    status: 'completed', kind: 'concat', origin: 'concat', mergedUrl: shotUrl, duration: 2,
    createdAt: ts, completedAt: ts,
  }).run()
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/mix-source.test.ts tests/mix-plan.test.ts
cd backend && npm run typecheck
```

- [ ] **Step 7: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 8: 混音源选择 API 与版本持久化

**Files:**
- Modify: `backend/src/routes/mix.ts`
- Create: `backend/tests/mix-source-routes.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `resolveMixSource/persistMixSource/compileMixPlanDetailed`。
- Produces：
  - `GET /api/v1/episodes/:id/mix?source_film_id=` → 计划 + `source_film` + `source_warnings`
  - `PUT /api/v1/episodes/:id/mix/source` body `{ film_id }` → 持久化并重新编译
  - 错误映射：`MixSourceError` → `{ code, message }`，状态码取 `error.status`
  - `POST /mix/revisions` 返回的版本带 `sourceFilmId`

- [ ] **Step 1: 写失败测试**

`backend/tests/mix-source-routes.test.ts`：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-mix-source-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/mix.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '混音路由', aspectRatio: '16:9', createdAt: ts, updatedAt: ts }).run()
const episode = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第一集', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', '1', 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const filmPath = path.join(videoDir, 'film.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=1',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', filmPath,
], { stdio: 'ignore' })

function insertFilm(kind: string, title: string) {
  return db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: 1, title, provider: 'ffmpeg', model: 'test',
    status: 'completed', kind, origin: 'legacy', mergedUrl: 'static/projects/1/videos/film.mp4',
    duration: 1, createdAt: ts, completedAt: ts,
  }).returning().get()
}
const concat = insertFilm('concat', '拼接一')
const mixFilm = insertFilm('mix', '混音一')

after(() => fs.rmSync(root, { recursive: true, force: true }))

async function json(response: Response): Promise<any> {
  return response.json()
}

test('GET /mix 返回源成片与警告', async () => {
  const response = await app.request(`/episodes/${episode.id}/mix`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.source_film.filmId, concat.id)
  assert.deepEqual(data.source_warnings, [])
  assert.equal(data.source.filmId, concat.id)
})

test('PUT /mix/source 持久化选择并重新编译', async () => {
  const response = await app.request(`/episodes/${episode.id}/mix/source`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ film_id: mixFilm.id }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.source_film.filmId, mixFilm.id)
  assert.equal(data.source_film.kind, 'mix')
  assert.equal(data.source_warnings.some((item: any) => item.code === 'MIX_SOURCE_NON_CONCAT'), true)
  const stored = db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).get()!
  assert.equal(stored.mixSourceMergeId, mixFilm.id)
})

test('GET ?source_film_id= 使用指定源且不写持久化', async () => {
  db.update(schema.episodes).set({ mixSourceMergeId: mixFilm.id })
    .where(eq(schema.episodes.id, episode.id)).run()
  const response = await app.request(`/episodes/${episode.id}/mix?source_film_id=${concat.id}`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.source_film.filmId, concat.id)
  const stored = db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).get()!
  assert.equal(stored.mixSourceMergeId, mixFilm.id)
})

test('源成片不可读时返回 422 与错误码', async () => {
  const broken = db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: 1, title: '坏源', provider: 'ffmpeg', model: 'test',
    status: 'completed', kind: 'concat', origin: 'legacy',
    mergedUrl: 'static/projects/1/videos/missing.mp4', duration: 1, createdAt: ts, completedAt: ts,
  }).returning().get()
  const response = await app.request(`/episodes/${episode.id}/mix/source`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ film_id: broken.id }),
  })
  assert.equal(response.status, 422)
  assert.equal((await json(response)).code, 'MIX_SOURCE_UNREADABLE')
})

test('保存混音版本记录 source_film_id', async () => {
  db.update(schema.episodes).set({ mixSourceMergeId: concat.id })
    .where(eq(schema.episodes.id, episode.id)).run()
  const response = await app.request(`/episodes/${episode.id}/mix/revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '源版本' }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.sourceFilmId, concat.id)
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/mix-source-routes.test.ts
```

预期：`/mix/source` 404，`source_film` 为空。

- [ ] **Step 3: 实现路由**

`backend/src/routes/mix.ts`：

1. 导入：

```ts
import {
  MixSourceError,
  persistMixSource,
} from '../services/mix-source.js'
```

2. `compileMixPlan` 导入改为同时导入详细版：

```ts
import {
  MixPlanError,
  compileMixPlan,
  compileMixPlanDetailed,
  ensureDefaultBuses,
  hashMixPlan,
  saveMixPlan,
  saveMixBuses,
  createMixRevision,
  listMixRevisions,
  restoreMixRevision,
  type MixPlanInputBus,
} from '../services/mix-plan.js'
```

3. `handleError` 增加：

```ts
  if (error instanceof MixSourceError) {
    return c.json({ code: error.code, message: error.message }, error.status)
  }
```

4. 用以下实现替换 `GET /episodes/:id/mix`：

```ts
function sourceQueryId(c: Context): number | null | undefined {
  const raw = c.req.query('source_film_id')
  if (raw === undefined || raw === '') return undefined
  return parseId(raw) ?? null
}

function planResponse(plan: any, warnings: any[]) {
  return { ...plan, source_film: plan.source ?? null, source_warnings: warnings }
}

app.get('/episodes/:id/mix', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  const sourceFilmId = sourceQueryId(c)
  if (sourceFilmId === null) return badRequest(c, '源成片编号无效')
  try {
    const { plan, warnings } = await compileMixPlanDetailed(episodeId, episode.dramaId, { sourceFilmId })
    return success(c, planResponse(plan, warnings))
  } catch (error: any) {
    return handleError(c, error, '读取混音计划失败')
  }
})

app.put('/episodes/:id/mix/source', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  const filmId = parseId(String(body.film_id ?? ''))
  if (!filmId) return badRequest(c, '缺少源成片')
  try {
    await persistMixSource(episodeId, filmId)
    const { plan, warnings } = await compileMixPlanDetailed(episodeId, episode.dramaId)
    return success(c, planResponse(plan, warnings))
  } catch (error: any) {
    return handleError(c, error, '切换源成片失败')
  }
})
```

5. `POST /mix/revisions` 服务已写入 `sourceFilmId`，路由无需改。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/mix-source-routes.test.ts tests/mix-source.test.ts
cd backend && npm run typecheck
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 9: 混音视频导出使用源成片并支持复制字幕

**Files:**
- Modify: `backend/src/services/export-presets.ts`
- Modify: `backend/src/services/export-service.ts`
- Create: `backend/tests/export-source-film.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `resolveMixSource`、Task 2 的 `projectFilmFromExport`。
- Produces：
  - `ExportSubtitleMode = 'soft' | 'burn' | 'none' | 'copy'`
  - `startEpisodeExport` 接受 `sourceFilmId/source_film_id`、`title`、`projectId/project_id`
  - 视频导出使用源成片画面与时长；`copy` 只复制源成片外挂字幕，不重新生成、不烧录
  - 导出记录写 `source_merge_id`；`paramsJson` 写 `sourceFilmId/title/subtitleUrl` 供投影使用

- [ ] **Step 1: 写失败测试**

`backend/tests/export-source-film.test.ts`：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const ffprobeBin: string = process.env.FFPROBE_BIN || require('ffprobe-static')?.path || 'ffprobe'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-export-source-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { startEpisodeExport, getExport } = await import('../src/services/export-service.ts')
const { getAbsolutePath } = await import('../src/utils/storage.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '源成片导出', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '第一集', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const sourcePath = path.join(videoDir, 'source.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=1.2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath,
], { stdio: 'ignore' })
const subtitlePath = path.join(videoDir, 'source.srt')
fs.writeFileSync(subtitlePath, '1\n00:00:00,000 --> 00:00:01,000\n源字幕\n')
const sourceFilm = db.insert(schema.videoMerges).values({
  episodeId: episode.id, dramaId: drama.id, title: '源拼接成片',
  provider: 'ffmpeg', model: 'test', status: 'completed', kind: 'concat', origin: 'concat',
  mergedUrl: `static/projects/${drama.id}/videos/source.mp4`, duration: 1,
  subtitleUrl: `static/projects/${drama.id}/videos/source.srt`,
  createdAt: ts, completedAt: ts,
}).returning().get()

after(() => fs.rmSync(root, { recursive: true, force: true }))

async function waitExport(id: number) {
  for (let i = 0; i < 300; i += 1) {
    const record = getExport(id)
    if (record && ['completed', 'failed', 'cancelled'].includes(String(record.status))) return record
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('导出超时')
}

function probe(file: string) {
  const result = spawnSync(ffprobeBin, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'json', file,
  ])
  return JSON.parse(result.stdout.toString()) as {
    format?: { duration?: string }
    streams?: { codec_type?: string }[]
  }
}

test('视频导出使用源成片并复制外挂字幕', async () => {
  const { record } = await startEpisodeExport(episode.id, {
    kind: 'video',
    preset: 'horizontal-hd',
    subtitleMode: 'copy',
    sourceFilmId: sourceFilm.id,
    title: '第一集 混音成片',
    setCurrent: false,
  })
  const done = await waitExport(record.id)
  assert.equal(done.status, 'completed', done.error || '')
  assert.equal(done.sourceMergeId, sourceFilm.id)

  const output = getAbsolutePath(done.outputUrl!)
  const media = probe(output)
  const duration = Number(media.format?.duration || 0)
  assert.ok(Math.abs(duration - 1.2) < 0.15, `导出时长应跟随源成片，实际 ${duration}`)
  assert.equal(media.streams?.some((stream) => stream.codec_type === 'subtitle'), false)

  assert.ok(done.filmId, '缺少投影成片')
  const film = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, done.filmId!)).get()!
  assert.equal(film.kind, 'mix')
  assert.equal(film.origin, 'export')
  assert.equal(film.sourceMergeId, sourceFilm.id)
  assert.equal(film.subtitleBurned, false)
  assert.ok(film.subtitleUrl, '复制模式应带外挂字幕')
  assert.ok(fs.existsSync(getAbsolutePath(film.subtitleUrl!)))
})

test('没有源成片时 copy 模式被拒绝', async () => {
  await assert.rejects(
    () => startEpisodeExport(episode.id, {
      kind: 'video', preset: 'horizontal-hd', subtitleMode: 'copy', setCurrent: false,
    }),
    (error: any) => error?.status === 400,
  )
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/export-source-film.test.ts
```

预期：`copy` 被归一化为 `soft` 或导出仍走合片；`sourceMergeId` 为空。

- [ ] **Step 3: 扩展字幕模式**

`backend/src/services/export-presets.ts`：

```ts
export type ExportSubtitleMode = 'soft' | 'burn' | 'none' | 'copy'
```

预设的 `subtitleModes` 不变，`copy` 仅在导出服务中按源成片放行。

- [ ] **Step 4: 导出服务接入源成片**

`backend/src/services/export-service.ts`：

1. 顶部导入：

```ts
import {
  MixSourceError,
  resolveMixSource,
  type MixPlanSource,
} from './mix-source.js'
```

2. `StartEpisodeExportInput` 增加：

```ts
  sourceFilmId?: number | null
  source_film_id?: number | null
  title?: string | null
  projectId?: number | null
  project_id?: number | null
```

3. `ExportParams` 增加：

```ts
  sourceFilmId?: number | null
  title?: string | null
  subtitleUrl?: string | null
```

4. `paramsJsonOf` 增加第 6 个参数 `extra`：

```ts
function paramsJsonOf(
  preset: ExportPreset,
  subtitleMode: ExportSubtitleMode,
  plan: MixPlan,
  setCurrent = false,
  subtitle: SubtitleRenderSettings | null = null,
  extra: { sourceFilmId?: number | null; title?: string | null; subtitleUrl?: string | null } = {},
): string {
  return JSON.stringify(canonicalize({
    preset: preset.key,
    subtitleMode,
    targetLufs: plan.master.lufs,
    truePeak: plan.master.truePeak,
    ...(setCurrent ? { setCurrent: true } : {}),
    ...(extra.sourceFilmId ? { sourceFilmId: extra.sourceFilmId } : {}),
    ...(extra.title ? { title: extra.title } : {}),
    ...(extra.subtitleUrl ? { subtitleUrl: extra.subtitleUrl } : {}),
    ...(preset.kind === 'video' && (subtitleMode === 'soft' || subtitleMode === 'burn') && subtitle
      ? {
          subtitleFontSize: subtitle.fontSize,
          subtitleMarginV: subtitle.marginV,
          narratorPrefix: subtitle.narratorPrefix,
        }
      : {}),
  }))
}
```

5. `fileNameFor` 支持标题覆盖：

```ts
function fileNameFor(
  episode: typeof schema.episodes.$inferSelect,
  preset: ExportPreset,
  title?: string | null,
): string {
  return buildExportFilename({
    episodeNumber: episode.episodeNumber || 1,
    title: String(title || '').trim() || episode.title || '未命名',
    preset,
    at: new Date(),
  })
}
```

6. `PipelineContext` 增加：

```ts
  source?: { film: MixPlanSource; subtitleUrl: string | null } | null
  title?: string | null
```

7. `startEpisodeExportLocked` 中，在 `resolveExportPreset` 之后、`compileMixPlan` 之前插入：

```ts
  const requestedSourceId = Number(input.sourceFilmId ?? input.source_film_id ?? 0) || null
  const sourceResolved = kind === 'video' && requestedSourceId
    ? await resolveMixSource(episodeId, requestedSourceId)
    : null
  const requestedSubtitle = String(input.subtitleMode ?? input.subtitle_mode ?? '').trim()
  const subtitleMode: ExportSubtitleMode = kind === 'video' && requestedSubtitle === 'copy'
    ? 'copy'
    : normalizeSubtitleMode(input.subtitleMode ?? input.subtitle_mode, preset)
  if (subtitleMode === 'copy' && !sourceResolved) {
    throw new ExportError('复制字幕需要先选择源成片', 400)
  }
```

8. 同函数内把 `compileMixPlan(episodeId, episode.dramaId)` 改为：

```ts
  const plan = await compileMixPlan(episodeId, episode.dramaId, {
    sourceFilmId: sourceResolved?.source.filmId ?? null,
  })
```

9. 字幕检查只对 `soft/burn` 生效：

```ts
  if (kind === 'video' && (subtitleMode === 'soft' || subtitleMode === 'burn')
    && dialogueClipsOf(plan).length === 0) {
    throw new ExportError('没有可生成字幕的台词，请先生成语音', 400)
  }
```

10. `subtitleSettings` 与 `paramsJson` 改为：

```ts
  const subtitleSettings = kind === 'video' && (subtitleMode === 'soft' || subtitleMode === 'burn')
    ? currentSubtitleSettings()
    : null
  const paramsJson = paramsJsonOf(preset, subtitleMode, plan, setCurrent, subtitleSettings, {
    sourceFilmId: sourceResolved?.source.filmId ?? null,
    title: input.title ?? null,
  })
```

11. 插入导出记录时增加：

```ts
    sourceMergeId: sourceResolved?.source.filmId ?? null,
    projectId: Number(input.projectId ?? input.project_id ?? 0) || null,
```

12. `executeExport` 中解析源并构建上下文：

```ts
  const sourceFilmId = Number(params.sourceFilmId ?? 0) || null
  let source: PipelineContext['source'] = null
  if (row.kind === 'video' && sourceFilmId) {
    const resolved = await resolveMixSource(episode.id, sourceFilmId)
    const sourceRow = db.select().from(schema.videoMerges)
      .where(eq(schema.videoMerges.id, resolved.source.filmId)).get()
    source = { film: resolved.source, subtitleUrl: sourceRow?.subtitleUrl ?? null }
  }
```

13. 将 `merged` 的构建改为源优先：

```ts
    let merged: PipelineContext['merged']
    if (row.kind === 'video') {
      if (source) {
        merged = {
          videoPath: getAbsolutePath(source.film.url),
          videoUrl: source.film.url,
          durationMs: source.film.durationMs,
          clips: [],
          remixed: false,
        }
      } else {
        const { ensureMergedVideo } = await import('./dubbing.js')
        merged = await ensureMergedVideo(episode.id, episode.dramaId, {
          onProgress: () => setProgress(recordId, 3),
          signal,
        })
      }
      if (signal.aborted) throw new ExportCancelledError()
    }
    const plan = await compileMixPlan(episode.id, episode.dramaId, {
      sourceFilmId: source?.film.filmId ?? null,
    })
```

14. 上下文增加 `source` 与 `title`：

```ts
    const context: PipelineContext = {
      recordId,
      episode,
      preset,
      subtitleMode,
      setCurrent: Boolean(params.setCurrent),
      plan,
      signal,
      merged,
      subtitleSettings,
      source,
      title: typeof params.title === 'string' ? params.title : null,
    }
```

15. `runVideoPipeline` 改为使用上下文源与标题：

```ts
async function runVideoPipeline(context: PipelineContext): Promise<PipelineResult> {
  const { recordId, episode, preset, subtitleMode, plan, signal, source } = context
  const dir = exportDirOf(episode.dramaId, episode.id, recordId)
  fs.mkdirSync(dir, { recursive: true })
  const filename = fileNameFor(episode, preset, context.title)
  const outputPath = path.join(dir, filename)
  const mixPath = path.join(dir, `mix-${recordId}.wav`)

  const { ensureMergedVideo, buildEpisodeSubtitles } = await import('./dubbing.js')

  setProgress(recordId, 5)
  const merged = context.merged ?? (source
    ? {
        videoPath: getAbsolutePath(source.film.url),
        videoUrl: source.film.url,
        durationMs: source.film.durationMs,
        clips: [],
        remixed: false,
      }
    : await ensureMergedVideo(episode.id, episode.dramaId, {
        onProgress: () => setProgress(recordId, 8),
        signal,
      }))
  if (signal.aborted) throw new ExportCancelledError()

  let subtitleUrl: string | null = null
  let srtPath: string | null = null
  let assPath: string | null = null
  if (subtitleMode === 'soft' || subtitleMode === 'burn') {
    const defaults = context.subtitleSettings || currentSubtitleSettings()
    const subs = await buildEpisodeSubtitles(episode.id, episode.dramaId, merged, {
      subtitleMode,
      width: preset.width || undefined,
      height: preset.height || undefined,
      markNarration: defaults.narratorPrefix,
      fontSize: defaults.fontSize,
      marginV: defaults.marginV,
    })
    srtPath = subs.srtPath
    assPath = subs.assPath
    subtitleUrl = subs.srtUrl
  } else if (subtitleMode === 'copy' && source?.subtitleUrl) {
    try {
      const abs = getAbsolutePath(source.subtitleUrl)
      if (fs.existsSync(abs)) {
        const target = path.join(dir, `source${path.extname(abs) || '.srt'}`)
        fs.copyFileSync(abs, target)
        subtitleUrl = exportUrlOf(
          episode.dramaId,
          episode.id,
          recordId,
          path.basename(target),
        )
      }
    } catch {
      subtitleUrl = null
    }
  }
  setProgress(recordId, 18)
```

之后的渲染、校验与返回逻辑不改动——直接沿用 `executeExport` 现有实现（本任务只在其上游替换 `merged` 来源与字幕来源，下游 `renderMixVideo`/`renderExportVideo` 调用、时长校验、状态推进、`setProgress` 节奏全部保持原样）。

16. `executeExport` 完成时重新生成 `paramsJson` 带上字幕与标题：

```ts
    const paramsJson = paramsJsonOf(preset, subtitleMode, plan, context.setCurrent, subtitleSettings, {
      sourceFilmId: row.sourceMergeId,
      title: context.title,
      subtitleUrl: result.subtitleUrl ?? null,
    })
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/export-source-film.test.ts tests/export-service.test.ts tests/export-projection.test.ts
cd backend && npm run typecheck
```

- [ ] **Step 6: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 10: 小白版方案板、声音素材库与背景声入口

**Files:**
- Create: `frontend/app/components/MixEpisodeSettings.vue`
- Create: `frontend/app/components/MixStemLibrary.vue`
- Modify: `frontend/app/components/MixClipInspector.vue`
- Modify: `frontend/app/components/MixStage.vue`
- Create: `frontend/tests/mix-inspector-structure.test.mjs`
- Modify: `frontend/app/locales/{zh,en,ja,ko}.json`

**Interfaces:**
- Consumes: `MixPlanSource/MixSourceWarning` 类型（在前端 `useApi.ts` 以 `type MixSourceSnapshot = {...}` 镜像）、现有 `separation/assets/soundscape` 状态。
- Produces：
  - `MixEpisodeSettings` props `{ source, warnings, tracks, separation, soundscapeRunning, canGenerateSound, hasAnyAudio, durationMs }`；emits `change-source`、`toggle-role(role, muted)`、`set-role-volume(role, volume)`、`generate-sound`、`withdraw-sound`、`open-export`。
  - `MixStemLibrary` props `{ separation, assets, busy }`；emits `separate(force)`、`cancel-separation`、`insert-asset(asset)`、`remove-asset(asset)`。
  - 检查器固定顺序：这一集怎么听 → 当前选中 → 声音素材库（折叠） → 高级（折叠） → 添加轨道（折叠）。

- [ ] **Step 1: 写结构测试**

`frontend/tests/mix-inspector-structure.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const inspector = fs.readFileSync(new URL('../app/components/MixClipInspector.vue', import.meta.url), 'utf8')
const settings = fs.readFileSync(new URL('../app/components/MixEpisodeSettings.vue', import.meta.url), 'utf8')
const stems = fs.readFileSync(new URL('../app/components/MixStemLibrary.vue', import.meta.url), 'utf8')
const stage = fs.readFileSync(new URL('../app/components/MixStage.vue', import.meta.url), 'utf8')
const zh = JSON.parse(fs.readFileSync(new URL('../app/locales/zh.json', import.meta.url), 'utf8'))

function indexOf(text, label) {
  const index = text.indexOf(label)
  assert.ok(index >= 0, `缺少 ${label}`)
  return index
}

test('检查器按小白顺序排列', () => {
  const order = ['episode-settings', 'clip-section', 'stem-library', 'advanced-section', 'add-track-section']
  const indexes = order.map((label) => indexOf(inspector, label))
  for (let i = 1; i < indexes.length; i += 1) {
    assert.ok(indexes[i - 1] < indexes[i], `${order[i - 1]} 必须排在 ${order[i]} 之前`)
  }
})

test('小白文案不再使用专业术语做主标签', () => {
  const forbidden = ['增益', '声像', '淡入', '淡出', '总线', '自动压低', '分离素材']
  for (const word of forbidden) {
    assert.equal(JSON.stringify(zh.mix).includes(`"${word}`), false, `中文文案仍包含术语 ${word}`)
  }
  for (const word of ['音量', '左右声道', '开始渐强', '结束渐弱', '声音分组', '说话时自动降低背景音', '提取声音素材']) {
    assert.equal(JSON.stringify(zh.mix).includes(word), true, `中文文案缺少 ${word}`)
  }
})

test('整集设置包含三个声音开关与背景声入口', () => {
  for (const text of ['保留原声', '使用配音对白', '播放背景音乐', '生成背景声', '导出前检查']) {
    assert.ok(settings.includes(text), `MixEpisodeSettings 缺少 ${text}`)
  }
  assert.match(settings, /emit\('generate-sound'\)/)
})

test('声音素材库独立折叠且不再遮挡设置', () => {
  assert.match(stems, /提取声音素材/)
  assert.match(stems, /不会自动改变当前混音/)
  assert.match(stems, /emit\('separate'/)
  const sep = inspector.indexOf('separation?.status')
  const settingsIndex = indexOf(inspector, 'episode-settings')
  assert.ok(sep === -1 || sep > settingsIndex, '分离状态必须排在整集设置之后或由素材库承载')
})

test('MixStage 不再把分离按钮放在顶栏主操作区', () => {
  const header = stage.slice(stage.indexOf('<header'), stage.indexOf('</header>'))
  assert.equal(header.includes("t('mix.separate')"), false)
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test frontend/tests/mix-inspector-structure.test.mjs
```

- [ ] **Step 3: 实现 `MixEpisodeSettings.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { Sparkles, Volume2, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  source: { filmId: number; kind: string; url: string; durationMs: number; hasAudio: boolean } | null
  warnings: { code: string; message: string }[]
  tracks: { role: string; muted: boolean; volume: number }[]
  soundscapeRunning: boolean
  canGenerateSound: boolean
  durationMs: number
}>()
const emit = defineEmits<{
  (e: 'change-source'): void
  (e: 'toggle-role', role: string, muted: boolean): void
  (e: 'set-role-volume', role: string, volume: number): void
  (e: 'generate-sound'): void
  (e: 'open-export'): void
}>()
const { t } = useI18n()

const SWITCHES = [
  { role: 'original', labelKey: 'mix.episode.keepOriginal', hintKey: 'mix.episode.keepOriginalHint' },
  { role: 'voice', labelKey: 'mix.episode.useDialogue', hintKey: 'mix.episode.useDialogueHint' },
  { role: 'bgm', labelKey: 'mix.episode.playBgm', hintKey: 'mix.episode.playBgmHint' },
] as const

function trackOf(role: string) {
  return props.tracks.find((track) => track.role === role) ?? null
}
function percentOf(role: string): number {
  return Math.round((trackOf(role)?.volume ?? 1) * 100)
}
const nonConcat = computed(() => Boolean(props.source && props.source.kind !== 'concat'))
</script>

<template>
  <section class="mx-card episode-settings">
    <div class="mx-card-head">
      <span class="mx-chip is-accent">{{ t('mix.episode.title') }}</span>
    </div>

    <div class="mx-source-row">
      <span class="mx-source-label">{{ t('mix.episode.source') }}</span>
      <b>{{ t(`films.kind.${source?.kind || 'concat'}`) }}</b>
      <button class="mx-btn is-plain" type="button" @click="emit('change-source')">
        {{ t('mix.episode.changeSource') }}
      </button>
    </div>

    <p v-if="nonConcat" class="mx-note is-warning">{{ t('mix.episode.nonConcat') }}</p>
    <p v-for="warning in warnings" :key="warning.code" class="mx-note is-warning">
      <AlertTriangle :size="12" /> {{ warning.message }}
    </p>

    <div v-for="item in SWITCHES" :key="item.role" class="mx-switch-row">
      <div>
        <b>{{ t(item.labelKey) }}</b>
        <p class="mx-hint">{{ t(item.hintKey) }}</p>
      </div>
      <button
        :class="['mx-toggle', { on: !(trackOf(item.role)?.muted ?? false) }]"
        type="button"
        :aria-pressed="!(trackOf(item.role)?.muted ?? false)"
        @click="emit('toggle-role', item.role, !(trackOf(item.role)?.muted ?? false))"
      >
        {{ trackOf(item.role)?.muted ? t('mix.episode.off') : t('mix.episode.on') }}
      </button>
      <label class="mx-field">
        <span><Volume2 :size="11" /> {{ t('mix.episode.volume') }} {{ percentOf(item.role) }}%</span>
        <input
          class="mx-range"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="percentOf(item.role)"
          @input="emit('set-role-volume', item.role, Number(($event.target as HTMLInputElement).value) / 100)"
        />
      </label>
    </div>

    <button class="mx-btn is-primary" type="button" :disabled="!source || !canGenerateSound || soundscapeRunning" @click="emit('generate-sound')">
      <Sparkles :size="12" />
      {{ t('mix.episode.generateSound') }}
    </button>
    <p class="mx-hint">{{ t('mix.episode.generateSoundHint') }}</p>

    <div class="mx-check-summary">
      <b>{{ t('mix.episode.checkTitle') }}</b>
      <span><CheckCircle2 :size="11" /> {{ t('mix.episode.checkSource', { time: (source?.durationMs || 0) / 1000 }) }}</span>
      <span><CheckCircle2 :size="11" /> {{ t('mix.episode.checkDuration', { time: durationMs / 1000 }) }}</span>
      <button class="mx-btn is-plain" type="button" @click="emit('open-export')">
        {{ t('mix.episode.export') }}
      </button>
    </div>
  </section>
</template>
```

> 完整样式复用 `MixClipInspector.vue` 已有的 `.mx-card/.mx-field/.mx-range/.mx-toggle/.mx-note` 类；新增类只做布局，不引入新视觉语言。

- [ ] **Step 4: 实现 `MixStemLibrary.vue`**

把原 `MixClipInspector.vue` 顶部「分离运行/失败」和素材列表整段迁移过来：

```vue
<script setup lang="ts">
import { AudioWaveform, Loader2, Play, Trash2, Plus } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  separation: { status?: string; progress?: number; step?: string; error?: string } | null
  assets: { id: number; kind: string; durationMs?: number; url?: string }[]
  busy?: boolean
}>()
const emit = defineEmits<{
  (e: 'separate', force: boolean): void
  (e: 'cancel-separation'): void
  (e: 'insert-asset', asset: any): void
  (e: 'remove-asset', asset: any): void
  (e: 'preview-asset', asset: any): void
}>()
const { t } = useI18n()
</script>

<template>
  <section class="mx-card stem-library">
    <div class="mx-card-head">
      <span class="mx-chip">{{ t('mix.stems.title') }}</span>
      <span class="mx-muted">{{ assets.length }}</span>
    </div>
    <p class="mx-hint">{{ t('mix.stems.intro') }}</p>
    <div v-if="separation?.status === 'running'" class="mx-stem-progress">
      <div class="mx-mini-bar"><span :style="{ width: `${separation.progress || 0}%` }" /></div>
      <span>{{ separation.step || t('mix.separationPreparing') }} · {{ separation.progress || 0 }}%</span>
      <button class="mx-btn is-plain" type="button" @click="emit('cancel-separation')">{{ t('mix.separationCancel') }}</button>
    </div>
    <p v-else-if="separation?.status === 'failed'" class="mx-note is-danger">
      {{ separation.error || t('mix.separationFailedHint') }}
    </p>
    <button class="mx-btn" type="button" :disabled="busy || separation?.status === 'running'" @click="emit('separate', Boolean(assets.length))">
      <AudioWaveform :size="12" />
      {{ t('mix.stems.extract') }}
    </button>
    <ul v-if="assets.length" class="mx-stem-list">
      <li v-for="asset in assets" :key="asset.id">
        <span>{{ t(`mix.assetKind${asset.kind}`) }}</span>
        <span class="mx-muted">{{ Math.round((asset.durationMs || 0) / 1000) }}s</span>
        <button class="mx-icon" type="button" @click="emit('preview-asset', asset)"><Play :size="12" /></button>
        <button class="mx-icon" type="button" @click="emit('insert-asset', asset)"><Plus :size="12" /></button>
        <button class="mx-icon is-danger" type="button" @click="emit('remove-asset', asset)"><Trash2 :size="12" /></button>
      </li>
    </ul>
  </section>
</template>
```

- [ ] **Step 5: 重排 `MixClipInspector.vue`**

1. 删除顶部两个 `separation?.status` 卡片和 `basicEngine` 提示。
2. 在 `.mx-ins-scroll` 起始处加入：

```vue
<slot name="episode-settings" />
```

3. 片段卡片包上 `<section class="mx-card clip-section">`（保留原有 `v-if="clip"`）。
4. 声音素材库放在片段/轨道卡片之后：

```vue
<details class="mx-card stem-library" :open="false">
  <summary>{{ t('mix.stems.title') }}</summary>
  <slot name="stem-library" />
</details>
```

5. 原「总线」卡片、响度与版本历史包进：

```vue
<details class="mx-card advanced-section" :open="false">
  <summary>{{ t('mix.advanced.title') }}</summary>
  <!-- 原总线、master、revision 内容 -->
  <slot name="settings" />
</details>
```

6. 原「添加轨道」按钮组包进：

```vue
<details class="mx-card add-track-section" :open="false">
  <summary>{{ t('mix.addTrack') }}</summary>
  <!-- 原 addTrack 按钮 -->
</details>
```

- [ ] **Step 6: `MixStage.vue` 接入新组件**

1. 导入：

```ts
import MixEpisodeSettings from '~/components/MixEpisodeSettings.vue'
import MixStemLibrary from '~/components/MixStemLibrary.vue'
```

2. 整集设置通过 `MixClipInspector` 的 `episode-settings` 插槽注入（见下一条），**不要**在检查器外再单独渲染一份 `MixEpisodeSettings`——否则同一设置渲染两次。

3. `MixClipInspector` 增加两个插槽，内容在 `MixStage` 提供：

```vue
<template #episode-settings>
  <MixEpisodeSettings
    class="mx-ins-settings"
    :source="plan?.source ?? null"
    :warnings="sourceWarnings"
    :tracks="tracks"
    :soundscape-running="soundscapeRunning"
    :can-generate-sound="canGenerateSound"
    :duration-ms="totalDuration"
    @change-source="sourcePickerOpen = true"
    @toggle-role="setRoleMuted"
    @set-role-volume="setRoleVolume"
    @generate-sound="openSoundscape"
    @open-export="exportOpen = true"
  />
</template>
<template #stem-library>
  <MixStemLibrary
    :separation="separation"
    :assets="assets"
    :busy="separationRunning || soundscapeRunning"
    @separate="requestSeparate"
    @cancel-separation="onCancelSeparation"
    @insert-asset="insertAsset"
    @remove-asset="requestRemoveAsset"
    @preview-asset="previewAsset"
  />
</template>
```

4. 顶栏删除「分离原声 / 重新分离」和「生成声音」两个按钮及其运行中取消按钮；保留撤销/重做/吸附/缩放/新建轨道/保存版本/刷新/面板开关。

5. 脚本增加虚拟轨开关与音量：

```ts
const VIRTUAL_ROLE_TRACKS = ['voice', 'original', 'bgm']

function setRoleMuted(role: string, muted: boolean) {
  const track = tracks.value.find((item) => item.role === role)
  if (!track) return
  if (role === 'voice' || role === 'bgm') {
    const source = plan.value?.source
    if (source && source.kind !== 'concat' && !muted) {
      const ok = window.confirm(t('mix.episode.enableNonConcatConfirm'))
      if (!ok) return
    }
  }
  beginChange()
  track.muted = muted
  endChange()
}

function setRoleVolume(role: string, volume: number) {
  const track = tracks.value.find((item) => item.role === role)
  if (!track) return
  beginChange()
  track.volume = Math.max(0, Math.min(1, volume))
  endChange()
}
```

6. 把 `savePlan` 请求体中的 `virtualTracks` 从 `VIRTUAL_ROLE_TRACKS` 生成（保留已有 overrides）：

```ts
const virtualTracks = tracks.value
  .filter((track) => track.virtual && VIRTUAL_ROLE_TRACKS.includes(track.role))
  .map((track) => ({
    role: track.role,
    volume: track.volume,
    pan: track.pan,
    muted: track.muted,
    solo: track.solo,
    loop: track.loop,
  }))
```

- [ ] **Step 7: 四语言文案**

中文必须包含（其他三语言按同义翻译，键名一致）：

```json
"episode": {
  "title": "这一集怎么听",
  "source": "源成片",
  "changeSource": "更换",
  "nonConcat": "这部成片已经包含配音或配乐。为避免人声重复，对白和配乐轨已默认关闭。需要单独调整人声时，请先用「提取声音素材」。",
  "keepOriginal": "保留原声",
  "keepOriginalHint": "保留成片自带的现场声和环境声。",
  "useDialogue": "使用配音对白",
  "useDialogueHint": "播放本集生成的角色配音。",
  "playBgm": "播放背景音乐",
  "playBgmHint": "播放本集选择的配乐。",
  "volume": "音量",
  "on": "开",
  "off": "关",
  "generateSound": "生成背景声 / 环境声",
  "generateSoundHint": "根据本集剧情和分镜，自动生成环境声、场景音效和群众声，放到新的声音轨道。不会覆盖你已有的声音，也不会改变画面。",
  "checkTitle": "导出前检查",
  "checkSource": "源成片 {time} 秒",
  "checkDuration": "混音时长 {time} 秒",
  "export": "导出成片",
  "enableNonConcatConfirm": "这部成片已经包含配音或配乐，重新开启可能造成人声重复。仍要开启吗？"
},
"stems": {
  "title": "声音素材库（可选）",
  "intro": "从原声中提取人声、伴奏等声音素材，方便单独调整或替换。提取不会自动改变当前混音；需要使用时，把素材放入时间线。",
  "extract": "提取声音素材"
},
"advanced": { "title": "高级" }
```

同文件把旧键文案改为：

| 键 | 新值 |
| --- | --- |
| `mix.gain` | 音量 |
| `mix.pan` | 左右声道 |
| `mix.fadeIn` | 开始渐强 (s) |
| `mix.fadeOut` | 结束渐弱 (s) |
| `mix.fadeCurve` | 渐变方式 |
| `mix.trackDuck` | 说话时自动降低背景音 |
| `mix.trackSolo` | 只听这条 |
| `mix.trackMute` | 静音 |
| `mix.busSection` | 声音分组 |
| `mix.separate` | 提取声音素材 |
| `mix.reseparate` | 重新提取声音素材 |
| `mix.assets` | 声音素材 |

- [ ] **Step 8: 运行测试确认通过**

```bash
node --test frontend/tests/mix-inspector-structure.test.mjs
cd frontend && npm run build
```

- [ ] **Step 9: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 11: 混音页源成片选择器、警告与导出成片

**Files:**
- Modify: `frontend/app/composables/useApi.ts`
- Modify: `frontend/app/composables/useMixStage.ts`
- Modify: `frontend/app/composables/useExportSession.ts`
- Create: `frontend/app/components/MixExportDialog.vue`
- Modify: `frontend/app/components/MixStage.vue`
- Modify: `frontend/app/components/DubbingStage.vue`
- Modify: `frontend/app/views/drama/episode.vue`
- Modify: `frontend/app/locales/{zh,en,ja,ko}.json`
- Create: `frontend/tests/mix-source-ui.test.mjs`

**Interfaces:**
- Consumes: `filmAPI/FilmPicker`（Task 6）、`mixAPI`、`exportAPI`。
- Produces：
  - `mixAPI.plan(episodeId, sourceFilmId?)`、`mixAPI.setSource(episodeId, filmId)`
  - `exportAPI.start` 接受 `source_film_id/title/set_current`
  - `useMixStage` 暴露 `sourceFilm/sourceWarnings/selectSourceFilm/exportSource`
  - 顶栏显示「源成片：拼接成片 ▾」；非拼接源常驻提示；导出对话框默认字幕「复制源成片外挂字幕」

- [ ] **Step 1: 写结构测试**

`frontend/tests/mix-source-ui.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const api = fs.readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const mix = fs.readFileSync(new URL('../app/composables/useMixStage.ts', import.meta.url), 'utf8')
const stage = fs.readFileSync(new URL('../app/components/MixStage.vue', import.meta.url), 'utf8')
const dialog = fs.readFileSync(new URL('../app/components/MixExportDialog.vue', import.meta.url), 'utf8')
const zh = JSON.parse(fs.readFileSync(new URL('../app/locales/zh.json', import.meta.url), 'utf8'))

test('mixAPI 支持源成片参数与切换', () => {
  assert.match(api, /plan:\s*\(episodeId: number, sourceFilmId\?/)
  assert.match(api, /setSource:\s*\(episodeId: number, filmId: number\)/)
  assert.match(api, /source_film_id/)
})

test('useMixStage 暴露源成片与警告', () => {
  for (const key of ['sourceFilm', 'sourceWarnings', 'selectSourceFilm', 'exportSource']) {
    assert.match(mix, new RegExp(key))
  }
})

test('MixStage 顶栏接入 FilmPicker 与导出对话框', () => {
  assert.match(stage, /FilmPicker/)
  assert.match(stage, /MixExportDialog/)
  assert.match(stage, /sourceWarnings/)
  assert.match(stage, /sourcePickerOpen/)
})

test('导出对话框包含源成片、字幕复制与设为当前', () => {
  for (const text of ['源成片', '复制源成片外挂字幕', '设为当前成片', '仅音频', '分轨 ZIP']) {
    assert.ok(dialog.includes(text), `导出对话框缺少 ${text}`)
  }
})

test('中文文案包含源成片与警告 key', () => {
  for (const key of ['mix.sourcePicker.title', 'mix.sourcePicker.change', 'mix.sourceWarnings.nonConcat']) {
    assert.ok(key.split('.').reduce((obj, part) => obj?.[part], zh) !== undefined, `缺少 ${key}`)
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test frontend/tests/mix-source-ui.test.mjs
```

- [ ] **Step 3: 扩展 API 与状态**

`useApi.ts`：

```ts
export const mixAPI = {
  ...existing,
  plan: (episodeId: number, sourceFilmId?: number | null) =>
    api.get<MixPlan & {
      source_film: MixSourceSnapshot | null
      source_warnings: { code: string; message: string }[]
    }>(`/episodes/${episodeId}/mix${sourceFilmId ? `?source_film_id=${sourceFilmId}` : ''}`),
  setSource: (episodeId: number, filmId: number) =>
    api.put<MixPlan & {
      source_film: MixSourceSnapshot | null
      source_warnings: { code: string; message: string }[]
    }>(`/episodes/${episodeId}/mix/source`, { film_id: filmId }),
}
```

新增类型：

```ts
export interface MixSourceSnapshot {
  filmId: number
  kind: 'concat' | 'mix' | 'edit' | 'import'
  url: string
  durationMs: number
  hasAudio: boolean
  containsDialogue: boolean
  containsBgm: boolean
}
```

`exportAPI.start` 数据参数增加 `source_film_id?: number`、`title?: string`。

`useMixStage.ts`：

```ts
const sourceFilm = ref<MixSourceSnapshot | null>(null)
const sourceWarnings = ref<{ code: string; message: string }[]>([])

async function loadPlan(sourceFilmId?: number | null) {
  const plan = await mixAPI.plan(episodeId.value, sourceFilmId)
  sourceFilm.value = plan.source_film ?? plan.source ?? null
  sourceWarnings.value = plan.source_warnings ?? []
  // 原有 plan/tracks 赋值逻辑不变
}

async function selectSourceFilm(filmId: number) {
  await saveNow()
  const plan = await mixAPI.setSource(episodeId.value, filmId)
  sourceFilm.value = plan.source_film ?? plan.source ?? null
  sourceWarnings.value = plan.source_warnings ?? []
  applyPlan(plan)
}
```

初始加载优先使用路由 `?film=`：

```ts
import { useRoute } from 'vue-router'
const route = useRoute()
const initialFilmId = Number(route.query.film) || null
await loadPlan(initialFilmId)
```

导出状态：

```ts
const exportSource = computed(() => sourceFilm.value)
```

`useExportSession.ts` 的 `start` 改为：

```ts
async function start(kind: ExportKind, overrides: {
  preset?: string
  subtitleMode?: ExportSubtitleMode
  sourceFilmId?: number | null
  title?: string | null
  setCurrent?: boolean
} = {}) {
  // ...
  const result = await exportAPI.start(episodeId, {
    kind,
    ...(kind === 'video'
      ? {
          preset: overrides.preset || preset.value,
          subtitle_mode: overrides.subtitleMode || subtitleMode.value,
          ...(overrides.sourceFilmId ? { source_film_id: overrides.sourceFilmId } : {}),
          ...(overrides.title ? { title: overrides.title } : {}),
          ...(overrides.setCurrent ? { set_current: true } : {}),
        }
      : {}),
  })
  // ...
}
```

- [ ] **Step 4: 导出对话框**

`MixExportDialog.vue`：弹窗字段固定：

```vue
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ExportKind, ExportSubtitleMode } from '~/composables/useApi'

const props = defineProps<{
  open: boolean
  source: { kind: string; durationMs: number } | null
  episodeNumber: number
  defaultPreset: string
  active: { status?: string; progress?: number } | null
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'start', payload: {
    kind: ExportKind
    preset: string
    subtitleMode: ExportSubtitleMode
    title: string
    setCurrent: boolean
  }): void
}>()
const { t } = useI18n()
const kind = ref<ExportKind>('video')
const preset = ref(props.defaultPreset)
const subtitleMode = ref<ExportSubtitleMode>('copy')
const title = ref('')
const setCurrent = ref(false)

watch(() => props.open, (open) => {
  if (!open) return
  title.value = `第 ${props.episodeNumber} 集 混音成片（${new Date().toLocaleString()}）`
  subtitleMode.value = 'copy'
})
</script>

<template>
  <div v-if="open" class="modal-mask" @click.self="emit('close')">
    <div class="mix-export-dialog">
      <h3>{{ t('mix.export.title') }}</h3>
      <label>{{ t('mix.export.source') }}
        <input :value="t(`films.kind.${source?.kind || 'concat'}`)" disabled />
      </label>
      <label>{{ t('mix.export.kind') }}
        <select v-model="kind">
          <option value="video">{{ t('mix.export.kindVideo') }}</option>
          <option value="mix">{{ t('mix.export.kindAudio') }}</option>
          <option value="stems">{{ t('mix.export.kindStems') }}</option>
        </select>
      </label>
      <label v-if="kind === 'video'">{{ t('mix.export.preset') }}
        <select v-model="preset">
          <option value="vertical-hd">{{ t('export.preset.verticalHd') }}</option>
          <option value="horizontal-hd">{{ t('export.preset.horizontalHd') }}</option>
        </select>
      </label>
      <label v-if="kind === 'video'">{{ t('mix.export.subtitle') }}
        <select v-model="subtitleMode">
          <option value="copy">{{ t('mix.export.copySource') }}</option>
          <option value="none">{{ t('mix.export.subtitleNone') }}</option>
        </select>
      </label>
      <label>{{ t('mix.export.titleLabel') }} <input v-model="title" /></label>
      <label v-if="kind === 'video'" class="checkbox">
        <input v-model="setCurrent" type="checkbox" /> {{ t('mix.export.setCurrent') }}
      </label>
      <p v-if="active" class="hint">{{ active.status }} {{ active.progress || 0 }}%</p>
      <div class="actions">
        <button class="btn" type="button" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" type="button" :disabled="Boolean(active)" @click="emit('start', {
          kind, preset, subtitleMode, title, setCurrent,
        })">{{ t('mix.export.start') }}</button>
      </div>
    </div>
  </div>
</template>
```

> 「跟随源成片」在本期等价于按剧集画幅选择竖屏/横屏预设，因为本集成片都由同一画幅生成；对话框只显示这两个明确选项，不增加第三个无效选项。

- [ ] **Step 5: `MixStage` 顶栏与导出联动**

1. 顶栏标题后加源成片按钮：

```vue
<button class="mx-source-pill" type="button" :disabled="!episodeId" @click="sourcePickerOpen = true">
  {{ t('mix.sourcePicker.label') }}：{{ t(`films.kind.${sourceFilm?.kind || 'concat'}`) }}
  <ChevronDown :size="11" />
</button>
```

2. 在 `MixEpisodeSettings` 之后、错误提示附近加常驻警告：

```vue
<p v-for="warning in sourceWarnings" :key="warning.code" class="mx-source-warning">
  {{ warning.code === 'MIX_SOURCE_NON_CONCAT'
    ? t('mix.sourceWarnings.nonConcat')
    : warning.message }}
</p>
```

3. 页面底部挂载选择器与导出框：

```vue
<FilmPicker
  v-model:show="sourcePickerOpen"
  :episode-id="episodeId"
  :model-value="sourceFilm?.filmId ?? null"
  mode="mix"
  @select="selectSourceFilm($event.id)"
/>
<MixExportDialog
  :open="exportOpen"
  :source="sourceFilm"
  :episode-number="episodeNumber"
  :default-preset="defaultExportPreset"
  :active="activeExport"
  @close="exportOpen = false"
  @start="startMixExport"
/>
```

4. 脚本：

```ts
const sourcePickerOpen = ref(false)
const exportOpen = ref(false)
const defaultExportPreset = computed(() => dramaAspect?.value === '9:16' ? 'vertical-hd' : 'horizontal-hd')

async function startMixExport(payload: {
  kind: ExportKind; preset: string; subtitleMode: ExportSubtitleMode; title: string; setCurrent: boolean
}) {
  const record = await exportSession.start(payload.kind, {
    preset: payload.preset,
    subtitleMode: payload.subtitleMode,
    sourceFilmId: sourceFilm.value?.filmId ?? null,
    title: payload.title,
    setCurrent: payload.setCurrent,
  })
  if (!record) return
  toast.success(t('mix.export.started'))
  exportOpen.value = false
}
```

> `episodeNumber/dramaAspect/activeExport/exportSession` 由现有 `useMixStage` 或 DubbingStage props 提供；DubbingStage 已传入 `durationMs/videoUrl`，新增 `episode-number` 与 `drama-aspect` props，并在 DubbingStage 内读取 `episode` 数据。

5. `DubbingStage.vue` 第 4 步删除 `<template #settings>` 里的旧混音卡（字幕模式/原声/ducking/BGM）；字幕模式移入导出对话框，BGM 由整集设置开关控制。保留 `MixStage` 的 `:episode-number` 与 `:drama-aspect`。

- [ ] **Step 6: 四语言文案**

```json
"sourcePicker": {
  "label": "源成片",
  "title": "选择源成片",
  "change": "更换源成片",
  "empty": "本集还没有成片，先去拼接导出一版吧"
},
"sourceWarnings": {
  "nonConcat": "这部成片已经包含配音或配乐。为避免人声重复，对白和配乐轨已默认关闭。需要单独调整人声时，请先用「提取声音素材」。"
},
"export": {
  "title": "导出混音成片",
  "source": "源成片",
  "kind": "导出类型",
  "kindVideo": "视频成片",
  "kindAudio": "仅音频",
  "kindStems": "分轨 ZIP",
  "preset": "视频预设",
  "subtitle": "字幕",
  "copySource": "复制源成片外挂字幕",
  "subtitleNone": "不添加",
  "titleLabel": "标题",
  "setCurrent": "设为当前成片",
  "start": "开始导出",
  "started": "已开始导出，完成后会出现在成片列表",
  "keepOriginal": "保留原声"
}
```

- [ ] **Step 7: 运行测试与前端门禁**

```bash
node --test frontend/tests/mix-source-ui.test.mjs frontend/tests/mix-inspector-structure.test.mjs frontend/tests/film-ui-structure.test.mjs
cd frontend && npm run build
```

- [ ] **Step 8: 记录改动（不提交）**

```bash
git status --short
```

---

## Phase C：剪辑工程与字幕

### Task 12: 剪辑工程服务与工程路由

**Files:**
- Modify: `backend/src/services/film-hub.ts`（导出 `getFilmRow`）
- Create: `backend/src/services/edit-project-service.ts`
- Modify: `backend/src/routes/edit.ts`
- Test: `backend/tests/edit-project.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `schema.editProjects` 与唯一索引 `idx_edit_projects_source/idx_edit_projects_legacy`；Task 2 的 `film-hub.ts`。
- Produces: `getFilmRow(filmId: number): VideoMergeRow`（404 FILM_NOT_FOUND）；`EditProjectRow`；`EditProjectSummary`；`projectResponse(row)`；`requireEditProject(episodeId, projectId)`；`projectForFilm(episodeId, filmId)`；`resolveEditProject(episodeId, rawProjectId?): EditProjectRow | null`；`openProjectForFilm(episodeId, filmId): { project, created }`；`setOpenEditProject(episodeId, projectId)`；`listEditProjects(episodeId)`。
- Produces 路由：`GET /episodes/:id/edit/projects`、`POST /episodes/:id/edit/projects`（body `{ film_id }`）。后续 Task 14 依赖 `resolveEditProject` 与 `openProjectForFilm`。

- [ ] **Step 1: 写失败测试**

在 `backend/tests/edit-project.test.ts` 写入：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-project-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const {
  resolveEditProject,
  openProjectForFilm,
  requireEditProject,
  listEditProjects,
} = await import('../src/services/edit-project-service.ts')

const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '工程解析', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '集', createdAt: ts, updatedAt: ts,
}).returning().get()

function insertFilm(mergedUrl: string, kind = 'concat', createdAt = ts) {
  return db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: drama.id, title: `成片 ${mergedUrl}`,
    status: 'completed', mergedUrl, kind, createdAt,
  }).returning().get()
}
const filmA = insertFilm('a.mp4', 'concat', '2026-11-01T00:00:00.000Z')
const filmB = insertFilm('b.mp4', 'mix', '2026-11-02T00:00:00.000Z')

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('openProjectForFilm 创建工程并记录打开指针，重复打开复用', () => {
  setEditWorkspaceMode('on')
  const first = openProjectForFilm(episode.id, filmA.id)
  assert.equal(first.created, true)
  assert.equal(first.project.sourceMergeId, filmA.id)
  assert.equal(first.project.dramaId, drama.id)
  const opened = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, episode.id)).get()
  assert.equal(opened?.editProjectId, first.project.id)

  const second = openProjectForFilm(episode.id, filmA.id)
  assert.equal(second.created, false)
  assert.equal(second.project.id, first.project.id)
})

test('工程按 (episode, film) 唯一，删除后可重建', () => {
  const { editProjects } = schema
  assert.throws(() => db.insert(editProjects).values({
    episodeId: episode.id, dramaId: drama.id, sourceMergeId: filmA.id,
    title: '重复', status: 'active', createdAt: ts, updatedAt: ts,
  }).run(), /UNIQUE/)

  db.update(editProjects).set({ status: 'deleted', deletedAt: ts })
    .where(eq(editProjects.id, first_project_id())).run()
  const recreated = openProjectForFilm(episode.id, filmA.id)
  assert.equal(recreated.created, true)
})

function first_project_id(): number {
  return db.select().from(schema.editProjects).all()
    .find((row) => row.sourceMergeId === filmA.id && !row.deletedAt)!.id
}

test('resolveEditProject 按 打开指针 → 当前成片工程 → 最新工程 顺序解析', () => {
  // 指针指向已删除工程时跳过，回退到最新成片工程
  const fallback = resolveEditProject(episode.id)
  assert.ok(fallback)
  assert.equal(fallback!.sourceMergeId, filmA.id)

  // 当前成片的工程优先
  db.update(schema.episodes).set({ currentFilmId: filmB.id })
    .where(eq(schema.episodes.id, episode.id)).run()
  assert.equal(resolveEditProject(episode.id)!.sourceMergeId, filmB.id)

  // 打开指针优先于当前成片
  openProjectForFilm(episode.id, filmA.id)
  assert.equal(resolveEditProject(episode.id)!.sourceMergeId, filmA.id)

  // 显式 project_id 优先于指针
  const other = openProjectForFilm(episode.id, filmB.id).project
  assert.equal(resolveEditProject(episode.id, other.id)!.id, other.id)
})

test('requireEditProject 拒绝跨集/已删除工程', () => {
  const project = resolveEditProject(episode.id)!
  assert.throws(() => requireEditProject(episode.id + 1, project.id), /EDIT_PROJECT_NOT_FOUND/)
  db.update(schema.editProjects).set({ deletedAt: ts })
    .where(eq(schema.editProjects.id, project.id)).run()
  assert.throws(() => requireEditProject(episode.id, project.id), /EDIT_PROJECT_NOT_FOUND/)
})

test('listEditProjects 返回成片标题与旧版标记', () => {
  const legacy = db.insert(schema.editProjects).values({
    episodeId: episode.id, dramaId: drama.id, title: '旧版工程',
    status: 'active', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const { items } = listEditProjects(episode.id)
  const legacyItem = items.find((item: any) => item.id === legacy.id)
  assert.equal(legacyItem.legacy, true)
  assert.equal(legacyItem.film_title, null)
  const filmItem = items.find((item: any) => item.source_merge_id === filmA.id)
  assert.equal(filmItem.legacy, false)
  assert.equal(filmItem.film_title, `成片 a.mp4`)
  assert.equal(filmItem.film_kind, 'concat')
})

test('工程路由：列出与按成片打开', async () => {
  setEditWorkspaceMode('on')
  const listed = await app.request(`/episodes/${episode.id}/edit/projects`)
  assert.equal(listed.status, 200)
  const listedData = (await listed.json()).data
  assert.ok(listedData.items.length >= 2)

  const opened = await app.request(`/episodes/${episode.id}/edit/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ film_id: filmA.id }),
  })
  assert.equal(opened.status, 200, await opened.clone().text())
  const openedData = (await opened.json()).data
  assert.equal(openedData.project.source_merge_id, filmA.id)

  const missing = await app.request(`/episodes/${episode.id}/edit/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ film_id: 99999 }),
  })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'FILM_NOT_FOUND')
})
```

注意：测试里 `import { eq } from 'drizzle-orm'` 放在文件顶部动态 import 之前的静态 import 区（`import { eq } from 'drizzle-orm'`）。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/edit-project.test.ts
```

预期：`edit-project-service` 不存在导致加载失败。

- [ ] **Step 3: 实现服务与路由**

`backend/src/services/film-hub.ts`：把 `function requireFilm(filmId: number)` 改为：

```ts
export function getFilmRow(filmId: number) {
  const row = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, filmId)).get()
  if (!row || row.deletedAt) throw new FilmError(404, 'FILM_NOT_FOUND', '成片不存在或已删除')
  return row
}
```

并把文件内所有 `requireFilm(` 调用替换为 `getFilmRow(`。

新建 `backend/src/services/edit-project-service.ts`：

```ts
/**
 * 剪辑工程解析（设计 §6.1、§6.11）：
 * - 一部源成片对应一个工程（idx_edit_projects_source 唯一）；
 * - 打开顺序：显式 project_id → episodes.edit_project_id → 当前成片工程 →
 *   最新成片工程（updatedAt 降序）→ 旧版工程（source_merge_id 为空）；
 * - 本文件只负责工程行与解析，不构建计划、不写草稿。
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { EditWorkspaceError } from './edit-errors.js'
import { getFilmRow } from './film-hub.js'

export type EditProjectRow = typeof schema.editProjects.$inferSelect

export interface EditProjectSummary {
  id: number
  title: string
  status: string
  source_merge_id: number | null
  source_url: string | null
  film_title: string | null
  film_kind: string | null
  legacy: boolean
  updated_at: string
  revision_count: number
}

export function projectResponse(row: EditProjectRow): EditProjectSummary {
  const film = row.sourceMergeId
    ? db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, row.sourceMergeId)).get()
    : undefined
  const revisionCount = db.select().from(schema.editRevisions)
    .where(eq(schema.editRevisions.projectId, row.id))
    .all().length
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    source_merge_id: row.sourceMergeId ?? null,
    source_url: row.sourceUrl ?? null,
    film_title: film?.title ?? null,
    film_kind: film?.kind ?? null,
    legacy: !row.sourceMergeId,
    updated_at: row.updatedAt,
    revision_count: revisionCount,
  }
}

function loadProject(projectId: number, episodeId: number): EditProjectRow | null {
  const row = db.select().from(schema.editProjects)
    .where(and(
      eq(schema.editProjects.id, projectId),
      eq(schema.editProjects.episodeId, episodeId),
      isNull(schema.editProjects.deletedAt),
    ))
    .get()
  return row ?? null
}

export function requireEditProject(episodeId: number, projectId: number): EditProjectRow {
  const row = loadProject(projectId, episodeId)
  if (!row) throw new EditWorkspaceError(404, 'EDIT_PROJECT_NOT_FOUND', '剪辑工程不存在或已删除')
  return row
}

export function projectForFilm(episodeId: number, filmId: number): EditProjectRow | null {
  return db.select().from(schema.editProjects)
    .where(and(
      eq(schema.editProjects.episodeId, episodeId),
      eq(schema.editProjects.sourceMergeId, filmId),
      isNull(schema.editProjects.deletedAt),
    ))
    .get() ?? null
}

export function resolveEditProject(episodeId: number, rawProjectId?: number | null): EditProjectRow | null {
  if (rawProjectId) return requireEditProject(episodeId, rawProjectId)
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new EditWorkspaceError(404, 'EPISODE_NOT_FOUND', '分集不存在')
  if (episode.editProjectId) {
    const opened = loadProject(episode.editProjectId, episodeId)
    if (opened) return opened
  }
  if (episode.currentFilmId) {
    const filmProject = projectForFilm(episodeId, episode.currentFilmId)
    if (filmProject) return filmProject
  }
  const rows = db.select().from(schema.editProjects)
    .where(and(eq(schema.editProjects.episodeId, episodeId), isNull(schema.editProjects.deletedAt)))
    .orderBy(sql`${schema.editProjects.sourceMergeId} IS NULL ASC`, desc(schema.editProjects.updatedAt))
    .all()
  return rows[0] ?? null
}

export function setOpenEditProject(episodeId: number, projectId: number): void {
  db.update(schema.episodes).set({ editProjectId: projectId, updatedAt: new Date().toISOString() })
    .where(eq(schema.episodes.id, episodeId)).run()
}

export function openProjectForFilm(episodeId: number, filmId: number): {
  project: EditProjectRow
  created: boolean
} {
  const film = getFilmRow(filmId)
  if (film.episodeId !== episodeId) {
    throw new EditWorkspaceError(400, 'EDIT_FILM_MISMATCH', '成片不属于该集')
  }
  if (!film.mergedUrl) throw new EditWorkspaceError(422, 'EDIT_FILM_UNREADABLE', '成片文件不可用')
  const existing = projectForFilm(episodeId, filmId)
  if (existing) {
    setOpenEditProject(episodeId, existing.id)
    return { project: existing, created: false }
  }
  const ts = new Date().toISOString()
  const project = db.insert(schema.editProjects).values({
    episodeId,
    dramaId: film.dramaId,
    sourceMergeId: film.id,
    sourceUrl: film.mergedUrl,
    title: film.title?.trim() || `成片 ${film.id}`,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  setOpenEditProject(episodeId, project.id)
  return { project, created: true }
}

export function listEditProjects(episodeId: number) {
  const rows = db.select().from(schema.editProjects)
    .where(and(eq(schema.editProjects.episodeId, episodeId), isNull(schema.editProjects.deletedAt)))
    .orderBy(desc(schema.editProjects.updatedAt))
    .all()
  return { items: rows.map(projectResponse) }
}
```

`backend/src/routes/edit.ts` 在 `app.get('/episodes/:id/edit/media', ...)` 之前插入：

```ts
import { listEditProjects, openProjectForFilm } from '../services/edit-project-service.js'
import { getWritableEpisode } from '../services/edit-access.js'
import { handleFilmError } from './films.js'

app.get('/episodes/:id/edit/projects', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, listEditProjects(episodeId))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/projects', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    getWritableEpisode(episodeId)
    const body = await readBody(c)
    const filmId = Number(body.film_id)
    if (!Number.isSafeInteger(filmId) || filmId <= 0) {
      return badRequest(c, '缺少有效的 film_id')
    }
    const { project, created } = openProjectForFilm(episodeId, filmId)
    return success(c, { project: projectResponse(project), created })
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      const mapped = handleFilmError(c, error)
      if (mapped) return mapped
    }
    return handleEditError(c, error)
  }
})
```

`handleFilmError` 在 Task 3 中返回 `Response | null`；此处按其真实签名调整（若返回 `Response`，直接 `return handleFilmError(c, error)`）。实现时以 Task 3 落地的代码为准。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/edit-project.test.ts && npm run typecheck
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 13: 源成片初始计划构建与 SRT 导入

**Files:**
- Create: `backend/src/services/edit-film-plan.ts`
- Test: `backend/tests/edit-film-plan.test.ts`

**Interfaces:**
- Consumes: Task 12 的 `getFilmRow`；`editSourceFromUrl`；`createSingleClipPlan/projectSettingsForAspect`。
- Produces: `parseSrtCues(text: string): { startMs: number; endMs: number; text: string }[]`；`buildFilmEditPlan(input: { episodeId: number; film: FilmRowLike; warnings: EditIssue[] }): Promise<EditPlanV1 | null>`（`FilmRowLike` 为 `video_merges` 行）。返回 `null` 表示成片不可读。Task 14 的 `getEpisodeEditState` 依赖它。

- [ ] **Step 1: 写失败测试**

在 `backend/tests/edit-film-plan.test.ts` 写入：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-film-plan-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { buildFilmEditPlan, parseSrtCues } = await import('../src/services/edit-film-plan.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '初始计划', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '集', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const filmFile = path.join(videoDir, 'film.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  filmFile,
], { stdio: 'ignore' })
const filmUrl = `static/projects/${drama.id}/videos/film.mp4`

function insertFilm(extra: Record<string, unknown> = {}) {
  return db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: drama.id, title: '成片',
    status: 'completed', mergedUrl: filmUrl, kind: 'concat', createdAt: ts,
    ...extra,
  }).returning().get()
}

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('parseSrtCues 解析时间轴与多行文本', () => {
  const cues = parseSrtCues(
    '1\n00:00:00,500 --> 00:00:01,800\n你好\n世界\n\n2\n00:00:02,000 --> 00:00:03,250\n第二句\n',
  )
  assert.deepEqual(cues, [
    { startMs: 500, endMs: 1800, text: '你好\n世界' },
    { startMs: 2000, endMs: 3250, text: '第二句' },
  ])
})

test('源成片生成单片段计划：画幅/帧率取成片，字幕从 SRT 导入', async () => {
  const srtPath = path.join(videoDir, 'film.srt')
  fs.writeFileSync(srtPath, '1\n00:00:00,500 --> 00:00:01,800\n你好\n', 'utf8')
  const film = insertFilm({ subtitleUrl: `static/projects/${drama.id}/videos/film.srt` })

  const warnings: any[] = []
  const plan = await buildFilmEditPlan({ episodeId: episode.id, film, warnings })
  assert.ok(plan)
  assert.equal(plan!.clips.length, 1)
  assert.equal(plan!.clips[0].source.kind, 'merge')
  assert.equal(plan!.clips[0].source.id, film.id)
  assert.equal(plan!.clips[0].source.url, filmUrl)
  assert.equal(plan!.project.aspect, '9:16')
  assert.equal(plan!.project.fps, 25)
  assert.equal(plan!.subtitles.length, 1)
  assert.equal(plan!.subtitles[0].source, 'import')
  assert.equal(plan!.subtitles[0].text, '你好')
  assert.equal(plan!.subtitles[0].follow, false)
  assert.equal(warnings.length, 0)
})

test('烧录字幕不导入并给出常驻提示', async () => {
  const film = insertFilm({ subtitleBurned: 1 })
  const warnings: any[] = []
  const plan = await buildFilmEditPlan({ episodeId: episode.id, film, warnings })
  assert.ok(plan)
  assert.equal(plan!.subtitles.length, 0)
  assert.ok(warnings.some((item) => item.code === 'SUBTITLE_BURNED'))
})

test('历史混音成片无外挂字幕时提示可能已烧录', async () => {
  const film = insertFilm({ kind: 'mix' })
  const warnings: any[] = []
  const plan = await buildFilmEditPlan({ episodeId: episode.id, film, warnings })
  assert.ok(plan)
  assert.ok(warnings.some((item) => item.code === 'MIX_FILM_SUBTITLE_UNKNOWN'))
})

test('成片文件缺失返回 null 并提示 MEDIA_MISSING', async () => {
  const film = insertFilm({ mergedUrl: 'static/projects/1/videos/gone.mp4' })
  const warnings: any[] = []
  const plan = await buildFilmEditPlan({ episodeId: episode.id, film, warnings })
  assert.equal(plan, null)
  assert.ok(warnings.some((item) => item.code === 'MEDIA_MISSING'))
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/edit-film-plan.test.ts
```

- [ ] **Step 3: 实现构建器**

新建 `backend/src/services/edit-film-plan.ts`：

```ts
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
  const plan = createSingleClipPlan(input.episodeId, source, {
    ...{ aspect: aspectFor(source.width, source.height), width: 1920, height: 1080, fps: 30 },
  } as never)
  // createSingleClipPlan 内部按 aspect 推导宽高；此处直接改写 fps 再重建，保证画幅/帧率一致
  const rebuilt = createSingleClipPlan(input.episodeId, source, {
    ...plan.project,
    aspect: aspectFor(source.width, source.height),
    fps,
  })
  rebuilt.project.fps = fps

  const burned = Boolean(input.film.subtitleBurned)
  if (input.film.subtitleUrl && !burned) {
    const abs = getAbsolutePath(input.film.subtitleUrl)
    const text = fs.readFileSync(abs, 'utf8')
    for (const [index, cue] of parseSrtCues(text).entries()) {
      rebuilt.subtitles.push({
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
      severity: 'info' as never,
      code: 'SUBTITLE_EMPTY',
      path: 'subtitles',
      message: '可手动添加字幕，或去配音页生成台词',
    })
  }
  return rebuilt
}
```

> 实现注意：`EditIssue.severity` 只有 `'error' | 'warning'`；`SUBTITLE_EMPTY` 用 `severity: 'warning'` 落地，上面 `as never` 只是在计划里的示意，实现时写 `severity: 'warning'`。`createSingleClipPlan` 的入参是完整 `EditProjectSettings`，实现时先 `projectSettingsForAspect(aspectFor(...), fps)` 再传入，避免上面两次重建的示意写法；测试断言以最终语义为准（aspect/fps/单片段/字幕导入）。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/edit-film-plan.test.ts && npm run typecheck
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 14: 工程化剪辑状态、草稿与版本

**Files:**
- Modify: `backend/src/services/edit-service.ts`（重写）
- Modify: `backend/src/services/edit-draft-service.ts`（重写为工程作用域）
- Modify: `backend/src/services/edit-revision-service.ts`（重写为工程作用域）
- Modify: `backend/src/services/edit-bootstrap.ts`（`persistInitialEditPlan` 增加工程维度）
- Modify: `backend/src/routes/edit.ts`
- Modify: `backend/tests/edit-route.test.ts`、`backend/tests/edit-draft-route.test.ts`、`backend/tests/edit-revision-route.test.ts`
- Test: `backend/tests/edit-project-state.test.ts`

**Interfaces:**
- Consumes: Task 12 `resolveEditProject/openProjectForFilm/projectResponse/listEditProjects`、Task 13 `buildFilmEditPlan`、Task 2 `listFilms`。
- Produces: `getEpisodeEditState(episodeId, projectIdParam?)`；`draftFor(projectId)`、`currentRevisionFor(projectId)`、`draftDirtyFor(projectId)`；`saveEditDraft(episodeId, project, input)`、`discardEditDraft(project)`；`listEditRevisions(project)`、`getEditRevision(project, revisionId)`、`createEditRevision(project, input)`、`restoreEditRevision(project, revisionId, input)`。
- 状态响应新增：`project`（projectResponse 或 null）、`projects`（工程列表）、`films`（仅无工程时）、`empty_reason: 'NO_FILM'`、`legacy_project`。
- 裁定（Ruling）：一键初剪与字幕建议仅对旧版工程（`source_merge_id === null`）可用；成片工程返回 `409 EDIT_ACTION_LEGACY_ONLY`。原因：分镜不作为剪辑素材入口、不按台词本生成字幕（设计 §6.2、§6.1）。

- [ ] **Step 1: 写失败测试**

在 `backend/tests/edit-project-state.test.ts` 写入（完整文件）：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-state-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const { openProjectForFilm } = await import('../src/services/edit-project-service.ts')

const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '工程状态', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const filmFile = path.join(videoDir, 'film.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  filmFile,
], { stdio: 'ignore' })
const filmUrl = `static/projects/${drama.id}/videos/film.mp4`

const emptyEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '无成片', createdAt: ts, updatedAt: ts,
}).returning().get()
const filmEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '有成片', createdAt: ts, updatedAt: ts,
}).returning().get()

const film = db.insert(schema.videoMerges).values({
  episodeId: filmEpisode.id, dramaId: drama.id, title: '拼接成片 A',
  status: 'completed', mergedUrl: filmUrl, kind: 'concat', createdAt: ts,
}).returning().get()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function getEdit(episodeId: number, query = ''): Promise<any> {
  const response = await app.request(`/episodes/${episodeId}/edit${query}`)
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()).data
}

test('无成片：空态不建工程、不写草稿', async () => {
  setEditWorkspaceMode('on')
  const data = await getEdit(emptyEpisode.id)
  assert.equal(data.empty_reason, 'NO_FILM')
  assert.equal(data.project, null)
  assert.deepEqual(data.plan.clips, [])
  assert.deepEqual(data.films, [])
  assert.equal(data.capabilities.can_edit, true)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === emptyEpisode.id)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === emptyEpisode.id)
  assert.equal(drafts.length, 0)
  assert.equal(revisions.length, 0)
})

test('on 模式进入成片：自动创建工程并落初始计划与版本', async () => {
  setEditWorkspaceMode('on')
  const data = await getEdit(filmEpisode.id)
  assert.ok(data.project)
  assert.equal(data.project.source_merge_id, film.id)
  assert.equal(data.project.film_title, '拼接成片 A')
  assert.equal(data.legacy_project, false)
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.plan.clips[0].source.kind, 'merge')
  assert.equal(data.plan.clips[0].source.url, filmUrl)
  assert.ok(data.current_revision)
  assert.equal(data.draft_dirty, false)

  const project = openProjectForFilm(filmEpisode.id, film.id).project
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.projectId === project.id)
  assert.equal(drafts.length, 1)
  const opened = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, filmEpisode.id)).get()
  assert.equal(opened?.editProjectId, project.id)

  // 再次进入复用同一工程与草稿
  const again = await getEdit(filmEpisode.id)
  assert.equal(again.project.id, data.project.id)
  assert.equal(again.draft.version, data.draft.version)
})

test('readonly 模式不落库：返回临时计划且不创建工程', async () => {
  setEditWorkspaceMode('readonly')
  const freshEpisode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 3, title: '只读集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.videoMerges).values({
    episodeId: freshEpisode.id, dramaId: drama.id, title: '成片 B',
    status: 'completed', mergedUrl: filmUrl, kind: 'concat', createdAt: ts,
  }).run()
  const data = await getEdit(freshEpisode.id)
  assert.equal(data.project, null)
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.capabilities.can_edit, false)
  const projects = db.select().from(schema.editProjects).all()
    .filter((row) => row.episodeId === freshEpisode.id)
  assert.equal(projects.length, 0)
})

test('显式 project_id 优先，跨集工程返回 404', async () => {
  setEditWorkspaceMode('on')
  const other = openProjectForFilm(filmEpisode.id, film.id).project
  const data = await getEdit(filmEpisode.id, `?project_id=${other.id}`)
  assert.equal(data.project.id, other.id)

  const missing = await app.request(`/episodes/${filmEpisode.id}/edit?project_id=999999`)
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'EDIT_PROJECT_NOT_FOUND')
})

test('草稿与版本按工程隔离，指针只更新打开中的工程', async () => {
  setEditWorkspaceMode('on')
  const data = await getEdit(filmEpisode.id)
  const projectId = data.project.id

  const save = await app.request(`/episodes/${filmEpisode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: data.draft.version, plan: data.plan }),
  })
  assert.equal(save.status, 200, await save.clone().text())
  const saved = (await save.json()).data
  assert.equal(saved.version, data.draft.version + 1)

  const revision = await app.request(`/episodes/${filmEpisode.id}/edit/revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: saved.version, note: 'v1' }),
  })
  assert.equal(revision.status, 200, await revision.clone().text())
  const revisionData = (await revision.json()).data
  assert.equal(revisionData.revision.revision_no, 2)

  const listed = await app.request(`/episodes/${filmEpisode.id}/edit/revisions?project_id=${projectId}`)
  const listedData = (await listed.json()).data
  assert.equal(listedData.items.length, 2)
  assert.ok(listedData.items.every((item: any) => item.project_id === projectId))
})

test('初剪/字幕建议在成片工程上返回 409 EDIT_ACTION_LEGACY_ONLY', async () => {
  setEditWorkspaceMode('on')
  const data = await getEdit(filmEpisode.id)
  const rough = await app.request(`/episodes/${filmEpisode.id}/edit/rough-cut`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: data.project.id, mode: 'replace', plan: data.plan }),
  })
  assert.equal(rough.status, 409)
  assert.equal((await rough.json()).code, 'EDIT_ACTION_LEGACY_ONLY')
})
```

同时修改 `backend/tests/edit-route.test.ts`、`edit-draft-route.test.ts`、`edit-revision-route.test.ts` 的夹具（三个文件同样的改法）：

1. 在创建 `episode` 与视频文件之后，插入成片行并打开工程：

```ts
const film = db.insert(schema.videoMerges).values({
  episodeId: episode.id, dramaId: drama.id, title: '成片',
  status: 'completed', mergedUrl: sourceUrl, kind: 'concat', createdAt: ts,
}).returning().get()
const { openProjectForFilm } = await import('../src/services/edit-project-service.ts')
const project = openProjectForFilm(episode.id, film.id).project
```

2. 所有种子草稿/版本行增加 `projectId: project.id`；`draftEpisode` 等“草稿优先”夹具同样为各自集建工程。
3. 请求体/查询串带 `project_id`（PUT draft、POST revisions、GET revisions）。
4. 空集断言改为 `empty_reason === 'NO_FILM'`、`project === null`、`films` 数组为空；去掉“当前成片 bootstrap 为单片段（episode-video）”测试中 `source.kind === 'episode-video'` 的断言，改为 `source.kind === 'merge'` 且 `data.project.source_merge_id === film.id`。
5. “on 模式不写草稿”测试改为断言 `empty_reason`（无成片时空态不写）；新增 on 模式 + 成片的落库断言（同 edit-project-state.test.ts）。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/edit-project-state.test.ts
```

- [ ] **Step 3: 实现工程作用域服务**

`backend/src/services/edit-draft-service.ts` 整体替换为：

```ts
/**
 * 工程草稿写入（设计 §6.1、§6.11）：保存与丢弃。
 * 草稿按 project_id 唯一（idx_edit_drafts_project）；写闸门（off/readonly 403）
 * 先于计划归一化与任何写行；保存走 BEGIN IMMEDIATE 事务并在事务内二次校验版本。
 */
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWritableEpisode } from './edit-access.js'
import { throwVersionConflict } from './edit-conflict.js'
import { EditWorkspaceError } from './edit-errors.js'
import {
  computeLayout,
  editSyncHashOf,
  planHashOf,
  type EditProjectSettings,
} from './edit-plan.js'
import { normalizeEditPlan } from './edit-normalize.js'
import { layoutResponse, parsePlanJson, planHashes } from './edit-response.js'
import { loadEditTimelineData } from './edit-timeline-data.js'
import { buildEditTimeline, dialogPlacementsOf } from './edit-timeline.js'
import type { EditProjectRow } from './edit-project-service.js'

export function draftFor(projectId: number) {
  return db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.projectId, projectId))
    .get() ?? null
}

export function currentRevisionFor(projectId: number) {
  return db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.projectId, projectId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.editRevisions.createdAt), desc(schema.editRevisions.id))
    .get() ?? null
}

export function draftDirtyFor(projectId: number): boolean {
  const draft = draftFor(projectId)
  const revision = currentRevisionFor(projectId)
  return Boolean(draft) && (
    !revision
    || !revision.planHash
    || draft!.planHash !== revision.planHash
  )
}

function projectSettingsFor(project: EditProjectRow): EditProjectSettings {
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, project.dramaId)).get()
  const raw = drama?.aspectRatio
  const aspect = raw === '9:16' || raw === '16:9' || raw === '1:1' ? raw : '16:9'
  const width = aspect === '16:9' ? 1920 : 1080
  const height = aspect === '16:9' ? 1080 : 1920
  return {
    aspect,
    width,
    height,
    fps: 30,
    background: 'black',
    defaultFit: aspect === '16:9' ? 'fit' : 'fill',
    defaultTransition: 'cut',
    defaultSubtitleStyle: 'default',
    defaultExportPreset: aspect === '9:16' ? 'edit-vertical-hd' : 'edit-horizontal-hd',
    tailGapMs: 0,
  }
}

export async function saveEditDraft(
  episodeId: number,
  project: EditProjectRow,
  input: Record<string, unknown>,
) {
  const episode = getWritableEpisode(episodeId)
  const fallback = projectSettingsFor(project)
  const { plan, issues } = normalizeEditPlan(input.plan, {
    episodeId,
    project: fallback,
  })
  const rawBaseVersion = input.base_version
  const baseVersion = typeof rawBaseVersion === 'number' ? rawBaseVersion : Number.NaN
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new EditWorkspaceError(400, 'EDIT_BASE_VERSION', '缺少有效的 base_version')
  }
  const force = input.force === true
  const before = draftFor(project.id)
  if (!force && (before?.version ?? 0) !== baseVersion) {
    throwVersionConflict(episodeId, before)
  }

  const ts = new Date().toISOString()
  const planJson = JSON.stringify(plan)
  const planHash = planHashOf(plan)
  const syncHash = editSyncHashOf(plan)
  const revision = currentRevisionFor(project.id)
  const result = db.transaction((tx) => {
    const live = tx.select().from(schema.episodeEditDrafts)
      .where(eq(schema.episodeEditDrafts.projectId, project.id))
      .get()
    if (!force && (live?.version ?? 0) !== baseVersion) {
      return { conflict: live ?? undefined, version: 0 }
    }
    const version = (live?.version ?? 0) + 1
    if (live) {
      tx.update(schema.episodeEditDrafts).set({
        planJson, planHash, editSyncHash: syncHash, version,
        baseRevisionId: revision?.id ?? null, updatedAt: ts,
      }).where(eq(schema.episodeEditDrafts.projectId, project.id)).run()
    } else {
      tx.insert(schema.episodeEditDrafts).values({
        episodeId: project.episodeId,
        dramaId: project.dramaId,
        projectId: project.id,
        planJson, planHash, editSyncHash: syncHash, version,
        baseRevisionId: revision?.id ?? null,
        createdAt: ts, updatedAt: ts,
      }).run()
    }
    return { conflict: null, version }
  }, { behavior: 'immediate' })

  if (result.conflict !== null || result.version === 0) {
    throwVersionConflict(episodeId, result.conflict ?? undefined)
  }

  const { lines, takes } = loadEditTimelineData(episodeId)
  const timeline = buildEditTimeline(plan, lines, takes)
  return {
    version: result.version,
    updated_at: ts,
    plan,
    layout: layoutResponse(computeLayout(plan)),
    hashes: planHashes(plan, dialogPlacementsOf(timeline.linePlacements)),
    issues,
    draft_dirty: draftDirtyFor(project.id),
  }
}

export function discardEditDraft(project: EditProjectRow) {
  getWritableEpisode(project.episodeId)
  const result = db.delete(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.projectId, project.id))
    .run()
  return { discarded: result.changes > 0 }
}
```

`backend/src/services/edit-revision-service.ts` 整体替换为：

```ts
/**
 * 不可变剪辑版本（工程作用域）：版本号按工程自增；恢复 = 以旧计划建新版本。
 * episodes 指针只在被改工程是当前打开工程时同步。
 */
import { and, desc, eq, max } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWritableEpisode } from './edit-access.js'
import { throwVersionConflict } from './edit-conflict.js'
import { EditWorkspaceError } from './edit-errors.js'
import {
  computeLayout,
  editSyncHashOf,
  planHashOf,
  renderHashOf,
} from './edit-plan.js'
import { normalizeEditPlan } from './edit-normalize.js'
import { parsePlanJson, revisionResponse } from './edit-response.js'
import { draftDirtyFor, draftFor, currentRevisionFor } from './edit-draft-service.js'
import type { EditProjectRow } from './edit-project-service.js'

export function listEditRevisions(project: EditProjectRow) {
  const items = db.select().from(schema.editRevisions)
    .where(eq(schema.editRevisions.projectId, project.id))
    .orderBy(desc(schema.editRevisions.revisionNo), desc(schema.editRevisions.id))
    .all()
    .map((row) => ({ ...revisionResponse(row), project_id: row.projectId }))
  return { items }
}

export function getEditRevision(project: EditProjectRow, revisionId: number) {
  const row = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.id, revisionId),
      eq(schema.editRevisions.projectId, project.id),
    ))
    .get()
  if (!row) throw new EditWorkspaceError(404, 'EDIT_REVISION_NOT_FOUND', '剪辑版本不存在')
  const plan = parsePlanJson(row.planJson)
  if (!plan) throw new EditWorkspaceError(500, 'EDIT_REVISION_CORRUPT', '版本计划损坏')
  return { revision: revisionResponse(row), plan }
}

function fallbackSettingsOf(project: EditProjectRow) {
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, project.dramaId)).get()
  const raw = drama?.aspectRatio
  const aspect = raw === '9:16' || raw === '16:9' || raw === '1:1' ? raw : '16:9'
  return {
    aspect,
    width: aspect === '16:9' ? 1920 : 1080,
    height: aspect === '16:9' ? 1080 : 1920,
    fps: 30,
    background: 'black' as const,
    defaultFit: (aspect === '16:9' ? 'fit' : 'fill') as 'fit' | 'fill',
    defaultTransition: 'cut' as const,
    defaultSubtitleStyle: 'default' as const,
    defaultExportPreset: aspect === '9:16' ? 'edit-vertical-hd' : 'edit-horizontal-hd',
    tailGapMs: 0,
  }
}

export function createEditRevision(
  project: EditProjectRow,
  input: Record<string, unknown>,
) {
  const episodeId = project.episodeId
  getWritableEpisode(episodeId)
  const fallback = fallbackSettingsOf(project)
  const draft = draftFor(project.id)
  const current = currentRevisionFor(project.id)

  const source = input.plan
    ?? parsePlanJson(draft?.planJson)
    ?? parsePlanJson(current?.planJson)
  if (source == null) {
    throw new EditWorkspaceError(400, 'EDIT_PLAN_INVALID', '没有可保存的计划')
  }
  const { plan } = normalizeEditPlan(source, { episodeId, project: fallback })
  const force = input.force === true
  const baseVersion = input.base_version === undefined || input.base_version === null
    ? null
    : Number(input.base_version)
  if (baseVersion !== null && (!Number.isSafeInteger(baseVersion) || baseVersion < 0)) {
    throw new EditWorkspaceError(400, 'EDIT_BASE_VERSION', '缺少有效的 base_version')
  }
  if (!force && baseVersion !== null && (draft?.version ?? 0) !== baseVersion) {
    throwVersionConflict(episodeId, draft)
  }

  const updateDraft = input.update_draft !== false
  const note = typeof input.note === 'string' && input.note.trim()
    ? input.note.trim().slice(0, 200)
    : null
  const ts = new Date().toISOString()
  const planJson = JSON.stringify(plan)
  const planHash = planHashOf(plan)
  const syncHash = editSyncHashOf(plan)
  const layout = computeLayout(plan)

  const result = db.transaction((tx) => {
    const liveDraft = tx.select().from(schema.episodeEditDrafts)
      .where(eq(schema.episodeEditDrafts.projectId, project.id))
      .get()
    if (!force && baseVersion !== null && (liveDraft?.version ?? 0) !== baseVersion) {
      return { conflict: liveDraft ?? null, revision: null, draftVersion: null }
    }
    const maxRow = tx.select({ value: max(schema.editRevisions.revisionNo) })
      .from(schema.editRevisions)
      .where(eq(schema.editRevisions.projectId, project.id))
      .get()
    const revisionNo = Number(maxRow?.value ?? 0) + 1

    tx.update(schema.editRevisions)
      .set({ isCurrent: false })
      .where(and(
        eq(schema.editRevisions.projectId, project.id),
        eq(schema.editRevisions.isCurrent, true),
      ))
      .run()
    const inserted = tx.insert(schema.editRevisions).values({
      episodeId,
      projectId: project.id,
      revisionNo,
      planJson,
      planHash,
      editSyncHash: syncHash,
      renderHash: renderHashOf(plan),
      durationMs: layout.durationMs,
      clipCount: plan.clips.length,
      note,
      isCurrent: true,
      createdAt: ts,
    }).returning().get()

    const episode = tx.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId)).get()
    if (episode?.editProjectId === project.id) {
      tx.update(schema.episodes).set({
        editRevisionId: inserted.id,
        editPlanHash: planHash,
        editSyncHash: syncHash,
        editEnabled: true,
        updatedAt: ts,
      }).where(eq(schema.episodes.id, episodeId)).run()
    }

    let draftVersion = liveDraft?.version ?? null
    if (updateDraft) {
      draftVersion = (liveDraft?.version ?? 0) + 1
      if (liveDraft) {
        tx.update(schema.episodeEditDrafts).set({
          planJson, planHash, editSyncHash: syncHash, version: draftVersion,
          baseRevisionId: inserted.id, updatedAt: ts,
        }).where(eq(schema.episodeEditDrafts.projectId, project.id)).run()
      } else {
        tx.insert(schema.episodeEditDrafts).values({
          episodeId,
          dramaId: project.dramaId,
          projectId: project.id,
          planJson, planHash, editSyncHash: syncHash, version: draftVersion,
          baseRevisionId: inserted.id, createdAt: ts, updatedAt: ts,
        }).run()
      }
    }
    return { conflict: null, revision: inserted, draftVersion }
  }, { behavior: 'immediate' })

  if (result.conflict !== null || !result.revision) {
    throwVersionConflict(episodeId, result.conflict ?? undefined)
  }

  return {
    revision: revisionResponse(result.revision),
    draft_version: result.draftVersion,
    draft_dirty: draftDirtyFor(project.id),
  }
}

export function restoreEditRevision(
  project: EditProjectRow,
  revisionId: number,
  input: Record<string, unknown>,
) {
  getWritableEpisode(project.episodeId)
  const row = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.id, revisionId),
      eq(schema.editRevisions.projectId, project.id),
    ))
    .get()
  if (!row) throw new EditWorkspaceError(404, 'EDIT_REVISION_NOT_FOUND', '剪辑版本不存在')
  const plan = parsePlanJson(row.planJson)
  if (!plan) throw new EditWorkspaceError(500, 'EDIT_REVISION_CORRUPT', '版本计划损坏')
  return createEditRevision(project, {
    plan,
    base_version: input.base_version,
    note: `恢复自版本 v${row.revisionNo}`,
    update_draft: true,
  })
}
```

`backend/src/services/edit-bootstrap.ts`：`persistInitialEditPlan` 增加工程维度——签名改为：

```ts
export function persistInitialProjectPlan(input: {
  episodeId: number
  dramaId: number
  projectId: number
  plan: EditPlanV1
  mode: EditWorkspaceMode
}): { revisionId: number | null; draftVersion: number | null; plan: EditPlanV1; created: boolean }
```

实现与原 `persistInitialEditPlan` 相同，差异仅三处：现有版本查询加 `eq(schema.editRevisions.projectId, input.projectId)`；`revisionNo` 的 max 查询加工程过滤；draft 读/删/写均按 `projectId`（insert 增加 `projectId: input.projectId`）。`episodes` 指针更新（`editRevisionId/editPlanHash/editSyncHash/editEnabled`）包一层条件：仅当 `episodes.editProjectId === input.projectId` 时写。旧的 `persistInitialEditPlan` 删除（唯一调用方在本任务的 `edit-service.ts` 重写里）。

`backend/src/services/edit-service.ts` 整体替换为（保持原 mix_status/lock/audio 逻辑不变，此处给全量骨架与关键差异，其余照抄原实现）：

```ts
/**
 * 剪辑工作台状态（工程化）：读优先级 草稿 → 当前版本 → 成片初始计划 → 空计划。
 * 工程解析：显式 project_id → episodes.edit_project_id → 当前成片工程 → 最新工程；
 * 无工程且 on 模式且有可用成片时打开第一个成片的工程；无成片返回空态，不建工程。
 */
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  aspectOf,
  computeLayout,
  dialogueSyncHashOf,
  projectSettingsForAspect,
  validateEditPlan,
  createEmptyEditPlan,
  type EditIssue,
  type EditPlanV1,
} from './edit-plan.js'
import { getReadableEpisode } from './edit-access.js'
import { hasStoryboardMedia } from './edit-bootstrap.js'
import { persistInitialProjectPlan } from './edit-bootstrap.js'
import { buildFilmEditPlan } from './edit-film-plan.js'
import {
  draftFor,
  currentRevisionFor,
  draftDirtyFor,
} from './edit-draft-service.js'
import {
  listEditProjects,
  openProjectForFilm,
  projectResponse,
  resolveEditProject,
  type EditProjectRow,
} from './edit-project-service.js'
import { listFilms } from './film-hub.js'
import { layoutResponse, parsePlanJson, planHashes, revisionResponse } from './edit-response.js'
import { buildTimelineForPlan, placementsResponse } from './edit-timeline-data.js'
import { dialogPlacementsOf } from './edit-timeline.js'

function emptyStateOf(episode, mode, projects, reason: 'NO_FILM') {
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId)).get()
  const plan = createEmptyEditPlan(episode.id, projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30))
  const films = listFilms(episode.id, 50).films.filter((film) => Boolean(film.url))
  return {
    episode_id: episode.id,
    episode_number: episode.episodeNumber,
    enabled: true,
    mode,
    empty_reason: reason,
    project: null,
    projects,
    films,
    legacy_project: false,
    draft: null,
    current_revision: null,
    current_revision_plan: null,
    plan,
    layout: layoutResponse(computeLayout(plan)),
    hashes: planHashes(plan),
    draft_dirty: false,
    mix_status: { status: 'missing', reasons: [], edit_revision_id: null, mix_revision_id: null, summary: null },
    renders: { cut: null, audio_ref: null },
    audio: { mode: 'none' as const },
    media_warnings: [],
    line_placements: placementsResponse([]),
    rough_cut_available: false,
    capabilities: { can_edit: mode === 'on', can_export: false, lock: null },
  }
}

export async function getEpisodeEditState(episodeId: number, projectIdParam?: number | null) {
  const { episode, mode } = getReadableEpisode(episodeId)
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId)).get()
  const projects = listEditProjects(episodeId).items

  let project: EditProjectRow | null = resolveEditProject(episodeId, projectIdParam ?? null)
  const warnings: EditIssue[] = []

  if (!project && mode === 'on') {
    const films = listFilms(episodeId, 50).films.filter((film) => Boolean(film.url))
    if (films.length > 0) {
      project = openProjectForFilm(episodeId, films[0].id).project
    }
  }
  if (!project) return emptyStateOf(episode, mode, projects, 'NO_FILM')

  let draft = draftFor(project.id)
  let revision = currentRevisionFor(project.id)

  let plan = parsePlanJson(draft?.planJson)
  if (draft && !plan) {
    warnings.push({ severity: 'warning', code: 'DRAFT_INVALID', path: 'draft.plan_json', message: '草稿计划损坏，已忽略' })
  }
  let revisionPlan = parsePlanJson(revision?.planJson)
  if (revision && !revisionPlan) {
    warnings.push({ severity: 'warning', code: 'REVISION_INVALID', path: 'revision.plan_json', message: '版本计划损坏，已忽略' })
  }
  if (!plan) plan = revisionPlan

  if (!plan) {
    const projectSettings = projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30)
    if (project.sourceMergeId && project.sourceUrl) {
      const filmRow = db.select().from(schema.videoMerges)
        .where(eq(schema.videoMerges.id, project.sourceMergeId)).get()
      if (filmRow) {
        const built = await buildFilmEditPlan({
          episodeId: episode.id,
          film: filmRow,
          warnings,
        })
        if (built) {
          const persisted = persistInitialProjectPlan({
            episodeId: episode.id,
            dramaId: episode.dramaId,
            projectId: project.id,
            plan: built,
            mode,
          })
          plan = persisted.plan
          if (persisted.initializedRevisionId ?? persisted.revisionId) {
            draft = draftFor(project.id)
            revision = currentRevisionFor(project.id)
            revisionPlan = parsePlanJson(revision?.planJson)
          }
        }
      }
    }
    if (!plan) plan = createEmptyEditPlan(episode.id, projectSettings)
  } else {
    warnings.push(...validateEditPlan(plan))
  }

  // ……以下与原实现一致：timeline/line_placements/hash/mix_status/lock/audio/singleSource……
  // 唯一差异：draftDirty 用 draftDirtyFor(project.id)；
  // 响应新增 project/projects/legacy_project 字段：
  return {
    episode_id: episode.id,
    episode_number: episode.episodeNumber,
    enabled: true,
    mode,
    empty_reason: null,
    project: projectResponse(project),
    projects,
    legacy_project: !project.sourceMergeId,
    // ……draft/current_revision/current_revision_plan/plan/layout/hashes/draft_dirty/
    //   mix_status/renders/audio/media_warnings/line_placements/rough_cut_available/capabilities
    //   全部沿用原实现字段……
    rough_cut_available: !project.sourceMergeId && hasStoryboardMedia(episode.id),
    capabilities: { can_edit: mode === 'on', can_export: false, lock: null },
  }
}
```

> 实现注意：`persistInitialProjectPlan` 返回 `{ revisionId, draftVersion, plan, created }`（无 `initializedRevisionId`），重载判断直接用 `persisted.revisionId`。注释“与原实现一致”的部分必须逐字保留原 `getEpisodeEditState` 的对应代码（`buildTimelineForPlan`、`dialogueSyncHashOf`、`mix_status`、`episodeLocks`、`singleSource`/`audio`），只是把 `draftDirty` 换成 `draftDirtyFor(project.id)`、`rough_cut_available` 加工程条件。

`backend/src/routes/edit.ts` 的改动：

```ts
// GET /episodes/:id/edit
app.get('/episodes/:id/edit', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const rawProjectId = Number(c.req.query('project_id'))
  const projectId = Number.isSafeInteger(rawProjectId) && rawProjectId > 0 ? rawProjectId : null
  try {
    return success(c, await getEpisodeEditState(episodeId, projectId))
  } catch (error) {
    return handleEditError(c, error)
  }
})
```

草稿/版本/恢复/初剪/字幕建议统一用 helper 解析工程（放在文件顶部）：

```ts
import {
  resolveEditProject,
  requireEditProject,
  type EditProjectRow,
} from '../services/edit-project-service.js'
import { EditWorkspaceError } from '../services/edit-errors.js'

async function projectFromBody(
  c: Context,
  episodeId: number,
  body: Record<string, unknown>,
): Promise<EditProjectRow> {
  const raw = Number(body.project_id)
  const projectId = Number.isSafeInteger(raw) && raw > 0 ? raw : null
  const project = resolveEditProject(episodeId, projectId)
  if (!project) throw new EditWorkspaceError(409, 'EDIT_NO_PROJECT', '本集没有可编辑的剪辑工程')
  return project
}
```

- `PUT /episodes/:id/edit/draft`：`getWritableEpisode(episodeId)` 后 `const body = await readBody(c)`，`saveEditDraft(episodeId, await projectFromBody(c, episodeId, body), body)`。
- `DELETE /episodes/:id/edit/draft`：`discardEditDraft(await projectFromBody(c, episodeId, {}))`。
- `GET /episodes/:id/edit/revisions`：`project_id` 从 query 解析，`listEditRevisions(project)`；无工程时空列表 `{ items: [] }`。
- `GET /episodes/:id/edit/revisions/:revisionId`：`getEditRevision(project, revisionId)`。
- `POST /episodes/:id/edit/revisions`：`createEditRevision(project, body)`。
- `POST .../restore`：`restoreEditRevision(project, revisionId, body)`。
- `POST /episodes/:id/edit/rough-cut` 与 `POST /episodes/:id/edit/subtitles/suggest`：解析工程后，若 `project.sourceMergeId` 非空，返回：

```ts
return c.json({ code: 'EDIT_ACTION_LEGACY_ONLY', message: '该动作仅适用于旧版工程（按分镜生成）' }, 409)
```

否则保持原逻辑，并把工程草稿的读取/写入切到工程作用域（`edit-actions-service.ts` 内部对 `episodeEditDrafts`/`editRevisions` 的读写按 `projectId` 过滤，草稿不存在时以版本为基准，返回 envelope 不落库的行为不变）。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/edit-project-state.test.ts tests/edit-route.test.ts tests/edit-draft-route.test.ts tests/edit-revision-route.test.ts tests/edit-actions.test.ts
cd backend && npm run typecheck
```

预期：全部通过；`edit-actions.test.ts` 如使用分镜工程，按夹具改法补 `projectId`。

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 15: 字幕外观模型与 ASS/SRT 生成

**Files:**
- Modify: `backend/src/services/edit-plan.ts`（类型与默认值）
- Modify: `backend/src/services/edit-normalize.ts`（外观归一化）
- Create: `backend/src/services/edit-subtitle-ass.ts`
- Test: `backend/tests/edit-subtitle-ass.test.ts`、`backend/tests/edit-normalize.test.ts`（扩展）

**Interfaces:**
- Consumes: `EditSubtitleCue`/`EditProjectSettings`（edit-plan.ts 现状）、`formatAssTime`/`toSrt`（subtitles.ts）、`EditIssue`/`issue()`（edit-normalize.ts 内部）。
- Produces（后续任务依赖的精确签名）:
  - `EditSubtitleStyle = 'default' | 'outline' | 'box' | 'custom'`
  - `interface EditSubtitleAppearance { fontFamily: string; fontSize: number; color: string; strokeColor: string; strokeWidth: number; backgroundColor: string | null; backgroundOpacity: number; align: 'left'|'center'|'right'; xPct: number; yPct: number }`
  - `EditProjectSettings` 新增 `subtitleAppearance: EditSubtitleAppearance` 与 `subtitleSafeAreaPct: number`（默认 8）
  - `subtitleAppearanceForPreset(style: EditSubtitleStyle): EditSubtitleAppearance`（edit-plan.ts 导出）
  - `SUBTITLE_FONT_WHITELIST: readonly string[]`
  - `resolveSubtitleAppearance(cue, plan): RequiredAppearance`（edit-subtitle-ass.ts 导出；cue.appearance > project.subtitleAppearance > 按 cue.style 的预设默认）
  - `assAlignmentFor(align, yPct): 1|2|3|4|5|6|7|8|9`
  - `buildEditAss(plan: EditPlanV1): string`
  - `buildEditSrt(plan: EditPlanV1): string`
  - `fallbackExportFont(fontFamily: string, available: readonly string[]): string`

- [ ] **Step 1: 写失败测试**

`backend/tests/edit-subtitle-ass.test.ts` 新建：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assAlignmentFor,
  buildEditAss,
  buildEditSrt,
  fallbackExportFont,
  resolveSubtitleAppearance,
} from '../src/services/edit-subtitle-ass.ts'
import { createSingleClipPlan, projectSettingsForAspect } from '../src/services/edit-plan.ts'

function planWithCue(style: any, appearance: any) {
  const plan = createSingleClipPlan(1, {
    ...projectSettingsForAspect('9:16', 30),
    width: 1080,
    height: 1920,
  }, {
    kind: 'episode-video',
    id: 1,
    url: 'static/projects/1/videos/film.mp4',
    durationMs: 10_000,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    fingerprint: 'fp-1',
  })
  plan.subtitles = [{
    id: 'cue_1',
    text: '你好，世界',
    startMs: 1000,
    endMs: 3000,
    style,
    role: null,
    source: 'manual',
    follow: false,
    anchor: null,
    lineId: null,
    warnings: [],
    ...(appearance ? { appearance } : {}),
  }]
  return plan
}

test('底部居中映射 \\an2 与 \\pos(540, 1632)', () => {
  const plan = planWithCue('custom', null)
  const ass = buildEditAss(plan)
  const line = ass.split('\n').find((l) => l.startsWith('Dialogue:'))
  assert.ok(line)
  assert.ok(line!.includes('\\an2'), line)
  assert.ok(line!.includes('\\pos(540,1632)'), line)
})

test('对齐 × 纵向区映射九宫格 an 值', () => {
  assert.equal(assAlignmentFor('left', 10), 7)
  assert.equal(assAlignmentFor('center', 10), 8)
  assert.equal(assAlignmentFor('right', 10), 9)
  assert.equal(assAlignmentFor('left', 50), 4)
  assert.equal(assAlignmentFor('center', 50), 5)
  assert.equal(assAlignmentFor('center', 85), 2)
  assert.equal(assAlignmentFor('right', 85), 3)
  assert.equal(assAlignmentFor('left', 85), 1)
})

test('cue 外观覆盖工程默认：字号/颜色/描边内联标签', () => {
  const plan = planWithCue('custom', {
    fontFamily: 'KaiTi', fontSize: 64, color: '#FF0000', strokeColor: '#00FF00',
    strokeWidth: 3, backgroundColor: null, backgroundOpacity: 0,
    align: 'center', xPct: 50, yPct: 85,
  })
  const line = buildEditAss(plan).split('\n').find((l) => l.startsWith('Dialogue:'))
  assert.ok(line!.includes('\\fnKaiTi'))
  assert.ok(line!.includes('\\fs64'))
  assert.ok(line!.includes('\\1c&H0000FF&'))
  assert.ok(line!.includes('\\3c&H00FF00&'))
  assert.ok(line!.includes('\\bord3'))
})

test('旧计划无 appearance：按 style 预设解析（outline 描边 4）', () => {
  const plan = planWithCue('outline', null)
  const resolved = resolveSubtitleAppearance(plan.subtitles[0], plan)
  assert.equal(resolved.strokeWidth, 4)
  const line = buildEditAss(plan).split('\n').find((l) => l.startsWith('Dialogue:'))
  assert.ok(line!.includes('\\bord4'))
})

test('有背景色的 cue 使用 Boxed 样式并带 \\4c 透明度', () => {
  const plan = planWithCue('box', null)
  const line = buildEditAss(plan).split('\n').find((l) => l.startsWith('Dialogue:'))
  assert.ok(line!.includes('Boxed,'))
  assert.ok(/\\4c&H[0-9A-F]{6}&/.test(line!))
  assert.ok(/\\4a&H[0-9A-F]{2}&/.test(line!))
})

test('SRT 按时间排序且含序号/时间行', () => {
  const plan = planWithCue('default', null)
  plan.subtitles.push({ ...plan.subtitles[0], id: 'cue_0', startMs: 0, endMs: 500 })
  const srt = buildEditSrt(plan)
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:00,500\n'))
  assert.ok(srt.includes('2\n00:00:01,000 --> 00:00:03,000\n你好，世界\n'))
})

test('导出字体回退：白名单缺失时逐级降级', () => {
  assert.equal(fallbackExportFont('PingFang SC', ['Noto Sans CJK SC']), 'Noto Sans CJK SC')
  assert.equal(fallbackExportFont('PingFang SC', ['PingFang SC']), 'PingFang SC')
  assert.equal(fallbackExportFont('KaiTi', ['Noto Sans CJK SC']), 'Noto Sans CJK SC')
  assert.equal(fallbackExportFont('KaiTi', []), 'sans-serif')
})
```

`backend/tests/edit-normalize.test.ts` 追加（放在文件末尾，复用现有夹具构造方式）：

```ts
test('字幕外观归一化：custom 接受、未知字体回退并警告、数值夹取', async () => {
  const plan = buildValidPlanFixture() // 沿用本文件现有的最小合法计划构造
  plan.project.subtitleAppearance = {
    fontFamily: 'NotAFont', fontSize: 500, color: 'red', strokeColor: '#000000',
    strokeWidth: 99, backgroundColor: '#000000', backgroundOpacity: 200,
    align: 'diagonal', xPct: -5, yPct: 150,
  }
  plan.subtitles.push({
    id: 'cue_x', text: '测试', startMs: 0, endMs: 500, style: 'custom',
    role: null, source: 'manual', follow: false, anchor: null, lineId: null,
    warnings: [],
    appearance: { ...plan.project.subtitleAppearance },
  })
  const issues: EditIssue[] = []
  const normalized = normalizeEditPlan(plan, issues)
  const project = normalized.project.subtitleAppearance
  assert.equal(project.fontFamily, 'PingFang SC')
  assert.equal(project.fontSize, 120)
  assert.equal(project.color, '#FFFFFF')
  assert.equal(project.strokeWidth, 8)
  assert.equal(project.backgroundOpacity, 100)
  assert.equal(project.align, 'center')
  assert.equal(project.xPct, 0)
  assert.equal(project.yPct, 100)
  assert.ok(issues.some((i) => i.code === 'SUBTITLE_FONT' && i.severity === 'warning'))
  assert.equal(normalized.subtitles[0].style, 'custom')
  assert.equal(normalized.project.subtitleSafeAreaPct, 8)
})

test('旧计划（无 subtitleAppearance/appearance）归一化不报错且默认来自 defaultSubtitleStyle', async () => {
  const plan = buildValidPlanFixture()
  // 不设置 subtitleAppearance 与 cue.appearance
  const issues: EditIssue[] = []
  const normalized = normalizeEditPlan(plan, issues)
  assert.equal(normalized.project.subtitleAppearance.fontSize, 48)
  assert.equal(normalized.project.subtitleSafeAreaPct, 8)
  assert.equal(normalized.subtitles[0].appearance, undefined)
})
```

> `buildValidPlanFixture` 为该测试文件中现有的合法计划构造函数名；若实际名称不同（打开文件确认），以实际名称为准，测试逻辑不变。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/edit-subtitle-ass.test.ts tests/edit-normalize.test.ts
```

预期：`edit-subtitle-ass.test.ts` 因模块不存在而失败；`edit-normalize.test.ts` 新增用例因类型/默认值缺失而失败。

- [ ] **Step 3: 实现**

`backend/src/services/edit-plan.ts`：

```ts
export type EditSubtitleStyle = 'default' | 'outline' | 'box' | 'custom'

export interface EditSubtitleAppearance {
  fontFamily: string
  fontSize: number
  color: string
  strokeColor: string
  strokeWidth: number
  backgroundColor: string | null
  backgroundOpacity: number
  align: 'left' | 'center' | 'right'
  xPct: number
  yPct: number
}

export const SUBTITLE_FONT_WHITELIST = [
  'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC',
  'Source Han Sans SC', 'SimHei', 'KaiTi', 'Songti SC', 'Arial', 'Georgia',
] as const

/** 预设默认外观（设计 6.6 默认值表） */
export function subtitleAppearanceForPreset(style: EditSubtitleStyle): EditSubtitleAppearance {
  const base: EditSubtitleAppearance = {
    fontFamily: 'PingFang SC',
    fontSize: 48,
    color: '#FFFFFF',
    strokeColor: '#000000',
    strokeWidth: 2,
    backgroundColor: null,
    backgroundOpacity: 0,
    align: 'center',
    xPct: 50,
    yPct: 85,
  }
  if (style === 'outline') return { ...base, strokeWidth: 4 }
  if (style === 'box') {
    return { ...base, fontSize: 46, strokeWidth: 0, backgroundColor: '#000000', backgroundOpacity: 60 }
  }
  return base
}
```

`EditProjectSettings` 增加两个字段，`projectSettingsForAspect` 内补默认：

```ts
export interface EditProjectSettings {
  // ……现有字段不变……
  subtitleAppearance: EditSubtitleAppearance
  subtitleSafeAreaPct: number
}

// projectSettingsForAspect 返回对象中：
    subtitleAppearance: subtitleAppearanceForPreset('default'),
    subtitleSafeAreaPct: 8,
```

`backend/src/services/edit-normalize.ts`：

```ts
const SUBTITLE_STYLES = new Set<EditSubtitleStyle>(['default', 'outline', 'box', 'custom'])
const SUBTITLE_ALIGNS = new Set(['left', 'center', 'right'])
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function normalizeAppearance(
  raw: unknown,
  fallback: EditSubtitleAppearance,
  issues: EditIssue[],
  path: string,
): EditSubtitleAppearance {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const fontFamily = typeof input.fontFamily === 'string'
    && (SUBTITLE_FONT_WHITELIST as readonly string[]).includes(input.fontFamily)
    ? input.fontFamily
    : fallback.fontFamily
  if (fontFamily !== input.fontFamily) {
    issues.push(issue('warning', 'SUBTITLE_FONT', path, '字体不在白名单，已回退'))
  }
  const color = typeof input.color === 'string' && HEX_COLOR.test(input.color) ? input.color : fallback.color
  const strokeColor = typeof input.strokeColor === 'string' && HEX_COLOR.test(input.strokeColor)
    ? input.strokeColor
    : fallback.strokeColor
  const backgroundColor = typeof input.backgroundColor === 'string' && HEX_COLOR.test(input.backgroundColor)
    ? input.backgroundColor
    : null
  const align = SUBTITLE_ALIGNS.has(input.align as string) ? input.align as 'left' | 'center' | 'right' : fallback.align
  return {
    fontFamily,
    fontSize: clamp(round(input.fontSize, fallback.fontSize), 12, 120),
    color,
    strokeColor,
    strokeWidth: clamp(round(input.strokeWidth, fallback.strokeWidth), 0, 8),
    backgroundColor,
    backgroundOpacity: clamp(round(input.backgroundOpacity, fallback.backgroundOpacity), 0, 100),
    align,
    xPct: clamp(round(input.xPct, fallback.xPct), 0, 100),
    yPct: clamp(round(input.yPct, fallback.yPct), 0, 100),
  }
}
```

`normalizeProject` 返回值追加：

```ts
    subtitleAppearance: input.subtitleAppearance === undefined
      ? subtitleAppearanceForPreset(style) // 旧计划：按 defaultSubtitleStyle 预设生成
      : normalizeAppearance(input.subtitleAppearance, subtitleAppearanceForPreset(style), issues, 'project.subtitleAppearance'),
    subtitleSafeAreaPct: clamp(round(input.subtitleSafeAreaPct, fallback.subtitleSafeAreaPct ?? 8), 0, 30),
```

> 注意 `...fallback` 展开顺序：`subtitleAppearance` 与 `subtitleSafeAreaPct` 必须放在展开之后显式赋值，避免旧 fallback 对象缺字段时带入 `undefined`。

`normalizeSubtitles` 的 `cues.push({...})` 追加：

```ts
      ...(input.appearance !== undefined
        ? { appearance: normalizeAppearance(input.appearance, plan.project.subtitleAppearance, issues, `subtitles[${position}].appearance`) }
        : {}),
```

（`plan.project.subtitleAppearance` 此时已归一化，可直接作 fallback。）

新建 `backend/src/services/edit-subtitle-ass.ts`：

```ts
/**
 * 剪辑工作台字幕导出（设计 6.6）：逐条 cue 生成 \an/\pos/字号/颜色/描边/背景，
 * 预览与导出使用同一套锚点规则。不得 import DB / FFmpeg。
 */
import {
  subtitleAppearanceForPreset,
  type EditPlanV1,
  type EditSubtitleAppearance,
  type EditSubtitleCue,
} from './edit-plan.js'
import { formatAssTime, toSrt } from './subtitles.js'

const EXPORT_FONT_FALLBACK = ['PingFang SC', 'Noto Sans CJK SC', 'sans-serif'] as const

export function fallbackExportFont(fontFamily: string, available: readonly string[]): string {
  for (const candidate of [...EXPORT_FONT_FALLBACK.slice(0, 2), fontFamily]) {
    if (available.includes(candidate)) return candidate
  }
  return 'sans-serif'
}

/** 有效外观：cue 显式 > 工程默认 > 按 cue.style 的预设默认 */
export function resolveSubtitleAppearance(
  cue: EditSubtitleCue,
  plan: EditPlanV1,
): EditSubtitleAppearance {
  if (cue.appearance) return cue.appearance
  if (cue.style !== 'custom') return subtitleAppearanceForPreset(cue.style)
  return plan.project.subtitleAppearance
}

export function assAlignmentFor(align: 'left' | 'center' | 'right', yPct: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  const column = align === 'left' ? 0 : align === 'center' ? 1 : 2
  const row = yPct < 33 ? 2 : yPct > 66 ? 0 : 1
  return (1 + column + row * 3) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
}

function hexToBgr(hex: string): string {
  const r = hex.slice(1, 3)
  const g = hex.slice(3, 5)
  const b = hex.slice(5, 7)
  return `${b}${g}${r}`.toUpperCase()
}

function opacityToAlpha(opacity: number): string {
  return Math.round(255 - Math.max(0, Math.min(100, opacity)) * 2.55)
    .toString(16).toUpperCase().padStart(2, '0')
}

function overrideTags(appearance: EditSubtitleAppearance, width: number, height: number): string {
  const parts = [
    `an${assAlignmentFor(appearance.align, appearance.yPct)}`,
    `pos(${Math.round((appearance.xPct / 100) * width)},${Math.round((appearance.yPct / 100) * height)})`,
    `fn${appearance.fontFamily}`,
    `fs${Math.round(appearance.fontSize)}`,
    `1c&H${hexToBgr(appearance.color)}&`,
    `3c&H${hexToBgr(appearance.strokeColor)}&`,
    `bord${appearance.strokeWidth}`,
    `shad0`,
  ]
  if (appearance.backgroundColor) {
    parts.push(`4c&H${hexToBgr(appearance.backgroundColor)}&`, `4a&H${opacityToAlpha(appearance.backgroundOpacity)}&`)
  }
  return `{\\${parts.join('\\')}}`
}

export function buildEditAss(plan: EditPlanV1): string {
  const { width, height } = plan.project
  const def = plan.project.subtitleAppearance
  const styleOf = (appearance: EditSubtitleAppearance) =>
    appearance.backgroundColor ? 'Boxed' : 'Default'
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${def.fontFamily},${Math.round(def.fontSize)},&H00FFFFFF,&H000000FF,&H00141414,&H64000000,0,0,0,0,100,100,0,0,1,${def.strokeWidth},0,2,40,40,0,1`,
    `Style: Boxed,${def.fontFamily},${Math.round(def.fontSize)},&H00FFFFFF,&H000000FF,&H00141414,&H00000000,0,0,0,0,100,100,0,0,4,6,0,2,40,40,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')
  const sorted = [...plan.subtitles].sort((a, b) => a.startMs - b.startMs)
  const events = sorted.map((cue) => {
    const appearance = resolveSubtitleAppearance(cue, plan)
    const text = cue.text.replace(/\{/g, '（').replace(/\}/g, '）').replace(/\r?\n/g, '\\N')
    return `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},${styleOf(appearance)},,0,0,0,,${overrideTags(appearance, width, height)}${text}`
  })
  return `${header}\n${events.join('\n')}\n`
}

export function buildEditSrt(plan: EditPlanV1): string {
  const sorted = [...plan.subtitles].sort((a, b) => a.startMs - b.startMs)
  return toSrt(sorted.map((cue, index) => ({
    index: index + 1,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
    speaker: cue.role ?? '',
  })))
}
```

> 实现注意：`Style` 行字体直接用 `${def.fontFamily}`——`EditSubtitleAppearance` 没有 `fontName` 字段。测试 1 断言 `\\pos(540,1632)`：1080×1920、yPct 85 → y = round(0.85×1920) = 1632，成立。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/edit-subtitle-ass.test.ts tests/edit-normalize.test.ts tests/edit-plan.test.ts tests/edit-route.test.ts tests/edit-draft-route.test.ts
cd backend && npm run typecheck
```

预期：全部通过（`projectSettingsForAspect` 新增字段会影响既有快照式断言，如有按字段全等比较的用例需同步补两字段默认值）。

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 16: 前端——剪辑左侧成片面板与工程切换

**Files:**
- Modify: `frontend/app/composables/useApi.ts`
- Create: `frontend/app/components/edit/EditSidebar.vue`
- Modify: `frontend/app/components/edit/EditWorkbench.vue`
- Modify: `frontend/app/components/edit/EditTopBar.vue`
- Modify: `frontend/app/views/drama/edit.vue`
- Modify: `frontend/app/locales/zh.json`、`en.json`、`ja.json`、`ko.json`
- Test: `frontend/tests/edit-film-ui.test.mjs`

**Interfaces:**
- Consumes: Task 6 的 `filmAPI`、`frontend/app/components/ContextMenu.vue`；Task 12 后端 `GET/POST /episodes/:id/edit/projects`；Task 14 的 `?project_id=` 与响应 `project/projects/legacy_project/empty_reason/films` 字段。
- Produces:
  - `editAPI.get(episodeId, projectId?)`、`editAPI.projects(episodeId)`、`editAPI.openProject(episodeId, filmId)`；`saveDraft/createRevision/restoreRevision/roughCut/suggestSubtitles` 的 body 增加可选 `project_id`；`revisions(episodeId, projectId?)`。
  - `EditSidebar` props `{ films, loading, currentFilmId, activeFilmId, canEdit }`（`activeFilmId` = 当前工程源成片 id），emits `open(film) / refresh / rename(film, title) / remove(film) / set-current(film) / open-mix(film) / open-exports / new-concat`。
  - `EditWorkbench` emits 新增 `open-film(filmId)`；`EditTopBar` props 新增 `legacy: Boolean`。

- [ ] **Step 1: 写失败测试**

`frontend/tests/edit-film-ui.test.mjs` 新建：

```mjs
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('左侧主列表为成片，分镜素材库退出剪辑页', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /EditSidebar/)
  assert.doesNotMatch(workbench, /EditMediaLibrary/)
  assert.doesNotMatch(workbench, /useEditMedia/)

  const sidebar = read('app/components/edit/EditSidebar.vue')
  assert.match(sidebar, /ContextMenu/)
  assert.match(sidebar, /emit\('open'/)
  assert.match(sidebar, /set-current/)
  assert.match(sidebar, /open-mix/)
  assert.match(sidebar, /rename/)
  assert.match(sidebar, /remove/)
  assert.match(sidebar, /disabled/)
})

test('切换成片：先自动保存，失败阻止，成功经 ?film= 重新加载', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /function switchFilm/)
  assert.match(workbench, /saveNow/)
  assert.match(workbench, /\$emit\('open-film'/)

  const page = read('app/views/drama/edit.vue')
  assert.match(page, /route\.query\.film/)
  assert.match(page, /openProject/)
  assert.match(page, /:key=/)
})

test('editAPI 工程参数与四语言文案', () => {
  const api = read('app/composables/useApi.ts')
  assert.match(api, /edit\/projects/)
  assert.match(api, /project_id/)

  const top = read('app/components/edit/EditTopBar.vue')
  assert.match(top, /legacy/)

  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const data = read(`app/locales/${lang}.json`)
    assert.match(data, /legacyProject/)
    assert.match(data, /filmsPanelTitle/)
    assert.match(data, /deleteBlocked/)
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd frontend && node --test tests/edit-film-ui.test.mjs
```

预期：三组用例全部失败（组件/参数/文案不存在）。

- [ ] **Step 3: 实现**

`frontend/app/composables/useApi.ts` 的 `editAPI` 改为：

```ts
export const editAPI = {
  get: (episodeId: number, projectId?: number) =>
    api.get(`/episodes/${episodeId}/edit${projectId ? `?project_id=${projectId}` : ''}`),
  projects: (episodeId: number) => api.get(`/episodes/${episodeId}/edit/projects`),
  openProject: (episodeId: number, filmId: number) =>
    api.post(`/episodes/${episodeId}/edit/projects`, { film_id: filmId }),
  media: (episodeId: number) => api.get(`/episodes/${episodeId}/edit/media`),
  saveDraft: (episodeId: number, body: {
    base_version: number
    plan: unknown
    force?: boolean
    project_id?: number
  }) => api.put(`/episodes/${episodeId}/edit/draft`, body),
  discardDraft: (episodeId: number) => api.del(`/episodes/${episodeId}/edit/draft`),
  revisions: (episodeId: number, projectId?: number) =>
    api.get(`/episodes/${episodeId}/edit/revisions${projectId ? `?project_id=${projectId}` : ''}`),
  revision: (episodeId: number, revisionId: number, projectId?: number) =>
    api.get(`/episodes/${episodeId}/edit/revisions/${revisionId}${projectId ? `?project_id=${projectId}` : ''}`),
  createRevision: (episodeId: number, body: {
    base_version: number
    note?: string
    plan?: unknown
    update_draft?: boolean
    project_id?: number
  }) => api.post(`/episodes/${episodeId}/edit/revisions`, body),
  restoreRevision: (episodeId: number, revisionId: number, body: { base_version: number; project_id?: number }) =>
    api.post(`/episodes/${episodeId}/edit/revisions/${revisionId}/restore`, body),
  roughCut: (episodeId: number, body: {
    mode: 'replace' | 'append'
    plan: unknown
    create_revision?: boolean
    base_version?: number
    project_id?: number
  }) => api.post(`/episodes/${episodeId}/edit/rough-cut`, body),
  suggestSubtitles: (episodeId: number, body: {
    mode: 'fill' | 'replace'
    plan: unknown
    project_id?: number
  }) => api.post(`/episodes/${episodeId}/edit/subtitles/suggest`, body),
}
```

新建 `frontend/app/components/edit/EditSidebar.vue`：

```vue
<template>
  <aside class="ed-sidebar">
    <div class="ed-sidebar-head">
      <span class="ed-sidebar-title">{{ t('edit.filmsPanelTitle') }}</span>
      <button class="ed-side-btn" type="button" @click="$emit('new-concat')">{{ t('edit.newConcat') }}</button>
      <button class="ed-side-icon" type="button" :title="t('edit.refresh')" @click="$emit('refresh')">
        <RefreshCw :size="14" />
      </button>
    </div>
    <div v-if="loading" class="ed-side-state"><Loader2 :size="18" class="is-spin" /></div>
    <p v-else-if="!films.length" class="ed-side-state">{{ t('films.empty') }}</p>
    <ul v-else class="ed-film-list">
      <li v-for="film in films" :key="film.id">
        <button
          type="button"
          class="ed-film-card"
          :class="{ 'is-active': film.id === activeFilmId, 'is-current': film.id === currentFilmId }"
          @click="$emit('open', film)"
          @contextmenu.prevent="openMenu(film, $event)"
        >
          <span class="ed-film-title">{{ film.title }}</span>
          <span class="ed-film-meta">
            <span :class="['ed-film-kind', `is-${film.kind}`]">{{ t(`films.kind.${film.kind}`) }}</span>
            <span>{{ formatDuration(film.duration_ms) }}</span>
            <span v-if="film.id === currentFilmId" class="ed-film-flag">{{ t('films.current') }}</span>
            <span v-if="film.edited" class="ed-film-flag is-edited">{{ t('films.edited') }}</span>
          </span>
        </button>
      </li>
    </ul>
    <ContextMenu
      v-if="menuShow"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @close="menuShow = false"
    />
  </aside>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, RefreshCw } from 'lucide-vue-next'
import ContextMenu from '~/components/ContextMenu.vue'

const props = defineProps({
  films: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  currentFilmId: { type: Number, default: 0 },
  activeFilmId: { type: Number, default: 0 },
  canEdit: { type: Boolean, default: false },
})
const emit = defineEmits([
  'open', 'refresh', 'rename', 'remove', 'set-current', 'open-mix', 'open-exports', 'new-concat',
])
const { t } = useI18n()

const menuShow = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuFilm = ref(null)
```

> 修正：`activeFilmId` 由父组件直接传（`state.project?.source_merge_id ?? 0`），子组件不做二次推导。

```vue
function openMenu(film, event) {
  menuFilm.value = film
  menuX.value = event.clientX
  menuY.value = event.clientY
  menuShow.value = true
}
const menuItems = computed(() => {
  const film = menuFilm.value
  if (!film) return []
  const isCurrent = film.id === props.currentFilmId
  return [
    { key: 'open', label: t('edit.openEdit'), action: () => emit('open', film) },
    { key: 'preview', label: t('edit.preview'), action: () => emit('open', film) },
    { key: 'sep1', separator: true },
    { key: 'current', label: t('films.setCurrent'), action: () => emit('set-current', film) },
    { key: 'mix', label: t('films.openMix'), action: () => emit('open-mix', film) },
    { key: 'sep2', separator: true },
    {
      key: 'rename', label: t('films.rename'),
      action: () => {
        const title = window.prompt(t('films.rename'), film.title)
        if (title && title.trim() && title !== film.title) emit('rename', film, title.trim())
      },
    },
    { key: 'exports', label: t('edit.exportLog'), action: () => emit('open-exports') },
    { key: 'sep3', separator: true },
    {
      key: 'remove', label: t('films.delete'), danger: true,
      disabled: isCurrent, reason: t('edit.deleteBlocked'),
      action: () => { if (window.confirm(t('films.deleteConfirm'))) emit('remove', film) },
    },
  ]
})

function formatDuration(ms) {
  if (!ms || ms <= 0) return '--:--'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
</script>
```

> 实现注意：`<style scoped>` 部分按现有侧栏风格写（宽 240px、卡片列表、徽标配色复用 `--accent-bg/--warning-bg`），不引入新设计令牌。`ContextMenu` 的 `MenuItem` 需要 `key/label/action`，禁用项传 `disabled/reason`，分隔线传 `separator: true`（Task 6 已定义该结构）。`preview` 与 `open` 现阶段同一动作（打开工程即预览），保留独立菜单项是为了文案对齐设计 6.2。

`frontend/app/components/edit/EditWorkbench.vue` 的改动：

1. 模板：`<EditMediaLibrary class="ed-media-slot" ...>` 整块替换为：

```vue
      <EditSidebar
        class="ed-media-slot"
        :films="films"
        :loading="filmsLoading"
        :current-film-id="currentFilmId"
        :active-film-id="activeFilmId"
        :can-edit="canEdit"
        @open="switchFilm"
        @refresh="loadFilms"
        @rename="renameFilm"
        @remove="removeFilm"
        @set-current="setCurrentFilm"
        @open-mix="openFilmInMix"
        @open-exports="$emit('back')"
        @new-concat="goNewConcat"
      />
```

2. 脚本：删除 `import EditMediaLibrary` 与 `useEditMedia` 及其解构（`media/mediaLoading/mediaError/loadMedia`），删除 `addStoryboard/addAllStoryboards` 两个函数与模板引用（分镜不再是剪辑素材入口；初剪仍走顶栏/空态按钮，仅旧工程可用）。新增：

```ts
import EditSidebar from '~/components/edit/EditSidebar.vue'
import { editAPI, filmAPI } from '~/composables/useApi'

const films = ref([])
const filmsLoading = ref(false)
const currentFilmId = computed(() => Number(topState.value?.films?.find((f) => f.is_current)?.id)
  || Number(topState.value?.project?.source_merge_id) || 0)
const activeFilmId = computed(() => Number(topState.value?.project?.source_merge_id) || 0)

async function loadFilms() {
  filmsLoading.value = true
  try {
    films.value = (await filmAPI.list(props.state.episode_id)).items ?? []
  } catch {
    films.value = []
  } finally {
    filmsLoading.value = false
  }
}

async function switchFilm(film) {
  if (Number(film?.id) === activeFilmId.value) return
  if (dirty.value) {
    await saveNow()
    if (saveStatus.value === 'error' || saveStatus.value === 'conflict') {
      timelineMessage.value = t('edit.saveBeforeSwitch')
      return
    }
  }
  emit('open-film', film.id)
}

async function renameFilm(film, title) {
  try {
    await filmAPI.rename(film.id, title)
    await loadFilms()
  } catch (cause) {
    timelineMessage.value = cause instanceof Error ? cause.message : t('edit.openFailed')
  }
}

async function removeFilm(film) {
  try {
    await filmAPI.remove(film.id)
    await loadFilms()
  } catch (cause) {
    timelineMessage.value = cause instanceof Error ? cause.message : t('edit.openFailed')
  }
}

async function setCurrentFilm(film) {
  try {
    await filmAPI.setCurrent(props.state.episode_id, film.id)
    await loadFilms()
  } catch (cause) {
    timelineMessage.value = cause instanceof Error ? cause.message : t('edit.openFailed')
  }
}

function openFilmInMix(film) {
  const episodeId = props.state.episode_id
  navigateTo({ path: route.path.replace(/\/edit$/, ''), query: { panel: 'dubbing', step: '3', film: String(film.id) } })
  void episodeId
}
```

> 修正提示：`openFilmInMix` 不要走 episodeId 拼路径——配音工作台路由与剪辑页同级（`/drama/:id/episode/:n`），直接用 `navigateTo` 目标路径即可；`route` 需从 `useRoute()` 引入（`const route = useRoute()`，`goNewConcat` 同样用到）。`goNewConcat` 实现：`navigateTo(`${route.path.replace(/\/edit$/, '')}#exports`)`，回到剧集页拼接导出条。`defineEmits(['back'])` 改为 `const emit = defineEmits(['back', 'open-film'])`（模板里 `$emit('back')` 仍可用）。挂载时 `onMounted(loadFilms)`。`dirty/saveNow/saveStatus/timelineMessage` 均为现有变量，直接使用。

`frontend/app/views/drama/edit.vue` 的改动：

```vue
<EditWorkbench
  v-else-if="state"
  :key="`${found?.id ?? 0}:${state.project?.id ?? 0}`"
  :state="state"
  :episode-label="episodeLabel"
  @back="goBack"
  @open-film="openFilm"
/>
```

```ts
const filmParam = computed(() => {
  const raw = Number(route.query.film)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 0
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
    let projectId
    if (filmParam.value) {
      const opened = await editAPI.openProject(found.id, filmParam.value)
      projectId = opened?.data?.project?.id ?? opened?.project?.id
    }
    state.value = await editAPI.get(found.id, projectId)
  } catch (cause) {
    state.value = null
    error.value = cause instanceof Error ? cause.message : t('edit.loadFailed')
  } finally {
    loading.value = false
  }
}

function openFilm(filmId) {
  navigateTo({ query: { ...route.query, film: String(filmId) } })
}

watch(filmParam, () => { if (!loading.value) load() })
```

> 说明：`:key` 里的 `found` 在模板作用域不可见——实际实现把工程 id 提取为 computed：`const workbenchKey = computed(() => `${state.value?.episode_id ?? 0}:${state.value?.project?.id ?? 0}`)`，模板用 `:key="workbenchKey"`。工程切换后组件整体重挂载，`useEditPlan` 用新 state 重新初始化，避免旧草稿/历史残留。

`frontend/app/components/edit/EditTopBar.vue`：props 增加 `legacy: { type: Boolean, default: false }`，在混音状态 chip 前插入：

```vue
        <span v-if="legacy" class="ed-chip is-muted">{{ t('edit.legacyProject') }}</span>
```

`EditWorkbench` 调用处传 `:legacy="Boolean(topState.legacy_project)"`。

四语言 `app/locales/*.json` 的 `edit` 节新增（en/ja/ko 同步翻译）：

```json
"legacyProject": "旧版工程（按分镜生成）",
"filmsPanelTitle": "成片",
"newConcat": "新建拼接成片",
"refresh": "刷新",
"openEdit": "打开剪辑",
"preview": "预览",
"exportLog": "查看导出记录",
"deleteBlocked": "当前成片不能删除，先在其他成片上设为当前",
"saveBeforeSwitch": "草稿保存失败，已取消切换",
"openFailed": "操作失败"
```

- [ ] **Step 4: 运行测试与构建门禁**

```bash
cd frontend && node --test tests/edit-film-ui.test.mjs tests/edit-structure.test.mjs
cd frontend && npm run build
```

> `edit-structure.test.mjs` 如断言了 EditMediaLibrary 相关结构，按新结构同步修改断言（左侧为 EditSidebar；`useEditMedia` 断言删除）。前端 `build` 仅作 SFC 编译门禁。

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 17: 前端——字幕编辑（外观、位置、时间、覆盖层与字幕抽屉）

**Files:**
- Modify: `frontend/app/utils/edit-plan.ts`（外观类型镜像）
- Modify: `frontend/app/utils/edit-commands.ts`（cue 编辑命令）
- Create: `frontend/app/components/edit/EditSubtitleOverlay.vue`
- Modify: `frontend/app/components/edit/EditPreview.vue`
- Modify: `frontend/app/components/edit/EditClipInspector.vue`
- Create: `frontend/app/components/edit/EditSubtitleList.vue`
- Modify: `frontend/app/components/edit/EditWorkbench.vue`
- Modify: `frontend/app/locales/zh.json`、`en.json`、`ja.json`、`ko.json`
- Test: `frontend/tests/edit-cue-commands.test.mjs`、`frontend/tests/edit-subtitle-ui.test.mjs`

**Interfaces:**
- Consumes: Task 15 的外观语义（cue.appearance > 工程默认 > 预设默认，锚点/`\an` 同规则）；现有 `setCueText/moveCue/deleteCue/addCue`、`EditCommandResult { plan, issues, focusClipId }`；`EditWorkbench` 现有 `selectedCueId/currentMs/applyCommand/layout/plan`。
- Produces:
  - `frontend/app/utils/edit-plan.ts`：`EditSubtitleStyle` 含 `'custom'`、`EditSubtitleAppearance`、`subtitleAppearanceForPreset(style)`、`SUBTITLE_FONT_WHITELIST`、`resolveCueAppearance(cue, project)`。
  - 命令（均返回 `EditCommandResult`）：`setCueTime(plan, cueId, { startMs, endMs })`、`setCueAppearance(plan, cueId, patch)`、`applyAppearanceToAll(plan, appearance)`、`setSubtitleProjectDefaults(plan, { appearance, safeAreaPct })`、`mergeCueWithNext(plan, cueId)`、`splitCueAt(plan, cueId, atMs)`、`addCueAtPlayhead(plan, atMs, project)`。
  - `EditSubtitleOverlay` props `{ plan, layout, currentMs, containerWidth, containerHeight, selectedCueId, safeAreaPct, showSafeArea, project }`，emits `select(cueId)`。
  - `EditSubtitleList` props `{ open, cues, selectedCueId }`，emits `close / select(cueId) / add`。
  - `EditClipInspector` props 新增 `cue`（选中字幕或 null）；emits 新增 `cue-update(patch) / cue-apply-all(appearance) / cue-set-default(appearance) / cue-delete / cue-split / cue-merge-next / cue-align-start / cue-align-end / cue-follow(toggle)`。

- [ ] **Step 1: 写失败测试**

`frontend/tests/edit-cue-commands.test.mjs` 新建（纯函数测试，无 DOM）：

```mjs
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// edit-commands.ts 是 TS 源文件；用现有 edit-commands.test.mjs 同款加载方式。
// 若该文件使用 tsx/strip-types 运行器，则照抄其 import 头，不新发明机制。
const runner = readFileSync(new URL('./edit-commands.test.mjs', import.meta.url), 'utf8')
```

> 实现注意：先打开 `tests/edit-commands.test.mjs` 看它如何加载 TS 模块（现有工程已有此模式），`edit-cue-commands.test.mjs` 复用同一加载方式；下述用例假定 `import { setCueTime, setCueAppearance, applyAppearanceToAll, mergeCueWithNext, splitCueAt, addCueAtPlayhead, setSubtitleProjectDefaults } from '../app/utils/edit-commands.ts'` 可行。计划夹具用 `createEmptyEditPlan(1, projectSettingsForAspect('9:16'))` 加一个手工 cue。

```mjs
test('setCueTime 校验起止并保持最短 100ms', () => {
  const plan = planWithCue()
  const result = setCueTime(plan, 'cue_1', { startMs: 2000, endMs: 1000 })
  const cue = result.plan.subtitles.find((c) => c.id === 'cue_1')
  assert.equal(cue.endMs, cue.startMs + 100)
})

test('setCueAppearance 写入显式外观且 style 变为 custom', () => {
  const plan = planWithCue()
  const result = setCueAppearance(plan, 'cue_1', { fontSize: 72, yPct: 10 })
  const cue = result.plan.subtitles.find((c) => c.id === 'cue_1')
  assert.equal(cue.style, 'custom')
  assert.equal(cue.appearance.fontSize, 72)
  assert.equal(cue.appearance.yPct, 10)
  // 未 patch 的字段继承工程默认
  assert.equal(cue.appearance.fontFamily, result.plan.project.subtitleAppearance.fontFamily)
})

test('applyAppearanceToAll 覆盖全部 cue，setSubtitleProjectDefaults 只改工程默认', () => {
  let plan = planWithCue()
  plan = applyAppearanceToAll(plan, { ...plan.project.subtitleAppearance, fontSize: 60 }).plan
  assert.ok(plan.subtitles.every((c) => c.appearance?.fontSize === 60))
  const before = plan.subtitles.map((c) => c.appearance?.fontSize)
  plan = setSubtitleProjectDefaults(plan, { appearance: { ...plan.project.subtitleAppearance, fontSize: 36 }, safeAreaPct: 10 }).plan
  assert.equal(plan.project.subtitleAppearance.fontSize, 36)
  assert.equal(plan.project.subtitleSafeAreaPct, 10)
  assert.deepEqual(plan.subtitles.map((c) => c.appearance?.fontSize), before)
})

test('mergeCueWithNext 合并相邻文本并删除后一条', () => {
  const plan = planWithTwoCues() // cue_1 0–1000，cue_2 1000–2000
  const result = mergeCueWithNext(plan, 'cue_1')
  assert.equal(result.plan.subtitles.length, 1)
  assert.equal(result.plan.subtitles[0].text, '你好世界')
  assert.equal(result.plan.subtitles[0].endMs, 2000)
})

test('splitCueAt 在中点拆分，addCueAtPlayhead 在播放头新建 2s 字幕', () => {
  let plan = planWithTwoCues()
  plan = splitCueAt(plan, 'cue_1', 500).plan
  assert.equal(plan.subtitles.length, 3)
  plan = addCueAtPlayhead(plan, 3000, plan.project).plan
  const added = plan.subtitles.find((c) => c.startMs === 3000)
  assert.ok(added)
  assert.equal(added.endMs - added.startMs, 2000)
  assert.equal(added.source, 'manual')
})
```

> 兼容性裁决：`mergeCueWithNext` 仅在 `next.startMs - cue.endMs <= 200ms` 时可用（近似相邻），否则返回原计划并带 warning `CUE_NOT_MERGABLE`；实现据此写测试可加一条不可合并用例。

`frontend/tests/edit-subtitle-ui.test.mjs` 新建（结构测试）：

```mjs
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('字幕覆盖层渲染于预览之上且带安全区', () => {
  const overlay = read('app/components/edit/EditSubtitleOverlay.vue')
  assert.match(overlay, /safeArea/)
  assert.match(overlay, /xPct/)
  assert.match(overlay, /pointer-events/)
  const preview = read('app/components/edit/EditPreview.vue')
  assert.match(preview, /EditSubtitleOverlay/)
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /EditSubtitleOverlay/)
})

test('检查器字幕页含样式/位置/批量/操作分区', () => {
  const inspector = read('app/components/edit/EditClipInspector.vue')
  for (const key of ['subtitleText', 'subtitleTime', 'subtitleStyle', 'subtitlePosition', 'subtitleBatch', 'frameBack', 'frameForward', 'alignPlayhead', 'applyAll', 'setDefault', 'mergeNext', 'nineGrid']) {
    assert.match(inspector, new RegExp(key), key)
  }
})

test('字幕抽屉可搜索、定位选中', () => {
  const list = read('app/components/edit/EditSubtitleList.vue')
  assert.match(list, /search/)
  assert.match(list, /emit\('select'/)
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /EditSubtitleList/)
})

test('四语言字幕编辑文案', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const data = read(`app/locales/${lang}.json`)
    for (const key of ['subtitleText', 'subtitleStyle', 'subtitlePosition', 'applyAll', 'setDefault', 'previewApprox']) {
      assert.match(data, new RegExp(key), `${lang}:${key}`)
    }
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd frontend && node --test tests/edit-cue-commands.test.mjs tests/edit-subtitle-ui.test.mjs
```

预期：全部失败。

- [ ] **Step 3: 实现**

`frontend/app/utils/edit-plan.ts`：与 Task 15 后端同构追加 `EditSubtitleStyle` 第四值 `'custom'`、`EditSubtitleAppearance`、`SUBTITLE_FONT_WHITELIST`、`subtitleAppearanceForPreset`，以及：

```ts
export function resolveCueAppearance(cue, project) {
  if (cue.appearance) return cue.appearance
  if (cue.style !== 'custom') return subtitleAppearanceForPreset(cue.style)
  return project.subtitleAppearance
}
```

`frontend/app/utils/edit-commands.ts` 追加命令（全部 `clonePlan` 起步、返回 `EditCommandResult`，warning 走现有 `warning()` helper；`splitCueAt` 复用 `syncFollowedCues` 的现有工具处理锚点迁移——若其不覆盖 cue 拆分，手动二分并保持 `follow/anchor` 于前半段，后半段 `follow=false`）：

```ts
export function setCueTime(plan, cueId, { startMs, endMs }) {
  const next = clonePlan(plan)
  const cue = next.subtitles.find((c) => c.id === cueId)
  if (!cue) return { plan, issues: [], focusClipId: null }
  const s = Math.max(0, Math.round(startMs))
  let e = Math.max(0, Math.round(endMs))
  if (e <= s) { e = s + 100 }
  cue.startMs = s
  cue.endMs = e
  return { plan: next, issues: [], focusClipId: null }
}

export function setCueAppearance(plan, cueId, patch) {
  const next = clonePlan(plan)
  const cue = next.subtitles.find((c) => c.id === cueId)
  if (!cue) return { plan, issues: [], focusClipId: null }
  const base = cue.appearance ?? structuredClone(next.project.subtitleAppearance)
  cue.appearance = { ...base, ...patch }
  cue.style = 'custom'
  return { plan: next, issues: [], focusClipId: null }
}

export function applyAppearanceToAll(plan, appearance) {
  const next = clonePlan(plan)
  for (const cue of next.subtitles) cue.appearance = { ...appearance }
  return { plan: next, issues: [], focusClipId: null }
}

export function setSubtitleProjectDefaults(plan, { appearance, safeAreaPct }) {
  const next = clonePlan(plan)
  next.project.subtitleAppearance = { ...appearance }
  if (safeAreaPct !== undefined) next.project.subtitleSafeAreaPct = Math.max(0, Math.min(30, Math.round(safeAreaPct)))
  return { plan: next, issues: [], focusClipId: null }
}

export function mergeCueWithNext(plan, cueId) {
  const next = clonePlan(plan)
  const index = next.subtitles.findIndex((c) => c.id === cueId)
  if (index < 0 || index + 1 >= next.subtitles.length) return { plan, issues: [], focusClipId: null }
  const cue = next.subtitles[index]
  const nextCue = next.subtitles[index + 1]
  if (nextCue.startMs - cue.endMs > 200) {
    return { plan, issues: [warning('CUE_NOT_MERGABLE', `subtitles.${cueId}`, '两条字幕间隔过大，无法合并')], focusClipId: null }
  }
  cue.text = `${cue.text}${nextCue.text}`
  cue.endMs = nextCue.endMs
  next.subtitles.splice(index + 1, 1)
  return { plan: next, issues: [], focusClipId: null }
}

export function splitCueAt(plan, cueId, atMs) {
  const next = clonePlan(plan)
  const cue = next.subtitles.find((c) => c.id === cueId)
  if (!cue || atMs <= cue.startMs + 50 || atMs >= cue.endMs - 50) {
    return { plan, issues: [warning('CUE_SPLIT_RANGE', `subtitles.${cueId}`, '分割点需位于字幕内部')], focusClipId: null }
  }
  const tail = {
    ...structuredClone(cue),
    id: `cue_${Date.now().toString(36)}`,
    startMs: atMs,
    follow: false,
    anchor: null,
  }
  cue.endMs = atMs
  next.subtitles.push(tail)
  return { plan: next, issues: [], focusClipId: null }
}

export function addCueAtPlayhead(plan, atMs, project) {
  const next = clonePlan(plan)
  const appearance = structuredClone(project.subtitleAppearance)
  next.subtitles.push({
    id: `cue_${Date.now().toString(36)}`,
    text: '',
    startMs: Math.max(0, Math.round(atMs)),
    endMs: Math.max(0, Math.round(atMs)) + 2000,
    style: 'custom',
    role: null,
    source: 'manual',
    follow: false,
    anchor: null,
    lineId: null,
    warnings: [],
    appearance,
  })
  return { plan: next, issues: [], focusClipId: null }
}
```

> `setCueAppearance` 的 patch 值在前端不重复做范围校验——保存时后端 `normalizeEditPlan`（Task 15）会收敛；UI 滑杆自身限制范围。

新建 `frontend/app/components/edit/EditSubtitleOverlay.vue`：

```vue
<template>
  <div class="ed-sub-overlay" :style="{ width: `${containerWidth}px`, height: `${containerHeight}px` }">
    <div
      v-for="cue in activeCues"
      :key="cue.id"
      class="ed-sub-cue"
      :class="{ 'is-selected': cue.id === selectedCueId, 'is-out': cue.outOfBounds }"
      :style="cue.style2"
      @pointerdown.stop="$emit('select', cue.id)"
    >{{ cue.text }}</div>
    <div v-if="showSafeArea" class="ed-sub-safe" :style="safeStyle"></div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { resolveCueAppearance } from '~/utils/edit-plan'

const props = defineProps({
  plan: { type: Object, required: true },
  layout: { type: Object, required: true },
  currentMs: { type: Number, default: 0 },
  containerWidth: { type: Number, default: 0 },
  containerHeight: { type: Number, default: 0 },
  selectedCueId: { type: String, default: '' },
  showSafeArea: { type: Boolean, default: false },
})
defineEmits(['select'])

const safePct = computed(() => Number(props.plan.project.subtitleSafeAreaPct ?? 8))
const safeStyle = computed(() => ({
  left: `${safePct.value}%`,
  top: `${safePct.value}%`,
  right: `${safePct.value}%`,
  bottom: `${safePct.value}%`,
}))

const activeCues = computed(() => {
  const width = props.plan.project.width
  const height = props.plan.project.height
  const scale = props.containerWidth / Math.max(1, width)
  return props.plan.subtitles
    .filter((cue) => props.currentMs >= cue.startMs && props.currentMs < cue.endMs)
    .map((cue) => {
      const a = resolveCueAppearance(cue, props.plan.project)
      const anchorX = (a.xPct / 100) * props.containerWidth
      const anchorY = (a.yPct / 100) * props.containerHeight
      const transform = {
        left: 'translate(0, -50%)',
        center: 'translate(-50%, -50%)',
        right: 'translate(-100%, -50%)',
      }[a.align]
      const background = a.backgroundColor
        ? hexWithAlpha(a.backgroundColor, a.backgroundOpacity)
        : 'transparent'
      const out = a.xPct < safePct.value || a.xPct > 100 - safePct.value
        || a.yPct < safePct.value || a.yPct > 100 - safePct.value
      return {
        id: cue.id,
        text: cue.text,
        outOfBounds: out,
        style2: {
          left: `${anchorX}px`,
          top: `${anchorY}px`,
          transform,
          fontFamily: `"${a.fontFamily}", sans-serif`,
          fontSize: `${a.fontSize * scale}px`,
          color: a.color,
          WebkitTextStroke: a.strokeWidth > 0 ? `${a.strokeWidth * scale * 0.5}px ${a.strokeColor}` : 'none',
          background,
        },
      }
    })
})

function hexWithAlpha(hex, opacity) {
  const alpha = Math.round(Math.max(0, Math.min(100, opacity)) * 2.55).toString(16).padStart(2, '0')
  return `${hex}${alpha}`
}
</script>
```

> 实现注意：样式键名不得叫 `style`（Vue 模板保留冲突），上面用 `style2` 或改名 `css`；采用 `css`。覆盖层容器 `pointer-events: none`，`.ed-sub-cue` 单独 `pointer-events: auto`，保证点击字幕可选中、其余区域穿透给视频。`is-out` 类加黄色描边（`outline: 2px solid var(--warning)`），不阻止任何操作。

`frontend/app/components/edit/EditPreview.vue`：在 `<video>` 之后、`ed-preview-empty` 之前插入：

```vue
      <EditSubtitleOverlay
        :plan="plan"
        :layout="layout"
        :current-ms="currentMs"
        :container-width="frameWidth"
        :container-height="frameHeight"
        :selected-cue-id="selectedCueId"
        :show-safe-area="showSafeArea"
        @select="(id) => $emit('select-cue', id)"
      />
```

props 增加 `layout/selectedCueId/showSafeArea`，emits 增加 `select-cue`；`frameWidth/frameHeight` 用现有 `.ed-preview-frame` 的 ResizeObserver 或 `getBoundingClientRect` 的 ref 响应（若组件已有宽度测量逻辑则复用，否则补一个 `useElementSize` 式的本地实现）。`EditWorkbench` 的 `<EditPreview>` 调用处补传 `:layout="layout" :selected-cue-id="selectedCueId" :show-safe-area="showSafeArea"` 并监听 `@select-cue="selectCue"`（复用现有 `selectCue`）。

`frontend/app/components/edit/EditClipInspector.vue`：

- props 增加 `cue: { type: Object, default: null }`、`currentMs`（已有）、`fps`（从 `plan.project.fps` 取）。
- 模板顶部加分支：`<template v-if="cue">` 渲染字幕页（下列分区），`v-else-if="clip"` 保留现有片段页。

字幕页分区（每区一个 `ed-insp-section`，标题用 `t('edit.subtitleXxx')`）：

```vue
    <template v-if="cue">
      <section class="ed-insp-section">
        <h4>{{ t('edit.subtitleText') }}</h4>
        <textarea v-model="textDraft" rows="2" @change="emitPatch({ text: textDraft })" />
      </section>
      <section class="ed-insp-section">
        <h4>{{ t('edit.subtitleTime') }}</h4>
        <div class="ed-row">
          <label>{{ t('edit.startTime') }} <input :value="formatCueMs(cue.startMs)" @change="onStartInput($event)" /></label>
          <label>{{ t('edit.endTime') }} <input :value="formatCueMs(cue.endMs)" @change="onEndInput($event)" /></label>
        </div>
        <div class="ed-row">
          <button type="button" @click="nudgeFrames(-1)">−1 {{ t('edit.frameUnit') }}</button>
          <button type="button" @click="nudgeFrames(1)">+1 {{ t('edit.frameUnit') }}</button>
        </div>
        <div class="ed-row">
          <button type="button" @click="$emit('cue-align-start')">{{ t('edit.alignPlayheadStart') }}</button>
          <button type="button" @click="$emit('cue-align-end')">{{ t('edit.alignPlayheadEnd') }}</button>
        </div>
        <label class="ed-check">
          <input type="checkbox" :checked="cue.follow" @change="$emit('cue-follow', $event.target.checked)" />
          {{ t('edit.followClip') }}
        </label>
      </section>
      <section class="ed-insp-section">
        <h4>{{ t('edit.subtitleStyle') }}</h4>
        <label>{{ t('edit.fontFamily') }}
          <select v-model="styleDraft.fontFamily" @change="applyStyleDraft()">
            <option v-for="f in fonts" :key="f" :value="f">{{ f }}</option>
          </select>
        </label>
        <label>{{ t('edit.fontSize') }}
          <input type="range" min="12" max="120" v-model.number="styleDraft.fontSize" @change="applyStyleDraft()" />
          <span>{{ styleDraft.fontSize }}px</span>
        </label>
        <div class="ed-row">
          <label>{{ t('edit.textColor') }} <input type="color" v-model="styleDraft.color" @change="applyStyleDraft()" /></label>
          <label>{{ t('edit.strokeColor') }} <input type="color" v-model="styleDraft.strokeColor" @change="applyStyleDraft()" /></label>
        </div>
        <label>{{ t('edit.strokeWidth') }}
          <input type="range" min="0" max="8" step="0.5" v-model.number="styleDraft.strokeWidth" @change="applyStyleDraft()" />
        </label>
        <div class="ed-row">
          <label>{{ t('edit.backgroundColor') }} <input type="color" v-model="bgColor" @change="applyStyleDraft()" /></label>
          <label>{{ t('edit.backgroundOpacity') }}
            <input type="range" min="0" max="100" v-model.number="styleDraft.backgroundOpacity" @change="applyStyleDraft()" />
          </label>
        </div>
        <div class="ed-row" role="radiogroup">
          <button v-for="a in ['left', 'center', 'right']" :key="a" type="button"
            :class="{ 'is-on': styleDraft.align === a }" @click="styleDraft.align = a; applyStyleDraft()">
            {{ t(`edit.align_${a}`) }}
          </button>
        </div>
      </section>
      <section class="ed-insp-section">
        <h4>{{ t('edit.subtitlePosition') }}</h4>
        <div class="ed-row" role="radiogroup">
          <button type="button" :class="{ 'is-on': styleDraft.yPct <= 33 }" @click="setPosition(styleDraft.xPct ?? 50, 12)">{{ t('edit.posTop') }}</button>
          <button type="button" :class="{ 'is-on': styleDraft.yPct > 33 && styleDraft.yPct <= 66 }" @click="setPosition(styleDraft.xPct ?? 50, 50)">{{ t('edit.posMiddle') }}</button>
          <button type="button" :class="{ 'is-on': styleDraft.yPct > 66 }" @click="setPosition(styleDraft.xPct ?? 50, 85)">{{ t('edit.posBottom') }}</button>
        </div>
        <div class="ed-nine-grid" role="radiogroup">
          <button v-for="cell in NINE_GRID" :key="cell.key" type="button"
            :class="{ 'is-on': cell.x === (styleDraft.xPct ?? 50) && cell.y === (styleDraft.yPct ?? 85) }"
            @click="setPosition(cell.x, cell.y)" />
        </div>
        <div class="ed-row">
          <label>X <input type="range" min="0" max="100" v-model.number="styleDraft.xPct" @change="applyStyleDraft()" /></label>
          <label>Y <input type="range" min="0" max="100" v-model.number="styleDraft.yPct" @change="applyStyleDraft()" /></label>
        </div>
        <label class="ed-check">
          <input type="checkbox" v-model="showSafeAreaLocal" /> {{ t('edit.showSafeArea') }}
        </label>
        <p v-if="outOfBounds" class="ed-warn">{{ t('edit.subtitleOutOfBounds') }}</p>
      </section>
      <section class="ed-insp-section">
        <h4>{{ t('edit.subtitleBatch') }}</h4>
        <div class="ed-row">
          <button type="button" @click="$emit('cue-apply-all', effectiveAppearance)">{{ t('edit.applyAll') }}</button>
          <button type="button" @click="$emit('cue-set-default', effectiveAppearance)">{{ t('edit.setDefault') }}</button>
        </div>
      </section>
      <section class="ed-insp-section">
        <h4>{{ t('edit.subtitleActions') }}</h4>
        <div class="ed-row">
          <button type="button" class="is-danger" @click="$emit('cue-delete')">{{ t('edit.deleteCue') }}</button>
          <button type="button" @click="$emit('cue-split')">{{ t('edit.splitAtPlayhead') }}</button>
          <button type="button" @click="$emit('cue-merge-next')">{{ t('edit.mergeNext') }}</button>
        </div>
      </section>
```

脚本要点：

```ts
const fonts = SUBTITLE_FONT_WHITELIST
const NINE_GRID = [
  { key: 'tl', x: 12, y: 12 }, { key: 'tc', x: 50, y: 12 }, { key: 'tr', x: 88, y: 12 },
  { key: 'ml', x: 12, y: 50 }, { key: 'mc', x: 50, y: 50 }, { key: 'mr', x: 88, y: 50 },
  { key: 'bl', x: 12, y: 85 }, { key: 'bc', x: 50, y: 85 }, { key: 'br', x: 88, y: 85 },
]
// styleDraft：watch(props.cue) 深拷贝 resolveCueAppearance(cue, props.plan.project)；
// applyStyleDraft() → emit('cue-update', { appearance: { ...styleDraft } })（父级走 setCueAppearance，含文本 patch 同入口）
// nudgeFrames(delta)：开始/结束同时 ±(1000/fps)，emit('cue-update', { startMs, endMs })
// onStartInput/onEndInput：解析 mm:ss.mmm → ms
// outOfBounds：xPct/yPct 越出 subtitleSafeAreaPct
```

> 时间显示格式 `mm:ss.mmm` 由 `~/utils/edit-timecode` 新增 `formatClockMs(ms)` / `parseClockMs(text)`（若已有等价函数则复用；测试 `edit-utils.test.mjs` 补两条解析用例）。九宫格按钮样式 `.ed-nine-grid` 用 3×3 grid；`frameBack/frameForward` 类名保留在按钮 class 上供结构测试断言。

`frontend/app/components/edit/EditSubtitleList.vue`（抽屉）：

```vue
<template>
  <Teleport to="body">
    <div v-if="open" class="ed-sub-list" role="dialog">
      <header>
        <h3>{{ t('edit.subtitleListTitle') }}</h3>
        <input v-model="search" :placeholder="t('edit.search')" />
        <button type="button" @click="$emit('close')">×</button>
      </header>
      <ul>
        <li v-for="cue in filtered" :key="cue.id"
          :class="{ 'is-selected': cue.id === selectedCueId }"
          @click="$emit('select', cue.id)">
          <span class="ed-sub-time">{{ formatClockMs(cue.startMs) }} – {{ formatClockMs(cue.endMs) }}</span>
          <span class="ed-sub-text">{{ cue.text }}</span>
          <span v-if="cue.role" class="ed-sub-role">{{ cue.role }}</span>
          <span v-if="cue.follow" class="ed-sub-follow">{{ t('edit.following') }}</span>
        </li>
      </ul>
      <footer><button type="button" @click="$emit('add')">{{ t('edit.addSubtitle') }}</button></footer>
    </div>
  </Teleport>
</template>
```

`EditWorkbench` 接线：

- 顶部操作区（EditTopBar 的 `ed-top-right`）新增两个图标按钮：字幕列表（`Captions` 已引入）emit `toggle-subtitles`，导出入口按钮在 Task 23 加入；`EditTopBar` emits 增加 `toggle-subtitles`。
- `<EditClipInspector>` 增加 props：`:cue="selectedCue" :plan="plan"`，事件分别接到命令：

```ts
const selectedCue = computed(() => plan.value.subtitles.find((c) => c.id === selectedCueId.value) ?? null)
const showSafeArea = ref(false)
const subtitlesOpen = ref(false)

function updateSelectedCue(patch) {
  if (!selectedCueId.value) return
  applyCommand((p) => {
    if (patch.text !== undefined) return setCueText(p, selectedCueId.value, patch.text)
    if (patch.appearance !== undefined) return setCueAppearance(p, selectedCueId.value, patch.appearance)
    return setCueTime(p, selectedCueId.value, patch)
  })
}
function applyAllAppearance(appearance) {
  applyCommand((p) => applyAppearanceToAll(p, appearance))
}
function setDefaultAppearance(appearance) {
  applyCommand((p) => setSubtitleProjectDefaults(p, { appearance }))
}
function alignCueStart() { updateSelectedCue({ startMs: Math.round(currentMs.value) }) }
function alignCueEnd() { updateSelectedCue({ endMs: Math.round(currentMs.value) }) }
```

- `<EditSubtitleList :open="subtitlesOpen" :cues="plan.subtitles" :selected-cue-id="selectedCueId" @close="subtitlesOpen = false" @select="(id) => { selectCue(id); seek(plan.subtitles.find(c => c.id === id)?.startMs ?? currentMs) }" @add="addCueAtPlayheadCmd" />`，`addCueAtPlayheadCmd` 调 `applyCommand((p) => addCueAtPlayhead(p, currentMs.value, p.project))`。

四语言 `edit` 节新增（en/ja/ko 同步翻译）：`subtitleText/subtitleTime/subtitleStyle/subtitlePosition/subtitleBatch/subtitleActions/subtitleListTitle/addSubtitle/search/startTime/endTime/frameUnit/alignPlayheadStart/alignPlayheadEnd/followClip/following/fontFamily/fontSize/textColor/strokeColor/strokeWidth/backgroundColor/backgroundOpacity/align_left/align_center/align_right/posTop/posMiddle/posBottom/showSafeArea/subtitleOutOfBounds/applyAll/setDefault/deleteCue/splitAtPlayhead/mergeNext/previewApprox/subtitleBurnedWarning/mixSubtitleWarning`（`previewApprox` 固定文案「预览为近似效果，导出以成片为准」；两条 warning 用于 Task 13/14 的 `SUBTITLE_BURNED`/`MIX_FILM_SUBTITLE_UNKNOWN` 提示展示，本任务先加文案）。

- [ ] **Step 4: 运行测试与构建门禁**

```bash
cd frontend && node --test tests/edit-cue-commands.test.mjs tests/edit-subtitle-ui.test.mjs tests/edit-commands.test.mjs tests/edit-utils.test.mjs tests/edit-structure.test.mjs
cd frontend && npm run build
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 18: 前端——帧级操作纯函数

**Files:**
- Create: `frontend/app/utils/edit-frame-commands.ts`
- Test: `frontend/tests/edit-frame-commands.test.mjs`

**Interfaces:**
- Consumes: `splitClip/insertClip/removeClip/trimClipStart/trimClipEnd/createClipFromSource/createCommandId`（edit-commands.ts，签名已核对：`splitClip(plan, clipId, atOffsetMs, secondClipId)`、`trimClipStart/End(plan, clipId, deltaMs, {ripple})`）、`computeLocalLayout/activeClipIndex`（edit-layout.ts）、`minimumClipMs`（前端 edit-plan.ts 如无则用 `Math.ceil(3 * 1000 / fps)` 内联，裁决：视频片段最短 3 帧、图片最短 1 帧）。
- Produces（Task 22/23 的右键菜单与工具栏调用这些函数）:
  - `frameMsOf(fps: number): number`
  - `snapToFrame(ms: number, fps: number): number`
  - `rippleDeleteFrame(plan, atMs, fps): EditCommandResult`（错误码 `FRAME_DELETE_TOO_SHORT`）
  - `insertImageClip(plan, atMs, fps, imageSource, durationMs?): EditCommandResult`（默认 3000ms，上限 30000ms）
  - `insertFreezeFrame(plan, atMs, fps, imageSource, durationMs?): EditCommandResult`（默认 1000ms，范围 1 帧–10000ms）
  - `buildFreezeTail(plan, clipId, extendMs, fps, imageSource): EditCommandResult`（上限 600000ms）
  - `insertImageAtPlayheadNeedsSplit(plan, atMs, fps): boolean`（Task 23 决定是否先分割）

- [ ] **Step 1: 写失败测试**

`frontend/tests/edit-frame-commands.test.mjs`（加载方式与 `tests/edit-commands.test.mjs` 相同，见该文件头部的 TS import 机制）：

```mjs
test('帧网格：snapToFrame 与 frameMsOf', () => {
  assert.equal(frameMsOf(25), 40)
  assert.equal(frameMsOf(30), Math.round(1000 / 30 * 1000) / 1000)
  assert.equal(snapToFrame(1010, 25), 1000)
  assert.equal(snapToFrame(45, 25), 40)
})

test('片段内部删一帧：时长减一帧、后续内容前移', () => {
  const plan = planWithSingleVideoClip(10_000, 25) // 一个 10s/25fps 视频片段
  const before = computeLocalLayout(plan).duration_ms
  const result = rippleDeleteFrame(plan, 5000, 25)
  assert.equal(result.issues.filter((i) => i.severity === 'error').length, 0)
  const after = computeLocalLayout(result.plan).duration_ms
  assert.equal(before - after, 40)
  assert.equal(result.plan.clips.length, 3) // 分割为三段、删除中间一段后剩两段？——
  // 实现：两次分割得三段、删中段 → clips.length == 2。此断言应写 2。
})
```

> 上例注释里的自我矛盾就是实现要裁决的点：断言最终写成 `assert.equal(result.plan.clips.length, 2)`（删除中段后剩 2 段）。计划正文以此为准，写测试时直接用 2，不保留注释。

完整用例清单（每个用例独立夹具，`planWithSingleVideoClip(durationMs, fps)` / `planWithImageClip(durationMs)` 参照 `tests/edit-commands.test.mjs` 的现有夹具写法）：

1. `rippleDeleteFrame` 片段内部删帧：总时长 −`frameMs`、片段数 +1（分割出两段）、删除位置后内容整体前移。
2. `rippleDeleteFrame` 播放头在片段开头（= 前一片段结尾）且存在前一片段：前一片段 `sourceOutMs` 减少 1 帧，片段数不变。
3. `rippleDeleteFrame` 时间线起点（无前一片段）：首个片段 `sourceInMs` 增加 1 帧。
4. `rippleDeleteFrame` 片段太短（内容 < 2×最短帧 + 1 帧）：返回原计划，issues 含 `severity:'error'`、`code:'FRAME_DELETE_TOO_SHORT'`。
5. `rippleDeleteFrame` 图片片段内删帧：图片片段时长减 1 帧（图片最短 1 帧，减到 1 帧后再删报错）。
6. `insertImageClip` 在片段中间：先分割再插入图片片段，图片默认 3000ms，后续内容后移。
7. `insertImageClip` 时长上限 30000ms、下限 1 帧：超出被夹取并带 warning。
8. `insertFreezeFrame` 默认 1000ms；`buildFreezeTail` 追加图片片段 5000ms，原视频片段不动；`buildFreezeTail` 上限 600000ms。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd frontend && node --test tests/edit-frame-commands.test.mjs
```

- [ ] **Step 3: 实现**

新建 `frontend/app/utils/edit-frame-commands.ts`：

```ts
import {
  createClipFromSource,
  createCommandId,
  insertClip,
  removeClip,
  splitClip,
  trimClipEnd,
  trimClipStart,
  type EditCommandIssue,
  type EditCommandResult,
} from './edit-commands.ts'
import type { EditClipSource, EditPlanV1 } from './edit-plan.ts'
import { computeLocalLayout } from './edit-layout.ts'

export function frameMsOf(fps: number): number {
  return 1000 / Math.max(1, Math.round(fps))
}

export function snapToFrame(ms: number, fps: number): number {
  const frame = frameMsOf(fps)
  return Math.round(ms / frame) * frame
}

function issueError(code: string, path: string, message: string): EditCommandIssue {
  return { severity: 'error', code, path, message }
}

function issueWarning(code: string, path: string, message: string): EditCommandIssue {
  return { severity: 'warning', code, path, message }
}

function minFramesMs(plan: EditPlanV1, fps: number): number {
  return 3 * frameMsOf(fps)
}

function imageSourceToClipSource(imageSource: {
  url: string
  width: number
  height: number
  fingerprint: string
}, durationMs: number): EditClipSource {
  return {
    kind: 'asset',
    id: imageSource.fingerprint,
    url: imageSource.url,
    durationMs: Math.max(1, Math.round(durationMs)),
    width: imageSource.width,
    height: imageSource.height,
    fps: null,
    hasAudio: false,
    fingerprint: imageSource.fingerprint,
    label: imageSource.label,
  }
}

export function rippleDeleteFrame(
  plan: EditPlanV1,
  atMs: number,
  fps: number,
): EditCommandResult {
  const frame = frameMsOf(fps)
  const snapped = snapToFrame(atMs, fps)
  const layout = computeLocalLayout(plan)
  const hit = layout.clips.find(
    (item) => snapped >= item.timeline_start_ms && snapped < item.timeline_end_ms,
  )
  if (!hit) return { plan, issues: [issueError('FRAME_NOT_FOUND', 'playhead', '播放头不在任何片段内')], focusClipId: null }
  const index = plan.clips.findIndex((clip) => clip.id === hit.clip_id)
  const clip = plan.clips[index]
  const isImage = clip.kind === 'image'
  const minMs = isImage ? frame : minFramesMs(plan, fps)

  // 边界：播放头正好在片段起点
  if (snapped === hit.timeline_start_ms) {
    if (index > 0) {
      const prev = plan.clips[index - 1]
      const content = prev.sourceOutMs - prev.sourceInMs
      if (content - frame < (prev.kind === 'image' ? frame : minFramesMs(plan, fps))) {
        return { plan, issues: [issueError('FRAME_DELETE_TOO_SHORT', prev.id, '片段太短，无法删除这一帧')], focusClipId: null }
      }
      return trimClipEnd(plan, prev.id, -Math.round(frame * (Number(prev.speed) || 1)))
    }
    if (clip.sourceInMs + Math.round(frame * (Number(clip.speed) || 1)) > Number(clip.sourceOutMs) - minMs) {
      return { plan, issues: [issueError('FRAME_DELETE_TOO_SHORT', clip.id, '片段太短，无法删除这一帧')], focusClipId: null }
    }
    return trimClipStart(plan, clip.id, Math.round(frame * (Number(clip.speed) || 1)))
  }
  // 边界：播放头在片段结尾帧 → 删本片段最后一帧
  if (snapped >= hit.timeline_end_ms - frame) {
    if (clip.sourceOutMs - Math.round(frame * (Number(clip.speed) || 1)) < Number(clip.sourceInMs) + minMs) {
      return { plan, issues: [issueError('FRAME_DELETE_TOO_SHORT', clip.id, '片段太短，无法删除这一帧')], focusClipId: null }
    }
    return trimClipEnd(plan, clip.id, -Math.round(frame * (Number(clip.speed) || 1)))
  }

  // 内部：两次分割 + 删中段
  const offsetInClip = snapped - hit.timeline_start_ms
  const speed = Number(clip.speed) || 1
  const tailId = createCommandId('clp')
  const first = splitClip(plan, clip.id, offsetInClip, tailId)
  if (first.issues.some((i) => i.severity === 'error')) {
    return { plan, issues: [issueError('FRAME_DELETE_TOO_SHORT', clip.id, '片段太短，无法删除这一帧')], focusClipId: null }
  }
  const midId = createCommandId('clp')
  const second = splitClip(first.plan, tailId, Math.round(frame * speed), midId)
  if (second.issues.some((i) => i.severity === 'error')) {
    return { plan, issues: [issueError('FRAME_DELETE_TOO_SHORT', clip.id, '片段太短，无法删除这一帧')], focusClipId: null }
  }
  return removeClip(second.plan, tailId)
}
```

> 实现注意：`splitClip` 的 `atOffsetMs` 是片段内容偏移，speed≠1 时源时间换算已由 `splitClip` 内部处理（`sourceSplit = sourceInMs + offset * speed`），传入的时间线偏移无需再乘 speed——删除的“1 帧”是时间线帧，片段内偏移即 `frame`，上面 `Math.round(frame * speed)` 应为 `Math.round(frame)`（splitClip 自己乘 speed 换算源时间）。实现时按此修正，测试用例 1 用 speed=1 不受影响，补一条 speed=2 的删帧用例锁定语义（总时长 −1 帧、源区间缩 2 帧）。

```ts
export function insertImageClip(
  plan: EditPlanV1,
  atMs: number,
  fps: number,
  imageSource: { url: string; width: number; height: number; fingerprint: string; label?: string },
  durationMs = 3000,
): EditCommandResult {
  const frame = frameMsOf(fps)
  const target = Math.max(frame, Math.min(30_000, Math.round(durationMs)))
  const issues: EditCommandIssue[] = []
  if (target !== Math.round(durationMs)) {
    issues.push(issueWarning('IMAGE_DURATION_CLAMPED', 'image', '图片时长已夹取到 0.1–30 秒'))
  }
  const source = imageSourceToClipSource(imageSource, target)
  let working = plan
  let insertIndex = working.clips.length
  const layout = computeLocalLayout(working)
  const hit = layout.clips.find(
    (item) => atMs > item.timeline_start_ms && atMs < item.timeline_end_ms,
  )
  if (hit) {
    const split = splitClip(working, hit.clip_id, atMs - hit.timeline_start_ms, createCommandId('clp'))
    if (split.issues.some((i) => i.severity === 'error')) {
      return { plan, issues: [issueError('IMAGE_INSERT_SPLIT', hit.clip_id, '播放头位置无法分割，无法插入图片')], focusClipId: null }
    }
    issues.push(...split.issues)
    working = split.plan
    insertIndex = working.clips.findIndex((clip) => clip.id === hit.clip_id) + 1
  } else {
    const at = layout.clips.findIndex((item) => item.timeline_start_ms >= atMs)
    insertIndex = at < 0 ? working.clips.length : at
  }
  const clip = createClipFromSource(createCommandId('img'), source, {
    kind: 'image',
    sourceInMs: 0,
    sourceOutMs: target,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
  })
  return insertClip(working, clip, { index: insertIndex })
}
```

```ts
export function insertFreezeFrame(
  plan: EditPlanV1,
  atMs: number,
  fps: number,
  imageSource: { url: string; width: number; height: number; fingerprint: string; label?: string },
  durationMs = 1000,
): EditCommandResult {
  const min = frameMsOf(fps)
  return insertImageClip(plan, atMs, fps, imageSource, Math.max(min, Math.min(10_000, durationMs)))
}

export function buildFreezeTail(
  plan: EditPlanV1,
  clipId: string,
  extendMs: number,
  fps: number,
  imageSource: { url: string; width: number; height: number; fingerprint: string; label?: string },
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) return { plan, issues: [issueError('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在')], focusClipId: null }
  const target = Math.max(frameMsOf(fps), Math.min(600_000, Math.round(extendMs)))
  const source = imageSourceToClipSource(imageSource, target)
  const clip = createClipFromSource(createCommandId('frz'), source, {
    kind: 'image',
    sourceInMs: 0,
    sourceOutMs: target,
  })
  return insertClip(plan, clip, { index: index + 1 })
}

export function insertImageAtPlayheadNeedsSplit(plan: EditPlanV1, atMs: number, fps: number): boolean {
  const layout = computeLocalLayout(plan)
  return layout.clips.some(
    (item) => snapToFrame(atMs, fps) > item.timeline_start_ms
      && snapToFrame(atMs, fps) < item.timeline_end_ms,
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd frontend && node --test tests/edit-frame-commands.test.mjs tests/edit-commands.test.mjs
cd frontend && npm run build
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 19: 后端——帧抽取与图片上传

**Files:**
- Modify: `backend/src/services/edit-draft-service.ts`（导出 `loadProjectPlan`）
- Create: `backend/src/services/edit-frames.ts`
- Create: `backend/src/services/edit-image-assets.ts`
- Modify: `backend/src/routes/edit.ts`
- Modify: `backend/src/services/edit-media-library.ts`
- Test: `backend/tests/edit-frames.test.ts`

**Interfaces:**
- Consumes: Task 12 的 `requireEditProject`；`video-frames.ts` 的既有模式（`ffmpeg` fluent 调用、`projectStorageRelative/projectSubdirPath/ensureProjectStorageLayout`、`scaleFilter` 思路）；`edit-media.ts` 的 `fingerprintOfFile`；`sharp`（storage.ts 已在用）。
- Produces:
  - `loadProjectPlan(project: EditProjectRow): EditPlanV1`（草稿优先，其次当前版本；都没有时抛 `EditWorkspaceError(409, 'EDIT_NO_PLAN', '工程还没有计划')`）。
  - `extractEditFrame(input: { episodeId, project: EditProjectRow, clipId: string, offsetMs: number }): Promise<{ url, width, height, fingerprint }>`。
  - `saveEditImageAsset(dramaId: number, file: File): Promise<{ url, width, height, fingerprint }>`。
  - `listEditImageAssets(dramaId: number): Promise<EditMediaLibraryResponse['images']>`。

- [ ] **Step 1: 写失败测试**

`backend/tests/edit-frames.test.ts`（环境变量与动态 import 头部照抄 `tests/edit-route.test.ts`）：

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-frames-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '抽帧', aspectRatio: '9:16', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '抽帧集', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'src.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoFile,
], { stdio: 'ignore' })
const sourceUrl = `static/projects/${drama.id}/videos/src.mp4`

setEditWorkspaceMode('on')

async function createProject(): Promise<{ filmId: number; projectId: number }> {
  const merge = db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: drama.id, title: '源成片', kind: 'concat',
    status: 'completed', mergedUrl: sourceUrl, duration: 2000,
    createdAt: ts, completedAt: ts,
  }).returning().get()
  const opened = await app.request(`/episodes/${episode.id}/edit/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ film_id: merge.id }),
  })
  const data = (await opened.json()).data
  return { filmId: merge.id, projectId: data.project.id }
}

function pngBuffer(size = 64): Promise<Buffer> {
  return import('sharp').then((mod) => mod.default({
    create: { width: size, height: size, channels: 3, background: 'blue' },
  }).png().toBuffer())
}

after(() => fs.rmSync(root, { recursive: true, force: true }))

test('抽帧：返回 PNG、尺寸与指纹，重复请求命中缓存', async () => {
  const { projectId } = await createProject()
  const state = (await (await app.request(`/episodes/${episode.id}/edit?project_id=${projectId}`)).json()).data
  const clipId = state.plan.clips[0].id

  const first = await app.request(`/episodes/${episode.id}/edit/frames`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, clip_id: clipId, offset_ms: 500 }),
  })
  assert.equal(first.status, 200, await first.clone().text())
  const data = (await first.json()).data
  assert.match(data.url, /edit\/frames\/.+\.png$/)
  assert.ok(data.width > 0 && data.height > 0)
  assert.equal(data.fingerprint.length, 32)
  assert.ok(fs.existsSync(path.join(root, data.url)))

  const second = await app.request(`/episodes/${episode.id}/edit/frames`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, clip_id: clipId, offset_ms: 500 }),
  })
  assert.equal((await second.json()).data.url, data.url)
})

test('抽帧：未知片段 404、offset 越界夹取到片段内', async () => {
  const { projectId } = await createProject()
  const missing = await app.request(`/episodes/${episode.id}/edit/frames`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, clip_id: 'nope', offset_ms: 0 }),
  })
  assert.equal(missing.status, 404)

  const state = (await (await app.request(`/episodes/${episode.id}/edit?project_id=${projectId}`)).json()).data
  const clipId = state.plan.clips[0].id
  const out = await app.request(`/episodes/${episode.id}/edit/frames`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, clip_id: clipId, offset_ms: 99_999 }),
  })
  assert.equal(out.status, 200) // 夹取到片段末尾，不报错
})

test('图片上传：入库 edit/assets、同内容去重、非法类型拒绝', async () => {
  const buffer = await pngBuffer()
  const form = new FormData()
  form.append('file', new File([buffer], 'a.png', { type: 'image/png' }))
  const ok = await app.request(`/episodes/${episode.id}/edit/assets/images`, { method: 'POST', body: form })
  assert.equal(ok.status, 200, await ok.clone().text())
  const data = (await ok.json()).data
  assert.match(data.url, /edit\/assets\//)
  assert.equal(data.width, 64)
  assert.equal(data.fingerprint.length, 32)

  const again = await app.request(`/episodes/${episode.id}/edit/assets/images`, {
    method: 'POST',
    body: (() => { const f = new FormData(); f.append('file', new File([buffer], 'b.png', { type: 'image/png' })); return f })(),
  })
  assert.equal((await again.json()).data.url, data.url)

  const bad = await app.request(`/episodes/${episode.id}/edit/assets/images`, {
    method: 'POST',
    body: (() => { const f = new FormData(); f.append('file', new File([Buffer.from('text')], 'x.txt', { type: 'text/plain' })); return f })(),
  })
  assert.equal(bad.status, 400)
})

test('媒体库包含已上传图片', async () => {
  const media = (await (await app.request(`/episodes/${episode.id}/edit/media`)).json()).data
  assert.ok(Array.isArray(media.images))
  assert.ok(media.images.some((img: any) => img.width === 64))
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/edit-frames.test.ts
```

预期：404（路由不存在）导致断言失败。

- [ ] **Step 3: 实现**

`backend/src/services/edit-draft-service.ts` 导出：

```ts
import { EditWorkspaceError } from './edit-errors.js'
import { parsePlanJson } from './edit-plan-json.js' // 若该文件没有此 helper，用现有草稿/版本反序列化路径（与 getEpisodeEditState 同一实现）

/** 草稿优先，其次当前版本；都没有抛 EDIT_NO_PLAN */
export function loadProjectPlan(project: EditProjectRow): EditPlanV1 {
  const draft = db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.projectId, project.id)).get()
  if (draft?.planJson) return parsePlanJson(draft.planJson)
  const revision = db.select().from(schema.editRevisions)
    .where(and(eq(schema.editRevisions.projectId, project.id), eq(schema.editRevisions.isCurrent, true)))
    .orderBy(desc(schema.editRevisions.revisionNo)).get()
  if (revision?.planJson) return parsePlanJson(revision.planJson)
  throw new EditWorkspaceError(409, 'EDIT_NO_PLAN', '工程还没有计划，无法执行该操作')
}
```

> `parsePlanJson` 与版本/草稿读取的真实 helper 名以 Task 14 重写后的 `edit-draft-service.ts` 为准，不要新造第二套。

新建 `backend/src/services/edit-frames.ts`：

```ts
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ffmpeg } from '../utils/ffmpeg.js'
import { getAbsolutePath } from '../utils/storage.js'
import { fingerprintOfFile } from './edit-media.js'
import { loadProjectPlan } from './edit-draft-service.js'
import type { EditProjectRow } from './edit-project-service.js'
import {
  ensureProjectStorageLayout,
  projectSubdirPath,
  projectStorageRelative,
} from './project-storage.js'

const FRAME_MAX_EDGE = 1920

function scaleFilter(width: number, height: number): string {
  const edge = Math.max(width, height)
  if (edge <= FRAME_MAX_EDGE) return 'null'
  const ratio = FRAME_MAX_EDGE / edge
  return `scale=${Math.max(2, Math.round(width * ratio / 2) * 2)}:${Math.max(2, Math.round(height * ratio / 2) * 2)}`
}

export async function extractEditFrame(input: {
  episodeId: number
  project: EditProjectRow
  clipId: string
  offsetMs: number
}): Promise<{ url: string; width: number; height: number; fingerprint: string }> {
  const plan = loadProjectPlan(input.project)
  const clip = plan.clips.find((item) => item.id === input.clipId)
  if (!clip) {
    const error = new Error('片段不存在') as Error & { status?: number; code?: string }
    error.status = 404
    error.code = 'CLIP_NOT_FOUND'
    throw error
  }
  const contentMs = Math.max(1, clip.sourceOutMs - clip.sourceInMs)
  const offset = Math.min(Math.max(0, Math.round(input.offsetMs)), contentMs - 1)
  const sourceMs = clip.sourceInMs + Math.round(offset * (Number(clip.speed) || 1))
  const sourceAbsolute = getAbsolutePath(clip.source.url)
  const fingerprint = await fingerprintOfFile(sourceAbsolute)
  const dramaId = input.project.dramaId
  await ensureProjectStorageLayout(dramaId)
  const filename = `frame-${fingerprint.slice(0, 12)}-${sourceMs}.png`
  const relativePath = projectStorageRelative(dramaId, 'edit/frames', filename)
  const absolutePath = path.join(projectSubdirPath(dramaId, 'edit/frames'), filename)

  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).size === 0) {
    await fsp.mkdir(path.dirname(absolutePath), { recursive: true })
    await new Promise<void>((resolve, reject) => {
      ffmpeg(sourceAbsolute)
        .seekInput(sourceMs / 1000)
        .outputOptions(['-frames:v', '1', '-vf', scaleFilter(clip.source.width, clip.source.height)])
        .output(absolutePath)
        .on('end', () => resolve())
        .on('error', (error: Error) => reject(new Error(`抽帧失败：${error.message}`)))
        .run()
    })
  }
  const outputFingerprint = await fingerprintOfFile(absolutePath)
  const { width, height } = await probePngSize(absolutePath)
  return { url: `/${relativePath}`, width, height, fingerprint: outputFingerprint }
}

async function probePngSize(file: string): Promise<{ width: number; height: number }> {
  const sharp = (await import('sharp')).default
  const meta = await sharp(file).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}
```

> 若 `project-storage.ts` 没有按子目录建目录的 `projectSubdirPath`（它接收相对子路径并保证目录存在——以 Task 10 已有的实现为准，打开文件确认函数名），就改用 `ensureProjectStorageLayout(dramaId)` 后手动 `fsp.mkdir(path.dirname(absolutePath), { recursive: true })` + 自拼 `static/projects/<dramaId>/edit/frames/...` 相对路径，返回 URL 仍为 `/${relativePath}`。

新建 `backend/src/services/edit-image-assets.ts`：

```ts
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  ensureProjectStorageLayout,
  projectStorageRelative,
} from './project-storage.js'
import { getAbsolutePath } from '../utils/storage.js'

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_BYTES = 20 * 1024 * 1024
const MAX_EDGE = 4096

export async function saveEditImageAsset(
  dramaId: number,
  file: File,
): Promise<{ url: string; width: number; height: number; fingerprint: string }> {
  if (!ALLOWED.has(file.type)) throw assetError(400, 'IMAGE_TYPE', '仅支持 PNG / JPG / WebP 图片')
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.byteLength > MAX_BYTES) throw assetError(400, 'IMAGE_TOO_LARGE', '图片不能超过 20MB')
  const sharp = (await import('sharp')).default
  const meta = await sharp(buffer).metadata().catch(() => null)
  if (!meta || !ALLOWED.has(`image/${meta.format === 'jpg' ? 'jpeg' : meta.format}`)) {
    throw assetError(400, 'IMAGE_DECODE', '图片无法解码')
  }
  if ((meta.width ?? 0) > MAX_EDGE || (meta.height ?? 0) > MAX_EDGE) {
    throw assetError(400, 'IMAGE_DIMENSIONS', '图片尺寸不能超过 4096×4096')
  }
  const fingerprint = crypto.createHash('sha256').update(buffer).digest('hex')
  const ext = meta.format === 'jpeg' ? 'jpg' : meta.format
  await ensureProjectStorageLayout(dramaId)
  const filename = `${fingerprint.slice(0, 16)}.${ext}`
  const relativePath = projectStorageRelative(dramaId, 'edit/assets', filename)
  const absolutePath = getAbsolutePath(relativePath)
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true })
  if (!fs.existsSync(absolutePath)) await fsp.writeFile(absolutePath, buffer)
  return { url: `/${relativePath}`, width: meta.width ?? 0, height: meta.height ?? 0, fingerprint }
}

function assetError(status: number, code: string, message: string) {
  const error = new Error(message) as Error & { status?: number; code?: string }
  error.status = status
  error.code = code
  return error
}

export interface EditImageAsset {
  url: string
  width: number
  height: number
  fingerprint: string
  source: 'uploaded' | 'storyboard'
  label: string
}

export async function listEditImageAssets(dramaId: number): Promise<EditImageAsset[]> {
  const sharp = (await import('sharp')).default
  const dir = getAbsolutePath(`static/projects/${dramaId}/edit/assets`)
  const files = await fsp.readdir(dir).catch(() => [] as string[])
  const uploaded: EditImageAsset[] = []
  for (const name of files.filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).sort()) {
    const relativePath = `static/projects/${dramaId}/edit/assets/${name}`
    const meta = await sharp(getAbsolutePath(relativePath)).metadata().catch(() => null)
    if (!meta?.width || !meta?.height) continue
    uploaded.push({
      url: `/${relativePath}`,
      width: meta.width,
      height: meta.height,
      fingerprint: name.replace(/\.[^.]+$/, ''),
      source: 'uploaded',
      label: name,
    })
  }
  return uploaded
}
```

> `fs` 需要同时 import（`import fs from 'node:fs'`）。`projectStorageRelative(dramaId, 'edit/assets', filename)` 返回形如 `static/projects/<id>/edit/assets/<file>` 的相对路径——以 `project-storage.ts` 实际签名为准（video-frames.ts 的用法可对照）。

`backend/src/services/edit-media-library.ts`：返回对象增加 `images` 字段——

```ts
import { listEditImageAssets } from './edit-image-assets.js'
// getEditMediaLibrary 内（storyboards 组装前）：
const dramaId = /* episode 行的 dramaId，getReadableEpisode 已返回或再查一次 */
const uploadedImages = await listEditImageAssets(dramaId)
const storyboardImages = storyboardRows
  .filter((row) => row.firstFrameImage || row.composedImage)
  .map((row) => ({
    url: `/${row.firstFrameImage || row.composedImage}`,
    width: 0,
    height: 0,
    fingerprint: `sb-${row.id}`,
    source: 'storyboard' as const,
    label: `分镜 ${row.storyboardNumber}`,
  }))
// 返回值增加：
    images: [...storyboardImages, ...uploadedImages],
```

> 故事板图片尺寸未知时填 0，前端选择器显示时按容器缩放即可；`import_enabled` 字段保持不变。

`backend/src/routes/edit.ts` 追加两条路由（放在草稿路由之后）：

```ts
app.post('/episodes/:id/edit/frames', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    getWritableEpisode(episodeId)
    const body = await readBody(c)
    const project = await projectFromBody(c, episodeId, body)
    const clipId = String(body.clip_id ?? '')
    if (!clipId) return badRequest(c, '片段编号必填')
    const result = await extractEditFrame({
      episodeId,
      project,
      clipId,
      offsetMs: Number(body.offset_ms) || 0,
    })
    return success(c, result)
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/assets/images', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    const episode = getWritableEpisode(episodeId)
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || !(file instanceof File)) return badRequest(c, '文件必填')
    const result = await saveEditImageAsset(episode.dramaId, file)
    return success(c, result)
  } catch (error) {
    return handleEditError(c, error)
  }
})
```

> `handleEditError` 需识别带 `status/code` 的自定义 Error：若现有实现只认 `EditWorkspaceError`，在 `handleEditError` 里补一个分支——`error` 含数字 `status`（200–599）时按该状态返回 `{ code, message }`。这属于本任务的允许改动。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/edit-frames.test.ts tests/edit-project-state.test.ts tests/edit-route.test.ts
cd backend && npm run typecheck
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 20: 后端——剪辑渲染器

**Files:**
- Create: `backend/src/services/edit-render-plan.ts`
- Test: `backend/tests/edit-render-plan.test.ts`

**Interfaces:**
- Consumes: `computeLayout`（edit-plan.ts）、`ffmpeg`（utils/ffmpeg.ts）、`getAbsolutePath`、Task 15 的 `buildEditAss`（烧录字幕文件由 Task 21 生成后传入）。
- Produces（Task 21 依赖的精确签名）:
  - `interface EditRenderWarning { code: string; message: string }`
  - `buildRenderReport(plan: EditPlanV1): { warnings: EditRenderWarning[] }`（转场→硬切、滤镜、缩放位移、叠加轨四类降级，全部列出，供导出确认弹窗使用）
  - `renderEditVideo(input: { plan: EditPlanV1; outputPath: string; subtitleMode: 'burn' | 'soft' | 'none'; assPath?: string; srtPath?: string; onProgress?: (pct: number) => void }): Promise<{ durationMs: number; warnings: EditRenderWarning[] }>`

- [ ] **Step 1: 写失败测试**

`backend/tests/edit-render-plan.test.ts`（环境头部照抄 edit-route.test.ts；不走路由，直接调服务）：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const ffprobeBin: string = process.env.FFPROBE_BIN || require('ffprobe-static').path || 'ffprobe'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-render-'))
const videoFile = path.join(root, 'src.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoFile,
], { stdio: 'ignore' })

function probe(file: string) {
  const out = execFileSync(ffprobeBin, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ]).toString()
  return JSON.parse(out)
}

function basePlan() {
  const plan = createSingleClipPlan(1, { ...projectSettingsForAspect('16:9', 25), width: 320, height: 240 }, {
    kind: 'episode-video', id: 1, url: '', durationMs: 2000,
    width: 320, height: 240, fps: 25, hasAudio: true, fingerprint: 'fp',
  })
  plan.clips[0].sourceInMs = 0
  plan.clips[0].sourceOutMs = 1000
  return plan
}

test('渲染报告列出转场/滤镜/变换/叠加降级', () => {
  const plan = basePlan()
  plan.transitions = [{ id: 'tr1', fromClipId: plan.clips[0].id, toClipId: 'c2', type: 'dissolve', durationMs: 300 }]
  plan.clips[0].filter.preset = 'warm'
  plan.clips[0].transform.x = 40
  plan.overlays = [{ /* 任一 overlay 对象 */ } as any]
  const { warnings } = buildRenderReport(plan)
  const codes = warnings.map((w) => w.code)
  assert.ok(codes.includes('TRANSITION_HARD_CUT'))
  assert.ok(codes.includes('FILTER_UNSUPPORTED'))
  assert.ok(codes.includes('TRANSFORM_UNSUPPORTED'))
  assert.ok(codes.includes('OVERLAY_UNSUPPORTED'))
})

test('渲染两段 + 空档：时长误差 ≤1 帧，含 H.264 与 AAC 流', async () => {
  const plan = basePlan()
  const clip2 = structuredClone(plan.clips[0])
  clip2.id = 'clp_2'
  clip2.sourceInMs = 1000
  clip2.gapBeforeMs = 250
  plan.clips.push(clip2)
  const output = path.join(root, 'out.mp4')
  const { durationMs, warnings } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.equal(warnings.length, 0)
  const media = probe(output)
  assert.ok(media.streams.some((s: any) => s.codec_name === 'h264'))
  assert.ok(media.streams.some((s: any) => s.codec_name === 'aac'))
  const expected = 1000 + 250 + 1000
  const frame = 1000 / 25
  assert.ok(Math.abs(media.format.duration * 1000 - expected) <= frame, `${media.format.duration}s vs ${expected}ms`)
  assert.ok(Math.abs(durationMs - expected) <= frame)
})

test('图片片段循环为视频帧且无声', async () => {
  const sharp = (await import('sharp')).default
  const img = path.join(root, 'img.png')
  await sharp({ create: { width: 320, height: 240, channels: 3, background: 'blue' } }).png().toFile(img)
  const plan = basePlan()
  plan.clips.push({
    ...structuredClone(plan.clips[0]),
    id: 'img_1',
    kind: 'image',
    source: { kind: 'asset', id: 'img', url: img, durationMs: 1500, width: 320, height: 240, fps: null, hasAudio: false, fingerprint: 'img' },
    sourceInMs: 0,
    sourceOutMs: 1500,
    gapBeforeMs: 0,
  })
  const output = path.join(root, 'img-out.mp4')
  const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  const media = probe(output)
  assert.ok(Math.abs(media.format.duration * 1000 - 2500) <= 40)
  assert.ok(Math.abs(durationMs - 2500) <= 40)
})

test('变速 2× 与淡入淡出按参数生效（时长减半）', async () => {
  const plan = basePlan()
  plan.clips[0].sourceOutMs = 2000
  plan.clips[0].speed = 2
  plan.clips[0].videoFadeInMs = 200
  plan.clips[0].videoFadeOutMs = 200
  const output = path.join(root, 'speed.mp4')
  const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.ok(Math.abs(durationMs - 1000) <= 40)
})

test('烧录字幕：传入 ASS 后输出含烧录字幕（时长不变）', async () => {
  const plan = basePlan()
  plan.subtitles = [{
    id: 'cue_1', text: '测试字幕', startMs: 0, endMs: 1000, style: 'default',
    role: null, source: 'manual', follow: false, anchor: null, lineId: null, warnings: [],
  }]
  const assPath = path.join(root, 'subs.ass')
  fs.writeFileSync(assPath, buildEditAss(plan))
  const output = path.join(root, 'burn.mp4')
  const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'burn', assPath })
  assert.ok(Math.abs(durationMs - 1000) <= 40)
  // 烧录字幕不改变流结构
  assert.ok(probe(output).streams.some((s: any) => s.codec_name === 'h264'))
})

after(() => fs.rmSync(root, { recursive: true, force: true }))
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/edit-render-plan.test.ts
```

- [ ] **Step 3: 实现**

新建 `backend/src/services/edit-render-plan.ts`。核心结构（完整实现，`run()` 为 fluent-ffmpeg Promise 封装，与本仓库 video-frames.ts 同款）：

```ts
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ffmpeg } from '../utils/ffmpeg.js'
import { getAbsolutePath } from '../utils/storage.js'
import { computeLayout, type EditPlanV1 } from './edit-plan.js'

export interface EditRenderWarning { code: string; message: string }

/** 导出降级清单：所有不支持项必须出现在报告中（设计 6.10 支持范围表） */
export function buildRenderReport(plan: EditPlanV1): { warnings: EditRenderWarning[] } {
  const warnings: EditRenderWarning[] = []
  if (plan.transitions.length) {
    warnings.push({ code: 'TRANSITION_HARD_CUT', message: '转场将按硬切导出' })
  }
  if (plan.clips.some((clip) => clip.filter.preset !== 'none')) {
    warnings.push({ code: 'FILTER_UNSUPPORTED', message: '滤镜暂不支持导出，将按原画面输出' })
  }
  if (plan.clips.some((clip) => clip.transform.scale !== 1 || clip.transform.x !== 0 || clip.transform.y !== 0)) {
    warnings.push({ code: 'TRANSFORM_UNSUPPORTED', message: '缩放与位移暂不支持导出' })
  }
  if (plan.overlays.length) {
    warnings.push({ code: 'OVERLAY_UNSUPPORTED', message: '叠加轨（画中画/文字）暂不支持导出，将忽略' })
  }
  if (plan.clips.some((clip) => (Number(clip.speed) || 1) < 0.5 || (Number(clip.speed) || 1) > 2)) {
    warnings.push({ code: 'SPEED_CLAMPED', message: '变速超出 0.5–2×，将夹取到支持范围' })
  }
  return { warnings }
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = ffmpeg()
    // 直接以参数数组驱动，绕过 fluent 的输入封装（concat 列表需要 -f concat）
    child._getArguments = () => args
    child.on('end', () => resolve())
    child.on('error', (error: Error) => reject(new Error(error.message)))
    child.run()
  })
}
```

> `child._getArguments` 是 fluent-ffmpeg 的内部口子，不要依赖——改用 `spawn` 直接调用 `resolveFfmpegSuite().ffmpeg.path` 更稳。裁决：用 `node:child_process` 的 `execFile(ffmpegPath, args)`（utils/ffmpeg.ts 导出 `resolveFfmpegSuite`，必要时在本文件 `import { resolveFfmpegSuite } from '../utils/ffmpeg.js'` 并新增导出——若该文件未导出，则导出之）。上面 `run()` 的最终形态：

```ts
import { execFile } from 'node:child_process'
import { resolveFfmpegSuite } from '../utils/ffmpeg.js'

function run(args: string[]): Promise<void> {
  const bin = resolveFfmpegSuite().ffmpeg.path || 'ffmpeg'
  return new Promise((resolve, reject) => {
    execFile(bin, ['-hide_banner', '-loglevel', 'error', ...args], (error) => {
      if (error) reject(new Error(`渲染失败：${error.message}`))
      else resolve()
    })
  })
}
```

逐片段渲染（片段文件统一为 `WxH@fps` + `aac 48k stereo`，之后 concat `-c copy`）：

```ts
function videoFilter(clip: EditPlanV1['clips'][number], plan: EditPlanV1): string[] {
  const { width, height } = plan.project
  const fps = plan.project.fps
  const t = clip.transform
  const chain: string[] = [`fps=${fps}`]
  if (t.rotation === 90) chain.push('transpose=1')
  if (t.rotation === 270) chain.push('transpose=2')
  if (t.rotation === 180) chain.push('transpose=1,transpose=1')
  if (t.flipH) chain.push('hflip')
  if (t.flipV) chain.push('vflip')
  if (plan.project.defaultFit === 'fill') {
    chain.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`)
    chain.push(`crop=${width}:${height}`)
  } else {
    chain.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`)
    chain.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`)
  }
  if (clip.videoFadeInMs > 0) chain.push(`fade=t=in:st=0:d=${(clip.videoFadeInMs / 1000).toFixed(3)}`)
  if (clip.videoFadeOutMs > 0) {
    const contentMs = clip.sourceOutMs - clip.sourceInMs
    chain.push(`fade=t=out:st=${((contentMs - clip.videoFadeOutMs) / 1000).toFixed(3)}:d=${(clip.videoFadeOutMs / 1000).toFixed(3)}`)
  }
  chain.push('format=yuv420p')
  return chain
}

function audioFilter(clip: EditPlanV1['clips'][number]): string[] {
  const chain: string[] = []
  const speed = Math.min(2, Math.max(0.5, Number(clip.speed) || 1))
  if (speed !== 1) chain.push(`atempo=${speed}`)
  const contentMs = clip.sourceOutMs - clip.sourceInMs
  if (clip.videoFadeInMs > 0) chain.push(`afade=t=in:st=0:d=${(clip.videoFadeInMs / 1000).toFixed(3)}`)
  if (clip.videoFadeOutMs > 0) {
    chain.push(`afade=t=out:st=${((contentMs / (Number(clip.speed) || 1) - clip.videoFadeOutMs) / 1000).toFixed(3)}:d=${(clip.videoFadeOutMs / 1000).toFixed(3)}`)
  }
  chain.push('aresample=48000')
  return chain
}
```

> 注意：fade/atempo 的“内容时长”按**速度换算后的输出时长**（`contentMs / speed`）计算；视频 fade 的 `st` 同理。上面 `videoFilter` 里直接用了 `contentMs`——实现时统一改为 `outputContentMs = (clip.sourceOutMs - clip.sourceInMs) / speed`，测试用例 4（speed=2、fade 200）锁定此行为。

```ts
async function renderSegment(
  plan: EditPlanV1,
  clip: EditPlanV1['clips'][number],
  file: string,
): Promise<void> {
  const { width, height, fps } = plan.project
  const speed = Math.min(2, Math.max(0.5, Number(clip.speed) || 1))
  if (clip.kind === 'image') {
    const durationSec = ((clip.sourceOutMs - clip.sourceInMs) / 1000).toFixed(3)
    await run([
      '-y', '-loop', '1', '-t', durationSec, '-i', getAbsolutePath(clip.source.url),
      '-f', 'lavfi', '-t', durationSec, '-i', 'anullsrc=r=48000:cl=stereo',
      '-vf', videoFilter(clip, plan).join(','), '-af', 'aresample=48000',
      '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-shortest', file,
    ])
    return
  }
  const inSec = (clip.sourceInMs / 1000).toFixed(3)
  const contentSec = ((clip.sourceOutMs - clip.sourceInMs) / 1000).toFixed(3)
  await run([
    '-y', '-ss', inSec, '-t', contentSec, '-i', getAbsolutePath(clip.source.url),
    '-vf', videoFilter(clip, plan).join(','),
    '-af', audioFilter(clip).join(','),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    file,
  ])
}

async function renderGap(plan: EditPlanV1, gapMs: number, file: string): Promise<void> {
  const { width, height, fps } = plan.project
  const sec = (gapMs / 1000).toFixed(3)
  await run([
    '-y',
    '-f', 'lavfi', '-t', sec, '-i', `color=c=black:s=${width}x${height}:r=${fps}`,
    '-f', 'lavfi', '-t', sec, '-i', 'anullsrc=r=48000:cl=stereo',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    file,
  ])
}
```

主流程：

```ts
export async function renderEditVideo(input: {
  plan: EditPlanV1
  outputPath: string
  subtitleMode: 'burn' | 'soft' | 'none'
  assPath?: string
  srtPath?: string
  onProgress?: (pct: number) => void
}): Promise<{ durationMs: number; warnings: EditRenderWarning[] }> {
  const warnings = buildRenderReport(input.plan).warnings
  const layout = computeLayout(input.plan)
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huobao-edit-render-'))
  try {
    const listLines: string[] = []
    let index = 0
    for (const layoutClip of layout.clips) {
      const clip = input.plan.clips.find((c) => c.id === layoutClip.clip_id)
      if (!clip) continue
      if (layoutClip.gap_before_ms > 0) {
        const gapFile = path.join(workDir, `gap-${index}.mp4`)
        await renderGap(input.plan, layoutClip.gap_before_ms, gapFile)
        listLines.push(`file '${gapFile.replace(/'/g, "'\\''")}'`)
      }
      const segFile = path.join(workDir, `seg-${index}.mp4`)
      await renderSegment(input.plan, clip, segFile)
      listLines.push(`file '${segFile.replace(/'/g, "'\\''")}'`)
      index += 1
      input.onProgress?.(Math.round((index / Math.max(1, layout.clips.length)) * 80))
    }
    if (!listLines.length) throw new Error('时间线没有任何可渲染片段')
    const listFile = path.join(workDir, 'list.txt')
    await fsp.writeFile(listFile, listLines.join('\n'), 'utf8')
    const concatFile = path.join(workDir, 'concat.mp4')
    await run(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', concatFile])
    input.onProgress?.(85)

    // 字幕阶段：burn 需要重编码；soft 挂 mov_text 流；none 直接 faststart 拷贝
    if (input.subtitleMode === 'burn' && input.assPath) {
      await run([
        '-y', '-i', concatFile,
        '-vf', `ass=${input.assPath.replace(/\\/g, '/').replace(/:/g, '\\:')}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy', input.outputPath,
      ])
    } else if (input.subtitleMode === 'soft' && input.srtPath) {
      await run([
        '-y', '-i', concatFile, '-i', input.srtPath,
        '-c', 'copy', '-c:s', 'mov_text',
        '-metadata:s:s:0', 'language=chi', input.outputPath,
      ])
    } else {
      await run(['-y', '-i', concatFile, '-c', 'copy', '-movflags', '+faststart', input.outputPath])
    }
    if (input.subtitleMode !== 'none' || true) {
      // 统一补 faststart：burn/soft 分支产物再 remux 一次代价可忽略
      await run(['-y', '-i', input.outputPath, '-c', 'copy', '-movflags', '+faststart', input.outputPath + '.fs.mp4'])
      await fsp.rename(input.outputPath + '.fs.mp4', input.outputPath)
    }
    input.onProgress?.(95)
    const durationMs = await probeDurationMs(input.outputPath)
    return { durationMs, warnings }
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
  }
}

async function probeDurationMs(file: string): Promise<number> {
  const { execFileSync } = await import('node:child_process')
  const bin = resolveFfmpegSuite().ffprobe.path || 'ffprobe'
  const out = execFileSync(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString()
  return Math.round(Number(out.trim()) * 1000)
}
```

> 上面 `if (input.subtitleMode !== 'none' || true)` 是冗余写法——实现时直接无条件执行 faststart remux（三分支都受益）。`layout.clips` 的字段名（`gap_before_ms/timeline_start_ms` 等）以 `computeLayout` 实际返回为准（edit-plan.ts 已有定义），实现前打开核对。静音 AAC 兜底：图片/空档段本就带 `anullsrc` 音轨，拼接后必然存在音频流，无需单独兜底；若纯视频片段且源无音频，`-af aresample` 作用于不存在的音轨会失败——`renderSegment` 对 `hasAudio === false` 的视频片段改用 `anullsrc`（与图片分支相同），测试补一条「无声视频片段渲染后仍有 aac 流」用例。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/edit-render-plan.test.ts
cd backend && npm run typecheck
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 21: 后端——剪辑导出服务与路由

**Files:**
- Create: `backend/src/services/edit-export-service.ts`
- Modify: `backend/src/routes/edit.ts`
- Test: `backend/tests/edit-export.test.ts`

**Interfaces:**
- Consumes: Task 12 `requireEditProject/projectForFilm`、Task 14 `loadProjectPlan/保存草稿的版本号语义`、Task 19 `extractEditFrame` 无关；`buildEditAss/buildEditSrt`（Task 15）、`renderEditVideo/buildRenderReport`（Task 20）、`setCurrentFilm`（Task 2）、`computeLayout/editPlanHashOf/editSyncHashOf`（edit-plan.ts）、`createEditRevision`（Task 14 重写后的签名）。
- Produces:
  - `startEditExport(episodeId: number, body: { project_id: number; preset: string; subtitle_mode?: 'burn'|'soft'|'none'; set_current?: boolean; title?: string; base_version: number }): Promise<{ exportId: number }>`（立即返回，渲染在后台继续）
  - `getEditExportStatus(episodeId: number, exportId: number)`（episode_exports 行 + progress）
  - 路由：`POST /episodes/:id/edit/render`、`GET /episodes/:id/edit/render/:exportId`

- [ ] **Step 1: 写失败测试**

`backend/tests/edit-export.test.ts`（环境头部与夹具同 `edit-frames.test.ts`：临时库 + ffmpeg 造 2s 带音视频源 + 拼接成片 + 打开工程）：

```ts
test('导出主流程：完成后写入台账并投影剪辑成片', async () => {
  const { projectId } = await createProject() // 同 edit-frames.test.ts 的夹具函数
  // 保存一份草稿（PUT /edit/draft，plan 为单片段、subtitle 一条）
  const draftRes = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: 0, plan: draftPlan }),
  })
  assert.equal(draftRes.status, 200)
  const draftVersion = (await draftRes.json()).data.draft.version

  const started = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', subtitle_mode: 'burn', set_current: true, base_version: draftVersion }),
  })
  assert.equal(started.status, 200, await started.clone().text())
  const exportId = (await started.json()).data.export_id

  let row: any = null
  for (let i = 0; i < 120; i += 1) {
    const status = await app.request(`/episodes/${episode.id}/edit/render/${exportId}`)
    row = (await status.json()).data
    if (row.status === 'completed' || row.status === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.equal(row.status, 'completed', JSON.stringify(row))
  assert.ok(fs.existsSync(path.join(root, row.output_url)))
  assert.equal(row.subtitle_mode, 'burn')

  const films = db.select().from(schema.videoMerges).all()
    .filter((m) => m.episodeId === episode.id && m.kind === 'edit')
  assert.equal(films.length, 1)
  assert.equal(films[0].mergedUrl, row.output_url)
  assert.equal(films[0].status, 'completed')
  const episodeRow = db.select().from(schema.episodes).all().find((e) => e.id === episode.id)!
  assert.equal(episodeRow.currentFilmId, films[0].id) // set_current 生效
})

test('base_version 不匹配返回 409 EDIT_VERSION_CONFLICT，不创建导出', async () => {
  const { projectId } = await createProject()
  const res = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', base_version: 999 }),
  })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).code, 'EDIT_VERSION_CONFLICT')
  assert.equal(db.select().from(schema.episodeExports).all()
    .filter((e) => e.episodeId === episode.id && e.kind === 'edit').length, 0)
})

test('已有进行中的导出返回 409 EXPORT_ALREADY_RUNNING', async () => {
  const { projectId } = await createProject()
  db.insert(schema.episodeExports).values({
    episodeId: episode.id, kind: 'edit', status: 'rendering', projectId,
    preset: 'vertical-hd', createdAt: '2026-11-06T00:00:00.000Z',
  } as any).run()
  const res = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', base_version: 0 }),
  })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).code, 'EXPORT_ALREADY_RUNNING')
})

test('subtitle_mode 非法与 preset 非法返回 400', async () => {
  const { projectId } = await createProject()
  for (const body of [
    { project_id: projectId, preset: 'vertical-hd', subtitle_mode: 'hard', base_version: 0 },
    { project_id: projectId, preset: 'audio-wav', base_version: 0 },
    { project_id: projectId, preset: 'mp4-1080p', base_version: 0 },
  ]) {
    const res = await app.request(`/episodes/${episode.id}/edit/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(res.status, 400, JSON.stringify(body))
  }
})
```

> 夹具注意：`episodeExports` 的 Drizzle 表定义在 Task 1 已补 `projectId/sourceMergeId/filmId` 字段；测试里插入假"进行中"行只用于并发断言。`createProject()`/`draftPlan` 沿用本文件顶部定义（`draftPlan` 用 `createSingleClipPlan`，片段指向 2s 源成片，`projectSettingsForAspect('9:16', 25)`）。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/edit-export.test.ts
```

- [ ] **Step 3: 实现**

新建 `backend/src/services/edit-export-service.ts`：

```ts
import fsp from 'node:fs/promises'
import path from 'node:path'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { EditWorkspaceError } from './edit-errors.js'
import { requireEditProject, projectForFilm } from './edit-project-service.js'
import { loadProjectPlan } from './edit-draft-service.js'
import { computeLayout, editPlanHashOf, editSyncHashOf, type EditPlanV1 } from './edit-plan.js'
import { buildEditAss, buildEditSrt } from './edit-subtitle-ass.js'
import { renderEditVideo } from './edit-render-plan.js'
import { setCurrentFilm } from './film-hub.js'
import { createEditRevision } from './edit-revision-service.js'
import { getReadableEpisode } from './edit-access.js'
import { getAbsolutePath } from '../utils/storage.js'

const EDIT_PRESETS = new Set(['vertical-hd', 'horizontal-hd', 'vertical-high'])
const SUBTITLE_MODES = new Set(['burn', 'soft', 'none'])
const RUNNING = new Set<number>() // project_id 级并发守卫（与台账 status 双保险）

function now(): string {
  return new Date().toISOString()
}

export async function startEditExport(episodeId: number, body: {
  project_id: number
  preset: string
  subtitle_mode?: string
  set_current?: boolean
  title?: string
  base_version: number
}): Promise<{ exportId: number }> {
  getReadableEpisode(episodeId)
  const project = requireEditProject(Number(body.project_id))
  if (project.episodeId !== episodeId) {
    throw new EditWorkspaceError(400, 'EDIT_PROJECT_MISMATCH', '工程不属于本集')
  }
  if (!EDIT_PRESETS.has(String(body.preset))) {
    throw new EditWorkspaceError(400, 'EDIT_PRESET_INVALID', '导出预设无效')
  }
  const subtitleMode = body.subtitle_mode === undefined ? 'burn' : String(body.subtitle_mode)
  if (!SUBTITLE_MODES.has(subtitleMode)) {
    throw new EditWorkspaceError(400, 'EDIT_SUBTITLE_MODE_INVALID', '字幕模式必须为 burn / soft / none')
  }
  if (!project.sourceMergeId) {
    throw new EditWorkspaceError(400, 'EDIT_LEGACY_EXPORT', '旧版工程不支持导出，请先另存为成片工程')
  }

  const draft = db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.projectId, project.id)).get()
  const draftVersion = draft?.version ?? 0
  if (Number(body.base_version) !== draftVersion) {
    throw new EditWorkspaceError(409, 'EDIT_VERSION_CONFLICT', '计划已更新，请刷新后重试')
  }

  const runningRow = db.select().from(schema.episodeExports)
    .where(and(
      eq(schema.episodeExports.kind, 'edit'),
      inArray(schema.episodeExports.status, ['pending', 'rendering']),
      isNull(schema.episodeExports.deletedAt),
    )).all()
    .find((row) => (row as any).projectId === project.id)
  if (runningRow || RUNNING.has(project.id)) {
    throw new EditWorkspaceError(409, 'EXPORT_ALREADY_RUNNING', '该工程已有导出任务进行中')
  }

  const plan = loadProjectPlan(project)

  // 草稿领先于版本时自动创建里程碑版本（设计 6.10 流程 3）
  const currentRevision = db.select().from(schema.editRevisions)
    .where(and(eq(schema.editRevisions.projectId, project.id), eq(schema.editRevisions.isCurrent, true)))
    .orderBy(desc(schema.editRevisions.revisionNo)).get()
  let revisionId = currentRevision?.id ?? null
  if (!currentRevision || currentRevision.planHash !== editPlanHashOf(plan)) {
    const created = createEditRevision(project, { note: '导出里程碑', plan })
    revisionId = created.revision.id
  }

  const exportRow = db.insert(schema.episodeExports).values({
    episodeId,
    kind: 'edit',
    preset: String(body.preset),
    status: 'pending',
    projectId: project.id,
    sourceMergeId: project.sourceMergeId,
    editRevisionId: revisionId,
    editPlanHash: editPlanHashOf(plan),
    editSyncHash: editSyncHashOf(plan),
    subtitleMode,
    renderMode: 'edit',
    paramsJson: JSON.stringify({ set_current: Boolean(body.set_current), title: body.title ?? null }),
    createdAt: now(),
  } as any).returning().get()

  void runEditExport({ exportId: exportRow.id, episodeId, project, plan, subtitleMode, setCurrent: Boolean(body.set_current), title: body.title })
  return { exportId: exportRow.id }
}

async function runEditExport(ctx: {
  exportId: number
  episodeId: number
  project: { id: number; episodeId: number; dramaId: number; sourceMergeId: number | null; sourceUrl: string | null }
  plan: EditPlanV1
  subtitleMode: 'burn' | 'soft' | 'none'
  setCurrent: boolean
  title?: string
}): Promise<void> {
  RUNNING.add(ctx.project.id)
  const patch = (values: Record<string, unknown>) =>
    db.update(schema.episodeExports).set(values as any).where(eq(schema.episodeExports.id, ctx.exportId)).run()
  try {
    patch({ status: 'rendering', progress: 5 })
    const layout = computeLayout(ctx.plan)
    const episode = db.select().from(schema.episodes).all().find((e) => e.id === ctx.episodeId)!
    const revisionNo = db.select().from(schema.episodeExports)
      .where(eq(schema.episodeExports.id, ctx.exportId)).get()?.editRevisionId ?? 0

    const exportsDir = `static/projects/${ctx.project.dramaId}/exports/edit`
    await fsp.mkdir(getAbsolutePath(exportsDir), { recursive: true })
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '-')
    const baseName = body_title_or_default(ctx) // `第${episode.episodeNumber}集-剪辑-v${revisionNo}`
    const outputRel = `${exportsDir}/${baseName}.mp4`
    const outputAbs = getAbsolutePath(outputRel)

    let assPath: string | undefined
    let srtPath: string | undefined
    if (ctx.subtitleMode === 'burn') {
      assPath = getAbsolutePath(`${exportsDir}/${baseName}.ass`)
      srtPath = getAbsolutePath(`${exportsDir}/${baseName}.srt`)
      await fsp.writeFile(assPath, buildEditAss(ctx.plan), 'utf8')
      await fsp.writeFile(srtPath, buildEditSrt(ctx.plan), 'utf8')
    } else if (ctx.subtitleMode === 'soft') {
      srtPath = getAbsolutePath(`${exportsDir}/${baseName}.srt`)
      await fsp.writeFile(srtPath, buildEditSrt(ctx.plan), 'utf8')
    }

    const { durationMs } = await renderEditVideo({
      plan: ctx.plan,
      outputPath: outputAbs,
      subtitleMode: ctx.subtitleMode,
      assPath,
      srtPath,
      onProgress: (pct) => patch({ progress: Math.max(10, Math.min(95, pct)) }),
    })

    const frameMs = 1000 / Math.max(1, ctx.plan.project.fps)
    if (Math.abs(durationMs - layout.duration_ms) > frameMs) {
      throw new Error(`导出时长偏差超过 1 帧：${durationMs}ms vs ${layout.duration_ms}ms`)
    }
    const stat = await fsp.stat(outputAbs)
    patch({
      status: 'completed',
      progress: 100,
      outputUrl: outputRel,
      durationMs,
      sizeBytes: stat.size,
      finishedAt: now(),
    })

    // 投影成片（设计 6.10 流程 8–9）
    const sourceFilm = ctx.project.sourceMergeId
      ? db.select().from(schema.videoMerges).all().find((m) => m.id === ctx.project.sourceMergeId)
      : null
    const subtitleUrl = ctx.subtitleMode === 'soft' ? `${exportsDir}/${baseName}.srt` : null
    const film = db.insert(schema.videoMerges).values({
      episodeId: ctx.episodeId,
      dramaId: ctx.project.dramaId,
      title: ctx.title || defaultTitle(episode.episodeNumber, stamp),
      kind: 'edit',
      origin: 'export',
      status: 'completed',
      mergedUrl: outputRel,
      duration: Math.round(durationMs),
      sourceMergeId: ctx.project.sourceMergeId,
      subtitleUrl,
      subtitleBurned: ctx.subtitleMode === 'burn' ? 1 : 0,
      createdAt: now(),
      completedAt: now(),
    } as any).returning().get()
    if (ctx.setCurrent) await setCurrentFilm(ctx.episodeId, film.id)
  } catch (cause) {
    patch({
      status: 'failed',
      error: cause instanceof Error ? cause.message : '导出失败',
      finishedAt: now(),
    })
  } finally {
    RUNNING.delete(ctx.project.id)
  }
}

export function getEditExportStatus(episodeId: number, exportId: number) {
  const row = db.select().from(schema.episodeExports)
    .where(and(eq(schema.episodeExports.id, exportId), eq(schema.episodeExports.episodeId, episodeId), isNull(schema.episodeExports.deletedAt)))
    .get()
  if (!row) throw new EditWorkspaceError(404, 'EXPORT_NOT_FOUND', '导出任务不存在')
  return row
}
```

> 实现注意：`body_title_or_default(ctx)`/`defaultTitle(episodeNumber, stamp)` 按设计 6.10 生成 `第 ${n} 集 剪辑成片（YYYY-MM-DD HH:mm）`；`revisionNo` 直接从 `editRevisions` 表按 `editRevisionId` 查 `revisionNo`（上面写法是错的，实现时修正）。`videoMerges` 的 `origin/subtitleBurned` 列由 Task 1 迁移与 schema 定义提供，若 Task 1 只加了 `origin` 而未加 `subtitle_burned`，把 `subtitleBurned` 的写入改为 `mixOptions` JSON 内的字段并同步调整 film-hub 的读取——**实现前先打开 schema.ts 核对**，以现有列为准。

`backend/src/routes/edit.ts` 追加：

```ts
app.post('/episodes/:id/edit/render', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    getWritableEpisode(episodeId)
    const body = await readBody(c)
    return success(c, await startEditExport(episodeId, body))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.get('/episodes/:id/edit/render/:exportId', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  const exportId = parseId(c.req.param('exportId'))
  if (!episodeId || !exportId) return badRequest(c, '编号无效')
  try {
    return success(c, getEditExportStatus(episodeId, exportId))
  } catch (error) {
    return handleEditError(c, error)
  }
})
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/edit-export.test.ts tests/edit-project-state.test.ts tests/edit-route.test.ts
cd backend && npm run typecheck
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 22: 时间线右键菜单与可见操作（spec 6.8）

**Files:**
- Modify: `frontend/app/components/edit/EditTimeline.vue`
- Modify: `frontend/app/components/edit/EditWorkbench.vue`
- Test: `frontend/tests/edit-frame-ui.test.mjs`（新建，Task 23 会追加用例；本任务先建文件）

**Interfaces:**
- Consumes: Task 6 的 `ContextMenu.vue`（`items: MenuItem[]`、`x`、`y`；`MenuItem: { key, label, icon?, shortcut?, danger?, disabled?, reason?, separator?, action }`）；Task 18 的帧操作命令在 EditWorkbench 侧分发（本任务只发事件，不直接调命令）；现有 emits `split-clip`、`select-clip`、`select-cue`。
- Produces: `EditTimeline` 新 emits —— `frame-op`（`{ kind: 'delete-frame' | 'duplicate-frame' | 'insert-image' | 'extend-1s', clipId: string, atMs: number }`）、`cue-op`（`{ kind: 'edit' | 'split' | 'merge-next' | 'delete', cueId: string }`）、`toggle-subtitles`（无参）、`fit-view`（无参）、`open-subtitles`（无参）；新 props `showSubtitles: boolean`。工具栏新增可见按钮（含中文文字）：`帧操作 ▾` 下拉（删除这一帧/复制这一帧/插入图片/拉长1秒）、`字幕 ▾` 下拉（新建字幕/显示·隐藏字幕轨/打开字幕列表）、`分割`、`删除`、`适应画幅`。

> 设计 6.8 要求「不依赖右键和快捷键」：右键菜单与工具栏按钮调用同一套事件，右键只是快捷路径，不是唯一入口。下拉菜单用原生 `<details>` 不够可控，直接用 `ContextMenu` 复用（在按钮位置打开，`x/y` 取按钮 `getBoundingClientRect()`）。

- [ ] **Step 1: 写失败测试**

`frontend/tests/edit-frame-ui.test.mjs` 新建：

```mjs
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('时间线右键菜单覆盖帧操作与字幕操作', () => {
  const timeline = read('app/components/edit/EditTimeline.vue')
  assert.match(timeline, /ContextMenu/)
  assert.match(timeline, /delete-frame/)
  assert.match(timeline, /duplicate-frame/)
  assert.match(timeline, /insert-image/)
  assert.match(timeline, /extend-1s/)
  assert.match(timeline, /cue-op/)
  assert.match(timeline, /merge-next/)
})

test('工具栏可见按钮：帧操作、字幕、分割、删除、适应画幅', () => {
  const timeline = read('app/components/edit/EditTimeline.vue')
  for (const key of [
    'edit.frameOps', 'edit.frameDelete', 'edit.frameDuplicate',
    'edit.frameInsertImage', 'edit.frameExtend', 'edit.subtitleMenu',
    'edit.subtitleNew', 'edit.subtitleToggle', 'edit.subtitleOpenList',
    'edit.fitView',
  ]) {
    assert.match(timeline, new RegExp(key.replace('.', '\\.')))
  }
  assert.match(timeline, /\$emit\('fit-view'\)/)
  assert.match(timeline, /showSubtitles/)
})

test('工作台接线帧操作与字幕菜单事件', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /@frame-op/)
  assert.match(workbench, /@cue-op/)
  assert.match(workbench, /@toggle-subtitles/)
  assert.match(workbench, /@fit-view/)
  assert.match(workbench, /rippleDeleteFrame/)
  assert.match(workbench, /insertFreezeFrame/)
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd frontend && node --test tests/edit-frame-ui.test.mjs
```

预期：3 个用例全部 FAIL（EditTimeline 无 ContextMenu、EditWorkbench 无 @frame-op）。

- [ ] **Step 3: 实现 EditTimeline 右键菜单与工具栏**

`EditTimeline.vue` 修改（关键片段）：

模板 —— 工具栏（`ed-timeline-tools` 内，在现有磁吸/缩放按钮之前插入可见按钮组）：

```html
<div class="ed-timeline-tools">
  <button
    class="ed-tool is-text" type="button" :disabled="readonly"
    @click="openMenuFromButton($event, frameMenuItems())"
  >{{ t('edit.frameOps') }} ▾</button>
  <button
    class="ed-tool is-text" type="button"
    @click="openMenuFromButton($event, subtitleMenuItems())"
  >{{ t('edit.subtitleMenu') }} ▾</button>
  <button class="ed-tool is-text" type="button" :disabled="!canSplit" @click="splitAtPlayhead">
    {{ t('edit.split') }}
  </button>
  <button class="ed-tool is-text" type="button" :disabled="!selectedClipId || readonly" @click="removeSelected">
    {{ t('edit.delete') }}
  </button>
  <button class="ed-tool is-text" type="button" @click="$emit('fit-view')">
    {{ t('edit.fitView') }}
  </button>
  <span class="ed-tools-sep"></span>
  <!-- 现有磁吸/缩放/分割图标按钮保持不变 -->
</div>
```

模板 —— 片段与字幕块右键（在现有 `@pointerdown.stop="startDrag(...)"` 旁追加）：

```html
<div
  v-for="view in clipViews" ... 
  @pointerdown.stop="startDrag($event, 'move', { clipId: view.clip_id })"
  @contextmenu.prevent.stop="openClipMenu($event, view)"
>
```

```html
<div
  v-for="cue in cueViews" ...
  @pointerdown.stop="startDrag($event, 'cue', { cueId: cue.id, startMs: cue.startMs, endMs: cue.endMs })"
  @contextmenu.prevent.stop="openCueMenu($event, cue)"
>
```

模板 —— 右键/下拉共用菜单（`ed-timeline-body` 末尾）：

```html
<ContextMenu
  v-if="menu"
  :items="menu.items"
  :x="menu.x"
  :y="menu.y"
  @close="menu = null"
/>
```

脚本 —— 菜单构建与事件（新增部分；`import ContextMenu from '~/components/ContextMenu.vue'`）：

```js
const props = defineProps({
  /* 现有 props 保留，追加： */
  showSubtitles: { type: Boolean, default: true },
})
const emit = defineEmits([
  'seek', 'select-clip', 'select-cue', 'move-clip', 'trim-clip',
  'split-clip', 'move-cue', 'remove-transition',
  'frame-op', 'cue-op', 'toggle-subtitles', 'fit-view', 'open-subtitles', 'remove-clip',
])

const menu = ref(null)

function closeMenu() { menu.value = null }

function openMenuAt(event, items) {
  menu.value = { items, x: event.clientX, y: event.clientY }
}

function openMenuFromButton(event, items) {
  const rect = event.currentTarget.getBoundingClientRect()
  menu.value = { items, x: rect.left, y: rect.bottom + 4 }
}

function frameMenuItems(view) {
  const at = view ? Math.round(view.timeline_start_ms) : Math.round(props.currentMs)
  const clipId = view?.clip_id ?? clipIdAt(props.currentMs)
  return [
    { key: 'delete-frame', label: t('edit.frameDelete'), shortcut: 'D', action: () => emit('frame-op', { kind: 'delete-frame', clipId, atMs: at }) },
    { key: 'duplicate-frame', label: t('edit.frameDuplicate'), action: () => emit('frame-op', { kind: 'duplicate-frame', clipId, atMs: at }) },
    { key: 'insert-image', label: t('edit.frameInsertImage'), action: () => emit('frame-op', { kind: 'insert-image', clipId, atMs: at }) },
    { separator: true, key: 'sep', label: '' },
    { key: 'extend-1s', label: t('edit.frameExtend'), action: () => emit('frame-op', { kind: 'extend-1s', clipId, atMs: at }) },
  ]
}

function clipIdAt(ms) {
  const index = activeClipIndex(props.layout, ms)
  return props.layout.clips[index]?.clip_id ?? ''
}

function openClipMenu(event, view) {
  if (props.readonly) return
  emit('select-clip', view.clip_id)
  openMenuAt(event, frameMenuItems(view))
}

function subtitleMenuItems() {
  return [
    { key: 'new', label: t('edit.subtitleNew'), action: () => emit('open-subtitles') },
    { key: 'toggle', label: props.showSubtitles ? t('edit.subtitleHide') : t('edit.subtitleShow'), action: () => emit('toggle-subtitles') },
    { key: 'list', label: t('edit.subtitleOpenList'), action: () => emit('open-subtitles') },
  ]
}

function openCueMenu(event, cue) {
  if (props.readonly) return
  emit('select-cue', cue.id)
  const next = props.plan.subtitles[props.plan.subtitles.findIndex((item) => item.id === cue.id) + 1]
  openMenuAt(event, [
    { key: 'edit', label: t('edit.cueEdit'), action: () => emit('cue-op', { kind: 'edit', cueId: cue.id }) },
    { key: 'split', label: t('edit.cueSplit'), disabled: cue.endMs - cue.startMs < 200, action: () => emit('cue-op', { kind: 'split', cueId: cue.id }) },
    { key: 'merge-next', label: t('edit.cueMerge'), disabled: !next, reason: next ? undefined : t('edit.cueMergeNone'), action: () => emit('cue-op', { kind: 'merge-next', cueId: cue.id }) },
    { separator: true, key: 'sep', label: '' },
    { key: 'delete', label: t('edit.delete'), danger: true, action: () => emit('cue-op', { kind: 'delete', cueId: cue.id }) },
  ])
}

function removeSelected() {
  if (props.selectedClipId) emit('remove-clip', props.selectedClipId)
}
```

> 实现注意：`frameMenuItems` 中工具栏下拉（`view` 为空）按播放头定位片段；右键（有 `view`）按被点片段定位。「删除」按钮走 `remove-clip`（EditWorkbench 已有 `removeClip` 命令，`{ ripple: true }` 默认）。`MenuItem.label` 必填，`separator` 项的 `label` 传空串即可（Task 6 的 ContextMenu 对 separator 项不渲染 label）。

- [ ] **Step 4: EditWorkbench 接线**

`EditWorkbench.vue`：

1. 导入 Task 18 命令：`import { insertFreezeFrame, rippleDeleteFrame } from '~/utils/edit-frame-commands'`（`insertImageClip` 在 Task 23 由图片选择器调用，本任务不接线）。
2. 模板 `<EditTimeline>` 追加：

```html
:show-subtitles="showSubtitles"
@frame-op="onFrameOp"
@cue-op="onCueOp"
@toggle-subtitles="showSubtitles = !showSubtitles"
@fit-view="fitView"
@open-subtitles="subtitlesOpen = true"
@remove-clip="removeClipById"
```

3. 脚本新增（`showSubtitles`/`subtitlesOpen` 为 `ref(false)`；`subtitlesOpen` 供 Task 17 的 `EditSubtitleList` 抽屉复用，若 Task 17 已命名不同变量则以 Task 17 为准合并）：

```js
function onFrameOp({ kind, clipId, atMs }) {
  if (!canEdit.value) return
  if (kind === 'delete-frame') {
    applyCommand(() => rippleDeleteFrame(plan.value, atMs, fpsOf(plan.value)))
  } else if (kind === 'duplicate-frame') {
    insertFreezeAt(clipId, atMs)
  } else if (kind === 'extend-1s') {
    extendClipByMs(clipId, 1000)
  }
  // kind === 'insert-image' 由 Task 23 的图片选择器打开后处理
}

function insertFreezeAt(clipId, atMs) {
  extractFreezeFrame(clipId, atMs) // Task 23 实现：调 editAPI.extractFrame 后 insertFreezeFrame
}

function extendClipByMs(clipId, deltaMs) {
  applyCommand(() => trimClipEnd(plan.value, clipId, deltaMs, { ripple: false }))
}

function onCueOp({ kind, cueId }) {
  if (!canEdit.value) return
  if (kind === 'edit') { selection.value = { type: 'cue', id: cueId } }
  else if (kind === 'split') { applyCommand(() => splitCueAt(plan.value, cueId, currentMs.value)) }
  else if (kind === 'merge-next') { applyCommand(() => mergeCueWithNext(plan.value, cueId)) }
  else if (kind === 'delete') { applyCommand(() => deleteCue(plan.value, cueId)) }
}

function fitView() {
  const width = timelineWrapRef?.value?.clientWidth ?? 0
  const duration = Math.max(1, Number(layout.value.duration_ms) || 0)
  if (width > 0) timelineZoomTo(width / duration)
}

function removeClipById(clipId) {
  if (canEdit.value) applyCommand(() => removeClip(plan.value, clipId))
}
```

> 实现注意：`fitView` 依赖 EditTimeline 暴露缩放控制。若现有 `zoom` 是 EditTimeline 内部 ref（当前实现如此），改用 `defineExpose({ zoomToFit })` 在 EditTimeline 内实现 `zoomToFit()`（`zoom.value = Math.max(0.02, (scrollRef.value?.clientWidth - pad * 2) / Math.max(1, layout.duration_ms))`），EditWorkbench 通过 `timelineRef.value?.zoomToFit()` 调用；上面 `fitView` 相应改为一行 `timelineRef.value?.zoomToFit()`，并删掉 `timelineZoomTo`/`timelineWrapRef`。`fpsOf(plan)` 若 Task 17/18 未提供辅助函数，就地写 `Number(plan.value.meta?.fps) || 30`（与 `framesToMs` 的取值一致，先读 `edit-timecode.ts` 确认实际字段路径再写）。

- [ ] **Step 5: 四语言文案**

`frontend/app/locales/{zh,en,ja,ko}.json` 的 `edit` 段追加：

```json
"frameOps": "帧操作", "frameDelete": "删除这一帧", "frameDuplicate": "复制这一帧（定格）",
"frameInsertImage": "插入图片", "frameExtend": "拉长 1 秒", "subtitleMenu": "字幕",
"subtitleNew": "新建字幕", "subtitleShow": "显示字幕轨", "subtitleHide": "隐藏字幕轨",
"subtitleOpenList": "打开字幕列表", "fitView": "适应画幅",
"cueEdit": "编辑字幕", "cueSplit": "在此分割", "cueMerge": "合并下一条", "cueMergeNone": "没有下一条",
"delete": "删除"
```

英文：`frameOps: Frame ops, frameDelete: Delete this frame, frameDuplicate: Duplicate frame (freeze), frameInsertImage: Insert image, frameExtend: Extend 1s, subtitleMenu: Subtitles, subtitleNew: New subtitle, subtitleShow: Show subtitle track, subtitleHide: Hide subtitle track, subtitleOpenList: Open subtitle list, fitView: Fit view, cueEdit: Edit subtitle, cueSplit: Split here, cueMerge: Merge next, cueMergeNone: No next subtitle, delete: Delete`（ja/ko 同义翻译）。

- [ ] **Step 6: 运行测试确认通过**

```bash
cd frontend && node --test tests/edit-frame-ui.test.mjs
```

预期：3 个用例 PASS。

- [ ] **Step 7: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 23: 帧操作 UI、图片选择器与剪辑导出对话框

**Files:**
- Create: `frontend/app/components/edit/EditImagePicker.vue`
- Create: `frontend/app/components/edit/EditExportDialog.vue`
- Create: `frontend/app/utils/edit-export-warnings.ts`
- Modify: `frontend/app/components/edit/EditWorkbench.vue`
- Modify: `frontend/app/composables/useApi.ts`（editAPI 块）
- Test: `frontend/tests/edit-frame-ui.test.mjs`（追加）、`frontend/tests/edit-export-ui.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 19 后端 `POST /episodes/:id/edit/frames`（返回 `{ url, width, height }`）、`POST /episodes/:id/edit/assets/images`、`GET /episodes/:id/edit/media`（`images` 数组）；Task 21 后端 `POST /episodes/:id/edit/render`（返回 `{ export_id }`）与 `GET /episodes/:id/edit/render/:exportId`（`{ status, progress, result: { film_id, file_url } }`）；Task 18 命令 `insertImageClip`、`insertFreezeFrame`、`buildFreezeTail`；Task 22 的 `frame-op` 事件（`insert-image` 分支）。
- Produces: `editAPI.extractFrame(episodeId, body)`、`editAPI.uploadImage(episodeId, file)`、`editAPI.render(episodeId, body)`、`editAPI.renderStatus(episodeId, exportId)`、`editAPI.mediaImages(episodeId, projectId)`；`collectExportWarnings(plan): Array<{ code: string, i18nKey: string }>`（code 与后端 `buildRenderReport` 同名：`TRANSITION_HARD_CUT/FILTER_UNSUPPORTED/TRANSFORM_UNSUPPORTED/OVERLAY_UNSUPPORTED/SPEED_CLAMPED`）；`EditImagePicker` props `{ episodeId, projectId, open }`，emit `insert(image)`、`close`；`EditExportDialog` props `{ open, plan, version, canEdit }`，emit `close`、`exported`。

- [ ] **Step 1: 写失败测试**

`frontend/tests/edit-export-ui.test.mjs` 新建：

```mjs
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('导出对话框：降级警告、模式与确认', () => {
  const dialog = read('app/components/edit/EditExportDialog.vue')
  assert.match(dialog, /collectExportWarnings/)
  assert.match(dialog, /subtitleMode/)
  assert.match(dialog, /setCurrent/)
  assert.match(dialog, /editAPI\.render/)
  assert.match(dialog, /renderStatus/)
  assert.match(dialog, /base_version|baseVersion/)
})

test('导出警告镜像后端编码', () => {
  const src = read('app/utils/edit-export-warnings.ts')
  for (const code of ['TRANSITION_HARD_CUT', 'FILTER_UNSUPPORTED', 'TRANSFORM_UNSUPPORTED', 'OVERLAY_UNSUPPORTED']) {
    assert.match(src, new RegExp(code))
  }
})

test('图片选择器：上传、列表与插入', () => {
  const picker = read('app/components/edit/EditImagePicker.vue')
  assert.match(picker, /editAPI\.uploadImage/)
  assert.match(picker, /emit\('insert'/)
  assert.match(picker, /type="file"/)
})

test('editAPI 新端点与四语言文案', () => {
  const api = read('app/composables/useApi.ts')
  for (const name of ['extractFrame', 'uploadImage', 'render', 'renderStatus']) {
    assert.match(api, new RegExp(`${name}\\(`))
  }
  const zh = JSON.parse(read('app/locales/zh.json'))
  assert.ok(zh.edit.exportTitle)
  assert.ok(zh.edit.exportWarningTitle)
  assert.ok(zh.edit.subtitleBurn)
  assert.ok(zh.edit.imagePickerTitle)
  assert.ok(zh.edit.frameFreezeInserted)
})
```

`frontend/tests/edit-frame-ui.test.mjs` 追加用例：

```mjs
test('工作台接线图片选择器与定格插入', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /EditImagePicker/)
  assert.match(workbench, /insertImageClip/)
  assert.match(workbench, /insertFreezeFrame/)
  assert.match(workbench, /editAPI\.extractFrame/)
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd frontend && node --test tests/edit-export-ui.test.mjs tests/edit-frame-ui.test.mjs
```

预期：4 + 4 用例 FAIL（EditExportDialog/EditImagePicker/edit-export-warnings 不存在）。

- [ ] **Step 3: 实现客户端警告镜像**

`frontend/app/utils/edit-export-warnings.ts`：

```ts
import type { EditPlanV1 } from './edit-plan'

export interface ExportWarning { code: string, i18nKey: string }

const WARNINGS: Record<string, string> = {
  TRANSITION_HARD_CUT: 'edit.exportWarnTransition',
  FILTER_UNSUPPORTED: 'edit.exportWarnFilter',
  TRANSFORM_UNSUPPORTED: 'edit.exportWarnTransform',
  OVERLAY_UNSUPPORTED: 'edit.exportWarnOverlay',
}

// 与后端 buildRenderReport 保持同名 code；后端是权威，前端仅用于导出前预览清单。
export function collectExportWarnings(plan: EditPlanV1): ExportWarning[] {
  const codes: string[] = []
  if (plan.transitions?.length) codes.push('TRANSITION_HARD_CUT')
  if (plan.clips.some((clip) => clip.filters?.length)) codes.push('FILTER_UNSUPPORTED')
  if (plan.clips.some((clip) => clip.transform && (clip.transform.x !== 0 || clip.transform.y !== 0))) codes.push('TRANSFORM_UNSUPPORTED')
  if (plan.overlay_tracks?.length) codes.push('OVERLAY_UNSUPPORTED')
  return codes.map((code) => ({ code, i18nKey: WARNINGS[code] }))
}
```

> 实现注意：写之前先读 `frontend/app/utils/edit-plan.ts` 中 `EditPlanV1` 的实际字段（`transitions`/`filters`/`transform`/`overlay_tracks` 的确切名称与形状），按真实字段改判断条件；若某字段不存在则删掉对应分支，保持与后端 Task 20 `buildRenderReport` 判断一致。

- [ ] **Step 4: 实现图片选择器**

`frontend/app/components/edit/EditImagePicker.vue`（关键结构）：

```html
<template>
  <NModal :show="open" @update:show="$emit('close')">
    <div class="ed-img-picker">
      <header>
        <b>{{ t('edit.imagePickerTitle') }}</b>
        <label class="ed-upload">
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden @change="onUpload" />
          <span>{{ uploading ? t('edit.uploading') : t('edit.uploadImage') }}</span>
        </label>
      </header>
      <p v-if="error" class="ed-error">{{ error }}</p>
      <div class="ed-img-grid">
        <button
          v-for="img in images" :key="img.url" type="button"
          class="ed-img-cell" @click="$emit('insert', img)"
        >
          <img :src="mediaUrl(img.url)" :alt="img.name" />
          <span>{{ img.name }}</span>
        </button>
      </div>
      <p v-if="!images.length" class="ed-empty">{{ t('edit.imagePickerEmpty') }}</p>
    </div>
  </NModal>
</template>
```

脚本：`props { open, projectId }`；`watch(() => props.open, 加载 mediaImages)`；`onUpload` 调 `editAPI.uploadImage` 后刷新列表；emit `insert`/`close`。`mediaUrl` 复用 `~/utils/edit-plan`。

- [ ] **Step 5: 实现导出对话框**

`frontend/app/components/edit/EditExportDialog.vue`（关键结构）：

```html
<NModal :show="open" @update:show="$emit('close')">
  <div class="ed-export">
    <header><b>{{ t('edit.exportTitle') }}</b></header>
    <section v-if="warnings.length" class="ed-warn-list">
      <b>{{ t('edit.exportWarningTitle') }}</b>
      <p v-for="w in warnings" :key="w.code">{{ t(w.i18nKey) }}</p>
    </section>
    <label class="ed-row">
      <span>{{ t('edit.exportSubtitle') }}</span>
      <NRadioGroup v-model:value="subtitleMode">
        <NRadio value="burn">{{ t('edit.subtitleBurn') }}</NRadio>
        <NRadio value="soft">{{ t('edit.subtitleSoft') }}</NRadio>
        <NRadio value="none">{{ t('edit.subtitleNone') }}</NRadio>
      </NRadioGroup>
    </label>
    <label class="ed-row">
      <span>{{ t('edit.exportSetCurrent') }}</span>
      <NSwitch v-model:value="setCurrent" />
    </label>
    <footer>
      <button :disabled="busy || !warningsAcked" @click="startExport">
        {{ busy ? t('edit.exportRunning') : t('edit.exportStart') }}
      </button>
    </footer>
    <p v-if="progressText">{{ progressText }}</p>
  </div>
</NModal>
```

脚本要点：

```js
const warnings = computed(() => collectExportWarnings(props.plan))
const warningsAcked = ref(false) // 有降级项时需勾选「我已知晓，按硬切导出」才可开始
watch(warnings, () => { warningsAcked.value = !warnings.value.length })

async function startExport() {
  busy.value = true
  const { export_id } = await editAPI.render(props.episodeId, {
    project_id: props.projectId,
    preset: 'vertical-hd',
    subtitle_mode: subtitleMode.value,
    set_current: setCurrent.value,
    base_version: props.version,
  })
  pollTimer = setInterval(async () => {
    const status = await editAPI.renderStatus(props.episodeId, export_id)
    progressText.value = `${t('edit.exportProgress')} ${status.progress ?? 0}%`
    if (status.status === 'completed' || status.status === 'failed') {
      clearInterval(pollTimer); busy.value = false
      if (status.status === 'failed') { error.value = status.error || t('edit.exportFailed'); return }
      emit('exported', status.result)
      emit('close')
    }
  }, 2000)
}
onUnmounted(() => clearInterval(pollTimer))
```

> 实现注意：`props` 需要 `episodeId/projectId/version/plan/open`；`preset` 选择器若设计 6.10 要求可选（vertical-hd/horizontal-hd/vertical-high），加一个 `NSelect`，默认 `vertical-hd`；`warningsAcked` 的勾选框文案 `edit.exportAck`。组件内不得修改计划——导出以保存后的服务端计划为准，对话框只读。

- [ ] **Step 6: editAPI 与 EditWorkbench 接线**

`useApi.ts` editAPI 追加：

```js
extractFrame: (episodeId, body) => api.post(`/episodes/${episodeId}/edit/frames`, body),
uploadImage: (episodeId, file) => api.upload(`/episodes/${episodeId}/edit/assets/images`, file),
render: (episodeId, body) => api.post(`/episodes/${episodeId}/edit/render`, body),
renderStatus: (episodeId, exportId) => api.get(`/episodes/${episodeId}/edit/render/${exportId}`),
mediaImages: (episodeId, projectId) => api.get(`/episodes/${episodeId}/edit/media?project_id=${projectId}`),
```

> 实现注意：`api.upload` 若 `useApi.ts` 的 `api` 对象没有现成 multipart 方法，先读 `useApi.ts` 里图片/文件上传的既有写法（其他工作台有上传先例），照抄同一封装；不要新造 transport。`mediaImages` 可并入 Task 19 已扩展的 `media` 返回，若 `editAPI.media` 已带 `images` 字段则删掉 `mediaImages`，测试第 4 用例同步移除该项。

`EditWorkbench.vue` 接线：

1. Task 22 遗留的 `onFrameOp` 中 `insert-image` 分支：`imagePickerOpen.value = true; pendingInsertAt.value = { clipId, atMs }`。
2. `EditImagePicker` 的 `insert` 处理：

```js
function insertImage(img) {
  const at = pendingInsertAt.value
  applyCommand(() => insertImageClip(plan.value, {
    url: mediaUrl(img.url), name: img.name, durationMs: 3000,
  }, at?.clipId ? { atMs: at.atMs } : {}))
  imagePickerOpen.value = false
}
```

> 实现注意：`insertImageClip` 签名以 Task 18 实际实现为准（Task 18 定义为 `(plan, source, options)`，插入点为播放头或指定 `atMs`）；按真实签名改参数。图片 URL 需走 `mediaUrl` 或直接存相对路径——与 `EditPlanV1` 图片片段 `source.url` 的既有约定一致（先读 `edit-plan.ts` 确认）。

3. 定格帧插入（Task 22 的 `insertFreezeAt` 实现）：

```js
async function insertFreezeAt(clipId, atMs) {
  freezeBusy.value = true
  try {
    const frame = await editAPI.extractFrame(props.state.episode_id, {
      project_id: stateProjectId.value, clip_id: clipId, offset_ms: atMs,
    })
    applyCommand(() => insertFreezeFrame(plan.value, {
      url: mediaUrl(frame.url), name: t('edit.freezeFrameName'),
      sourceMs: atMs, durationMs: 1000,
    }, { atMs, afterClipId: clipId }))
  } catch (error) { notify(error?.message || t('edit.actionFailed')) }
  finally { freezeBusy.value = false }
}
```

> 实现注意：`stateProjectId` 取 `state.project?.id ?? 0`；`offset_ms` 语义是「片段内容内偏移」（Task 19 定义），传入前用 `atMs` 换算：`offset = atMs - 该片段 timeline_start_ms`（需从 `layout.clips` 找到该片段），不要直接传时间线绝对时间。`insertFreezeFrame` 签名以 Task 18 为准。

4. 导出入口：`EditTopBar` 增加「导出成片」按钮（emit `open-export`），EditWorkbench 打开 `EditExportDialog`（props 传 `plan/version/projectId/episodeId`）；`exported` 回调里刷新成片列表（Task 16 的 `loadFilms()`）并显示成功消息。

- [ ] **Step 7: 四语言文案**

`edit` 段追加（zh）：`exportTitle: 导出剪辑成片, exportSubtitle: 字幕方式, subtitleBurn: 烧录字幕, subtitleSoft: 软字幕, subtitleNone: 不带字幕, exportSetCurrent: 导出后设为当前成片, exportStart: 开始导出, exportRunning: 导出中…, exportProgress: 进度, exportFailed: 导出失败, exportWarningTitle: 以下效果将按简化方式导出, exportWarnTransition: 转场将按硬切导出, exportWarnFilter: 滤镜暂不支持导出, exportWarnTransform: 位置变换暂不支持导出, exportWarnOverlay: 叠加轨将被忽略, exportAck: 我已知晓并确认导出, exportPreset: 输出规格, imagePickerTitle: 选择图片, uploadImage: 上传图片, uploading: 上传中…, imagePickerEmpty: 暂无图片，先上传一张, freezeFrameName: 定格帧, frameFreezeInserted: 已插入定格帧, actionFailed: 操作失败`。en/ja/ko 同义翻译（英文示例：`Export edit film / Subtitles / Burn-in / Soft subs / None / Set as current film after export / Start export / Exporting… / Progress / Export failed / These effects will be simplified on export / Transitions export as hard cuts / Filters are not exported yet / Position transforms are not exported yet / Overlay tracks are ignored / I understand and confirm / Output preset / Choose image / Upload image / Uploading… / No images yet, upload one / Freeze frame / Frame inserted / Action failed`）。

- [ ] **Step 8: 运行测试确认通过**

```bash
cd frontend && node --test tests/edit-export-ui.test.mjs tests/edit-frame-ui.test.mjs
```

预期：全部 PASS。

- [ ] **Step 9: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 24: 剪辑预览播放时钟与回退横幅（spec 6.9）

**Files:**
- Modify: `backend/src/services/edit-service.ts`（state.audio 扩展）
- Modify: `backend/src/services/edit-normalize.ts` 或新增小型类型（audio 联合类型，若前端/后端共享类型则在 `backend/src/services/edit-plan.ts` 与 `frontend/app/utils/edit-plan.ts` 同步）
- Create: `frontend/app/composables/useEditClock.ts`
- Modify: `frontend/app/components/edit/EditWorkbench.vue`、`frontend/app/components/edit/EditPreview.vue`
- Test: `backend/tests/edit-audio-state.test.ts`（新建）、`frontend/tests/edit-clock-ui.test.mjs`（新建）

**Interfaces:**
- Consumes: `mix_status`（`aligned/stale/missing`，现有）；`videoMerges`（kind='mix' 最新 completed 行的 `mergedUrl`）。
- Produces: state.audio 扩展为 `{ mode: 'mix' | 'video' | 'none', url?: string, reference_only: boolean, duration_ms?: number }`——`mode='mix'`：mix_status aligned 且存在混音成片音轨（url=混音成片）；`mode='video'`：混音不可用但源成片/单片段有原声（`reference_only` = mix_status==='stale'）；`mode='none'`：两者皆无。前端 `useEditClock({ audioUrl, playing })` 暴露 `{ audioMs, drift, mode, start, stop, seek }`；漂移阈值常量 `EDIT_DRIFT_MS = 120`（区别于混音页 320ms，不共享播放器实现）。

- [ ] **Step 1: 写失败测试（后端）**

`backend/tests/edit-audio-state.test.ts` 新建（夹具沿用 edit-project.test.ts 风格：隔离 SQLITE_PATH、动态 import、completed 拼接成片 + 单片段 plan）：

```ts
test('混音 aligned 时 audio.mode 为 mix', async () => {
  // 插入 kind='mix' origin='export' status='completed' mergedUrl='static/m.mp4' 的成片，并让 mix_status 为 aligned
  const state = await getEpisodeEditState(episode.id)
  assert.equal(state.audio.mode, 'mix')
  assert.equal(state.audio.reference_only, false)
  assert.ok(state.audio.url)
})

test('混音 stale 时回退源原声并标记 reference_only', async () => {
  // 改动 plan 使 mix_status 为 stale
  const state = await getEpisodeEditState(episode.id)
  assert.equal(state.audio.mode, 'video')
  assert.equal(state.audio.reference_only, true)
})

test('无混音无原声时 mode 为 none', async () => {
  // 无声源成片
  const state = await getEpisodeEditState(episode.id)
  assert.equal(state.audio.mode, 'none')
})
```

- [ ] **Step 2: 写失败测试（前端结构）**

`frontend/tests/edit-clock-ui.test.mjs`：

```mjs
test('剪辑页播放时钟契约与回退横幅', () => {
  const clock = read('app/composables/useEditClock.ts')
  assert.match(clock, /EDIT_DRIFT_MS/)
  assert.match(clock, /120/)
  assert.match(clock, /AudioContext|audioContext/)

  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /useEditClock/)
  assert.match(workbench, /audioBanner/)

  const zh = JSON.parse(read('app/locales/zh.json'))
  assert.ok(zh.edit.audioBannerStale)
  assert.ok(zh.edit.audioBannerNone)
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd backend && npx tsx --test tests/edit-audio-state.test.ts
cd frontend && node --test tests/edit-clock-ui.test.mjs
```

预期：全部 FAIL。

- [ ] **Step 4: 实现 audio 状态扩展**

`edit-service.ts` 的 state 构建处（现 `audio` 常量）：查询最新 `kind='mix'、status='completed'` 的 videoMerges 行；按 Interfaces 的优先级写 `audio`（`reference_only` 仅在 mode='video' 且 mix_status==='stale' 时为 true；mode='mix' 时 url 直接用混音成片 url）。`frontend/app/utils/edit-plan.ts` 中对应类型同步加 `reference_only`。

- [ ] **Step 5: 实现 useEditClock**

`useEditClock.ts` 契约：

```ts
export const EDIT_DRIFT_MS = 120
// audioUrl 变化时 fetch + decodeAudioData 缓存 AudioBuffer
// start(ms): AudioBufferSourceNode 从 ms 起播，记录 startCtxTime = ctx.currentTime - ms/1000
// audioMs(): playing 时 (ctx.currentTime - startCtxTime) * 1000，否则 lastSeekMs
// syncVideo(videoEl, timelineToSourceMs): 每帧调用；|videoMs - 映射后音频位置| > EDIT_DRIFT_MS 时 video.currentTime = 音频位置对应的源时间
// 停止/暂停：sourceNode.stop()；seek(ms)：重设 lastSeekMs 并在下次 start 从该处起播
```

`EditWorkbench` 接线：`audioMode` 计算改为基于新 `state.audio.mode`（'mix'/'video'/'none'，替代现 `plan.clips.some(hasAudio)` 判定）；播放/暂停时 start/stop clock，rAF 循环里调用 `syncVideo`；`audioBanner` computed——`mode='video' && reference_only` → `t('edit.audioBannerStale')`，`mode='none'` → `t('edit.audioBannerNone')`，其余为空。`EditPreview` 增加 banner 显示条（现有 `ed-audio` 标签替换为横幅文案）。

> 实现注意：`mode='mix'` 时视频画面仍按片段切源播放，音频走 WebAudio——视频定期 seek 到音频位置（漂移>120ms 才 seek，避免频繁跳帧）；`mode='video'` 保持现有「视频即时钟」逻辑不动（原生漂移）。混合模式切换（audio.url 变化）必须先 stop 旧时钟再重建。播放到混音末尾而视频还有片段时，回退到「视频即时钟」并显示 `audioBannerStale` 文案之外的静音提示可不做——以音频先结束为准停止音频继续视频静音，属可接受近似。

- [ ] **Step 6: 四语言文案**

`edit` 段追加：zh `audioBannerStale: 混音需更新，当前播放原声参考`, `audioBannerNone: 暂无可用音频，仅静音预览`；en `Mix needs updating — playing source audio as reference` / `No audio available — silent preview`；ja/ko 同义。

- [ ] **Step 7: 运行测试确认通过**

```bash
cd backend && npx tsx --test tests/edit-audio-state.test.ts tests/edit-project-state.test.ts
cd frontend && node --test tests/edit-clock-ui.test.mjs && npm run build
```

预期：全部 PASS，SFC 构建成功。

- [ ] **Step 8: 记录改动（不提交）**

```bash
git status --short
```

---

### Task 25: Phase E —— 全量验证、文档与验收清单

**Files:**
- Modify: `docs/superpowers/specs/2026-11-06-film-hub-mix-edit-redesign.md`（如实现中出现过裁定，回写差异）
- Modify: `docs/adr/ADR-05-film-catalog.md`、`docs/adr/ADR-12-edit-workbench.md`（按 Task 1 已修订内容核对最终状态）
- Modify: `docs/superpowers/plans/` 对应执行日志（若项目有执行日志惯例则追加，无则跳过）
- Test: 全量

**Interfaces:**
- Consumes: Task 1–23 的全部产出；现有测试套件。
- Produces: 全量验证证据（命令输出）、验收清单核对结果、文档一致性。

- [ ] **Step 1: 后端全量测试**

```bash
cd backend && npm run typecheck && npx tsx --test tests/
```

预期：全部 PASS，无新增告警。重点回归：`edit-plan.test.ts`、`edit-normalize.test.ts`、`edit-subtitle-ass.test.ts`、`edit-project-service.test.ts`、`edit-project-state.test.ts`、`edit-frames.test.ts`、`edit-export.test.ts`、`film-hub.test.ts`、`mix-*.test.ts`（混音回归）、`route.test.ts`。

- [ ] **Step 2: 前端测试与构建门禁**

```bash
cd frontend && node --test tests/ && npm run build
```

预期：结构测试全部 PASS；SFC 构建成功（构建是前端正确性门禁，构建失败视为未完成）。构建产物不部署、不打包。

- [ ] **Step 3: 手动验收清单（逐条核对 spec 第 7 节）**

按 spec 第 7 节「交互验收清单」逐条核对，每条记录 通过/未实现/偏差。最低核对集：

1. 成片中心三处入口（混音、剪辑、导出）使用同一 `FilmPicker`，列表来自拼接导出成片 + 各类成片；
2. 混音选择拼接成片 → 完成导出 → 成片列表出现 `mix` 类型新成片且可设为当前；
3. 剪辑从成片列表打开工程 → 保存/版本/恢复在工程维度生效；切换成片时未保存改动先保存或被阻止；
4. 右键菜单与工具栏按钮均可执行：分割、删除、删除这一帧、复制这一帧（定格）、插入图片、拉长 1 秒；
5. 字幕：新建/编辑/分割/合并/删除；字体、字号、颜色、描边、底色、对齐、位置（九宫格 + X/Y）、时间均可编辑并反映到预览（近似）与导出（burn/soft/none）；
6. 帧级操作真实生效：删除一帧后时间线与预览时长减少约 1/fps 秒；定格帧插入后出现图片片段；
7. 导出前检查列出全部降级项；确认后导出成功，成片列表出现 `edit` 类型成片，`subtitle_burned` 与 `subtitle_url` 按所选模式投影；
8. 只读模式（`edit_workspace != 'on'`）下所有写操作返回 `403`，读操作可用。

> 本任务只核对清单并记录结果；真实浏览器 E2E、打包与安装需要用户单独批准后另行执行（遵循既有约定：构建/安装需显式批准）。

- [ ] **Step 4: 文档一致性核对**

1. ADR-05/ADR-12 与实际实现一致（成片目录唯一来源、导出仅记账、工程按源成片隔离）；
2. spec 中与实现有出入的点（若有裁定）回写 spec，注明日期；
3. 检查四语言文案无缺失键（抽查 `zh.json` 与 `en.json` 键集合一致）：

```bash
cd frontend && node -e "
const zh=require('./app/locales/zh.json').edit, en=require('./app/locales/en.json').edit;
const miss=Object.keys(zh).filter(k=>!(k in en));
console.log(miss.length?'缺失:'+miss.join(',')':'en 键齐全');
"
```

- [ ] **Step 5: 记录改动（不提交）**

```bash
git status --short
```

改动保留在工作区，等待用户验收后决定是否提交（遵循「Git 提交需显式要求」约定）。

---

## 计划收尾说明

- 任务依赖：Phase A（1–4）→ Phase B（5–11）与 Phase C（12–17）可并行 → Phase D（18–24）→ Phase E（25）。Task 22/23 依赖 16/17/18/19/21；Task 19 依赖 12/14；Task 24 依赖 14（audio 状态）与 17（预览接线）。
- 全局约束重申：所有新用户可见文案中文优先并四语言齐备；播放器/工作台「必须一套」，不新增并行页面；不改用户已选模型/供应商配置；ComfyUI 工作流只暴露名称不给用户 JSON；不动 5679/3013 端口语义；导出降级项必须显式列出，不得静默忽略。
- 计划中所有「实现注意」块是对实现者的约束性裁定（非可选项）：签名以所引用任务的真实实现为准，发现计划文本与早前任务实现冲突时，以真实实现 + 全局约束为准并在报告中记录偏差。

