<template>
  <div class="prompt-editor">
    <div class="prompt-editor-head">
      <span class="prompt-editor-title">{{ copy.title }}</span>
      <span class="prompt-editor-hint">{{ copy.hint }}</span>
    </div>

    <section class="prompt-section">
      <div class="prompt-section-head"><b>1</b><span>{{ copy.cast }}</span><em>@</em></div>
      <MentionTextarea
        :model-value="castText"
        :options="options"
        :rows="1"
        input-class="textarea prompt-section-input"
        :placeholder="copy.castPlaceholder"
        @update:model-value="onCastInput"
        @commit="commitAll"
      />
    </section>

    <section class="prompt-section">
      <div class="prompt-section-head"><b>2</b><span>{{ copy.scene }}</span><em>@</em></div>
      <MentionTextarea
        :model-value="sceneText"
        :options="options"
        :rows="1"
        input-class="textarea prompt-section-input"
        :placeholder="copy.scenePlaceholder"
        @update:model-value="onSceneInput"
        @commit="commitAll"
      />
    </section>

    <section class="prompt-section">
      <div class="prompt-section-head"><b>3</b><span>{{ copy.blocking }}</span><em>@</em></div>
      <MentionTextarea
        :model-value="blocking"
        :options="options"
        :rows="3"
        input-class="textarea prompt-section-input"
        :placeholder="copy.blockingPlaceholder"
        @update:model-value="onBlockingInput"
        @commit="commitAll"
      />
    </section>

    <section class="prompt-section">
      <div class="prompt-section-head">
        <b>4</b><span>{{ copy.segments }}</span>
        <button type="button" class="btn btn-sm prompt-add-segment" @click="addSegment">{{ copy.addSegment }}</button>
      </div>
      <div class="prompt-segment-list">
        <div v-for="(segment, index) in segments" :key="segment.id" class="prompt-segment">
          <div class="prompt-segment-time">
            <span class="prompt-segment-range">{{ fmt(segment.start) }}–{{ fmt(segment.end) }}s</span>
            <span class="prompt-segment-duration">{{ fmt(segmentDuration(segment)) }}s</span>
            <button type="button" class="btn btn-sm prompt-segment-step" :title="copy.shorten" @click="adjustSegment(index, -0.5)">−</button>
            <button type="button" class="btn btn-sm prompt-segment-step" :title="copy.lengthen" @click="adjustSegment(index, 0.5)">＋</button>
          </div>
          <MentionTextarea
            :model-value="segment.text"
            :options="options"
            :rows="2"
            input-class="textarea prompt-section-input prompt-segment-input"
            :placeholder="copy.segmentPlaceholder"
            @update:model-value="value => onSegmentInput(index, value)"
            @commit="commitAll"
          />
          <button
            v-if="segments.length > 1"
            type="button"
            class="btn btn-sm prompt-segment-remove"
            :title="copy.removeSegment"
            @click="removeSegment(index)"
          >×</button>
        </div>
      </div>
      <div class="prompt-segment-foot">
        <span class="prompt-total">{{ copy.total }} <b>{{ fmt(totalDuration) }}s</b></span>
        <label class="prompt-lock">
          <input v-model="lockTotal" type="checkbox" />
          {{ copy.lockTotal }}
        </label>
        <button type="button" class="btn btn-sm" @click="evenSegments">{{ copy.even }}</button>
        <button type="button" class="btn btn-sm" @click="fitDialogue">{{ copy.fitDialogue }}</button>
        <span v-if="segmentWarning" class="prompt-segment-warning">{{ segmentWarning }}</span>
      </div>
    </section>

    <section class="prompt-section">
      <div class="prompt-section-head"><b>5</b><span>{{ copy.negative }}</span><em>{{ copy.negativeHint }}</em></div>
      <MentionTextarea
        :model-value="negative"
        :options="options"
        :rows="2"
        input-class="textarea prompt-section-input"
        :placeholder="copy.negativePlaceholder"
        @update:model-value="onNegativeInput"
        @commit="commitAll"
      />
    </section>
    <div v-if="sound.trim()" class="prompt-sound-note">{{ copy.soundLocked }}</div>

    <details class="prompt-raw">
      <summary>{{ copy.raw }}</summary>
      <pre>{{ rendered }}</pre>
    </details>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MentionTextarea from '~/components/MentionTextarea.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  duration: { type: Number, default: 10 },
})
const emit = defineEmits(['update:modelValue', 'commit', 'duration'])
const { locale } = useI18n()

