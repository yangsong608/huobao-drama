/**
 * 小说 Markdown 渲染：标题/强调/代码/列表/引用，且必须转义原始 HTML
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderNovelMarkdown } from '../app/utils/novel-markdown.js'

test('渲染标题、强调、行内代码与安全链接', () => {
  const html = renderNovelMarkdown(
    '# 标题\n\n这是 **加粗**、*斜体* 与 `代码`，还有 [链接](https://example.com/a?b=1)。',
  )
  assert.match(html, /<h1>标题<\/h1>/)
  assert.match(html, /<strong>加粗<\/strong>/)
  assert.match(html, /<em>斜体<\/em>/)
  assert.match(html, /<code>代码<\/code>/)
  assert.match(
    html,
    /<a href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer">链接<\/a>/,
  )
})

test('渲染列表、引用、分隔线与代码块', () => {
  const html = renderNovelMarkdown(
    '- 一\n- 二\n\n1. 第一\n2. 第二\n\n> 引用\n\n---\n\n```js\nconst a = 1 < 2\n```',
  )
  assert.match(html, /<ul>[\s\S]*<li>一<\/li>[\s\S]*<li>二<\/li>[\s\S]*<\/ul>/)
  assert.match(html, /<ol>[\s\S]*<li>第一<\/li>[\s\S]*<li>第二<\/li>[\s\S]*<\/ol>/)
  assert.match(html, /<blockquote>[\s\S]*引用[\s\S]*<\/blockquote>/)
  assert.match(html, /<hr \/>/)
  assert.match(html, /<pre class="md-code"><code>const a = 1 &lt; 2<\/code><\/pre>/)
})

test('转义原始 HTML，不执行脚本或注入标签', () => {
  const html = renderNovelMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /<img/i)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('拒绝 javascript 链接，仅保留文本', () => {
  const html = renderNovelMarkdown('[点我](javascript:alert(1))')
  assert.doesNotMatch(html, /href=/)
  assert.match(html, /点我/)
})

test('空内容返回空字符串', () => {
  assert.equal(renderNovelMarkdown(''), '')
  assert.equal(renderNovelMarkdown(null), '')
  assert.equal(renderNovelMarkdown(undefined), '')
})
