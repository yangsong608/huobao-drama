/** V2 计划导出视图：Markdown 只是数据库计划的只读投影。 */
import type { V2Plan, V2Shot } from './storyboard-v2.js'

const COVERAGE_LABELS: Record<string, string> = {
  establishing: '建立',
  master: 'Master',
  over_shoulder: '过肩',
  reverse: '反打',
  reaction: '反应',
  insert: '插入',
}

const CUT_LABELS: Record<string, string> = {
  scene_open: '场景开场',
  scene_change: '场景变化',
  new_beat: '新节拍',
  listener_reaction: '听者反应',
  coverage_change: '覆盖变化',
  action_change: '动作主体变化',
  duration_limit: '容量上限',
}

const SIZE_LABELS: Record<string, string> = {
  wide: '全景',
  medium: '中景',
  medium_close: '中近景',
  close_up: '近景',
}

const ANGLE_LABELS: Record<string, string> = {
  eye_level: '平视',
  high_angle: '俯拍',
  low_angle: '仰拍',
  over_shoulder: '过肩',
}

function spatial(shot: V2Shot): string {
  const parts = [
    shot.screenLeft ? `左：${shot.screenLeft}` : '',
    shot.screenRight ? `右：${shot.screenRight}` : '',
    shot.axisSide ? `轴线：${shot.axisSide}` : '',
    shot.landmarkSide ? `地标：${shot.landmarkSide}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join('；') : '未绑定场景空间契约'
}

function shotMarkdown(shot: V2Shot): string[] {
  const camera = shot.camera
  const cameraText = camera
    ? `${SIZE_LABELS[camera.shotSize] || camera.shotSize} / ${ANGLE_LABELS[camera.angle] || camera.angle} / ${camera.movement}`
    : '未定义'
  const lines = [
    `### ${shot.shotId} · ${COVERAGE_LABELS[shot.coverage] || shot.coverage} · ${shot.duration}s`,
    '',
    `- 场景：${shot.sceneLabel}${shot.location ? ` · ${shot.location}` : ''}${shot.time ? ` · ${shot.time}` : ''}`,
    `- 切镜理由：${CUT_LABELS[shot.cutReason] || shot.cutReason}${shot.cutDetail ? `（${shot.cutDetail}）` : ''}`,
    `- 时长来源：${shot.durationSource}`,
    `- 机位：${cameraText}`,
    `- 空间：${spatial(shot)}`,
  ]
  if (shot.lines.length) {
    lines.push('', '**台词**')
    for (const line of shot.lines) {
      lines.push(`- ${line.speaker}（${line.estimatedSeconds.toFixed(2)}s）：${line.text}`)
    }
  }
  if (shot.actions.length) {
    lines.push('', shot.actions.some(action => action.narration) ? '**旁白**' : '**动作**')
    for (const action of shot.actions) lines.push(`- ${action.text}`)
  }
  lines.push('')
  return lines
}

export function renderV2PlanMarkdown(plan: V2Plan): string {
  const d = plan.diagnostics
  const header = [
    '# 分镜 V2 计划',
    '',
    `- 原文：${plan.sourceChars} 字`,
    `- 覆盖预设：${plan.config.coveragePresetName}（${plan.config.coveragePresetKey}）`,
    `- 节奏目标：${plan.config.rhythmTargetSeconds}s（验收参考，不是每镜配额）`,
    `- 场景 / 节拍 / 镜头：${d.sceneCount} / ${d.beatCount} / ${d.shotCount}`,
    `- 平均时长：${d.averageDuration}s`,
    `- 台词估算 / 动作估算：${d.estimatedDialogueSeconds}s / ${d.estimatedActionSeconds}s`,
    `- 结构问题：${plan.issues.length}`,
    '',
  ]
  const issues = plan.issues.length
    ? [
      '## 结构问题',
      '',
      ...plan.issues.map(issue => `- [${issue.ruleId}] ${issue.shotId || '全局'}：${issue.message}（${issue.evidence}）`),
      '',
    ]
    : ['## 结构问题', '', '无。', '']
  return [...header, ...issues, '## 镜头', '', ...plan.shots.flatMap(shotMarkdown)].join('\n')
}