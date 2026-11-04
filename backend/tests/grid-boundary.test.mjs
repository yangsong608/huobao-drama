import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const exists = (path) => existsSync(new URL(path, root))

/**
 * 宫格图能力边界
 *
 * V1 移除了旧宫格实现（grid-split + 分镜工具里的宫格提示词模式）。
 * V2 以「grid-image 服务 + 独立 grid-prompt 技能」重新引入，
 * 旧实现仍不得回归。
 */
test('backend keeps the legacy grid split service removed and mounts the V2 grid route when present', () => {
  const index = read('src/index.ts')

  assert.equal(exists('src/services/grid-split.ts'), false)
  assert.doesNotMatch(index, /routes\/grid-split/)

  // V2 能力（M4-2）：文件存在就必须挂载，避免路由 404
  if (exists('src/routes/grid.ts')) {
    assert.match(index, /routes\/grid/)
  }
  if (exists('src/services/grid-image.ts')) {
    assert.doesNotMatch(read('src/services/grid-image.ts'), /grid-split/)
  }
})

test('image prompt tools keep role and scene modes without the old grid prompt mode', () => {
  const agents = read('src/agents/index.ts')
  const skills = read('src/agents/skills.ts')
  const imagePromptTools = read('src/agents/tools/image-prompt-tools.ts')
  const storyboardTools = read('src/agents/tools/storyboard-tools.ts')
  const skill = read('workspace/skills/prompt-generator/prop-prompt/SKILL.md')

  assert.match(agents, /prompt_generator/)
  assert.match(skills, /prompt_generator/)
  assert.match(imagePromptTools, /save_character_final_prompt/)
  assert.match(imagePromptTools, /save_scene_final_prompt/)

  // 旧的分镜内宫格提示词工具不得回归；V2 的宫格走独立技能与服务
  assert.doesNotMatch(imagePromptTools, /read_shots_for_grid/)
  assert.doesNotMatch(imagePromptTools, /generate_grid_prompt/)
  assert.doesNotMatch(storyboardTools, /generate_grid_prompt/)
  assert.doesNotMatch(skill, /宫格图/)
  assert.doesNotMatch(skill, /grid layout/)
})
