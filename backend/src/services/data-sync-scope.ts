/**
 * A8 数据同步范围与 schema 指纹。
 *
 * 2026-11-12 校准：当前后端 schema 共 65 张表，52 张业务表同步、13 张设备/运行/主机表不同步。
 * 4.0.38 分镜管线新增 scene_geographies / coverage_plans / shot_relations /
 * visual_preflight_reports / acceptance_reports / transition_shots / sound_plans / sound_cues
 * 纳入业务同步；storyboard_pipeline_jobs / storyboard_skeletons 属于运行时中间态，不同步并在应用前清理。
 * 原设计中的 director_plans / agent_sessions / novel_annotations 等 7 张表尚未落地，
 * 不计入清单；表实际出现后再按同一规则纳入并更新设计。
 */
import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import { sqlite } from '../db/index.js'

export const SYNC_TABLES = [
  'dramas',
  'episodes',
  'characters',
  'episode_characters',
  'episode_scenes',
  'episode_props',
  'scenes',
  'scene_geographies',
  'storyboards',
  'coverage_plans',
  'shot_relations',
  'visual_preflight_reports',
  'acceptance_reports',
  'transition_shots',
  'breakdown_methods',
  'storyboard_characters',
  'storyboard_props',
  'style_presets',
  'video_merges',
  'video_transitions',
  'props',
  'assets',
  'character_voices',
  'storyboard_lines',
  'line_takes',
  'voice_samples',
  'line_tombstones',
  'episode_audio_assets',
  'audio_buses',
  'mix_revisions',
  'episode_mix_line_exclusions',
  'episode_exports',
  'episode_edit_drafts',
  'edit_revisions',
  'edit_renders',
  'edit_projects',
  'episode_media_proxies',
  'dubbing_jobs',
  'episode_audio_tracks',
  'episode_audio_clips',
  'sound_plans',
  'sound_cues',
  'grid_sheets',
  'script_imports',
  'script_chapters',
  'novels',
  'novel_chapters',
  'novel_graph_snapshots',
  'novel_chapter_graphs',
  'novel_jobs',
  'novel_imports',
  'novel_import_episodes',
] as const

export const NON_SYNC_TABLES = [
  'remote_devices',
  'app_settings',
  'ai_service_configs',
  'ai_service_providers',
  'sys_task',
  'pipeline_jobs',
  'video_batch_jobs',
  'video_batch_items',
  'storyboard_split_jobs',
  'storyboard_audit_jobs',
  'storyboard_pipeline_jobs',
  'storyboard_skeletons',
  'episode_locks',
] as const

export const RUNTIME_CLEAR_TABLES = [
  'sys_task',
  'pipeline_jobs',
  'video_batch_jobs',
  'video_batch_items',
  'storyboard_split_jobs',
  'storyboard_audit_jobs',
  'storyboard_pipeline_jobs',
  'storyboard_skeletons',
  'episode_locks',
] as const

export class SyncScopeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SyncScopeError'
    this.code = code
  }
}

export interface SyncTableCount {
  table: string
  rows: number
}

export interface SyncScopeCoverage {
  ok: boolean
  business: string[]
  nonSync: string[]
  unknown: string[]
  missing: string[]
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new SyncScopeError('SYNC_BAD_TABLE', `非法表名: ${name}`)
  return `"${name}"`
}

export function listDatabaseTables(database: Database.Database = sqlite): string[] {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

/** 检查清单是否覆盖当前库；未知表必须显式归类，避免新业务表被静默漏同步 */
export function inspectSyncScopeCoverage(database: Database.Database = sqlite): SyncScopeCoverage {
  const actual = new Set(listDatabaseTables(database))
  const listed = new Set<string>([...SYNC_TABLES, ...NON_SYNC_TABLES])
  const unknown = [...actual].filter(name => !listed.has(name)).sort()
  const missing = [...listed].filter(name => !actual.has(name)).sort()
  return {
    ok: unknown.length === 0 && missing.length === 0,
    business: [...SYNC_TABLES],
    nonSync: [...NON_SYNC_TABLES],
    unknown,
    missing,
  }
}

export function assertSyncScopeCoverage(database: Database.Database = sqlite): SyncScopeCoverage {
  const coverage = inspectSyncScopeCoverage(database)
  if (!coverage.ok) {
    throw new SyncScopeError(
      'SYNC_SCOPE_DRIFT',
      `同步范围与数据库不一致：unknown=${coverage.unknown.join(',') || '-'} missing=${coverage.missing.join(',') || '-'}`,
    )
  }
  return coverage
}

interface ColumnDefinition {
  name: string
  type: string
  notnull: number
  pk: number
  dflt_value: string | null
}

function tableColumns(table: string, database: Database.Database): ColumnDefinition[] {
  const rows = database.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as ColumnDefinition[]
  return rows.map(row => ({
    name: row.name,
    type: row.type,
    notnull: row.notnull,
    pk: row.pk,
    dflt_value: row.dflt_value,
  }))
}

/**
 * schema 指纹：只覆盖同步表的列定义，按表名与列顺序规范化后哈希。
 * 与 sqlite_sequence、索引、不同步表变化无关。
 */
export function syncSchemaFingerprint(database: Database.Database = sqlite): string {
  const payload = [...SYNC_TABLES]
    .sort()
    .map(table => ({ table, columns: tableColumns(table, database) }))
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function syncTableRowCounts(database: Database.Database = sqlite): SyncTableCount[] {
  return SYNC_TABLES.map(table => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`).get() as { count: number }
    return { table, rows: Number(row.count) }
  })
}

export function assertSyncTableRowCounts(expected: SyncTableCount[]): void {
  const actual = new Map(syncTableRowCounts().map(item => [item.table, item.rows]))
  const known = new Set<string>(SYNC_TABLES)
  for (const item of expected) {
    if (!known.has(item.table)) {
      throw new SyncScopeError('SYNC_UNKNOWN_TABLE', `行数校验包含未知表: ${item.table}`)
    }
    if (!Number.isInteger(item.rows) || item.rows < 0) {
      throw new SyncScopeError('SYNC_BAD_ROW_COUNT', `行数非法: ${item.table}=${item.rows}`)
    }
    if (actual.get(item.table) !== item.rows) {
      throw new SyncScopeError(
        'SYNC_ROW_COUNT_MISMATCH',
        `表 ${item.table} 行数不一致：期望 ${item.rows}，实际 ${actual.get(item.table) ?? '缺失'}`,
      )
    }
  }
}
