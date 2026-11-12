/**
 * 本地 H3 提示词编译器
 *
 * 实验结论（local-h3/experiments/README.md）：H3 会把中文提示词正文当成字幕烧进画面，
 * 而英文提示词 + 干净参考图可消除字幕；台词必须放进 H3 官方的 `<d>[Chinese] 原文</d>` 标签，
 * 语音模块才会按原文念出，标签外的中文仍会被当作字幕。
 * 因此本地 shim 提交前统一做一次「结构英文化」：
 * - @图片N → <Picture N>，去掉 #音色 / 音色参考音频N 等后端标记
 * - 人物/场景/音频/时间轴标签 → 英文结构
 * - native：对白 → `X says, <d>[Chinese] 台词原文</d>`；旁白 → 画外音 + 同样的标签
 * - ambient/silent：对白只保留说话动作（留给后期配音），旁白移除
 * - 其余中文交给文本模型翻译；`<d>` 标签用占位符保护，标签丢失时退回确定性结果
 */
import { callText } from './text-call.js'
import { logTaskWarn } from '../utils/task-logger.js'
import type { VideoAudioMode } from './video-audio.js'

const CJK_RE = /[\u3400-\u9fff]/
const H3_PROMPT_MAX_CHARS = 6800
const CACHE_LIMIT = 200
const TRANSLATE_TIMEOUT_MS = 120_000
const TRANSLATE_ATTEMPTS = 2
const DIALOGUE_ONLY_RULE = 'Only text inside <d> tags is spoken; all other text is visual description and must never be voiced.'
const NO_DIALOGUE_RULE = 'This shot has no spoken dialogue: do not voice any line; characters stay silent except for ambient sound.'
const translationCache = new Map<string, string>()

export class H3PromptTranslationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'H3PromptTranslationError'
  }
}

export const H3_TRANSLATOR_SYSTEM = `You translate Chinese video-generation prompts into English for the MiniMax H3 model.
Rules:
- Output only the English prompt. No markdown, no explanations, no extra shots.
- Preserve exactly: <Picture N> placeholders, [0-3s] time markers, and the line labels Characters:, Scene:, Audio:, Time:, Shot:.
- Dialogue is supplied as tokens like [[H3_DLG_N]]. Each token stands for an H3 dialogue tag of the form <d>[Chinese] ...</d>.
- Copy every [[H3_DLG_N]] token exactly once, unchanged, in its original position. Never translate, remove, duplicate, split or rewrite a token.
- Translate every other Chinese word, including character and place names. Transliterate Chinese names consistently to pinyin.
- Never write subtitles, captions, quoted speech, or on-screen text outside the tokens.
- Keep the original line order and every time marker.`

interface NamedDialogue {
  quote: RegExp
}

const SPEECH_VERBS = '说道|问道|答道|喊道|叫道|开口说|接着说|低语|喃喃道|轻声说|低声说|大声说|说|道'
const SPEECH_MANNER = '轻声|低声|大声|高声|小声|冷冷地|温柔地|笑着|哭着|沉声|怒声|柔声|喃喃|喃喃地|缓缓|开口|又|接着|随后|随即|继续|再次|然后'
const NAME_CHAR = '[^\\s，。！？；、：,.!?;:「」“”"\'（）()\\[\\]{}<>#@]'
const DIALOGUE: NamedDialogue[] = [
  {
    quote: new RegExp(
      `(${NAME_CHAR}{1,24}?)(?:（[^）]*）)?\\s*(?:${SPEECH_MANNER})?\\s*(?:${SPEECH_VERBS})\\s*[：:]?\\s*[「“"]([^」”"]*)[」”"]`,
      'g',
    ),
  },
]

function stripQuotedDialogue(
  text: string,
  audioMode: VideoAudioMode,
  tagDialogue: (line: string) => string,
): string {
  return text
    .replace(/[「“"]([^」”"]*)[」”"]/g, (_match, inner: string) => {
      const value = String(inner || '')
      // 短词多为专有名词（如“陆缘”）；长句或带句读的才按台词处理
      if (value.length <= 16 && !/[。！？!?，,；;]/.test(value)) return value
      return audioMode === 'native' ? tagDialogue(value) : ''
    })
    .replace(/[「」“”]/g, '')
}

