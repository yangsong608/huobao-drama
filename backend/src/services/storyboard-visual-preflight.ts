/**
 * L2 视觉预检：生成前用合同 + 参考图/首帧/上一镜尾帧做 AI 对照。
 *
 * 不生成新图，只使用现有场景 canonical 图、画内人物图、道具图和首帧/尾帧。
 * verdict=block 时生成门禁阻断；warn/pass 允许生成但记录。
 */
import crypto from 'node:crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { callVisionJson, loadVisionImages } from './vision-call.js'

type StoryboardRow = typeof schema.storyboards.$inferSelect

export interface PreflightCheck {
  key: string
  label: string
  verdict: 'pass' | 'warn' | 'block' | 'skipped'
  detail: string
}

export interface PreflightIssue {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  suggestion: string
  evidence: string
}

export interface VisualPreflightReport {
  id: number
  storyboard_id: number
  verdict: 'pass' | 'warn' | 'block'
  checks: PreflightCheck[]
  issues: PreflightIssue[]
  evidence: Array<{ label: string; path: string }>
  model: string
  provider: string
  created_at: string
}

interface PreflightEvidence {
  fingerprint: string
  images: Array<{ label: string; path: string }>
  contractText: string
  missingAssets: string[]
}

const CHECK_LABELS: Record<string, string> = {
  identity: '人物身份',
  set: '场景地理',
  axis: '轴线与屏幕方向',
  blocking: '站位与调度',
  composition: '构图与景别',
}

function parseJsonArray(value: string | null | undefined): any[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function fingerprintOf(storyboard: StoryboardRow, castIds: number[], sceneId: number | null): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      videoPrompt: storyboard.videoPrompt || '',
      contractVersion: storyboard.contractVersion || 0,
      sceneId,
      castIds: [...castIds].sort((a, b) => a - b),
      firstFrame: storyboard.firstFrameImage || '',
      lastFrame: storyboard.lastFrameImage || '',
    }))
    .digest('hex')
    .slice(0, 20)
}

function formatContract(storyboard: StoryboardRow, castNames: Record<number, string>, sceneName: string): string {
  const castOn = parseJsonArray(storyboard.castOnScreen)
  const castOff = parseJsonArray(storyboard.castOffScreen)
  const names = (ids: any[]) => ids.map(id => castNames[Number(id)] || `#${id}`).join('、') || '无'
  return [
    `- 镜头：第 ${storyboard.storyboardNumber} 镜，时长 ${storyboard.duration || 0} 秒`,
    `- 场景：${sceneName || storyboard.location || '未指定'}；时间：${storyboard.time || '未填'}`,
    `- 覆盖类型：${storyboard.coverageType || '未填'}；轴线侧：${storyboard.axisSide || '未填'}；机位侧：${storyboard.cameraSide || '未填'}`,
    `- 屏幕左：${parseJsonArray(storyboard.screenLeft).join('、') || '未填'}；屏幕右：${parseJsonArray(storyboard.screenRight).join('、') || '未填'}；过肩：${storyboard.foregroundShoulder || '未填'}`,
    `- 画内人物：${names(castOn)}；画外人物：${names(castOff)}；画外人物不得入画`,
    `- 背景地标：${parseJsonArray(storyboard.backgroundLandmarks).map((item: any) => `${item.name}:${item.side}`).join('、') || '未填'}`,
    `- 动作起点：${storyboard.actionStart || '未填'}；动作终点：${storyboard.actionEnd || '未填'}`,
    `- 负面约束：${storyboard.negativeConstraints || '未填'}`,
    '- 视频提示词：',
    String(storyboard.videoPrompt || '（空）'),
  ].join('\n')
}

