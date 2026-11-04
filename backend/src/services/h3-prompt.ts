/**
 * 本地 H3 提示词编译器
 *
 * 实验结论（local-h3/experiments/README.md）：H3 会把中文提示词正文当成字幕烧进画面，
 * 而英文提示词 + 干净参考图可消除字幕；对话原文既无法被本地音频驱动，也会加重字幕。
 * 因此本地 shim 提交前统一做一次「结构英文化」：
 * - @图片N → <Picture N>，去掉 #音色 / 音色参考音频N 等后端标记
 * - 人物/场景/音频/时间轴标签 → 英文结构
 * - 对白 → "X speaks in Mandarin, mouth moving"（不保留台词原文）
 * - 旁白按声音模式保留为画外音或移除
 * - 其余中文交给文本模型翻译；失败时退回确定性结果，绝不阻断生成
 */
import { callText } from './text-call.js'
import { logTaskWarn } from '../utils/task-logger.js'
import type { VideoAudioMode } from './video-audio.js'

const CJK_RE = /[\u3400-\u9fff]/
const H3_PROMPT_MAX_CHARS = 6800
const CACHE_LIMIT = 200
const translationCache = new Map<string, string>()

export const H3_TRANSLATOR_SYSTEM = `You translate Chinese video-generation prompts into English for the MiniMax H3 model.
Rules:
- Output only the English prompt. No markdown, no explanations, no extra shots.
- Preserve exactly: <Picture N> placeholders, [0-3s] time markers, and the line labels Characters:, Scene:, Audio:, Time:, Shot:.
- Translate every Chinese word, including character and place names. Transliterate Chinese names consistently to pinyin.
- Never write dialogue, subtitles, captions, quoted speech, or on-screen text.
- When a character speaks, describe it as "X speaks in Mandarin, mouth moving" without the spoken words.
- Keep the original line order and every time marker.`

interface NamedDialogue {
  quote: RegExp
}

const SPEECH_VERBS = '说道|问道|答道|喊道|叫道|开口说|接着说|低语|喃喃道|轻声说|低声说|大声说|说|道'
const SPEECH_MANNER = '轻声|低声|大声|高声|小声|冷冷地|温柔地|笑着|哭着|沉声|怒声|柔声|喃喃|喃喃地|缓缓|开口'
const NAME_CHAR = '[^\\s，。！？；、：,.!?;:「」“”"\'（）()\\[\\]{}<>#@]'
const DIALOGUE: NamedDialogue[] = [
  {
    quote: new RegExp(
      `(${NAME_CHAR}{1,24}?)(?:（[^）]*）)?\\s*(?:${SPEECH_MANNER})?\\s*(?:${SPEECH_VERBS})\\s*[：:]?\\s*[「“"]([^」”"]*)[」”"]`,
      'g',
    ),
  },
]

