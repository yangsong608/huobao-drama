import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const episode = fs.readFileSync(path.join(root, 'app/views/drama/episode.vue'), 'utf8')
const api = fs.readFileSync(path.join(root, 'app/composables/useApi.ts'), 'utf8')
const LOCALES = ['zh', 'en', 'ja', 'ko'].map(locale => ({
  locale,
  data: JSON.parse(fs.readFileSync(path.join(root, `app/locales/${locale}.json`), 'utf8')),
}))

test('视频检查器提供生成前预检与生成后验收入口', () => {
  assert.match(episode, /class="video-inspector-section visual-check-section"/)
  assert.match(episode, /@click="runShotPreflight\(selectedSb\)"/)
  assert.match(episode, /@click="runShotAcceptance\(selectedSb\)"/)
  assert.match(episode, /storyboardAPI\.runPreflight\(sb\.id\)/)
  assert.match(episode, /storyboardAPI\.runAcceptance\(sb\.id\)/)
  assert.match(episode, /acceptanceReport\.evidence/)
  assert.match(episode, /visual-verdict/)
})

test('预检/验收 API 走分镜子资源，不在页面里拼裸路径', () => {
  assert.match(api, /preflight: \(id: number\) => api\.get\(`\/storyboards\/\$\{id\}\/preflight`\)/)
  assert.match(api, /runPreflight: \(id: number, data: any = \{\}\) => api\.post\(`\/storyboards\/\$\{id\}\/preflight`, data\)/)
  assert.match(api, /acceptance: \(id: number\) => api\.get\(`\/storyboards\/\$\{id\}\/acceptance`\)/)
  assert.match(api, /runAcceptance: \(id: number, data: any = \{\}\) => api\.post\(`\/storyboards\/\$\{id\}\/acceptance`, data\)/)
})

test('四语言补齐视觉预检/验收文案', () => {
  const keys = ['title', 'hint', 'runPreflight', 'runAcceptance', 'preflightResult', 'acceptanceResult', 'verdictPass', 'verdictWarn', 'verdictBlock', 'verdictFail', 'verdictSkipped', 'preflightDone', 'acceptanceDone']
  for (const { locale, data } of LOCALES) {
    const copy = data.episode?.visualCheck
    assert.ok(copy, `${locale} episode.visualCheck`)
    for (const key of keys) {
      assert.equal(typeof copy[key], 'string', `${locale} episode.visualCheck.${key}`)
      assert.ok(copy[key].length > 0, `${locale} episode.visualCheck.${key} 为空`)
    }
  }
})
