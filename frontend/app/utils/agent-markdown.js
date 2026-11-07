/**
 * 智能体消息的 Markdown 子集解析（不使用 v-html）。
 * 仅支持标题、段落、列表、引用、代码、分隔线与行内强调/代码/HTTP(S) 链接；
 * 原始 HTML、图片与 javascript: 链接一律按纯文本处理。
 */

const INLINE_PATTERN = /`([^`\n]+)`|(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*/g

export function parseAgentInline(source) {
  const text = String(source ?? '')
  const tokens = []
  let last = 0
  INLINE_PATTERN.lastIndex = 0
  let match
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > last) tokens.push({ type: 'text', text: text.slice(last, match.index) })
    if (match[1] !== undefined) tokens.push({ type: 'code', text: match[1] })
    else if (match[2] !== undefined) tokens.push({ type: 'link', text: match[2], href: match[3] })
    else if (match[4] !== undefined) tokens.push({ type: 'strong', text: match[4] })
    else if (match[5] !== undefined) tokens.push({ type: 'del', text: match[5] })
    else if (match[6] !== undefined) tokens.push({ type: 'em', text: match[6] })
    last = match.index + match[0].length
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) })
  return tokens
}

export function parseAgentMarkdown(source) {
  if (source === null || source === undefined) return []
  const text = String(source).replace(/\r\n?/g, '\n')
  if (!text.trim()) return []

  const lines = text.split('\n')
  const blocks = []
  let paragraph = []
  let index = 0

  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push({ type: 'paragraph', lines: paragraph.map(parseAgentInline) })
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
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      blocks.push({ type: 'heading', level: heading[1].length, inlines: parseAgentInline(heading[2]) })
      index += 1
      continue
    }

    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flushParagraph()
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph()
      const quote = []
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quote.push(parseAgentInline(lines[index].trim().replace(/^>\s?/, '')))
        index += 1
      }
      blocks.push({ type: 'quote', lines: quote })
      continue
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph()
      const items = []
      while (index < lines.length && /^[-*+]\s+/.test(lines[index].trim())) {
        items.push(parseAgentInline(lines[index].trim().replace(/^[-*+]\s+/, '')))
        index += 1
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph()
      const items = []
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        items.push(parseAgentInline(lines[index].trim().replace(/^\d+[.)]\s+/, '')))
        index += 1
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    paragraph.push(trimmed)
    index += 1
  }

  flushParagraph()
  return blocks
}
