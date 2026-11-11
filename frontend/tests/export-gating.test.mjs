/**
 * A5 应用模式导出/合片门控：本机应用（无 FFmpeg）下入口禁用并提示「暂未开放」，
 * 经电脑接力的访客保持可用。只读源码结构测试：不执行组件、不启动 Nuxt。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const APP_ROOT = new URL('../app/', import.meta.url)

function readSource(relativePath) {
  try {
    return readFileSync(new URL(relativePath, APP_ROOT), 'utf8')
  } catch (error) {
    assert.fail(`无法读取 app/${relativePath}：${error.message}`)
  }
}

function withoutComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const capability = readSource('composables/useExportCapability.ts')
const notice = readSource('components/ExportUnavailableNotice.vue')
const mediaNotice = readSource('components/MediaCapabilityNotice.vue')
const episode = withoutComments(readSource('views/drama/episode.vue'))
const exportStage = withoutComments(readSource('components/ExportStage.vue'))
const mixDialog = withoutComments(readSource('components/MixExportDialog.vue'))
const editDialog = withoutComments(readSource('components/edit/EditExportDialog.vue'))
const LOCALES = ['zh', 'en', 'ja', 'ko'].map((locale) => ({
  locale,
  data: JSON.parse(readSource(`locales/${locale}.json`)),
}))

test('导出能力读取服务端媒体能力，不再按设备类型判断', () => {
  assert.match(capability, /import \{ useMediaCapabilities \} from '\.\/useMediaCapabilities'/, '必须复用媒体能力状态')
  assert.match(capability, /localOnly: computed\(\(\) => !caps\.outputReady\.value\)/, '缺少媒体能力即禁用导出')
})

test('「暂未开放」提示含原因与连接电脑入口', () => {
  assert.match(notice, /<MediaCapabilityNotice action="output" \/>/, '导出提示必须复用统一能力提示')
  assert.match(mediaNotice, /media\.capability\.unavailableTitle/, '缺少标题文案')
  assert.match(mediaNotice, /media\.capability\.unavailableBody/, '缺少原因说明')
  assert.match(mediaNotice, /t\('export\.gate\.connect'\)/, '缺少连接电脑入口文案')
  assert.match(mediaNotice, /const connectTarget = \{ path: '\/settings', query: \{ tab: 'device' \} \}/, '入口必须落到设置「本机与连接」')
  assert.match(mediaNotice, /@media \(max-width: 1180px\) \{[\s\S]*?min-height: 44px;/, '触屏下连接入口至少 44px 命中区')
})

test('分集页合片入口与应用模式门控联动', () => {
  assert.match(episode, /import ExportUnavailableNotice from '~\/components\/ExportUnavailableNotice\.vue'/, '缺少提示组件')
  assert.match(episode, /const \{ localOnly: exportLocalOnly \} = useExportCapability\(\)/, '缺少能力状态')
  assert.match(episode, /<ExportUnavailableNotice v-if="exportLocalOnly" \/>/, '导出面板必须显示门控提示')
  const mergeButtons = episode.match(/:disabled="!exportSelectedReadyIds\.length \|\| exportLocalOnly"/g) || []
  assert.equal(mergeButtons.length, 2, '顶部与平板粘性栏的合片按钮都要禁用')
  assert.match(
    episode,
    /:disabled="!mergeDialog\.ids\.length \|\| remoteReadonly \|\| exportLocalOnly"/,
    '合片确认按钮必须禁用',
  )
  assert.match(
    episode,
    /function openMergeDialog\(\) \{\s*if \(exportLocalOnly\.value\) \{\s*toast\.info\(t\('export\.gate\.hint'\)\)/,
    '打开合片弹窗需要二次守卫',
  )
  assert.match(
    episode,
    /async function doMerge\(ids, title, useAiTransitions = false\) \{\s*if \(exportLocalOnly\.value\)/,
    '发起合片请求前必须再次门控',
  )
})

test('配音导出阶段禁用导出与重试', () => {
  assert.match(exportStage, /import ExportUnavailableNotice from '~\/components\/ExportUnavailableNotice\.vue'/, '缺少提示组件')
  assert.match(exportStage, /const \{ localOnly: exportLocalOnly \} = useExportCapability\(\)/, '缺少能力状态')
  assert.match(exportStage, /<ExportUnavailableNotice v-if="exportLocalOnly" \/>/, '必须显示门控提示')
  for (const kind of ['mix', 'video', 'stems']) {
    assert.match(
      exportStage,
      new RegExp(`:disabled="exportLocalOnly \\|\\| !canStart \\|\\| !checks\\?\\.${kind === 'mix' ? 'mixReady' : kind === 'video' ? 'videoReady' : 'stemsReady'}`),
      `${kind} 导出按钮必须禁用`,
    )
  }
  assert.match(exportStage, /function start\(kind: ExportKind,[\s\S]*?if \(exportLocalOnly\.value\) \{/, 'start 必须门控')
  assert.match(exportStage, /function retry\(id: number\) \{\s*if \(exportLocalOnly\.value\)/, '重试必须门控')
})

test('混音导出弹窗与剪辑导出弹窗禁用开始按钮', () => {
  assert.match(mixDialog, /<ExportUnavailableNotice v-if="exportLocalOnly" \/>/, '混音导出缺少门控提示')
  assert.match(mixDialog, /:disabled="Boolean\(active\) \|\| exportLocalOnly"/, '混音导出开始按钮必须禁用')
  assert.match(mixDialog, /function start\(\) \{\s*if \(exportLocalOnly\.value\) \{/, '混音导出 emit 前必须门控')

  assert.match(editDialog, /<ExportUnavailableNotice v-if="exportLocalOnly" \/>/, '剪辑导出缺少门控提示')
  assert.match(editDialog, /:disabled="busy \|\| !canEdit \|\| !warningsAcked \|\| exportLocalOnly"/, '剪辑导出开始按钮必须禁用')
  assert.match(editDialog, /function startExport\(\) \{[\s\S]*?if \(exportLocalOnly\.value\) \{/, '剪辑渲染请求前必须门控')
})

test('四语言同步导出暂未开放文案', () => {
  for (const { locale, data } of LOCALES) {
    const gate = data.export?.gate
    assert.ok(gate, `${locale} 缺少 export.gate`)
    for (const key of ['title', 'hint', 'connect', 'unavailable']) {
      assert.equal(typeof gate[key], 'string', `${locale} 缺少 export.gate.${key}`)
      assert.ok(gate[key].trim().length > 0, `${locale} export.gate.${key} 不能为空`)
    }
  }
  assert.match(LOCALES[0].data.export.gate.title, /暂未开放/, '中文标题必须出现「暂未开放」')
  assert.match(LOCALES[0].data.export.gate.unavailable, /暂未开放/, '中文按钮提示必须出现「暂未开放」')
})
