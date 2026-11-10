/**
 * 分镜动作检验 Agent 工具
 *
 * 只挂载给 storyboard_auditor：
 * - report_storyboard_issues：语义检验阶段收集窗口问题
 * - apply_storyboard_repair：修复阶段提交受控修复动作
 *
 * 两个工具都只认任务内部注入的 auditJobId/auditPhase/auditWindowIndex，
 * 聊天等入口没有这些上下文，直接拒绝，避免绕过快照与安全护栏。
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { getAuditJobId, getAuditPhase, getAuditWindowIndex } from '../context.js'
import { recordAuditWindowIssues } from '../../services/storyboard-audit-jobs.js'
import {
  AUDIT_REPAIR_ACTIONS,
  applyAuditRepairActions,
  type AuditRepairAction,
  type AuditRepairActionInput,
} from '../../services/storyboard-audit-repair.js'

const NO_JOB_ERROR = '动作检验仅可通过检验任务触发'

const issueSchema = z.object({
  check: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).describe('检查项 1-5'),
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string().describe('问题码；只允许语义问题码 semantic_shot_description / semantic_continuity_break / semantic_asset_mismatch'),
  storyboardNumber: z.number().int().optional().describe('镜头号（分镜编号，如 17），推荐填写'),
  storyboardId: z.number().int().optional().describe('数据库分镜 ID；可省略，也可直接填镜头号'),
  lineId: z.number().int().nullish(),
  relatedStoryboardNumbers: z.array(z.number().int()).optional().describe('相关镜头号（前后连贯性问题时填写两侧镜头号）'),
  relatedStoryboardIds: z.array(z.number().int()).optional().describe('相关分镜 ID；可省略'),
  message: z.string().describe('问题描述'),
  evidence: z.string().optional().describe('证据片段，最多 500 字'),
  suggestion: z.string().optional().describe('可操作建议，最多 300 字'),
  repairable: z.boolean().optional(),
  repairAction: z.enum(['fill_camera_fields', 'normalize_video_prompt', 'rewrite_description', 'fix_continuity', 'extend_duration', 'insert_transition_shot']).nullish(),
  suggestedTransition: z.enum(['empty', 'scene', 'text']).nullish().describe('仅检查 2 可给出过渡类型建议'),
})

const repairActionSchema = z.object({
  issueId: z.string().describe('问题编号，必须来自本次检验的问题清单'),
  storyboardId: z.number().int().optional().describe('数据库分镜 ID；可省略，服务端按 issueId 定位'),
  storyboardNumber: z.number().int().optional().describe('镜头号；可省略'),
  action: z.enum(AUDIT_REPAIR_ACTIONS as unknown as [AuditRepairAction, ...AuditRepairAction[]]),
  shotType: z.string().optional(),
  angle: z.string().optional(),
  movement: z.string().optional(),
  description: z.string().optional(),
  videoPrompt: z.string().optional(),
  result: z.string().optional(),
  continuity: z.string().optional(),
  transition: z.string().optional(),
  duration: z.number().int().positive().optional(),
})

export const reportStoryboardIssues = createTool({
  id: 'report_storyboard_issues',
  description: '提交当前语义窗口发现的问题。只允许在动作检验的语义检验阶段调用；问题必须落在本窗口分镜内。',
  inputSchema: z.object({
    issues: z.array(issueSchema).describe('当前窗口的问题数组'),
  }),
  execute: async ({ issues }, context) => {
    const rc = context?.requestContext
    const jobId = getAuditJobId(rc)
    const phase = getAuditPhase(rc)
    const windowIndex = getAuditWindowIndex(rc)
    if (!jobId) return { error: NO_JOB_ERROR }
    if (phase !== 'audit') return { error: '当前不在检验阶段，不能报告新问题' }
    if (!windowIndex) return { error: '当前不在检验阶段：缺少语义窗口序号' }
    const drafts = (Array.isArray(issues) ? issues : []).map((issue) => ({
      ...issue,
      source: 'semantic' as const,
    }))
    return recordAuditWindowIssues(jobId, windowIndex, drafts)
  },
})

export const applyStoryboardRepair = createTool({
  id: 'apply_storyboard_repair',
  description: '提交受控修复动作。只允许在动作检验的修复阶段调用，每条动作必须引用本次检验的问题编号。',
  inputSchema: z.object({
    actions: z.array(repairActionSchema).describe('修复动作数组'),
  }),
  execute: async ({ actions }, context) => {
    const rc = context?.requestContext
    const jobId = getAuditJobId(rc)
    const phase = getAuditPhase(rc)
    if (!jobId) return { error: NO_JOB_ERROR }
    if (phase !== 'repair') return { error: '当前不在修复阶段，不能提交修复动作' }
    try {
      return applyAuditRepairActions(jobId, (Array.isArray(actions) ? actions : []) as AuditRepairActionInput[])
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})

export const storyboardAuditTools = {
  reportStoryboardIssues,
  applyStoryboardRepair,
}
