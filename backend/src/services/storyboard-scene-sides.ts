/**
 * 场景左右归一
 *
 * 模型经常在反打/换景别时把同一场戏的人物左右写反。审核可以报错，但让模型反复重试
 * 会拖垮整块拆分。这里在保存前用同场第一镜建立左右表，后续镜头按表自动纠正屏幕左右，
 * 再交给保存校验；只改写画面左/右两个子句，不改时间帧文字。
 */
import { parseContractFromPrompt, type ContractCharacter, type ParsedContract } from './storyboard-contract.js'

export interface SceneSidePlan {
  left: Set<string>
  right: Set<string>
  /** 同场固定的背景地标子句；undefined 表示尚未建立 */
  landmarks?: string
}

export interface NormalizeResult {
  prompt: string
  swapped: boolean
  parsed: ParsedContract
}

const SIDE_PATTERNS = {
  left: /(画面左|Screen\s*left|화면\s*왼쪽)\s*[：:]\s*([^；;\n]*)/i,
  right: /(画面右|Screen\s*right|화면\s*오른쪽)\s*[：:]\s*([^；;\n]*)/i,
}

const LANDMARK_RE = /(背景地标|Background\s*landmarks?|背景地標|배경\s*지표)\s*[：:]\s*([^；;\n]*)/i

function extractLandmarks(prompt: string): string | null {
  const match = LANDMARK_RE.exec(prompt)
  return match ? match[2].trim() : null
}

function replaceLandmarks(prompt: string, value: string): string {
  return prompt.replace(LANDMARK_RE, (match, label: string) => `${label}：${value}`)
}

function swapScreenSides(prompt: string): string {
  const left = SIDE_PATTERNS.left.exec(prompt)
  const right = SIDE_PATTERNS.right.exec(prompt)
  if (!left || !right) return prompt
  return prompt
    .replace(SIDE_PATTERNS.left, `${left[1]}：${right[2]}`)
    .replace(SIDE_PATTERNS.right, `${right[1]}：${left[2]}`)
}

function addPlan(plan: SceneSidePlan, parsed: ParsedContract) {
  const left = new Set(parsed.screenLeft)
  const right = new Set(parsed.screenRight)
  for (const name of left) {
    if (!plan.right.has(name) && !plan.left.has(name)) plan.left.add(name)
  }
  for (const name of right) {
    if (!plan.left.has(name) && !plan.right.has(name)) plan.right.add(name)
  }
}

function conflicts(plan: SceneSidePlan, parsed: ParsedContract): boolean {
  for (const name of parsed.screenLeft) {
    if (plan.right.has(name)) return true
  }
  for (const name of parsed.screenRight) {
    if (plan.left.has(name)) return true
  }
  return false
}

/** 按场景计划纠正一个提示词；plan 会被本镜新出现的人物补全 */
export function normalizeSceneSides(
  prompt: string,
  plan: SceneSidePlan | null,
  characters: ContractCharacter[],
): NormalizeResult {
  let current = prompt
  let parsed = parseContractFromPrompt(current, characters)
  let swapped = false
  if (plan && conflicts(plan, parsed)) {
    const next = swapScreenSides(current)
    if (next !== current) {
      current = next
      parsed = parseContractFromPrompt(current, characters)
      swapped = true
    }
  }
  if (plan) {
    const landmarks = extractLandmarks(current)
    if (plan.landmarks === undefined) {
      if (landmarks !== null) plan.landmarks = landmarks
    } else if (landmarks !== null && landmarks !== plan.landmarks) {
      current = replaceLandmarks(current, plan.landmarks)
      parsed = parseContractFromPrompt(current, characters)
      swapped = true
    }
    addPlan(plan, parsed)
  }
  return { prompt: current, swapped, parsed }
}

export function createSceneSidePlan(previous?: ParsedContract | null, prompt?: string): SceneSidePlan {
  const plan: SceneSidePlan = { left: new Set(), right: new Set() }
  if (previous) addPlan(plan, previous)
  if (prompt) {
    const landmarks = extractLandmarks(prompt)
    if (landmarks !== null) plan.landmarks = landmarks
  }
  return plan
}
