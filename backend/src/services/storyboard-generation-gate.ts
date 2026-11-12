/**
 * 生成前门禁：读最新审计问题，阻断有 error 的分镜；覆盖缺口/合同缺失作为警告。
 * 只做查询，不改数据；前端在单镜/批量生成前调用。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getCoveragePlan } from './scene-planning.js'
import { getPreflightState } from './storyboard-visual-preflight.js'

export interface GenerationGateItem {
  code: string
  message: string
  severity: 'error' | 'warning' | 'info'
  issue_id?: string
  storyboard_number?: number
}

export interface GenerationGateResult {
  allowed: boolean
  blockers: GenerationGateItem[]
  warnings: GenerationGateItem[]
}

function parseIssues(raw: string | null | undefined): any[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, any> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function evaluateStoryboardGenerationGate(
  episodeId: number,
  storyboardId: number,
): Promise<GenerationGateResult> {
  const [storyboard] = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.id, storyboardId), eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
  if (!storyboard) {
    return {
      allowed: false,
      blockers: [{ code: 'storyboard_not_found', message: '分镜不存在', severity: 'error' }],
      warnings: [],
    }
  }

  const [latestJob] = await db.select().from(schema.storyboardAuditJobs)
    .where(eq(schema.storyboardAuditJobs.episodeId, episodeId))
    .orderBy(desc(schema.storyboardAuditJobs.id))
    .limit(1)

  const blockers: GenerationGateItem[] = []
  const warnings: GenerationGateItem[] = []
  const shotStatusMap = parseJsonObject(latestJob?.shotStatusJson)
  const shotStatus = shotStatusMap?.[String(storyboardId)] ?? shotStatusMap?.[storyboardId] ?? null
  const jobUpdatedAt = latestJob?.updatedAt ? Date.parse(latestJob.updatedAt) : 0
  const shotUpdatedAt = storyboard.updatedAt ? Date.parse(storyboard.updatedAt) : 0
  const auditStale = Boolean(latestJob) && (
    Boolean(shotStatus?.stale)
    || (jobUpdatedAt > 0 && shotUpdatedAt > jobUpdatedAt)
  )
  const issues = auditStale ? [] : parseIssues(latestJob?.issuesJson)
  if (auditStale) {
    warnings.push({
      code: 'audit_stale',
      message: '该镜在最近一次审计后有修改，旧审计结论已过期；请重跑审计后再生成。',
      severity: 'warning',
    })
  }
  for (const issue of issues) {
    const related = Array.isArray(issue.relatedStoryboardIds) ? issue.relatedStoryboardIds : []
    if (issue.storyboardId !== storyboardId && !related.includes(storyboardId)) continue
    if (['fixed', 'stale', 'rolled_back'].includes(String(issue.status || ''))) continue
    const item: GenerationGateItem = {
      code: String(issue.code || 'audit_issue'),
      message: String(issue.message || issue.code || '审计问题'),
      severity: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info',
      issue_id: issue.id ? String(issue.id) : undefined,
      storyboard_number: issue.storyboardNumber,
    }
    if (item.severity === 'error') blockers.push(item)
    else if (item.severity === 'warning') warnings.push(item)
  }

  if (!latestJob) {
    warnings.push({ code: 'audit_missing', message: '该集还没有动作检验结果，建议先检验再生成。', severity: 'warning' })
  } else if (['pending', 'preparing', 'auditing', 'repairing', 'rechecking'].includes(String(latestJob.status || ''))) {
    warnings.push({ code: 'audit_running', message: '动作检验仍在进行，生成前请等待检验完成。', severity: 'warning' })
  }

  if ((storyboard.contractVersion || 0) === 0) {
    warnings.push({ code: 'contract_missing', message: '该镜还没有解析镜头合同（画内人物/屏幕方向/时间帧）；建议先保存一次提示词或同步合同。', severity: 'warning' })
  }

  const preflight = await getPreflightState(storyboardId)
  if (!preflight.report) {
    warnings.push({ code: 'preflight_missing', message: '该镜还没有视觉预检；建议生成前先跑一次视觉预检。', severity: 'warning' })
  } else if (preflight.stale) {
    warnings.push({ code: 'preflight_stale', message: '该镜的视觉预检在合同/首帧修改后已过期；请重跑预检。', severity: 'warning' })
  } else if (preflight.report.verdict === 'block') {
    blockers.push({ code: 'preflight_blocked', message: '视觉预检未通过：合同与参考图存在身份/场景/轴线冲突，请先修复或改合同。', severity: 'error' })
  } else if (preflight.report.verdict === 'warn') {
    warnings.push({ code: 'preflight_warn', message: '视觉预检有警告；可生成但建议先核对参考图与场景地理。', severity: 'warning' })
  }

  if (storyboard.sceneId) {
    try {
      const plan = await getCoveragePlan(episodeId, storyboard.sceneId)
      const gaps = Array.isArray((plan?.summary as any)?.gaps) ? (plan?.summary as any).gaps as string[] : []
      if (gaps.length) {
        warnings.push({
          code: 'coverage_gap',
          message: `本场覆盖计划有缺口：${gaps.join('、')}。`,
          severity: 'warning',
        })
      }
    } catch {
      // 计划读取失败不影响门禁结论
    }
  }

  return { allowed: blockers.length === 0, blockers, warnings }
}
