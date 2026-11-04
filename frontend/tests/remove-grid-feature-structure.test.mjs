import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const appRoot = new URL('../app/', import.meta.url)
const readApp = (path) => readFileSync(new URL(path, appRoot), 'utf8')

const dramaPage = readApp('views/drama/detail.vue')
const settingsPage = readApp('pages/settings.vue')
const useApi = readApp('composables/useApi.ts')

/**
 * 宫格图能力边界（V2）
 *
 * V1 移除了旧宫格实现（grid-split + 分镜工具里的宫格提示词模式）。
 * V2 以「grid-image 服务 + 独立 grid-prompt 技能」重新引入，
 * 但旧的分镜内宫格工具与历史 UI 不得回归。
 */
test('frontend API client exposes V2 grid endpoints without legacy grid prompt routes', () => {
  assert.match(useApi, /gridAPI/)
  assert.match(useApi, /\/grid/)
  assert.match(useApi, /\/split/)

  assert.doesNotMatch(useApi, /\/grid\/prompt/)
  assert.doesNotMatch(useApi, /\/grid\/generate/)
  assert.doesNotMatch(useApi, /\/grid\/status/)
})

test('asset library exposes the V2 grid sheet dialog without the legacy grid tool', () => {
  assert.match(dramaPage, /GridSheetDialog/)
  assert.match(dramaPage, /grid\.entry/)
  assert.match(dramaPage, /openGrid/)

  assert.doesNotMatch(dramaPage, /openGridTool/)
  assert.doesNotMatch(dramaPage, /generateGridPrompt/)
  assert.doesNotMatch(dramaPage, /startGridGen/)
  assert.doesNotMatch(dramaPage, /doGridSplit/)
  assert.doesNotMatch(dramaPage, /latest-grid-strip/)
  assert.doesNotMatch(dramaPage, /grid-history/)
})

test('settings image prompt agent copy only describes role and scene prompts', () => {
  assert.match(settingsPage, /prompt_generator/)
  assert.doesNotMatch(settingsPage, /宫格图/)
  assert.doesNotMatch(settingsPage, /read_shots_for_grid/)
  assert.doesNotMatch(settingsPage, /generate_grid_prompt/)
  assert.doesNotMatch(settingsPage, /grid_prompt（/)
  assert.doesNotMatch(settingsPage, /cell_prompts/)
})