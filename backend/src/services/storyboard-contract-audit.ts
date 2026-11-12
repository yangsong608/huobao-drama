/**
 * 合同成对校验：用镜头合同字段做确定性检查，作为 AI 成对判定的补充。
 * 只检查有合同数据的相邻两镜；旧数据（contract_version=0）不误报。
 */
import type { AuditIssueDraft } from './storyboard-audit-rules.js'
import type { AuditContextShot } from './storyboard-audit-context.js'
import { listCoveragePlans } from './scene-planning.js'

type PairShot = Pick<
  AuditContextShot,
  | 'id'
  | 'storyboardNumber'
  | 'sceneId'
  | 'coverageType'
  | 'axisSide'
  | 'screenLeft'
  | 'screenRight'
  | 'foregroundShoulder'
  | 'castOnScreen'
  | 'backgroundLandmarks'
  | 'sceneGeographyId'
  | 'contractVersion'
> & Partial<Pick<AuditContextShot, 'transition' | 'actionStart' | 'actionEnd'>>

function normalizeName(value: string) {
  return value.trim().replace(/^@+/, '').replace(/\s+/g, '')
}

function pairIssue(
  from: PairShot,
  to: PairShot,
  code: string,
  severity: 'error' | 'warning',
  message: string,
  evidence: string,
  suggestion: string,
): AuditIssueDraft {
  return {
    check: 2,
    source: 'rule',
    severity,
    code,
    storyboardId: to.id,
    storyboardNumber: to.storyboardNumber,
    relatedStoryboardIds: [from.id],
    message,
    evidence,
    suggestion,
    repairable: false,
    status: 'open',
  }
}

/** 相邻两镜的确定性合同检查；没有合同的旧数据直接跳过。 */
export function evaluateContractPairIssues(from: PairShot, to: PairShot): AuditIssueDraft[] {
  const issues: AuditIssueDraft[] = []
  const fromHasContract = (from.contractVersion || 0) > 0
  const toHasContract = (to.contractVersion || 0) > 0
  if (!fromHasContract && !toHasContract) return issues

  const leftA = new Set(from.screenLeft.map(normalizeName).filter(Boolean))
  const rightA = new Set(from.screenRight.map(normalizeName).filter(Boolean))
  const leftB = new Set(to.screenLeft.map(normalizeName).filter(Boolean))
  const rightB = new Set(to.screenRight.map(normalizeName).filter(Boolean))

  const sameScene = from.sceneId != null && from.sceneId === to.sceneId
  const leftToRight = sameScene ? [...leftA].filter(name => rightB.has(name)) : []
  const rightToLeft = sameScene ? [...rightA].filter(name => leftB.has(name)) : []
  if (leftToRight.length || rightToLeft.length) {
    const swapped = [...new Set([...leftToRight, ...rightToLeft])]
    issues.push(pairIssue(
      from,
      to,
      'screen_direction_flip',
      'error',
      `第 ${from.storyboardNumber} 镜到第 ${to.storyboardNumber} 镜屏幕左右翻转。`,
      `上一镜：左 ${from.screenLeft.join('、') || '未填'} / 右 ${from.screenRight.join('、') || '未填'}；下一镜：左 ${to.screenLeft.join('、') || '未填'} / 右 ${to.screenRight.join('、') || '未填'}；翻转人物：${swapped.join('、')}`,
      '保持同一轴线：人物在画面左/右不换边；需要换边时先插中性镜头（建立/插入/人物走动）过渡。',
    ))
  }

  const fromLandmarks = new Map(from.backgroundLandmarks.map(item => [normalizeName(item.name), item.side]))
  const toLandmarks = new Map(to.backgroundLandmarks.map(item => [normalizeName(item.name), item.side]))
  const mirroredLandmarks: string[] = []
  if (sameScene) {
    for (const [name, side] of fromLandmarks) {
      const nextSide = toLandmarks.get(name)
      if (!nextSide) continue
      if ((side === 'left' && nextSide === 'right') || (side === 'right' && nextSide === 'left')) {
        mirroredLandmarks.push(`${name}：${side} → ${nextSide}`)
      }
    }
  }
  if (mirroredLandmarks.length) {
    issues.push(pairIssue(
      from,
      to,
      'set_mirror',
      'error',
      `第 ${from.storyboardNumber} 镜到第 ${to.storyboardNumber} 镜背景地标左右翻面。`,
      `地标翻面：${mirroredLandmarks.join('；')}`,
      '反打保持同一面墙：窗/门/桌的屏幕侧不换边；需要换边时先确认场景地理卡或插中性镜头。',
    ))
  }

  if (sameScene && from.axisSide && to.axisSide && from.axisSide !== to.axisSide) {
    issues.push(pairIssue(
      from,
      to,
      'axis_cross',
      'error',
      `第 ${from.storyboardNumber} 镜到第 ${to.storyboardNumber} 镜轴线侧从 ${from.axisSide} 换到 ${to.axisSide}。`,
      `上一镜轴线=${from.axisSide}；下一镜轴线=${to.axisSide}`,
      '同一场戏保持同一轴线侧；确需越轴时用中性镜头过渡。',
    ))
  }

  if (
    from.sceneId != null
    && from.sceneId === to.sceneId
    && from.sceneGeographyId != null
    && to.sceneGeographyId != null
    && from.sceneGeographyId !== to.sceneGeographyId
  ) {
    issues.push(pairIssue(
      from,
      to,
      'scene_geography_mismatch',
      'warning',
      `同一场景的相邻两镜绑定了不同版本/不同布局的场景地理卡。`,
      `上一镜 geography=${from.sceneGeographyId}；下一镜 geography=${to.sceneGeographyId}`,
      '同一场戏只使用一张 canonical 场景地理卡；确认后重新同步合同。',
    ))
  }

  const fromCast = new Set(from.castOnScreen)
  const toCast = new Set(to.castOnScreen)
  const sharedCast = [...fromCast].filter(id => toCast.has(id))
  const stableCoverage = new Set(['two_shot', 'master', 'action'])
  if (
    from.castOnScreen.length
    && to.castOnScreen.length
    && from.sceneId != null
    && from.sceneId === to.sceneId
    && !stableCoverage.has(String(from.coverageType || ''))
    && stableCoverage.has(String(to.coverageType || ''))
    && sharedCast.length === 0
  ) {
    issues.push(pairIssue(
      from,
      to,
      'cast_presence_break',
      'warning',
      `第 ${from.storyboardNumber} 镜到第 ${to.storyboardNumber} 镜主要画内人物完全换人，缺少过渡。`,
      `上一镜画内=${from.castOnScreen.join('、')}；下一镜画内=${to.castOnScreen.join('、')}`,
      '补一个人物过渡镜头（转身/走动/空椅）或把新人物写进上一镜的尾段。',
    ))
  }

  const actionStart = String(to.actionStart || '').trim()
  const actionEnd = String(from.actionEnd || '').trim()
  const directCut = !['fade', 'dissolve', 'wipe'].includes(String(to.transition || 'cut').toLowerCase())
  if (
    from.sceneId != null
    && from.sceneId === to.sceneId
    && directCut
    && Boolean(actionStart || actionEnd)
    && !(actionStart && actionEnd)
  ) {
    issues.push(pairIssue(
      from,
      to,
      'action_match_missing',
      'warning',
      `第 ${from.storyboardNumber} 镜到第 ${to.storyboardNumber} 镜是同场直接切换，但动作端点没有配对。`,
      `上一镜动作终点=${actionEnd || '未填'}；下一镜动作起点=${actionStart || '未填'}`,
      '在同场连续动作的两镜都写「动作起点/动作终点」（写在画面调度里），保证尾动作接得上。',
    ))
  }

  if (String(to.coverageType || '') === 'ots' && !to.foregroundShoulder) {
    issues.push(pairIssue(
      from,
      to,
      'foreground_shoulder_missing',
      'warning',
      `第 ${to.storyboardNumber} 镜是过肩镜头，但没有写前景肩。`,
      `覆盖类型=ots；前景肩=未填`,
      '补“过谁的肩/哪一侧肩”，保证反打前景和上一镜接得上。',
    ))
  }

  return issues
}

