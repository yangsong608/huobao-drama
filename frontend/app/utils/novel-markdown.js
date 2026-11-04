/**
 * 小说 Markdown 渲染器：先转义全部 HTML，再生成受控标签。
 * 不依赖第三方库，禁止原始 HTML 与 javascript: 链接。
 */

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char])
}

function renderInline(source) {
  const codes = []
  let text = escapeHtml(source).replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `\u0000MD${codes.length}\u0000`
    codes.push(`<code>${code}</code>`)
    return token
  })

  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  )
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')

  return text.replace(/\u0000MD(\d+)\u0000/g, (_, index) => codes[Number(index)] ?? '')
}

export function renderNovelMarkdown(source) {
  if (source === null || source === undefined) return ''
  const text = String(source).replace(/\r\n?/g, '\n')
  if (!text.trim()) return ''

  const lines = text.split('\n')
  const output = []
  let paragraph = []
  let index = 0

  const flushParagraph = () => {
    if (!paragraph.length) return
    output.push(`<p>${paragraph.map(renderInline).join('<br />')}</p>`)
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      flushParagraph()
      index += 1
      continue
    }

    if (/^```/.test(trimmed)) {
      flushParagraph()
      const code = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      output.push(`<pre class="md-code"><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      const level = heading[1].length
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flushParagraph()
      output.push('<hr />')
      index += 1
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph()
      const quote = []
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''))
        index += 1
      }
      output.push(`<blockquote>${quote.map(renderInline).join('<br />')}</blockquote>`)
      continue
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph()
      const items = []
      while (index < lines.length && /^[-*+]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*+]\s+/, ''))
        index += 1
      }
      output.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`)
      continue
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph()
      const items = []
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+[.)]\s+/, ''))
        index += 1
      }
      output.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`)
      continue
    }

    paragraph.push(trimmed)
    index += 1
  }

  flushParagraph()
  return output.join('\n')
}
