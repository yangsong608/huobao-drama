/** 对白拆分期估算：默认按正常短剧语速；有真实配音证据时用 Voice Timing Profile 覆盖。 */
export const DIALOGUE_CHARS_PER_SECOND = 6
export const DIALOGUE_LINE_PAUSE_SECONDS = 0.25

/** 只统计会被念出的字，标点和空白不参与语速估算。 */
export function speechTextChars(value: string): number {
  return String(value || '').replace(/[\s，。！？；：、“”‘’（）《》【】…—,.!?;:"'()\[\]]/g, '').length
}
