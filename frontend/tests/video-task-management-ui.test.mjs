import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(path.join(root, rel), 'utf8')
const episode = read('app/views/drama/episode.vue')

test('视频制作页加载拆分方案并同步当前剧集选择', () => {
  assert.match(episode, /import \{[^}]*breakdownMethodAPI[^}]*\} from '~\/composables\/useApi'/)
  assert.match(episode, /breakdownMethodAPI\.list\(\)/)
  assert.match(episode, /breakdownMethodsLoaded/)
  assert.match(episode, /function syncBreakdownMethodKey/)
  assert.match(episode, /episode\.value = ep[\s\S]{0,400}syncBreakdownMethodKey\(\)/)
})

test('顶部栏拆分方式下拉随运行/保存禁用并可保存到剧集', () => {
  assert.match(episode, /t\('episode\.sb\.methodLabel'\)/)
  assert.match(episode, /:value="breakdownMethodKey"/)
  assert.match(episode, /:disabled="rn \|\| methodSaving"/)
  assert.match(episode, /@change="changeBreakdownMethod"/)
  assert.match(episode, /breakdown_method: nextKey/)
  assert.match(episode, /t\('episode\.sb\.methodSaved'\)/)
  assert.match(episode, /episode\.sb\.methodSaveFailed/)
})

test('重新拆分与空态提示使用当前方案名', () => {
  assert.match(episode, /window\.confirm\(t\('episode\.sb\.rebreakConfirm'/)
  assert.match(episode, /t\('episode\.sb\.methodCurrent'/)
  assert.match(episode, /:title="currentBreakdownMethodName"/)
})

test('视频任务列表提供新增镜头并继承源镜头绑定', () => {
  assert.match(episode, /t\('episode\.vid\.addShot'\)/)
  assert.match(episode, /t\('episode\.vid\.addShotHint'\)/)
  assert.match(episode, /async function addStoryboard/)
  assert.match(episode, /storyboardAPI\.create\(/)
  assert.match(episode, /Math\.max\(2, Math\.min\(10, videoDurationMax\.value \|\| 10\)\)/)
  assert.match(episode, /ref="sbDescriptionInput"/)
  assert.match(episode, /sbDescriptionInput\.value\?\.focus/)
  assert.match(episode, /videoSelectMode\.value = false/)
  assert.ok(!/storyboardAPI\.create\(\{[\s\S]{0,800}storyboard_number/.test(episode), '新增镜头不传分镜号，由后端自动编号')
})

test('视频任务行提供删除入口与确认弹窗', () => {
  assert.match(episode, /t\('episode\.vid\.deleteShot'\)/)
  assert.match(episode, /:aria-label="t\('episode\.vid\.deleteShot'\)"/)
  assert.match(episode, /function deleteStoryboard/)
  assert.match(episode, /async function confirmDeleteStoryboard/)
  assert.match(episode, /storyboardAPI\.del\(/)
  assert.match(episode, /shotDelete\.value\.nextId/)
  assert.match(episode, /:open="shotDelete\.open"/)
  assert.match(episode, /class="btn btn-icon btn-sm video-task-delete"/)
  assert.match(episode, /@click\.stop="deleteStoryboard/)
  assert.match(episode, /episode\.vid\.deleteDone/)
})

test('四语言包含删除镜头文案', () => {
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`app/locales/${locale}.json`))
    const vid = json.episode.vid
    for (const key of ['deleteShot', 'deleteTitle', 'deleteMessage', 'deleteConfirm', 'deleteDone', 'deleteFailed']) {
      assert.equal(typeof vid[key], 'string', `${locale}.episode.vid.${key}`)
      assert.ok(vid[key].length > 0, `${locale}.episode.vid.${key}`)
    }
  }
})

test('四语言包含新增镜头文案', () => {
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`app/locales/${locale}.json`))
    const vid = json.episode.vid
    for (const key of ['addShot', 'addShotHint', 'newShotTitle']) {
      assert.equal(typeof vid[key], 'string', `${locale}.episode.vid.${key}`)
      assert.ok(vid[key].length > 0, `${locale}.episode.vid.${key}`)
    }
  }
})

test('四语言包含拆分方式选择文案', () => {
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`app/locales/${locale}.json`))
    const sb = json.episode.sb
    for (const key of ['methodLabel', 'methodStandard', 'methodCurrent', 'methodSaved', 'methodSaveFailed', 'methodLoadFailed', 'rebreakConfirm']) {
      assert.equal(typeof sb[key], 'string', `${locale}.episode.sb.${key}`)
      assert.ok(sb[key].length > 0, `${locale}.episode.sb.${key}`)
    }
  }
})