/** 确定性转换：不依赖文本模型；台词进入 H3 `<d>` 标签，其余结构英文化 */
export function compileH3Prompt(prompt: string, audioMode: VideoAudioMode = 'native'): string {
  if (!prompt) return ''
  let text = String(prompt).replace(/\r\n?/g, '\n')

  // 台词原文只在最后还原，避免后续清洗规则改动标签内的字句
  const dialogueTags: string[] = []
  const tagDialogue = (line: string) => {
    dialogueTags.push(`<d>[Chinese] ${line}</d>`)
    return `[[H3_DLG_${dialogueTags.length - 1}]]`
  }

  // 参考图统一成 H3 训练时使用的 <Picture N> 标记
  text = text.replace(/@图片\s*(\d+)/g, '<Picture $1>')

  // #01 这类镜头编号原样保留；#角色名 只去掉井号，名字留给说话动作识别
  text = text.replace(/#([^\s#@，。！？；、：,.!?;:「」“”"'（）()\[\]{}<>]+?)音色/g, '$1')
  text = text.replace(/#(?=\D)/g, '')

  // 音色参考标记只对云端厂商有意义，本地 shim 不接收音频参考
  text = text.replace(/（音色参考音频\s*\d+）/g, '').replace(/音色参考音频\s*\d+/g, '')

  // 模板音频行里的「旁白/心声为画外音」是条件说明（有旁白时才适用），不代表本镜真有旁白，
  // 先移除，避免下面的旁白规则把它编译成画外音指令
  text = text.replace(/[；;]?\s*旁白\s*[\/／]\s*心声为画外音[^。\n]*。?/g, '')

  // 环境声交给模型自然生成，不把混音指令「压低」写进提示词
  text = text.replace(/环境音压低/g, '环境音自然')

  // 旁白：原生模式念出原文；ambient/silent 由后期配音，画面不需要旁白
  const narration = /(?:旁白\s*[（(]画外音[）)]|画外音|旁白)\s*(?:说|讲述|念白)?\s*[：:]?\s*[「“"]([^」”"]*)[」”"]/g
  text = audioMode === 'native'
    ? text.replace(narration, (_match, line: string) => `Off-screen narrator says, ${tagDialogue(line)}`)
    : text.replace(narration, '')

  // 对白：原生模式用 H3 官方的 <d>[Chinese] 原文</d> 标签驱动语音；其余模式只保留口型
  for (const { quote } of DIALOGUE) {
    text = text.replace(quote, (_match, name: string, line: string) =>
      audioMode === 'native'
        ? `${name} says, ${tagDialogue(line)}`
        : `${name} speaks in Mandarin, mouth moving`)
  }
  text = text.replace(
    new RegExp(`(?:${SPEECH_MANNER})?\\s*(?:${SPEECH_VERBS})\\s*[：:]?\\s*[「“"]([^」”"]*)[」”"]`, 'g'),
    (_match, line: string) =>
      audioMode === 'native' ? `says, ${tagDialogue(line)}` : 'speaks in Mandarin, mouth moving',
  )
  text = stripQuotedDialogue(text, audioMode, tagDialogue)

  // 残留的旁白标签（没有引号的情况）
  text = text.replace(/旁白\s*[（(]画外音[）)]|画外音|旁白/g,
    audioMode === 'native' ? 'Off-screen narrator' : '')

  // 结构标签英文化
  text = text.replace(/^人物\s*[：:]\s*/gm, 'Characters: ')
  text = text.replace(/^场景\s*[：:]\s*/gm, 'Scene: ')
  text = text.replace(/^时间\s*[：:]\s*/gm, 'Time: ')
  text = text.replace(/^镜头\s*[：:]\s*/gm, 'Shot: ')
  text = text.replace(/^风格\s*[：:]\s*/gm, 'Style: ')

  // 音频行：native 保留内容并换成英文标签；ambient/silent 整行移除
  if (audioMode === 'native') {
    text = text.replace(/^(?:音频|声音|Sound|音響|사운드)\s*[：:]\s*/gmi, 'Audio: ')
  } else {
    text = text.replace(/^\s*(?:音频|audio|声音|Sound|音響|사운드)\s*[：:].*(?:\n|$)/gim, '')
  }

  // 时间轴：0-3秒： → [0-3s]，单点时间同理
  text = text.replace(/^(\d+(?:\.\d+)?)\s*[-–—~至到]\s*(\d+(?:\.\d+)?)\s*秒\s*[：:]\s*/gm, '[$1-$2s] ')
  text = text.replace(/^(\d+(?:\.\d+)?)\s*秒\s*[：:]\s*/gm, '[$1s] ')

  // 没有索引的 @名字 只保留名字文本
  text = text.replace(/@([^\s@#，。！？；、：,.!?;:「」“”"'（）()\[\]{}<>]+)/g, '$1')

  const compiled = text
    .replace(/[，,]\s*[：:]\s*/g, '，')
    .replace(/^[：:]\s*/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const restored = dialogueTags.reduce(
    (value, tag, index) => value.split(`[[H3_DLG_${index}]]`).join(tag),
    compiled,
  )
  return delimitDialogueTags(mergeSameSpeakerDialogueTags(restored))
}

const SPEAKER_TAG_RE = /([A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5·._'’()（） -]{0,39}?)\s+says,\s*<d>\[Chinese\]\s*([\s\S]*?)<\/d>/g

/**
 * H3 对同一说话人的多个 `<d>` 标签绑定不稳定（容易让听者张嘴或丢句）。
 * 一个镜头内同一说话人的台词强制合并为一个标签：文本按原顺序拼到第一次出现处，
 * 后续位置保留“继续说话”的口型提示，不再产生第二个语音标签。
 */
export function mergeSameSpeakerDialogueTags(text: string): string {
  const matches = [...String(text || '').matchAll(SPEAKER_TAG_RE)]
  if (matches.length < 2) return text
  const bySpeaker = new Map<string, typeof matches>()
  for (const match of matches) {
    const speaker = String(match[1] || '').trim()
    if (!speaker || /^(?:says|continues speaking)$/i.test(speaker)) continue
    if (!bySpeaker.has(speaker)) bySpeaker.set(speaker, [])
    bySpeaker.get(speaker)!.push(match)
  }
  let result = text
  for (const [speaker, items] of bySpeaker) {
    if (items.length < 2) continue
    const merged = items
      .map(item => String(item[2] || '').trim())
      .filter(Boolean)
      .reduce((value, line) => {
        if (!value) return line
        return /[。！？!?…；;，,]$/.test(value) ? `${value}${line}` : `${value}，${line}`
      }, '')
    const mergedTag = `<d>[Chinese] ${merged}</d>`
    let seenFirst = false
    result = result.replace(SPEAKER_TAG_RE, (whole, name: string) => {
      if (String(name || '').trim() !== speaker) return whole
      if (!seenFirst) {
        seenFirst = true
        return `${name} says, ${mergedTag}`
      }
      return `${name} continues speaking`
    })
  }
  return result
}

/** `</d>` 后没有句读时 H3 会把后续画面描述并进台词，补一个句号把边界钉死 */
function delimitDialogueTags(text: string): string {
  return text
    .replace(/<\/d>\s*[，,；;]\s*/g, '</d>. ')
    .replace(/<\/d>(\s*)(?=[^\s。！？!?.;，,])/g, '</d>.$1')
}

function stripDialogueTags(text: string): string {
  return text.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, '')
}

function normalizeTranslation(text: string): string {
  let value = String(text || '').trim()
  const fenced = value.match(/^```(?:[a-z]+)?\s*([\s\S]*?)```$/i)
  if (fenced) value = fenced[1].trim()
  return value.replace(/\n{3,}/g, '\n\n').slice(0, H3_PROMPT_MAX_CHARS).trim()
}

const DIALOGUE_TAG_RE = /<d>\[Chinese\][\s\S]*?<\/d>/g
const DIALOGUE_PLACEHOLDER_RE = /\[\[H3_DLG_\d+\]\]/

/** 翻译前把 <d> 标签换成占位符，避免模型改写台词原文 */
function extractDialogueTags(text: string): { text: string; tags: string[] } {
  const tags: string[] = []
  const stripped = text.replace(DIALOGUE_TAG_RE, match => {
    tags.push(match)
    return `[[H3_DLG_${tags.length - 1}]]`
  })
  return { text: stripped, tags }
}

/** 翻译后按原样还原；缺失、重复或未知占位符视为翻译失败 */
function restoreDialogueTags(text: string, tags: string[]): string {
  let restored = text
  for (const [index, tag] of tags.entries()) {
    const token = `[[H3_DLG_${index}]]`
    const occurrences = restored.split(token).length - 1
    if (occurrences !== 1) throw new Error(`翻译结果中的对白标记 ${token} 出现 ${occurrences} 次`)
    restored = restored.split(token).join(tag)
  }
  if (DIALOGUE_PLACEHOLDER_RE.test(restored)) throw new Error('翻译结果包含未知对白标记')
  return restored
}

type H3Translate = (text: string, attempt: number) => Promise<string>

function defaultTranslate(text: string, attempt = 0): Promise<string> {
  const system = attempt > 0
    ? `${H3_TRANSLATOR_SYSTEM}\nStrict retry: the previous output was rejected. The output must contain no Chinese characters outside the [[H3_DLG_N]] tokens.`
    : H3_TRANSLATOR_SYSTEM
  return callText({
    system,
    prompt: text,
    temperature: 0.2,
    maxTokens: 4096,
    timeoutMs: TRANSLATE_TIMEOUT_MS,
    responseFormat: 'text',
  }).then(result => result.text)
}

function cacheTranslation(key: string, value: string): void {
  if (translationCache.size >= CACHE_LIMIT) {
    translationCache.delete(translationCache.keys().next().value as string)
  }
  translationCache.set(key, value)
}

async function requestTranslation(
  text: string,
  translate: H3Translate,
  validate?: (translated: string) => void,
): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < TRANSLATE_ATTEMPTS; attempt += 1) {
    try {
      const translated = normalizeTranslation(await translate(text, attempt))
      if (!translated) throw new Error('翻译结果为空')
      validate?.(translated)
      return translated
    } catch (err) {
      lastError = err
      if (attempt < TRANSLATE_ATTEMPTS - 1) {
        logTaskWarn('H3Prompt', 'translate-retry', {
          attempt: attempt + 1,
          error: (err as Error)?.message || String(err),
        })
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export interface TranslateH3TextOptions {
  translate?: H3Translate
}

/** 单独翻译视觉背景/风格；失败返回 null，由调用方决定是否跳过 */
export async function translateH3Text(
  text: string,
  options: TranslateH3TextOptions = {},
): Promise<string | null> {
  const source = String(text || '').trim()
  if (!source) return ''
  if (!CJK_RE.test(source)) return source

  const key = `visual-background\n${source}`
  const cached = translationCache.get(key)
  if (cached) return cached

  try {
    const translated = await requestTranslation(
      source,
      options.translate ?? defaultTranslate,
      value => {
        // 翻译模型可能原样回显或只译了一部分；中文送进本地 H3 会被烧进画面，重试一次再放弃
        if (CJK_RE.test(value)) throw new Error('翻译结果仍包含中文')
        if (/<\/?d>/i.test(value)) throw new Error('翻译结果包含意外的对白标签')
      },
    )
    cacheTranslation(key, translated)
    return translated
  } catch (err: any) {
    logTaskWarn('H3Prompt', 'visual-background-translate-failed', { error: err?.message || String(err) })
    return null
  }
}

export interface CompileLocalH3Options {
  translate?: H3Translate
}

/**
 * 本地 H3 编译：确定性结构转换 + 英文化。
 * `<d>` 标签外不允许残留中文；翻译失败会抛错取消提交，绝不把中文正文交给 H3。
 */
export async function compileLocalH3Prompt(
  prompt: string,
  audioMode: VideoAudioMode = 'native',
  options: CompileLocalH3Options = {},
): Promise<string> {
  const deterministic = compileH3Prompt(prompt, audioMode)
  if (!deterministic) return deterministic

  const dialogueCount = (deterministic.match(/<d>\[Chinese\][\s\S]*?<\/d>/g) || []).length
  const nativeRule = audioMode === 'native'
    ? (dialogueCount > 0 ? DIALOGUE_ONLY_RULE : NO_DIALOGUE_RULE)
    : ''
  const finish = (text: string) => (nativeRule ? `${text}\n${nativeRule}` : text)

  // 标签外没有中文时无需翻译，直接保留原文台词
  if (!CJK_RE.test(stripDialogueTags(deterministic))) return finish(deterministic)

  const key = `${audioMode}\n${deterministic}`
  const cached = translationCache.get(key)
  if (cached) return cached

  const { text: translatable, tags } = extractDialogueTags(deterministic)
  let lastError: unknown
  for (let attempt = 0; attempt < TRANSLATE_ATTEMPTS; attempt += 1) {
    try {
      const translated = normalizeTranslation(await (options.translate ?? defaultTranslate)(translatable, attempt))
      if (!translated) throw new Error('翻译结果为空')
      const restored = tags.length ? restoreDialogueTags(translated, tags) : translated
      if (CJK_RE.test(stripDialogueTags(restored))) throw new Error('翻译结果在 <d> 标签外仍包含中文')
      if ((restored.match(/<d>/g) || []).length !== tags.length) throw new Error('翻译结果包含多余的对白标签')
      const final = finish(delimitDialogueTags(restored))
      cacheTranslation(key, final)
      return final
    } catch (err) {
      lastError = err
      if (attempt < TRANSLATE_ATTEMPTS - 1) {
        logTaskWarn('H3Prompt', 'translate-retry', {
          audioMode,
          attempt: attempt + 1,
          error: (err as Error)?.message || String(err),
        })
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  logTaskWarn('H3Prompt', 'translate-failed', { audioMode, error: reason })
  throw new H3PromptTranslationError(
    `本地 H3 提示词英文化失败（${audioMode}）：${reason}。已取消提交，避免中文被烧成字幕或被念成台词；请检查文本模型配置与网络后重试。`,
  )
}

/** 测试与配置切换时清空翻译缓存 */
export function clearH3TranslationCache(): void {
  translationCache.clear()
}