const COPY = {
  zh: {
    title: '视频提示词',
    hint: '固定分区；Enter 换行，Ctrl/Cmd+Enter 保存；@/# 可插入资产。',
    cast: '出场人物', castPlaceholder: '只写画内人物，如 @唐大奕',
    scene: '场景', scenePlaceholder: '如 @邓州小饭馆',
    blocking: '画面调度', blockingPlaceholder: '画面左是谁、右边是谁、过谁的肩、背景窗/门/桌在哪；动作起点：…；动作终点：…',
    segments: '时间帧分段', addSegment: '添加分段', removeSegment: '删除本段',
    segmentPlaceholder: '这一段的画面与台词/旁白',
    shorten: '缩短 0.5 秒', lengthen: '延长 0.5 秒',
    total: '总时长', lockTotal: '锁定总时长', even: '均分', fitDialogue: '按台词分配',
    sound: '声音', soundHint: 'BGM / 环境声', soundPlaceholder: 'BGM：轻快市井弦乐；环境声：清晨街市人声、炊具碰撞、远处叫卖',
    soundLocked: '声音由第四步按场景/剧情统一设计，这里只读保留；编辑其他分区不会丢失。',
    negative: '负面约束', negativeHint: '默认约束可删改',
    negativePlaceholder: '只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
    raw: '查看渲染原文',
    minMax: '每段 1–6 秒；总时长受当前模式和模型上限约束。',
  },
  en: {
    title: 'Video prompt',
    hint: 'Fixed sections; Enter for a new line, Ctrl/Cmd+Enter to save; @/# inserts assets.',
    cast: 'On-screen cast', castPlaceholder: 'On-screen characters only, e.g. @Tang Yi',
    scene: 'Scene', scenePlaceholder: 'e.g. @Dengzhou tavern',
    blocking: 'Blocking', blockingPlaceholder: 'Who is screen-left/right, over whose shoulder, window/door/table; action start/end',
    segments: 'Time segments', addSegment: 'Add segment', removeSegment: 'Remove segment',
    segmentPlaceholder: 'Action and dialogue/narration for this segment',
    shorten: 'Shorten 0.5s', lengthen: 'Lengthen 0.5s',
    total: 'Total', lockTotal: 'Lock total', even: 'Even', fitDialogue: 'Fit dialogue',
    sound: 'Sound', soundHint: 'BGM / ambience', soundPlaceholder: 'BGM: light marketplace strings; ambience: morning street crowd, cookware, distant calls',
    soundLocked: 'Sound is designed in step 4 by scene/plot; it is preserved read-only here and not lost when editing other sections.',
    negative: 'Negative constraints', negativeHint: 'Defaults can be edited',
    negativePlaceholder: 'Only listed cast; no face/costume/extra people; no subtitles; no modern items',
    raw: 'Show rendered prompt',
    minMax: 'Each segment 1–6s; total is bounded by mode and model limit.',
  },
  ja: {
    title: '動画プロンプト',
    hint: '固定セクション。Enter で改行、Ctrl/Cmd+Enter で保存、@/# で素材を挿入。',
    cast: '登場人物', castPlaceholder: '画面内の人物のみ、例 @唐奕',
    scene: 'シーン', scenePlaceholder: '例 @鄧州の小さな食堂',
    blocking: '画面演出', blockingPlaceholder: '画面左/右、誰の肩越し、窓/扉/机の位置；動作開始：…；動作終了：…',
    segments: '時間セグメント', addSegment: 'セグメント追加', removeSegment: 'このセグメントを削除',
    segmentPlaceholder: 'この区間の画面と台詞/ナレーション',
    shorten: '0.5秒短く', lengthen: '0.5秒長く',
    total: '合計', lockTotal: '合計を固定', even: '均等', fitDialogue: '台詞に合わせる',
    sound: '音響', soundHint: 'BGM / 環境音', soundPlaceholder: 'BGM：軽快な市場の弦楽；環境音：朝の街の人声、調理器具、遠くの呼び声',
    soundLocked: '音響は第4ステップでシーン/物語単位に設計されます。ここでは読み取り専用で保持され、他のセクションを編集しても失われません。',
    negative: 'ネガティブ制約', negativeHint: '既定値は編集可',
    negativePlaceholder: '画面内の人物のみ、顔/衣装/人数を変えない、字幕なし、現代物品なし',
    raw: 'レンダリング原文を表示',
    minMax: '各セグメント 1–6 秒。合計はモードとモデル上限に従います。',
  },
  ko: {
    title: '비디오 프롬프트',
    hint: '고정 섹션; Enter로 줄바꿈, Ctrl/Cmd+Enter로 저장, @/#로 자산 삽입.',
    cast: '화면 인물', castPlaceholder: '화면에 나오는 인물만, 예 @탕이',
    scene: '장면', scenePlaceholder: '예 @덩저우 작은 식당',
    blocking: '화면 연출', blockingPlaceholder: '화면 왼쪽/오른쪽, 누구 어깨 너머, 창/문/책상 위치; 동작 시작: …; 동작 끝: …',
    segments: '시간 구간', addSegment: '구간 추가', removeSegment: '이 구간 삭제',
    segmentPlaceholder: '이 구간의 화면과 대사/내레이션',
    shorten: '0.5초 줄이기', lengthen: '0.5초 늘리기',
    total: '총 길이', lockTotal: '총 길이 고정', even: '균등', fitDialogue: '대사에 맞춤',
    sound: '사운드', soundHint: 'BGM / 환경음', soundPlaceholder: 'BGM: 경쾌한 시장 현악; 환경음: 아침 거리 인파, 조리도구, 먼 외침',
    soundLocked: '사운드는 4단계에서 장면/서사 단위로 설계됩니다. 여기서는 읽기 전용으로 유지되며 다른 섹션을 편집해도 사라지지 않습니다.',
    negative: '네거티브 제약', negativeHint: '기본값 편집 가능',
    negativePlaceholder: '화면 인물만, 얼굴/의상/인원 변경 금지, 자막 금지, 현대 물품 금지',
    raw: '렌더링 원문 보기',
    minMax: '구간당 1–6초; 총 길이는 모드와 모델 한도에 따릅니다.',
  },
}

