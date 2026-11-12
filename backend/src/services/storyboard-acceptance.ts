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
import { analyzeVideoAudio, formatAudioAnalysis, type SpeechWindow } from './video-audio-analysis.js'
import { logTaskWarn } from '../utils/task-logger.js'

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
  action: '动作连续性',
  presence: '人物在场',
  prop: '道具变化',
  lip: '说话人口型',
  audio: '声音与台词',
  subtitle: '字幕烧入',
  text: '字幕烧入',
}

const CHECK_ORDER = ['identity', 'set', 'axis', 'action', 'presence', 'prop', 'lip', 'audio', 'subtitle']
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

const SYSTEM_PROMPT = `你是短剧成片验收员。只根据随附的成片抽帧、参考图、台词时间表和合同做验收，不评价剧情创意，不要求补拍。
只输出一个 JSON 对象，不要 Markdown 代码块、不要解释：
{"verdict":"pass|warn|fail","summary":"一句话结论","checks":[{"key":"identity|set|axis|action|presence|prop|lip|audio|subtitle","verdict":"pass|warn|fail|skipped","detail":"证据"}],"issues":[{"code":"accept_identity|accept_set|accept_axis|accept_action|accept_presence|accept_prop|accept_lip|accept_audio|accept_subtitle","severity":"error|warning|info","message":"问题","suggestion":"修复动作","evidence":"对应帧/合同字段"}]}

判定规则：
- 身份：画内人物是否与角色参考图一致；换脸/换装/加人= fail。
- 场景：背景地标、窗/门/桌方位是否与合同和场景参考图一致；翻面/换景= fail。
- 轴线：人物左右、视线、过肩侧是否与合同一致；翻面= fail。
- 动作连续性：相邻抽帧的姿态/手部/道具是否连续，最后一帧是否接得上合同「动作终点」和上一镜尾帧；跳变= warn，动作方向相反或人物瞬移= fail。
- 在场：画内人物是否齐全；画外人物误入= fail。
- 道具变化：关键道具在相邻抽帧中是否凭空出现/消失、换手、换外观或位置跳变；明显不一致= fail，轻微= warn。
- 说话人口型：按台词时间表检查对应时间点抽帧——正在说话的角色嘴应张开，听者嘴唇必须闭合；张冠李戴（听者动嘴/说话人闭口）= fail；旁白/心声不要求画内人物张嘴；无法看清嘴部= skipped。
- 声音与台词：你听不到声音，只根据输入的音轨事实填写；音轨是否存在、台词窗口是否静音由系统检测，不得编造听感。
- 字幕烧入：帧内是否出现提示词正文、英文说明、重复字幕条、乱码或与剧情无关的文字；出现明显烧入字幕= warn，大面积乱码遮挡画面= fail。场景招牌/道具文字不算。
- 最多 5 条 issues；每条都要给可执行修复。`

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
    const rawKey = String(item?.key || `check_${index + 1}`)
    const key = rawKey === 'text' ? 'subtitle' : rawKey
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
  const dialogueLines = await db.select({
    text: schema.storyboardLines.text,
    speakerType: schema.storyboardLines.speakerType,
    speakerName: schema.storyboardLines.speakerName,
    plannedStartMs: schema.storyboardLines.plannedStartMs,
    plannedEndMs: schema.storyboardLines.plannedEndMs,
  })
    .from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.storyboardId, row.id), isNull(schema.storyboardLines.deletedAt)))
  const hasDialogue = dialogueLines.some(line => String(line.text || '').trim())
  const hasLipDialogue = dialogueLines.some(line => (
    String(line.text || '').trim()
    && line.speakerType !== 'narration'
    && line.speakerType !== 'inner'
  ))
  const speechWindows: SpeechWindow[] = dialogueLines
    .filter(line => String(line.text || '').trim() && line.plannedStartMs != null && line.plannedEndMs != null && Number(line.plannedEndMs) > Number(line.plannedStartMs))
    .map(line => ({
      startMs: Number(line.plannedStartMs),
      endMs: Number(line.plannedEndMs),
      speaker: `${String(line.speakerName || '角色')}${line.speakerType === 'narration' || line.speakerType === 'inner' ? '（旁白）' : ''}`,
      text: String(line.text || ''),
    }))
  const evidence: Array<{ label: string; path: string; time?: number }> = []
  let mediaProbe: Awaited<ReturnType<typeof probeMedia>> | null = null
  try {
    mediaProbe = await probeMedia(getAbsolutePath(videoUrl))
  } catch {
    mediaProbe = null
  }
  const duration = mediaProbe?.durationMs ? mediaProbe.durationMs / 1000 : Number(row.duration) || 0
  const sampledTimes = new Set<string>()
  const sampleFrame = async (time: number, label: string) => {
    if (duration <= 0) return
    const clamped = Math.max(0, Math.min(duration - 0.05, Math.round(time * 100) / 100))
    const key = clamped.toFixed(1)
    if (sampledTimes.has(key)) return
    sampledTimes.add(key)
    try {
      const frame = await extractVideoFrameAt(videoUrl, clamped, {
        dramaId: context.episode?.dramaId,
        label: `sb-${row.id}-accept`,
        subDir: `storyboards/acceptance/ep-${row.episodeId}`,
        tag: `t${clamped.toFixed(2)}`,
        maxEdge: 960,
      })
      evidence.push({ label, path: frame.relativePath, time: clamped })
    } catch {
      // 单帧失败不阻断整体验收
    }
  }
  if (duration > 0) {
    for (const ratio of SAMPLE_RATIOS) {
      const time = Math.max(0, Math.round(duration * ratio * 100) / 100)
      await sampleFrame(time, `成片抽帧 t=${time.toFixed(2)}s`)
    }
    for (const window of speechWindows.slice(0, 3)) {
      const mid = (window.startMs + window.endMs) / 2000
      await sampleFrame(mid, `台词帧：${window.speaker} t=${mid.toFixed(2)}s`)
    }
  }

  const referenceImages: Array<{ label: string; path: string }> = []
  if (context.scene?.imageUrl) referenceImages.push({ label: `参考图：场景「${context.scene.location || '本场'}」`, path: context.scene.imageUrl })
  for (const character of context.onScreen.slice(0, 2)) {
    if (character.imageUrl) referenceImages.push({ label: `参考图：角色「${character.name}」`, path: character.imageUrl })
  }
  for (const prop of context.props.slice(0, 1)) {
    if (prop.imageUrl) referenceImages.push({ label: `参考图：道具「${prop.name}」`, path: prop.imageUrl })
  }
  if (context.previous?.lastFrameImage) {
    referenceImages.push({ label: `上一镜尾帧（第 ${context.previous.storyboardNumber} 镜）`, path: context.previous.lastFrameImage })
  }

  const visionEvidence = evidence.slice(0, 7)
  const imageItems = [
    ...visionEvidence.map(item => ({ label: item.label, path: item.path })),
    ...referenceImages,
  ].slice(0, 12)
  const images = await loadVisionImages(imageItems)

  const hasAudio = Boolean(mediaProbe?.audio)
  const audioAnalysis = await analyzeVideoAudio(videoUrl, speechWindows)
  const audioFact = formatAudioAnalysis(audioAnalysis, hasDialogue)
  const dialogueFact = hasDialogue ? '本镜有台词' : '本镜无台词'
  const speechTimeline = speechWindows.length
    ? speechWindows.map((window, index) => (
        `${index + 1}. ${window.speaker} ${(window.startMs / 1000).toFixed(2)}-${(window.endMs / 1000).toFixed(2)}s：「${window.text}」`
      )).join('\n')
    : '本镜没有可定位的台词窗口。'

  let verdict: AcceptanceReport['verdict'] = 'warn'
  let checks: AcceptanceCheck[] = []
  let issues: AcceptanceIssue[] = []
  let provider = ''
  let model = ''

  if (!evidence.length) {
    checks = CHECK_ORDER.map(key => ({
      key,
      label: CHECK_LABELS[key],
      verdict: key === 'audio' ? (!hasAudio && hasDialogue ? 'fail' : 'skipped') : 'skipped',
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
    try {
      const result = await callVisionJson<{
        verdict?: string
        summary?: string
        checks?: unknown
        issues?: unknown
      }>({
        system: SYSTEM_PROMPT,
        prompt: [
          `镜头合同：\n${context.contractText}`,
          `声音事实：${audioFact}；${dialogueFact}。`,
          `台词与口型时间表：\n${speechTimeline}`,
          `随附 ${visionEvidence.length} 张成片抽帧（按时间顺序，含台词时间点帧）和 ${referenceImages.length} 张参考图。`,
          '请重点检查：动作连续性、说话人口型、字幕烧入、道具变化。',
        ].join('\n\n'),
        images,
        configId: opts.configId,
        model: opts.model,
        maxTokens: 3800,
        temperature: 0.2,
      })
      provider = result.provider
      model = result.model
      verdict = normalizeVerdict(result.data?.verdict)
      checks = normalizeChecks(result.data?.checks)
      issues = normalizeIssues(result.data?.issues)
    } catch (error) {
      verdict = 'warn'
      checks = []
      issues = [{
        code: 'accept_vision_failed',
        severity: 'warning',
        message: `视觉对照失败，本次只完成抽帧与音轨检测：${error instanceof Error ? error.message : String(error)}`,
        suggestion: '检查视觉模型配置/网络后重跑验收；音轨问题仍会照常记录。',
        evidence: videoUrl,
      }]
    }

    const audioVerdict: AcceptanceCheck['verdict'] = !hasAudio
      ? (hasDialogue ? 'fail' : 'skipped')
      : (!hasDialogue ? 'pass' : (audioAnalysis.error ? 'skipped' : (audioAnalysis.allSpeechSilent ? 'fail' : 'pass')))
    const audioCheck = checks.find(check => check.key === 'audio')
    if (audioCheck) {
      audioCheck.verdict = audioVerdict
      audioCheck.detail = audioFact
    } else {
      checks.push({ key: 'audio', label: CHECK_LABELS.audio, verdict: audioVerdict, detail: audioFact })
    }
    if (!hasAudio && hasDialogue) {
      issues.push({
        code: 'accept_audio',
        severity: 'error',
        message: '本镜有台词，但成片没有音轨。',
        suggestion: '检查生成参数的声音开关或配音合成，重新生成/合成后再验收。',
        evidence: audioFact,
      })
    } else if (hasAudio && hasDialogue && audioAnalysis.error) {
      issues.push({
        code: 'accept_audio_unknown',
        severity: 'warning',
        message: `音轨存在，但静音检测失败，无法确认台词是否真的发出：${audioAnalysis.error}`,
        suggestion: '人工试听台词窗口，或检查 FFmpeg 后重跑验收。',
        evidence: audioFact,
      })
    } else if (hasDialogue && audioAnalysis.allSpeechSilent) {
      issues.push({
        code: 'accept_audio_silent',
        severity: 'error',
        message: '本镜有台词，但所有台词时间窗口都接近静音。',
        suggestion: '检查 H3 台词标签是否完整、声音开关是否开启；重新生成或改用后期配音。',
        evidence: audioFact,
      })
    } else if (hasDialogue && audioAnalysis.speechWindows.some(window => window.silentRatio >= 0.8)) {
      issues.push({
        code: 'accept_audio_speech_gap',
        severity: 'warning',
        message: '部分台词时间窗口接近静音，可能存在丢句或时间轴偏移。',
        suggestion: '核对台词标签与时间帧；必要时重跑声音设计/后期配音。',
        evidence: audioFact,
      })
    }
    for (const key of ['action', 'prop', 'lip', 'subtitle'] as const) {
      if (checks.some(check => check.key === key)) continue
      checks.push({
        key,
        label: CHECK_LABELS[key],
        verdict: 'skipped',
        detail: key === 'lip' && !hasLipDialogue ? '本镜没有画内说话人，不需要口型对照' : '视觉模型没有返回该项结论',
      })
    }
    checks = CHECK_ORDER
      .map(key => checks.find(check => check.key === key))
      .filter((check): check is AcceptanceCheck => Boolean(check))
    if (checks.some(check => check.verdict === 'fail')) verdict = 'fail'
    else if (issues.some(issue => issue.severity === 'error')) verdict = 'fail'
    else if ((issues.some(issue => issue.severity === 'warning') || checks.some(check => check.verdict === 'warn')) && verdict === 'pass') verdict = 'warn'
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

const acceptanceTimers = new Map<number, NodeJS.Timeout>()

/** 视频落盘后自动跑一次抽帧/音频验收；再次落盘会重置计时，只验收最新视频。 */
export function queueAcceptance(storyboardId: number, opts: { configId?: number; model?: string } = {}): void {
  if (process.env.DISABLE_AUTO_ACCEPTANCE === '1') return
  if (!storyboardId) return
  const existing = acceptanceTimers.get(storyboardId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    acceptanceTimers.delete(storyboardId)
    void runAcceptance(storyboardId, opts)
      .catch(error => {
        logTaskWarn('Acceptance', 'auto-run-failed', {
          storyboardId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }, 1500)
  timer.unref?.()
  acceptanceTimers.set(storyboardId, timer)
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
