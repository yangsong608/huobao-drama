/**
 * L3 生成后验收：从成片抽 5 帧，与合同、参考图、上一镜尾帧做 AI 对照。
 *
 * 只做验收报告，不改视频、不改合同；fail 结果供 UI/装配门禁使用。
 * 抽帧无法判断声音内容，只检查音轨是否存在；对白内容仍以台词链和人工试听为准。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { probeMedia } from './export-validation.js'
import { extractVideoFrameAt } from './video-frames.js'
import { callVisionJson, loadVisionImages } from './vision-call.js'

type StoryboardRow = typeof schema.storyboards.$inferSelect

export interface AcceptanceCheck {
  key: string
  label: string
  verdict: 'pass' | 'warn' | 'fail' | 'skipped'
  detail: string
}

export interface AcceptanceIssue {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  suggestion: string
  evidence: string
}

export interface AcceptanceReport {
  id: number
  storyboard_id: number
  verdict: 'pass' | 'warn' | 'fail'
  checks: AcceptanceCheck[]
  issues: AcceptanceIssue[]
  evidence: Array<{ label: string; path: string; time?: number }>
  model: string
  provider: string
  video_url: string
  created_at: string
}

const CHECK_LABELS: Record<string, string> = {
  identity: '人物身份',
  set: '场景地理',
  axis: '轴线与屏幕方向',
  action: '动作与尾帧衔接',
  presence: '人物在场',
  prop: '道具',
  audio: '声音',
  text: '画面文字',
}

const CHECK_ORDER = ['identity', 'set', 'axis', 'action', 'presence', 'prop', 'audio', 'text']
const SAMPLE_RATIOS = [0.08, 0.25, 0.5, 0.75, 0.92]

function parseJsonArray(value: string | null | undefined): any[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function videoFingerprint(videoUrl: string): string {
  let size = 0
  let mtime = 0
  try {
    const stat = fs.statSync(getAbsolutePath(videoUrl))
    size = stat.size
    mtime = stat.mtimeMs
  } catch {
    // 文件暂时不可读时仍生成指纹，后续报告会因重生成再次失效
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify({ videoUrl, size, mtime }))
    .digest('hex')
    .slice(0, 20)
}

function formatContract(row: StoryboardRow, castNames: Record<number, string>, sceneName: string): string {
  const castOn = parseJsonArray(row.castOnScreen)
  const castOff = parseJsonArray(row.castOffScreen)
  const names = (ids: any[]) => ids.map(id => castNames[Number(id)] || `#${id}`).join('、') || '无'
  return [
    `- 镜头：第 ${row.storyboardNumber} 镜，时长 ${row.duration || 0} 秒`,
    `- 场景：${sceneName || row.location || '未指定'}；时间：${row.time || '未填'}`,
    `- 覆盖类型：${row.coverageType || '未填'}；轴线侧：${row.axisSide || '未填'}；机位侧：${row.cameraSide || '未填'}`,
    `- 屏幕左：${parseJsonArray(row.screenLeft).join('、') || '未填'}；屏幕右：${parseJsonArray(row.screenRight).join('、') || '未填'}；过肩：${row.foregroundShoulder || '未填'}`,
    `- 画内人物：${names(castOn)}；画外人物：${names(castOff)}；画外人物不得入画`,
    `- 背景地标：${parseJsonArray(row.backgroundLandmarks).map((item: any) => `${item.name}:${item.side}`).join('、') || '未填'}`,
    `- 动作起点：${row.actionStart || '未填'}；动作终点：${row.actionEnd || '未填'}`,
    `- 负面约束：${row.negativeConstraints || '未填'}`,
  ].join('\n')
}

async function buildContext(row: StoryboardRow) {
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
  const propLinks = await db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, row.id))
  const propIds = propLinks.map(link => link.propId)
  const props = propIds.length
    ? await db.select().from(schema.props).where(and(inArray(schema.props.id, propIds), isNull(schema.props.deletedAt)))
    : []
  const [previous] = await db.select().from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.episodeId, row.episodeId),
      eq(schema.storyboards.storyboardNumber, row.storyboardNumber - 1),
      isNull(schema.storyboards.deletedAt),
    ))
    .limit(1)
  const castNames: Record<number, string> = {}
  for (const character of castRows) castNames[character.id] = character.name
  return {
    episode,
    scene,
    onScreen,
    props,
    previous,
    castNames,
    contractText: formatContract(row, castNames, scene?.location || ''),
  }
}

const SYSTEM_PROMPT = `你是短剧成片验收员。只根据随附的成片抽帧、参考图和合同做验收，不评价剧情创意，不要求补拍。
只输出一个 JSON 对象，不要 Markdown 代码块、不要解释：
{"verdict":"pass|warn|fail","summary":"一句话结论","checks":[{"key":"identity|set|axis|action|presence|prop|audio|text","verdict":"pass|warn|fail|skipped","detail":"证据"}],"issues":[{"code":"accept_identity|accept_set|accept_axis|accept_action|accept_presence|accept_prop|accept_audio|accept_text","severity":"error|warning|info","message":"问题","suggestion":"修复动作","evidence":"对应帧/合同字段"}]}

判定规则：
- 身份：画内人物是否与角色参考图一致；换脸/换装/加人= fail。
- 场景：背景地标、窗/门/桌方位是否与合同和场景参考图一致；翻面/换景= fail。
- 轴线：人物左右、视线、过肩侧是否与合同一致；翻面= fail。
- 动作：最后一帧姿态是否接得上合同「动作终点」和上一镜尾帧；明显断开= warn，动作方向相反= fail。
- 在场：画内人物是否齐全；画外人物误入= fail。
- 道具：关键道具外观/位置是否明显错误；错误= warn。
- 声音：你只能看到音轨是否存在，内容无法判断；按输入的音轨状态填 pass 或 skipped，不编造听感。
- 文字：帧内字幕/招牌/界面文字是否乱码、错字或与剧情无关；乱码= warn。
- 最多 4 条 issues；每条都要给可执行修复。`

function normalizeVerdict(value: unknown): 'pass' | 'warn' | 'fail' {
  const text = String(value || '').toLowerCase()
  if (text === 'pass' || text === 'fail') return text
  return 'warn'
}

function normalizeSeverity(value: unknown): AcceptanceIssue['severity'] {
  const text = String(value || '').toLowerCase()
  if (text === 'error' || text === 'fail') return 'error'
  if (text === 'info') return 'info'
  return 'warning'
}

function normalizeChecks(value: unknown): AcceptanceCheck[] {
  if (!Array.isArray(value)) return []
  const byKey = new Map<string, AcceptanceCheck>()
  value.slice(0, 12).forEach((item: any, index: number) => {
    const key = String(item?.key || `check_${index + 1}`)
    const verdict = ['pass', 'warn', 'fail', 'skipped'].includes(String(item?.verdict)) ? String(item.verdict) as AcceptanceCheck['verdict'] : 'warn'
    byKey.set(key, { key, label: CHECK_LABELS[key] || key, verdict, detail: String(item?.detail || '') })
  })
  return CHECK_ORDER
    .filter(key => byKey.has(key))
    .map(key => byKey.get(key)!)
}

function normalizeIssues(value: unknown): AcceptanceIssue[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 6).map((item: any) => ({
    code: String(item?.code || 'accept_issue'),
    severity: normalizeSeverity(item?.severity),
    message: String(item?.message || ''),
    suggestion: String(item?.suggestion || ''),
    evidence: String(item?.evidence || ''),
  }))
}

export async function runAcceptance(
  storyboardId: number,
  opts: { configId?: number; model?: string } = {},
): Promise<AcceptanceReport> {
  const [row] = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.id, storyboardId), isNull(schema.storyboards.deletedAt)))
  if (!row) throw new Error('分镜不存在')
  const videoUrl = String(row.videoUrl || '').trim()
  if (!videoUrl) throw new Error('该镜还没有视频，请先生成镜头视频')

  const context = await buildContext(row)
  const evidence: Array<{ label: string; path: string; time?: number }> = []
  let mediaProbe: Awaited<ReturnType<typeof probeMedia>> | null = null
  try {
    mediaProbe = await probeMedia(getAbsolutePath(videoUrl))
  } catch {
    mediaProbe = null
  }
  const duration = mediaProbe?.durationMs ? mediaProbe.durationMs / 1000 : Number(row.duration) || 0
  if (duration > 0) {
    for (const ratio of SAMPLE_RATIOS) {
      const time = Math.max(0, Math.round(duration * ratio * 100) / 100)
      try {
        const frame = await extractVideoFrameAt(videoUrl, time, {
          dramaId: context.episode?.dramaId,
          label: `sb-${row.id}-accept`,
          subDir: `storyboards/acceptance/ep-${row.episodeId}`,
          tag: `t${time.toFixed(2)}`,
          maxEdge: 960,
        })
        evidence.push({ label: `成片抽帧 t=${time.toFixed(2)}s`, path: frame.relativePath, time })
      } catch {
        // 单帧失败不阻断整体验收
      }
    }
  }

  const referenceImages: Array<{ label: string; path: string }> = []
  if (context.scene?.imageUrl) referenceImages.push({ label: `参考图：场景「${context.scene.location || '本场'}」`, path: context.scene.imageUrl })
  for (const character of context.onScreen.slice(0, 3)) {
    if (character.imageUrl) referenceImages.push({ label: `参考图：角色「${character.name}」`, path: character.imageUrl })
  }
  for (const prop of context.props.slice(0, 2)) {
    if (prop.imageUrl) referenceImages.push({ label: `参考图：道具「${prop.name}」`, path: prop.imageUrl })
  }
  if (context.previous?.lastFrameImage) {
    referenceImages.push({ label: `上一镜尾帧（第 ${context.previous.storyboardNumber} 镜）`, path: context.previous.lastFrameImage })
  }

  const imageItems = [
    ...evidence.map(item => ({ label: item.label, path: item.path })),
    ...referenceImages,
  ].slice(0, 12)
  const images = await loadVisionImages(imageItems)

  const dialogueLines = await db.select({ text: schema.storyboardLines.text })
    .from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.storyboardId, row.id), isNull(schema.storyboardLines.deletedAt)))
  const hasDialogue = dialogueLines.some(line => String(line.text || '').trim())
  const hasAudio = Boolean(mediaProbe?.audio)
  const audioFact = hasAudio ? '成片存在音轨' : '成片没有音轨'
  const dialogueFact = hasDialogue ? '本镜有台词' : '本镜无台词'

  let verdict: AcceptanceReport['verdict'] = 'warn'
  let checks: AcceptanceCheck[] = []
  let issues: AcceptanceIssue[] = []
  let provider = ''
  let model = ''

  if (!evidence.length) {
    checks = CHECK_ORDER.map(key => ({
      key,
      label: CHECK_LABELS[key],
      verdict: key === 'audio' ? (hasAudio ? 'skipped' : 'fail') : 'skipped',
      detail: key === 'audio' ? audioFact : '抽帧失败，未做视觉对照',
    }))
    issues = [{
      code: 'accept_frames_missing',
      severity: 'error',
      message: '无法从成片抽帧，本次验收未执行。',
      suggestion: '确认视频文件可读且 FFmpeg 可用后重试验收。',
      evidence: videoUrl,
    }]
    verdict = 'fail'
  } else {
    const result = await callVisionJson<{
      verdict?: string
      summary?: string
      checks?: unknown
      issues?: unknown
    }>({
      system: SYSTEM_PROMPT,
      prompt: `镜头合同：\n${context.contractText}\n\n声音事实：${audioFact}；${dialogueFact}。\n随附 ${evidence.length} 张成片抽帧（按时间顺序）和 ${referenceImages.length} 张参考图。请做生成后验收。`,
      images,
      configId: opts.configId,
      model: opts.model,
      maxTokens: 3600,
      temperature: 0.2,
    })
    provider = result.provider
    model = result.model
    verdict = normalizeVerdict(result.data?.verdict)
    checks = normalizeChecks(result.data?.checks)
    issues = normalizeIssues(result.data?.issues)
    if (hasDialogue && !hasAudio) {
      issues.push({
        code: 'accept_audio',
        severity: 'error',
        message: '本镜有台词，但成片没有音轨。',
        suggestion: '检查生成参数的声音开关或配音合成，重新生成/合成后再验收。',
        evidence: audioFact,
      })
    }
    if (issues.some(issue => issue.severity === 'error')) verdict = 'fail'
    else if (issues.some(issue => issue.severity === 'warning') && verdict === 'pass') verdict = 'warn'
  }

  const ts = now()
  const id = getInsertId(db.insert(schema.acceptanceReports).values({
    episodeId: row.episodeId,
    storyboardId: row.id,
    taskId: null,
    videoUrl,
    videoFingerprint: videoFingerprint(videoUrl),
    contractVersion: row.contractVersion || 0,
    verdict,
    checksJson: JSON.stringify(checks),
    issuesJson: JSON.stringify(issues),
    evidenceJson: JSON.stringify(evidence),
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
    evidence,
    model,
    provider,
    video_url: videoUrl,
    created_at: ts,
  }
}

export async function getLatestAcceptance(storyboardId: number): Promise<AcceptanceReport | null> {
  const [row] = await db.select().from(schema.acceptanceReports)
    .where(eq(schema.acceptanceReports.storyboardId, storyboardId))
    .orderBy(desc(schema.acceptanceReports.id))
    .limit(1)
  if (!row) return null
  return {
    id: row.id,
    storyboard_id: row.storyboardId,
    verdict: normalizeVerdict(row.verdict),
    checks: parseJsonArray(row.checksJson) as AcceptanceCheck[],
    issues: parseJsonArray(row.issuesJson) as AcceptanceIssue[],
    evidence: parseJsonArray(row.evidenceJson) as Array<{ label: string; path: string; time?: number }>,
    model: row.model || '',
    provider: row.provider || '',
    video_url: row.videoUrl || '',
    created_at: row.createdAt,
  }
}

/** 报告是否仍对应当前视频；视频重生成后旧报告失效 */
export async function getAcceptanceState(storyboardId: number): Promise<{
  report: AcceptanceReport | null
  stale: boolean
}> {
  const report = await getLatestAcceptance(storyboardId)
  if (!report) return { report: null, stale: false }
  const [row] = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.id, storyboardId), isNull(schema.storyboards.deletedAt)))
  if (!row || !row.videoUrl) return { report, stale: true }
  const latestFingerprint = videoFingerprint(row.videoUrl)
  const [stored] = await db.select({ fingerprint: schema.acceptanceReports.videoFingerprint })
    .from(schema.acceptanceReports)
    .where(eq(schema.acceptanceReports.id, report.id))
  return { report, stale: Boolean(stored?.fingerprint && stored.fingerprint !== latestFingerprint) }
}