const copy = computed(() => COPY[locale.value] || COPY.zh)

const castText = ref('')
const sceneText = ref('')
const blocking = ref('')
const sound = ref('')
const negative = ref('')
const segments = ref([])
const unrecognized = ref([])
const lockTotal = ref(true)
const segmentWarning = ref('')
let nextSegmentId = 1

const timeUnit = computed(() => {
  if (locale.value === 'en') return 's'
  if (locale.value === 'ko') return '초'
  return '秒'
})
const headerLabels = computed(() => {
  if (locale.value === 'en') return { cast: 'Characters', scene: 'Scene', blocking: 'Blocking', sound: 'Sound', negative: 'Negative constraints', none: 'None', unspecified: 'Unspecified' }
  if (locale.value === 'ja') return { cast: '登場人物', scene: 'シーン', blocking: '画面演出', sound: '音響', negative: 'ネガティブ制約', none: 'なし', unspecified: '未指定' }
  if (locale.value === 'ko') return { cast: '등장인물', scene: '장면', blocking: '화면 연출', sound: '사운드', negative: '네거티브 제약', none: '없음', unspecified: '미지정' }
  return { cast: '出场人物', scene: '场景', blocking: '画面调度', sound: '声音', negative: '负面约束', none: '无', unspecified: '未指定' }
})

const defaultNegative = computed(() => copy.value.negativePlaceholder)

const totalDuration = computed(() => segments.value.reduce((sum, segment) => sum + segmentDuration(segment), 0))

const rendered = computed(() => buildPrompt())

function segmentDuration(segment) {
  return Math.max(0, round1(segment.end - segment.start))
}
function round1(value) {
  return Math.round(value * 10) / 10
}
function fmt(value) {
  return round1(Number(value) || 0).toFixed(1).replace(/\.0$/, '')
}

function segmentId() {
  return `seg-${nextSegmentId++}`
}