async function buildEvidence(row: StoryboardRow): Promise<PreflightEvidence> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
  const [scene] = row.sceneId
    ? await db.select().from(schema.scenes).where(eq(schema.scenes.id, row.sceneId))
    : [undefined]
  const links = await db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, row.id))
  const castIds = links.map(link => link.characterId)
  const castRows = castIds.length
    ? await db.select().from(schema.characters).where(and(inArray(schema.characters.id, castIds), isNull(schema.characters.deletedAt)))
    : []
  const onScreenIds = parseJsonArray(row.castOnScreen).map(Number)
  const onScreen = castRows.filter(character => !onScreenIds.length || onScreenIds.includes(character.id))
  const props = await db.select({ id: schema.props.id, name: schema.props.name, imageUrl: schema.props.imageUrl })
    .from(schema.props)
    .where(and(eq(schema.props.dramaId, episode?.dramaId || 0), isNull(schema.props.deletedAt)))
  const propLinks = await db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, row.id))
  const linkedProps = props.filter(prop => propLinks.some(link => link.propId === prop.id) && prop.imageUrl)

  const images: Array<{ label: string; path: string }> = []
  const missingAssets: string[] = []
  if (scene?.imageUrl) images.push({ label: `参考图：场景「${scene.location || '本场'}」`, path: scene.imageUrl })
  else missingAssets.push('场景参考图')
  for (const character of onScreen.slice(0, 4)) {
    if (character.imageUrl) images.push({ label: `参考图：角色「${character.name}」`, path: character.imageUrl })
    else missingAssets.push(`角色「${character.name}」参考图`)
  }
  for (const prop of linkedProps.slice(0, 2)) {
    if (prop.imageUrl) images.push({ label: `参考图：道具「${prop.name}」`, path: prop.imageUrl })
  }

  const [previous] = await db.select().from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.episodeId, row.episodeId),
      eq(schema.storyboards.storyboardNumber, row.storyboardNumber - 1),
      isNull(schema.storyboards.deletedAt),
    ))
    .limit(1)
  const previousTail = String(previous?.lastFrameImage || '').trim()
  const firstFrame = String(row.firstFrameImage || '').trim() || previousTail
  if (firstFrame) images.push({ label: firstFrame === previousTail && previousTail ? '生成首帧（上一镜尾帧）' : '生成首帧', path: firstFrame })
  if (previousTail && firstFrame !== previousTail) images.push({ label: '上一镜尾帧（衔接参考）', path: previousTail })

  const castNames: Record<number, string> = {}
  for (const character of castRows) castNames[character.id] = character.name
  return {
    fingerprint: fingerprintOf(row, castIds, row.sceneId ?? null),
    images,
    contractText: formatContract(row, castNames, scene?.location || ''),
    missingAssets,
  }
}

const SYSTEM_PROMPT = `你是短剧分镜的视觉预检员。你只能在生成前用现有参考图和合同文本做对照，不评价剧情创意，不要求补拍。
只输出一个 JSON 对象，不要 Markdown 代码块、不要解释：
{"verdict":"pass|warn|block","summary":"一句话结论","checks":[{"key":"identity|set|axis|blocking|composition","verdict":"pass|warn|block|skipped","detail":"证据"}],"issues":[{"code":"preflight_identity|preflight_set|preflight_axis|preflight_blocking|preflight_composition","severity":"error|warning|info","message":"问题","suggestion":"修复动作","evidence":"对应合同字段或图"}]}

判定规则：
- 人物身份：画内人物与角色参考图是否一致；参考图缺人物时该项 skipped，不据此 block。
- 场景地理：参考图里的窗/门/桌/地标方位是否与合同「背景地标」一致；不一致 block。
- 轴线：合同屏幕左/右、过肩侧与参考图机位是否冲突；冲突 block。
- 调度：动作起点/终点、站位、距离是否可执行；不可执行 warn，与参考图直接矛盾 block。
- 构图：景别、主体位置是否成立；仅明显矛盾时 warn。
- 没有参考图时 verdict=warn，checks 全部 skipped，issues 为空；不要编造画面细节。
- 最多 3 条 issues；问题必须给可执行修复。`

function normalizeVerdict(value: unknown): 'pass' | 'warn' | 'block' {
  const text = String(value || '').toLowerCase()
  if (text === 'pass' || text === 'block') return text
  return 'warn'
}

function normalizeSeverity(value: unknown): PreflightIssue['severity'] {
  const text = String(value || '').toLowerCase()
  if (text === 'error' || text === 'block') return 'error'
  if (text === 'info') return 'info'
  return 'warning'
}

function normalizeChecks(value: unknown): PreflightCheck[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).map((item: any, index: number) => {
    const key = String(item?.key || `check_${index + 1}`)
    const verdict = ['pass', 'warn', 'block', 'skipped'].includes(String(item?.verdict)) ? String(item.verdict) as PreflightCheck['verdict'] : 'warn'
    return { key, label: CHECK_LABELS[key] || key, verdict, detail: String(item?.detail || '') }
  })
}

function normalizeIssues(value: unknown): PreflightIssue[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 5).map((item: any) => ({
    code: String(item?.code || 'preflight_issue'),
    severity: normalizeSeverity(item?.severity),
    message: String(item?.message || ''),
    suggestion: String(item?.suggestion || ''),
    evidence: String(item?.evidence || ''),
  }))
}