export interface AcceptanceGateItem {
  code: string
  message: string
  storyboard_number: number
}

/** 装配门禁：只阻断「有新鲜 fail 报告」的镜头；缺报告/报告过期只作警告，兼容旧数据 */
export async function evaluateEpisodeAcceptanceGate(
  episodeId: number,
  storyboardIds?: number[],
): Promise<{ allowed: boolean; blockers: AcceptanceGateItem[]; warnings: AcceptanceGateItem[] }> {
  const rows = await db.select({
    id: schema.storyboards.id,
    number: schema.storyboards.storyboardNumber,
    videoUrl: schema.storyboards.videoUrl,
    composedVideoUrl: schema.storyboards.composedVideoUrl,
  }).from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)
  const allow = storyboardIds?.length ? new Set(storyboardIds.map(Number)) : null
  const blockers: AcceptanceGateItem[] = []
  const warnings: AcceptanceGateItem[] = []
  for (const row of rows) {
    if (allow && !allow.has(row.id)) continue
    if (!row.videoUrl && !row.composedVideoUrl) continue
    const { report, stale } = await getAcceptanceState(row.id)
    if (!report) {
      warnings.push({ code: 'acceptance_missing', storyboard_number: row.number, message: `第 ${row.number} 镜还没有生成后验收。` })
    } else if (stale) {
      warnings.push({ code: 'acceptance_stale', storyboard_number: row.number, message: `第 ${row.number} 镜的验收报告已过期（视频已重生成）。` })
    } else if (report.verdict === 'fail') {
      blockers.push({ code: 'acceptance_failed', storyboard_number: row.number, message: `第 ${row.number} 镜生成后验收未通过。` })
    } else if (report.verdict === 'warn') {
      warnings.push({ code: 'acceptance_warn', storyboard_number: row.number, message: `第 ${row.number} 镜生成后验收有警告。` })
    }
  }
  return { allowed: blockers.length === 0, blockers, warnings }
}
