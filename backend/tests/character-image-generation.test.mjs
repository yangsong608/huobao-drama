import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('character image generation uses 16:9 face close-up plus headless turnaround', () => {
  const source = read('src/routes/characters.ts')
  const helper = read('src/services/character-sheet-prompt.ts')

  assert.match(source, /CHARACTER_IMAGE_SIZE = '1920x1080'/)
  assert.match(source, /ensureCharacterSheetGuard/)
  assert.match(helper, /16:9 横版角色设定参考图/)
  assert.match(helper, /三张等高无头全身视图/)
  assert.match(helper, /只显示颈部以下/)
  assert.match(helper, /不出现头部、人脸或头发/)
  assert.doesNotMatch(helper, /半身角色海报构图/)
  assert.match(source, /size: CHARACTER_IMAGE_SIZE/)
})