function stripQuotedDialogue(text: string): string {
  return text.replace(/[「“"]([^」”"]*)[」”"]/g, '').replace(/[「」“”]/g, '')
}

/** 确定性转换：不依赖文本模型，输出去掉所有字幕源（对白原文/引号/标记） */
export function compileH3Prompt(prompt: string, audioMode: VideoAudioMode = 'native'): string {
  if (!prompt) return ''
  let text = String(prompt).replace(/\r\n?/g, '\n')

  // 参考图统一成 H3 训练时使用的 <Picture N> 标记
  text = text.replace(/@图片\s*(\d+)/g, '<Picture $1>')

  // #01 这类镜头编号原样保留；#角色名 只去掉井号，名字留给说话动作识别
  text = text.replace(/#([^\s#@，。！？；、：,.!?;:「」“”"'（）()\[\]{}<>]+?)音色/g, '$1')
  text = text.replace(/#(?=\D)/g, '')

  // 音色参考标记只对云端厂商有意义，本地 shim 不接收音频参考
  text = text.replace(/（音色参考音频\s*\d+）/g, '').replace(/音色参考音频\s*\d+/g, '')

  // 旁白：原生模式保留画外音描述；ambient/silent 由后期配音，画面不需要旁白
  const narration = /(?:旁白\s*[（(]画外音[）)]|画外音|旁白)\s*(?:说|讲述|念白)?\s*[：:]?\s*[「“"]([^」”"]*)[」”"]/g
  text = text.replace(narration, audioMode === 'native' ? 'Off-screen narrator speaks in Mandarin, mouth moving' : '')

  // 对白：只保留说话动作与口型，台词原文一律不进入 H3 提示词
  for (const { quote } of DIALOGUE) {
    text = text.replace(quote, (_match, name: string) => `${name} speaks in Mandarin, mouth moving`)
  }
  text = text.replace(
    new RegExp(`(?:${SPEECH_MANNER})?\\s*(?:${SPEECH_VERBS})\\s*[：:]?\\s*[「“"]([^」”"]*)[」”"]`, 'g'),
    'speaks in Mandarin, mouth moving',
  )
  text = stripQuotedDialogue(text)

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
    text = text.replace(/^音频\s*[：:]\s*/gm, 'Audio: ')
  } else {
    text = text.replace(/^\s*(?:音频|audio)\s*[：:].*(?:\n|$)/gim, '')
  }

  // 时间轴：0-3秒： → [0-3s]，单点时间同理
  text = text.replace(/^(\d+(?:\.\d+)?)\s*[-–—~至到]\s*(\d+(?:\.\d+)?)\s*秒\s*[：:]\s*/gm, '[$1-$2s] ')
  text = text.replace(/^(\d+(?:\.\d+)?)\s*秒\s*[：:]\s*/gm, '[$1s] ')

  // 没有索引的 @名字 只保留名字文本
  text = text.replace(/@([^\s@#，。！？；、：,.!?;:「」“”"'（）()\[\]{}<>]+)/g, '$1')

  return text
    .replace(/[，,]\s*[：:]\s*/g, '，')
    .replace(/^[：:]\s*/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeTranslation(text: string): string {
  let value = String(text || '').trim()
  const fenced = value.match(/^```(?:[a-z]+)?\s*([\s\S]*?)```$/i)
  if (fenced) value = fenced[1].trim()
  return value.replace(/\n{3,}/g, '\n\n').slice(0, H3_PROMPT_MAX_CHARS).trim()
}

function defaultTranslate(text: string): Promise<string> {
  return callText({
    system: H3_TRANSLATOR_SYSTEM,
    prompt: text,
    temperature: 0.2,
    maxTokens: 2048,
    timeoutMs: 30_000,
    responseFormat: 'text',
  }).then(result => result.text)
}

export interface CompileLocalH3Options {
  translate?: (text: string) => Promise<string>
}

/** 本地 H3 编译：确定性结构转换 + 可选英文化；翻译失败保留确定性结果 */
export async function compileLocalH3Prompt(
  prompt: string,
  audioMode: VideoAudioMode = 'native',
  options: CompileLocalH3Options = {},
): Promise<string> {
  const deterministic = compileH3Prompt(prompt, audioMode)
  if (!deterministic || !CJK_RE.test(deterministic)) return deterministic

  const key = `${audioMode}\n${deterministic}`
  const cached = translationCache.get(key)
  if (cached) return cached

  try {
    const translated = normalizeTranslation(await (options.translate ?? defaultTranslate)(deterministic))
    if (!translated) throw new Error('翻译结果为空')
    if (translationCache.size >= CACHE_LIMIT) {
      translationCache.delete(translationCache.keys().next().value as string)
    }
    translationCache.set(key, translated)
    return translated
  } catch (err: any) {
    logTaskWarn('H3Prompt', 'translate-fallback', { error: err?.message || String(err) })
    return deterministic
  }
}

/** 测试与配置切换时清空翻译缓存 */
export function clearH3TranslationCache(): void {
  translationCache.clear()
}