export async function runVisualPreflight(
  storyboardId: number,
  opts: { configId?: number; model?: string } = {},
): Promise<VisualPreflightReport> {
  const [row] = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.id, storyboardId), isNull(schema.storyboards.deletedAt)))
  if (!row) throw new Error('分镜不存在')
  if (!(row.videoPrompt || '').trim()) throw new Error('该镜还没有视频提示词，无法预检')

  const evidence = await buildEvidence(row)
  const images = await loadVisionImages(evidence.images)
  let verdict: 'pass' | 'warn' | 'block' = 'warn'
  let checks: PreflightCheck[] = []
  let issues: PreflightIssue[] = []
  let provider = ''
  let model = ''

  if (!images.length) {
    checks = ['identity', 'set', 'axis', 'blocking', 'composition'].map(key => ({
      key,
      label: CHECK_LABELS[key],
      verdict: 'skipped' as const,
      detail: '没有可用参考图',
    }))
    issues = [{
      code: 'preflight_no_reference',
      severity: 'warning',
      message: evidence.missingAssets.length
        ? `缺少参考图：${evidence.missingAssets.join('、')}；本次预检未做视觉对照。`
        : '该镜没有可用的场景/人物/首帧参考图，本次预检未做视觉对照。',
      suggestion: '先在资产页补齐场景 canonical 图、画内人物参考图，或设置首帧/上一镜尾帧后再预检。',
      evidence: evidence.images.map(item => item.path).join('、'),
    }]
  } else {
    const result = await callVisionJson<{
      verdict?: string
      summary?: string
      checks?: unknown
      issues?: unknown
    }>({
      system: SYSTEM_PROMPT,
      prompt: `镜头合同：\n${evidence.contractText}\n\n请对照随附的 ${images.length} 张参考图做生成前预检。`,
      images,
      configId: opts.configId,
      model: opts.model,
      maxTokens: 3200,
      temperature: 0.2,
    })
    provider = result.provider
    model = result.model
    verdict = normalizeVerdict(result.data?.verdict)
    checks = normalizeChecks(result.data?.checks)
    issues = normalizeIssues(result.data?.issues)
    if (issues.some(issue => issue.severity === 'error')) verdict = 'block'
  }

  const ts = now()
  const id = getInsertId(db.insert(schema.visualPreflightReports).values({
    episodeId: row.episodeId,
    storyboardId: row.id,
    contractVersion: row.contractVersion || 0,
    promptHash: evidence.fingerprint,
    verdict,
    checksJson: JSON.stringify(checks),
    issuesJson: JSON.stringify(issues),
    evidenceJson: JSON.stringify(evidence.images.map(item => ({ label: item.label, path: item.path }))),
    model: model || null,
    provider: provider || null,
    createdAt: ts,
  }).run())
  return {
    id,
    storyboard_id: row.id,
    verdict,
    checks,
    issues,
    evidence: evidence.images.map(item => ({ label: item.label, path: item.path })),
    model,
    provider,
    created_at: ts,
  }
}

export async function getLatestPreflight(storyboardId: number): Promise<VisualPreflightReport | null> {
  const [row] = await db.select().from(schema.visualPreflightReports)
    .where(eq(schema.visualPreflightReports.storyboardId, storyboardId))
    .orderBy(desc(schema.visualPreflightReports.id))
    .limit(1)
  if (!row) return null
  return {
    id: row.id,
    storyboard_id: row.storyboardId,
    verdict: normalizeVerdict(row.verdict),
    checks: parseJsonArray(row.checksJson) as PreflightCheck[],
    issues: parseJsonArray(row.issuesJson) as PreflightIssue[],
    evidence: parseJsonArray(row.evidenceJson) as Array<{ label: string; path: string }>,
    model: row.model || '',
    provider: row.provider || '',
    created_at: row.createdAt,
  }
}

/** 当前合同指纹；与报告里的 prompt_hash 不同则报告已过期 */
export async function currentPreflightFingerprint(storyboardId: number): Promise<string | null> {
  const [row] = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.id, storyboardId), isNull(schema.storyboards.deletedAt)))
  if (!row) return null
  const links = await db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  return fingerprintOf(row, links.map(link => link.characterId), row.sceneId ?? null)
}

export async function getPreflightState(storyboardId: number): Promise<{
  report: VisualPreflightReport | null
  stale: boolean
}> {
  const report = await getLatestPreflight(storyboardId)
  if (!report) return { report: null, stale: false }
  const fingerprint = await currentPreflightFingerprint(storyboardId)
  const [row] = await db.select({ promptHash: schema.visualPreflightReports.promptHash })
    .from(schema.visualPreflightReports)
    .where(eq(schema.visualPreflightReports.id, report.id))
  return { report, stale: Boolean(fingerprint && row?.promptHash && row.promptHash !== fingerprint) }
}
