/**
 * 节拍语义层
 *
 * 只回答“这句话是谁、对谁、什么情绪、什么道具、什么机位”，不做分镜。
 * 拆分器据此判断主体/目标/情绪/道具/机位是否发生变化，再决定节拍和分镜边界。
 */

export interface BeatSemantics {
  subject: string
  target: string
  emotion: string
  prop: string
  camera: string
  vocalAction: string
}

export interface BeatSemanticsOptions {
  subjectNames?: string[]
  propNames?: string[]
  previousSubject?: string
}

const GENERIC_PERSON_RE = /^(?:一个|一位|那个|这个|一名|那|这)?(?:花袄|白发|年轻|年老|瘦|胖|高个|矮个|青衣|布袍|山羊胡子|十三四岁|老|小)?(老妇|老头|老者|少年|少女|男子|女子|妇人|汉子|众人|街坊|客人|伙计|掌柜|郎中|文生|小厮|侍卫|士兵|孩子|姑娘|老人|老汉|嬷嬷|尼姑|道士|和尚)/
const OBJECT_PREFIX_RE = /(?:对|向|朝|跟|和|给|望|被|让|与|冲|把|将|替|为|从|着)$/
const PRONOUN_START_RE = /^(?:他|她|它|他们|她们|它们|其|此)/
const EMOTION_RE = /(心酸|失落|渐弱|愈发|自觉|无趣|吃味|得意|紧张|害怕|高兴|开心|难过|愤怒|委屈|不甘|眼红|嫌弃|得瑟|热切|讪讪|酸溜溜|嗤之以鼻|苦笑|摇头|皱眉|冷笑|焦急|着急|惊|怒|喜|悲|羞|慌|愣|慌神|没好气|客气|恭敬|打趣|抱怨|感叹|急道|笑道|叹道|沉声|柔声|冷声|怒声)/
const CAMERA_RE = /(特写|近景|中景|全景|远景|俯拍|仰拍|推近|推镜|拉开|横移|摇镜|跟拍|镜头)/g
const VOCAL_ACTION_RE = /(揽客|吆喝|叫卖|唱喝|唱喏|喊道?|叫道|嚷道?|吼道?|骂道?|招呼|开口|喝问|高喊|低语|喃喃|嚷|吼|骂)/

function cleanName(value: string) {
  return String(value || '').replace(/^@/, '').trim()
}

function findNames(text: string, names: string[]): Array<{ name: string; index: number }> {
  return names
    .map(name => ({ name: cleanName(name), index: text.indexOf(name) }))
    .filter(item => item.name && item.index >= 0)
    .sort((a, b) => a.index - b.index || b.name.length - a.name.length)
}

function findName(text: string, names: string[]): { name: string; index: number } | null {
  return findNames(text, names)[0] || null
}

function findSubjectName(text: string, names: string[]): { name: string; index: number } | null {
  const candidates = findNames(text, names).filter(item => !OBJECT_PREFIX_RE.test(text.slice(0, item.index)))
  return candidates[0] || null
}

function resolveSubject(text: string, options: BeatSemanticsOptions): string {
  const names = (options.subjectNames || []).map(cleanName).filter(Boolean)
  const named = findSubjectName(text, names)
  if (named) return named.name
  const generic = text.match(GENERIC_PERSON_RE)?.[1]
  if (generic) return generic
  if (PRONOUN_START_RE.test(text.trim()) && options.previousSubject) return options.previousSubject
  return ''
}

function resolveTarget(text: string, subject: string, options: BeatSemanticsOptions): string {
  const names = (options.subjectNames || []).map(cleanName).filter(Boolean)
  const otherNames = findNames(text, names).filter(item => item.name !== subject)
  if (otherNames.length) return otherNames[0].name
  const generic = text.match(GENERIC_PERSON_RE)?.[1] || text.match(/(?:老妇|老头|老者|少年|少女|男子|女子|妇人|汉子|众人|街坊|客人|伙计|掌柜|郎中|文生|小厮|侍卫|士兵|孩子|姑娘|老人|老汉)/)?.[0]
  if (generic && generic !== subject) return generic
  const prop = findName(text, options.propNames || [])
  return prop && prop.name !== subject ? prop.name : ''
}

function resolveProp(text: string, options: BeatSemanticsOptions): string {
  return findName(text, options.propNames || [])?.name || ''
}

export function detectBeatSemantics(text: string, options: BeatSemanticsOptions = {}): BeatSemantics {
  const source = String(text || '')
  const subject = resolveSubject(source, options)
  const target = resolveTarget(source, subject, options)
  const emotion = source.match(EMOTION_RE)?.[1] || ''
  const camera = source.match(CAMERA_RE)?.[1] || ''
  const vocalAction = source.match(VOCAL_ACTION_RE)?.[1] || ''
  const prop = resolveProp(source, options)
  return { subject, target, emotion, prop, camera, vocalAction }
}

/** 这些字段差异才触发分镜硬边界；情绪/道具是动作弧内部状态。 */
export function semanticBoundary(previous: BeatSemantics, next: BeatSemantics): string | null {
  if (previous.subject && next.subject && previous.subject !== next.subject) return 'subject'
  if (previous.subject && !next.subject) return 'subject_empty'
  if (!previous.subject && next.subject) return 'subject_set'
  if (previous.target && next.target && previous.target !== next.target) return 'target'
  if (previous.camera && next.camera && previous.camera !== next.camera) return 'camera'
  return null
}
