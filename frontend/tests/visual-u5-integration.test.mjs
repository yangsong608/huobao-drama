import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const files = {
  episode: read('app/views/drama/episode.vue'),
  workbench: read('app/components/director/DirectorWorkbench.vue'),
  topbar: read('app/components/director/DirectorTopBar.vue'),
  tab: read('app/components/director/DirectorTab.vue'),
  shotList: read('app/components/director/DirectorShotList.vue'),
  stage2d: read('app/components/director/DirectorStage2D.vue'),
  stage3d: read('app/components/director/DirectorStage3D.vue'),
  apply: read('app/components/director/DirectorApplyDialog.vue'),
  inspector: read('app/components/director/DirectorInspector.vue'),
  dock: read('app/components/agent/AgentDock.vue'),
  proposal: read('app/components/agent/AgentProposalCard.vue'),
  suggestion: read('app/components/agent/AgentSuggestionCard.vue'),
  markdown: read('app/components/agent/AgentMarkdown.vue'),
  adapter: read('app/composables/useAgentPageAdapter.ts'),
  studio: read('app/assets/studio.css'),
  studioTopBar: read('app/components/studio/StudioTopBar.vue'),
  inspectorPanel: read('app/components/studio/StudioInspectorPanel.vue'),
}

function styleOf(source) {
  const match = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  assert.ok(match, 'missing <style> block')
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '')
}

function rulesOf(style) {
  const rules = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = pattern.exec(style))) {
    rules.push({
      selectors: match[1].split(',').map((item) => item.trim()),
      body: match[2],
    })
  }
  return rules
}

function ruleBody(style, selector) {
  const rule = rulesOf(style).find((item) => item.selectors.includes(selector))
  assert.ok(rule, `missing CSS rule: ${selector}`)
  return rule.body
}

function fontPx(body) {
  const match = body.match(/font-size:\s*([\d.]+)px/)
  return match ? Number(match[1]) : null
}

function assertNoSubEleven(style, label) {
  assert.doesNotMatch(
    style,
    /font-size:\s*(?:9|9\.5|10|10\.5)px|font:\s*[^;]*\b(?:9|9\.5|10|10\.5)px/,
    `${label}: still contains 9/10px fonts`,
  )
}

function buttonsOf(source) {
  return [...source.matchAll(/<button\b[\s\S]*?>/g)].map((item) => item[0])
}

const localeNames = ['zh', 'en', 'ja', 'ko']
const locale = (name) => JSON.parse(read(`app/locales/${name}.json`))

test('制作区页签：导演台插在视频之后，素材与视频页签保持不变', () => {
  const source = files.episode
  const start = source.indexOf('const prodTabDefs')
  const end = source.indexOf('const mainStageDefs')
  assert.ok(start > 0 && end > start, 'missing prodTabDefs block')
  const block = source.slice(start, end)
  const assets = block.indexOf("id: 'assets'")
  const videos = block.indexOf("id: 'videos'")
  const director = block.indexOf("id: 'director'")
  assert.ok(assets >= 0 && videos > assets && director > videos, 'tab order must be assets, videos, director')
  assert.match(block, /directorMode\.value !== 'off'/)
  assert.match(source, /v-if="prodTab === 'director'" class="director-pane"/)
  assert.match(source, /<DirectorTab/)
  assert.match(source, /defineAsyncComponent\(\(\) => import\('~\/components\/director\/DirectorTab\.vue'\)\)/)
})

test('导演台：三栏与底部镜头条固定，2D/3D 共用同一网格', () => {
  const source = files.workbench
  const style = styleOf(source)
  assert.match(ruleBody(style, '.director-workbench'), /grid-template-columns:\s*260px minmax\(0, 1fr\) 320px/)
  assert.match(ruleBody(style, '.director-shot-strip'), /height:\s*96px/)
  assert.match(ruleBody(style, '.director-shot-strip'), /min-height:\s*96px/)
  assert.match(style, /grid-template-columns:\s*240px minmax\(0, 1fr\) 300px/)
  assert.match(source, /v-if="props\.view === '2d'"/)
  assert.match(source, /<Suspense v-else>[\s\S]*<DirectorStage3D/)
  assert.equal((source.match(/class="director-main"/g) || []).length, 1)
  assert.doesNotMatch(files.stage2d, /grid-template-columns/)
  assert.doesNotMatch(files.stage3d, /grid-template-columns/)
})

