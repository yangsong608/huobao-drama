/**
 * 旧版模板要求模型在视频提示词里写「音频：人声清晰靠前……旁白/心声为画外音……」。
 * 云端视频适配器会把提示词原样发给模型，这行会诱导模型生成人声/旁白；
 * 本地 H3 也会把它编译成音频指令。模板已不再生成该行，这里负责拦掉存量提示词。
 */
const AUDIO_LINE_RE = /^[ \t]*(?:音频|audio)[ \t]*[：:][^\n]*(?:\n|$)/gim
const GENERIC_AUDIO_MARKERS = /人声清晰靠前|旁白\s*[/／]\s*心声为画外音|环境音压低/
const NARRATION_CLAUSE_RE = /[；;，,、]?[ \t]*旁白[ \t]*[/／][ \t]*心声为画外音[^。\n]*。?/g

export function stripLegacyAudioInstruction(prompt: string): string {
  if (!prompt) return ''
  return String(prompt)
    .replace(/\r\n?/g, '\n')
    .replace(AUDIO_LINE_RE, line => (GENERIC_AUDIO_MARKERS.test(line) ? '' : line))
    .replace(NARRATION_CLAUSE_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