const GAP_LABELS: Record<string, string> = {
  missing_establishing: '缺建立镜头',
  missing_two_shot: '缺双人/关系镜头',
  missing_reaction: '缺反应镜头',
  missing_insert: '缺插入镜头',
}

/** 场景覆盖计划的缺口，挂在该场第一个真实分镜上，作为 warning。 */
export async function evaluateCoverageGapIssues(
  episodeId: number,
  shots: Array<Pick<AuditContextShot, 'id' | 'storyboardNumber' | 'sceneId'>>,
): Promise<AuditIssueDraft[]> {
  const plans = await listCoveragePlans(episodeId)
  const latestByScene = new Map<number, (typeof plans)[number]>()
  for (const plan of plans) {
    if (!plan.scene_id) continue
    const current = latestByScene.get(plan.scene_id)
    if (!current || Number(plan.version) >= Number(current.version)) latestByScene.set(plan.scene_id, plan)
  }
  const issues: AuditIssueDraft[] = []
  for (const [sceneId, plan] of latestByScene) {
    const gaps = Array.isArray((plan.summary as any)?.gaps) ? (plan.summary as any).gaps as string[] : []
    if (!gaps.length) continue
    const sceneShots = shots.filter(shot => shot.sceneId === sceneId).sort((a, b) => a.storyboardNumber - b.storyboardNumber)
    if (!sceneShots.length) continue
    const first = sceneShots[0]
    issues.push({
      check: 2,
      source: 'rule',
      severity: 'warning',
      code: 'coverage_gap',
      storyboardId: first.id,
      storyboardNumber: first.storyboardNumber,
      relatedStoryboardIds: sceneShots.slice(1).map(shot => shot.id),
      message: `场景覆盖计划有缺口：${gaps.map(gap => GAP_LABELS[gap] || gap).join('、')}。`,
      evidence: `覆盖计划 v${plan.version}；缺口=${gaps.join('、')}`,
      suggestion: '在覆盖板补建立/双人/反应/插入镜头，再重新生成覆盖计划。',
      repairable: false,
      status: 'open',
    })
  }
  return issues
}