test('导演台镜头卡：选中态为背景 + 左侧 2px 指示条 + 标题加粗，尺寸不变', () => {
  const style = styleOf(files.shotList)
  assert.match(ruleBody(style, '.director-shot-item'), /position:\s*relative/)
  const active = ruleBody(style, '.director-shot-item.active')
  assert.match(active, /background:\s*var\(--bg-active/)
  const indicator = ruleBody(style, '.director-shot-item.active::before')
  assert.match(indicator, /width:\s*2px/)
  assert.match(indicator, /background:\s*var\(--accent\)/)
  assert.match(ruleBody(style, '.director-shot-item.active .director-shot-no'), /font-weight:\s*700/)
})

test('导演台与智能体：无 9/10px 文字，正文与元信息使用令牌', () => {
  const newSurfaces = ['topbar', 'tab', 'shotList', 'stage2d', 'stage3d', 'apply', 'inspector', 'dock', 'proposal', 'suggestion', 'markdown']
  for (const name of newSurfaces) {
    assertNoSubEleven(styleOf(files[name]), name)
  }
  const markdown = styleOf(files.markdown)
  assert.match(ruleBody(markdown, '.agent-md'), /font-size:\s*var\(--text-body\)/)
  assert.match(ruleBody(markdown, '.agent-md'), /line-height:\s*var\(--leading-body\)/)
  const dock = styleOf(files.dock)
  assert.match(ruleBody(dock, '.agent-message-meta'), /var\(--text-2\)/)
  assert.equal(fontPx(ruleBody(dock, '.agent-message-meta')), 11)
  assert.equal(fontPx(ruleBody(dock, '.agent-message-model')), 11)
  const inspector = styleOf(files.inspector)
  assert.match(ruleBody(inspector, '.director-form-hint'), /var\(--text-2\)/)
  assert.equal(fontPx(ruleBody(inspector, '.director-form-hint')), 11)
  assert.match(ruleBody(styleOf(files.apply), '.director-apply-tag'), /var\(--text-2\)/)
})

test('壳组件与空态：导演台复用 StudioTopBar / InspectorPanel / EmptyState', () => {
  assert.match(files.topbar, /import StudioTopBar from '~\/components\/studio\/StudioTopBar\.vue'/)
  assert.match(files.topbar, /<StudioTopBar class="director-topbar">/)
  assert.doesNotMatch(files.topbar, /<StudioTopBar dense/)
  assert.match(styleOf(files.studioTopBar), /height:\s*var\(--topbar-h\)/)
  assert.match(files.studio, /--topbar-h:\s*44px/)
  assert.match(ruleBody(styleOf(files.inspectorPanel), '.studio-inspector-head'), /height:\s*40px/)
  assert.match(files.inspector, /import StudioInspectorPanel from '~\/components\/studio\/StudioInspectorPanel\.vue'/)
  assert.match(files.inspector, /<StudioInspectorPanel/)
  assert.match(files.inspector, /<StudioEmptyState/)
  assert.match(files.tab, /import StudioEmptyState from '~\/components\/studio\/StudioEmptyState\.vue'/)
  assert.equal((files.tab.match(/<StudioEmptyState/g) || []).length, 2)
  assert.match(files.stage2d, /<StudioEmptyState/)
  assert.match(files.stage3d, /<StudioEmptyState/)
})

test('智能体抽屉：默认 380、可在 360–520 拖动、底部留 24px 且层级低于遮罩与菜单', () => {
  assert.match(files.adapter, /DOCK_DEFAULT_WIDTH = 380/)
  assert.match(files.adapter, /DOCK_MIN_WIDTH = 360/)
  assert.match(files.adapter, /DOCK_MAX_WIDTH = 520/)
  const style = styleOf(files.dock)
  const dock = ruleBody(style, '.agent-dock')
  assert.match(dock, /min-width:\s*360px/)
  assert.match(dock, /max-width:\s*520px/)
  assert.match(dock, /bottom:\s*24px/)
  assert.match(dock, /z-index:\s*90/)
  assert.match(ruleBody(style, '.agent-dock-trigger'), /z-index:\s*80/)
  assert.match(ruleBody(style, '.agent-dock-trigger'), /transform var\(--motion-fast\) var\(--ease-out\)/)
  assert.match(files.dock, /ref="triggerEl"/)
  assert.match(files.dock, /ref="dockEl"/)
  assert.match(files.dock, /@click="openDockFromTrigger"/)
  assert.match(files.dock, /restoreFocusEl\?\.isConnected[\s\S]{0,80}restoreFocusEl\.focus\(\)/)
  assert.match(files.dock, /triggerEl\.value\?\.focus\(\)/)
  assert.match(files.dock, /inputEl\.value\?\.focus\(\)/)
  assert.match(files.dock, /<option value="director">/)
  assert.match(files.dock, /<option value="assistant">/)
  assert.match(files.studio, /--z-menu:\s*1000/)
  assert.match(files.studio, /\.overlay\s*\{[\s\S]*?z-index:\s*100/)
  assert.match(ruleBody(styleOf(files.apply), '.director-apply-mask'), /z-index:\s*100/)
  assert.match(ruleBody(styleOf(files.tab), '.director-revisions-mask'), /z-index:\s*100/)
})

test('焦点与可访问名称：新页面焦点环、图标按钮 title/aria、提案 36px 操作', () => {
  for (const name of ['topbar', 'tab', 'shotList', 'stage2d', 'stage3d', 'apply', 'inspector', 'dock', 'proposal', 'suggestion']) {
    assert.match(styleOf(files[name]), /var\(--focus-ring\)/, `${name}: missing focus ring`)
  }
  const dockButtons = buttonsOf(files.dock).filter((tag) => tag.includes('btn-icon'))
  assert.ok(dockButtons.length >= 3, 'expected dock icon buttons')
  for (const tag of dockButtons) {
    assert.match(tag, /:title=/, `dock icon button missing title: ${tag}`)
    assert.match(tag, /:aria-label=/, `dock icon button missing aria-label: ${tag}`)
  }
  for (const [name, source] of [['apply', files.apply], ['tab', files.tab], ['stage2d', files.stage2d]]) {
    const iconButtons = buttonsOf(source).filter((tag) => tag.includes('director-icon-btn') || tag.includes('director-apply-close'))
    assert.ok(iconButtons.length >= 1, `${name}: expected icon buttons`)
    for (const tag of iconButtons) {
      assert.match(tag, /:title=/, `${name}: icon button missing title: ${tag}`)
      assert.match(tag, /:aria-label=/, `${name}: icon button missing aria-label: ${tag}`)
    }
  }
  assert.match(ruleBody(styleOf(files.proposal), '.proposal-actions .btn'), /min-height:\s*36px/)
  assert.match(ruleBody(styleOf(files.proposal), '.proposal-head'), /min-height:\s*40px/)
  assert.match(files.proposal, /<div class="proposal-body">/)
  const proposalBody = ruleBody(styleOf(files.proposal), '.proposal-body')
  assert.match(proposalBody, /max-height:/)
  assert.match(proposalBody, /overflow-y:\s*auto/)
  assert.match(ruleBody(styleOf(files.proposal), '.proposal-card'), /font-size:\s*var\(--text-label\)/)
  const bodyStart = files.proposal.indexOf('<div class="proposal-body">')
  const bodyEnd = files.proposal.indexOf('<footer class="proposal-actions">')
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, 'proposal body must precede the fixed footer')
})

test('U5 终验：无临时类，四语言导演台与智能体键齐全', () => {
  const newSurfaces = ['topbar', 'tab', 'shotList', 'stage2d', 'stage3d', 'apply', 'inspector', 'dock', 'proposal', 'suggestion', 'markdown', 'workbench']
  for (const name of newSurfaces) {
    assert.doesNotMatch(files[name], /\bclass="[^"]*\b(?:u[1-5]|tmp|temp)-[a-z-]+/, `${name}: temporary visual class`)
  }
  for (const name of localeNames) {
    const data = locale(name)
    assert.equal(typeof data.director?.tab?.label, 'string', `${name}: director.tab.label`)
    assert.equal(typeof data.director?.stage3d?.emptyTitle, 'string', `${name}: director.stage3d.emptyTitle`)
    assert.equal(typeof data.assistant?.historyEmpty, 'string', `${name}: assistant.historyEmpty`)
    assert.equal(typeof data.assistant?.suggestion?.noAutoRun, 'string', `${name}: assistant.suggestion.noAutoRun`)
  }
})