function parsePrompt(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n')
  const first = lines.find(line => line.trim())
  const normalized = first ? first.trim() : ''
  const labels = headerLabels.value
  let cast = ''
  let scene = ''
  if (normalized) {
    const parts = normalized.split(/[｜|]/).map(part => part.trim())
    for (const part of parts) {
      if (new RegExp(`^(?:${labels.cast}|Characters|登場人物|등장인물)\\s*[：:]`, 'i').test(part)) {
        cast = part.replace(new RegExp(`^(?:${labels.cast}|Characters|登場人物|등장인물)\\s*[：:]\\s*`, 'i'), '')
      } else if (new RegExp(`^(?:${labels.scene}|Scene|シーン|장면)\\s*[：:]`, 'i').test(part)) {
        scene = part.replace(new RegExp(`^(?:${labels.scene}|Scene|シーン|장면)\\s*[：:]\\s*`, 'i'), '')
      }
    }
    if (!cast && !scene) cast = normalized
  }

  const nextSegments = []
  const nextUnrecognized = []
  let nextBlocking = ''
  let nextSound = ''
  let nextNegative = ''
  const timeRe = /^\s*(\d+(?:\.\d+)?)\s*[-–—~至到]\s*(\d+(?:\.\d+)?)\s*(?:秒|s|초)\s*[：:]\s*(.*)$/i
  const bracketRe = /^\s*\[(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)s\]\s*(.*)$/i
  for (const line of lines) {
    if (!line.trim() || line === first) continue
    const time = timeRe.exec(line) || bracketRe.exec(line)
    if (time) {
      nextSegments.push({ id: segmentId(), start: Number(time[1]), end: Number(time[2]), text: time[3] || '' })
      continue
    }
    const blockingMatch = new RegExp(`^(?:${labels.blocking}|Blocking)\\s*[：:]\\s*(.*)$`, 'i').exec(line)
    if (blockingMatch) { nextBlocking = blockingMatch[1]; continue }
    const soundMatch = new RegExp(`^(?:${labels.sound}|Sound|音響|사운드)\\s*[：:]\\s*(.*)$`, 'i').exec(line)
    if (soundMatch) { nextSound = soundMatch[1]; continue }
    const negativeMatch = new RegExp(`^(?:${labels.negative}|Negative constraints|ネガティブ制約|네거티브 제약)\\s*[：:]\\s*(.*)$`, 'i').exec(line)
    if (negativeMatch) { nextNegative = negativeMatch[1]; continue }
    nextUnrecognized.push(line)
  }

  if (!nextSegments.length) {
    const duration = Math.max(1, Number(props.duration) || 10)
    nextSegments.push({ id: segmentId(), start: 0, end: duration, text: nextUnrecognized.join('\n').trim() })
    nextUnrecognized.length = 0
  }

  castText.value = cast
  sceneText.value = scene
  blocking.value = nextBlocking
  sound.value = nextSound
  negative.value = nextNegative || defaultNegative.value
  segments.value = nextSegments
  unrecognized.value = nextUnrecognized
  segmentWarning.value = ''
  normalizeSegmentTimes()
}

function onCastInput(value) { castText.value = value; emitPrompt() }
function onSceneInput(value) { sceneText.value = value; emitPrompt() }
function onBlockingInput(value) { blocking.value = value; emitPrompt() }
function onSoundInput(value) { sound.value = value; emitPrompt() }
function onNegativeInput(value) { negative.value = value; emitPrompt() }
function onSegmentInput(index, value) {
  const segment = segments.value[index]
  if (!segment) return
  segment.text = value
  emitPrompt()
}

function buildPrompt() {
  const labels = headerLabels.value
  const cast = castText.value.trim().replace(/\s*\n+\s*/g, ' ') || labels.none
  const scene = sceneText.value.trim().replace(/\s*\n+\s*/g, ' ') || labels.unspecified
  const lines = [`${labels.cast}：${cast}｜${labels.scene}：${scene}`]
  if (blocking.value.trim()) lines.push(`${labels.blocking}：${blocking.value.trim()}`)
  for (const segment of segments.value) {
    const text = String(segment.text || '').replace(/\s+$/g, '')
    lines.push(`${fmt(segment.start)}-${fmt(segment.end)}${timeUnit.value}：${text}`)
  }
  if (unrecognized.value.length) lines.push(...unrecognized.value)
  if (sound.value.trim()) lines.push(`${labels.sound}：${sound.value.trim()}`)
  if (negative.value.trim()) lines.push(`${labels.negative}：${negative.value.trim()}`)
  return lines.join('\n')
}

function emitPrompt() {
  const value = buildPrompt()
  emit('update:modelValue', value)
  emit('duration', totalDuration.value)
}

function commitAll() {
  const value = buildPrompt()
  emit('update:modelValue', value)
  emit('commit', value)
  emit('duration', totalDuration.value)
}

function normalizeSegmentTimes() {
  let cursor = 0
  for (const segment of segments.value) {
    const duration = clamp(segmentDuration(segment) || 1, 1, 6)
    segment.start = round1(cursor)
    segment.end = round1(cursor + duration)
    cursor = segment.end
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function updateTimesFromStart(startIndex = 0) {
  let cursor = startIndex === 0 ? 0 : segments.value[startIndex - 1].end
  for (let index = startIndex; index < segments.value.length; index += 1) {
    const segment = segments.value[index]
    const duration = clamp(segmentDuration(segment) || 1, 1, 6)
    segment.start = round1(cursor)
    segment.end = round1(cursor + duration)
    cursor = segment.end
  }
}

function adjustSegment(index, delta) {
  const segment = segments.value[index]
  if (!segment) return
  const oldDuration = segmentDuration(segment)
  const nextDuration = clamp(oldDuration + delta, 1, 6)
  if (nextDuration === oldDuration) return
  segmentWarning.value = ''
  if (lockTotal.value) {
    const total = totalDuration.value
    const others = segments.value.filter((_, i) => i !== index)
    if (!others.length) {
      segment.end = round1(segment.start + nextDuration)
      segmentWarning.value = copy.value.minMax
      normalizeSegmentTimes()
      emitPrompt()
      return
    }
    let remaining = round1(total - nextDuration)
    const minTotal = others.length * 1
    const maxTotal = others.length * 6
    if (remaining < minTotal || remaining > maxTotal) {
      segmentWarning.value = copy.value.minMax
      return
    }
    const oldOthers = others.reduce((sum, item) => sum + segmentDuration(item), 0)
    for (const item of others) {
      const share = oldOthers > 0 ? segmentDuration(item) / oldOthers : 1 / others.length
      item.end = round1(item.start + clamp(remaining * share, 1, 6))
    }
    // 逐段修正，保证其他段之和等于 remaining
    let currentOthers = others.reduce((sum, item) => sum + segmentDuration(item), 0)
    let guard = 0
    while (Math.abs(currentOthers - remaining) > 0.05 && guard < 20) {
      guard += 1
      for (const item of others) {
        const diff = round1(remaining - currentOthers)
        if (Math.abs(diff) <= 0.05) break
        const next = clamp(segmentDuration(item) + diff, 1, 6)
        item.end = round1(item.start + next)
        currentOthers = others.reduce((sum, entry) => sum + segmentDuration(entry), 0)
      }
    }
    segment.end = round1(segment.start + nextDuration)
    // 按顺序重排 start/end，保留每段时长
    let cursor = 0
    for (const item of segments.value) {
      const duration = clamp(segmentDuration(item), 1, 6)
      item.start = round1(cursor)
      item.end = round1(cursor + duration)
      cursor = item.end
    }
    if (Math.abs(cursor - total) > 0.05) segmentWarning.value = copy.value.minMax
  } else {
    segment.end = round1(segment.start + nextDuration)
    updateTimesFromStart(index + 1)
  }
  emitPrompt()
}

function addSegment() {
  const last = segments.value[segments.value.length - 1]
  const start = last ? last.end : 0
  const end = round1(start + 2)
  segments.value.push({ id: segmentId(), start, end, text: '' })
  emitPrompt()
}

function removeSegment(index) {
  if (segments.value.length <= 1) return
  segments.value.splice(index, 1)
  normalizeSegmentTimes()
  emitPrompt()
}

function evenSegments() {
  const total = totalDuration.value
  const count = segments.value.length
  if (!count) return
  const each = clamp(round1(total / count), 1, 6)
  for (const segment of segments.value) {
    segment.end = round1(segment.start + each)
  }
  normalizeSegmentTimes()
  emitPrompt()
}

function fitDialogue() {
  for (const segment of segments.value) {
    const chars = String(segment.text || '').replace(/\s+/g, '').length
    const seconds = clamp(Math.ceil(chars / 4 + 0.5), 1, 6)
    segment.end = round1(segment.start + seconds)
  }
  if (lockTotal.value) {
    const total = totalDuration.value
    let current = segments.value.reduce((sum, segment) => sum + segmentDuration(segment), 0)
    let guard = 0
    while (current < total && guard < 40) {
      guard += 1
      for (const segment of segments.value) {
        if (current >= total) break
        const next = clamp(segmentDuration(segment) + 0.5, 1, 6)
        if (next !== segmentDuration(segment)) {
          segment.end = round1(segment.start + next)
          current = segments.value.reduce((sum, item) => sum + segmentDuration(item), 0)
        }
      }
      if (!segments.value.some(segment => segmentDuration(segment) < 6)) break
    }
    while (current > total && guard < 80) {
      guard += 1
      for (const segment of segments.value) {
        if (current <= total) break
        const next = clamp(segmentDuration(segment) - 0.5, 1, 6)
        if (next !== segmentDuration(segment)) {
          segment.end = round1(segment.start + next)
          current = segments.value.reduce((sum, item) => sum + segmentDuration(item), 0)
        }
      }
      if (!segments.value.some(segment => segmentDuration(segment) > 1)) break
    }
  }
  normalizeSegmentTimes()
  emitPrompt()
}

watch(() => props.modelValue, (value) => {
  if (String(value || '') === rendered.value) return
  parsePrompt(value)
}, { immediate: true })

watch(() => props.duration, (value) => {
  if (!segments.value.length) return
  if (segments.value.length === 1 && !String(segments.value[0].text || '').trim()) {
    segments.value[0].end = Math.max(1, Number(value) || 10)
    emitPrompt()
  }
})
</script>

<style scoped>
.prompt-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.prompt-editor-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.prompt-editor-title { font-size: 12px; font-weight: 700; }
.prompt-editor-hint { font-size: 10.5px; color: var(--text-3); }
.prompt-section {
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
  padding: 8px;
}
.prompt-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 700;
}
.prompt-section-head b {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 5px;
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 9px;
}
.prompt-section-head em {
  margin-left: auto;
  font-style: normal;
  font-size: 9.5px;
  color: var(--text-3);
  font-weight: 400;
}
.prompt-section-input { width: 100%; }
.prompt-add-segment { margin-left: auto; height: 24px; padding: 0 8px; font-size: 10px; }
.prompt-segment-list { display: flex; flex-direction: column; gap: 7px; }
.prompt-segment {
  display: grid;
  grid-template-columns: 1fr 24px;
  gap: 6px;
  align-items: start;
  border-top: 1px dashed var(--border);
  padding-top: 7px;
}
.prompt-segment:first-child { border-top: 0; padding-top: 0; }
.prompt-segment-time {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  color: var(--text-2);
}
.prompt-segment-range { font-weight: 700; color: var(--text-1); font-variant-numeric: tabular-nums; }
.prompt-segment-duration { color: var(--text-3); font-variant-numeric: tabular-nums; }
.prompt-segment-step { height: 22px; min-width: 24px; padding: 0 5px; font-size: 11px; }
.prompt-segment-input { grid-column: 1; }
.prompt-segment-remove { grid-column: 2; height: 28px; padding: 0; }
.prompt-segment-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-top: 7px;
  font-size: 10px;
  color: var(--text-3);
}
.prompt-total b { color: var(--text-1); font-variant-numeric: tabular-nums; }
.prompt-lock { display: inline-flex; align-items: center; gap: 4px; }
.prompt-segment-warning { color: var(--warning); }
.prompt-raw { font-size: 10px; color: var(--text-3); }
.prompt-raw summary { cursor: pointer; }
.prompt-raw pre {
  margin: 6px 0 0;
  padding: 8px;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-2);
  border-radius: 6px;
  color: var(--text-2);
}
</style>
