<template>
  <div class="coverage-board">
    <div class="coverage-board-head">
      <div class="coverage-board-copy">
        <strong>覆盖板</strong>
        <span>{{ storyboards.length }} 镜 · {{ groups.length }} 场</span>
      </div>
      <button class="btn btn-sm" :disabled="deriving" @click="deriveAll">
        <Loader2 v-if="deriving" :size="11" class="animate-spin" />
        {{ deriving ? '生成中…' : '刷新计划' }}
      </button>
    </div>

    <div v-if="!groups.length" class="coverage-empty">
      还没有分镜。先拆分或新增镜头，覆盖板会按场景自动分组。
    </div>

    <section v-for="group in groups" :key="group.sceneId" class="coverage-scene">
      <header class="coverage-scene-head">
        <div class="coverage-scene-copy">
          <strong>{{ group.name }}</strong>
          <span>{{ group.shots.length }} 镜 · {{ group.duration }}s</span>
        </div>
        <button class="btn btn-sm" @click="$emit('open-geography', group.scene)">地理卡</button>
      </header>

      <div class="coverage-coverage-line">
        <span v-for="(count, type) in group.counts" :key="type" class="coverage-chip">
          {{ typeLabel(type) }} {{ count }}
        </span>
        <span v-for="gap in group.gaps" :key="gap" class="coverage-chip is-gap">{{ gapLabel(gap) }}</span>
        <span v-if="group.planVersion" class="coverage-chip is-plan">计划 v{{ group.planVersion }}</span>
      </div>

      <div class="coverage-shot-list">
        <div
          v-for="shot in group.shots"
          :key="shot.id"
          :class="['coverage-shot', { active: selectedId === shot.id }]"
          role="button"
          tabindex="0"
          @click="$emit('select', shot)"
          @keydown.enter.prevent="$emit('select', shot)"
          @keydown.space.prevent="$emit('select', shot)"
        >
          <div class="coverage-thumb">
            <video v-if="videoSrc(shot)" :src="videoSrc(shot)" preload="none" muted playsinline />
            <span v-else class="coverage-thumb-empty">无视频</span>
          </div>
          <div class="coverage-shot-main">
            <div class="coverage-shot-title">#{{ shot.storyboard_number }} {{ shot.title || '未命名' }}</div>
            <div class="coverage-shot-meta">
              <select
                class="coverage-type-select"
                :value="shot.coverageType"
                :title="'修改覆盖类型并保存本场计划'"
                @click.stop
                @change="changeCoverageType(group, shot, $event.target.value)"
              >
                <option v-for="(label, type) in TYPE_LABELS" :key="type" :value="type">{{ label }}</option>
              </select>
              · {{ shot.duration }}s
              <template v-if="shot.castNames.length"> · {{ shot.castNames.join('、') }}</template>
            </div>
            <div v-if="shot.screenLeft.length || shot.screenRight.length" class="coverage-shot-screen">
              左 {{ shot.screenLeft.join('、') || '—' }} · 右 {{ shot.screenRight.join('、') || '—' }}
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { toastError } from '~/composables/useToast'
import { planningAPI, storyboardAPI } from '~/composables/useApi'

const props = defineProps({
  episodeId: { type: Number, default: 0 },
  storyboards: { type: Array, default: () => [] },
  scenes: { type: Array, default: () => [] },
  characters: { type: Array, default: () => [] },
  selectedId: { type: Number, default: null },
})
defineEmits(['select', 'open-geography'])

const plans = ref([])
const deriving = ref(false)

const TYPE_LABELS = {
  establishing: '建立',
  master: '主镜',
  two_shot: '双人',
  ots: '过肩',
  single: '单人',
  reaction: '反应',
  insert: '插入',
  pov: '主观',
  action: '动作',
  transition: '过渡',
  long_take: '长镜头',
}
const GAP_LABELS = {
  missing_establishing: '缺建立',
  missing_two_shot: '缺双人',
  missing_reaction: '缺反应',
  missing_insert: '缺插入',
}

function typeLabel(type) { return TYPE_LABELS[type] || type || '未分类' }
function gapLabel(gap) { return GAP_LABELS[gap] || gap }

function summarizeUnits(units) {
  const counts = {}
  for (const unit of units) counts[unit.coverage_type] = (counts[unit.coverage_type] || 0) + 1
  const gaps = []
  if (!counts.establishing) gaps.push('missing_establishing')
  if (units.some(unit => (unit.cast_on_screen || []).length > 1) && !counts.two_shot) gaps.push('missing_two_shot')
  if (!counts.reaction) gaps.push('missing_reaction')
  if (!counts.insert) gaps.push('missing_insert')
  return {
    shot_count: units.length,
    total_duration: Math.round(units.reduce((sum, unit) => sum + (Number(unit.duration) || 0), 0) * 10) / 10,
    counts,
    gaps,
  }
}

async function changeCoverageType(group, shot, type) {
  if (!type || shot.coverageType === type) return
  if (!group.sceneId) {
    toast.warning('该镜没有绑定场景，无法保存覆盖计划')
    return
  }
  const previous = shot.coverageType
  shot.coverageType = type
  try {
    const units = group.shots.map(item => ({
      unit_id: `sb-${item.id}`,
      storyboard_id: item.id,
      storyboard_number: item.storyboard_number ?? item.storyboardNumber,
      title: item.title || '',
      coverage_type: item.coverageType,
      cast_on_screen: parseArray(item.cast_on_screen ?? item.castOnScreen),
      screen_left: item.screenLeft || [],
      screen_right: item.screenRight || [],
      duration: Number(item.duration) || 0,
      shot_type: item.shot_type || item.shotType || '',
    }))
    const summary = summarizeUnits(units)
    await planningAPI.saveCoveragePlan(props.episodeId, group.sceneId, {
      units,
      summary,
      target_duration: summary.total_duration,
      status: 'confirmed',
    })
    await loadPlans()
    toast.success('覆盖类型已保存')
  } catch (error) {
    shot.coverageType = previous
    toastError(error)
  }
}

function parseArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function characterName(id) {
  return props.characters.find(character => character.id === id)?.name || ''
}

function castNames(shot) {
  const ids = parseArray(shot.cast_on_screen ?? shot.castOnScreen)
  if (ids.length) return ids.map(characterName).filter(Boolean)
  return (shot.character_ids || shot.characterIds || []).map(characterName).filter(Boolean)
}

function screenNames(shot, side) {
  const stored = parseArray(side === 'left' ? (shot.screen_left ?? shot.screenLeft) : (shot.screen_right ?? shot.screenRight))
  return stored.filter(name => typeof name === 'string')
}

function inferCoverageType(shot) {
  const explicit = shot.coverage_type ?? shot.coverageType
  if (explicit) return explicit
  const text = `${shot.shot_type || shot.shotType || ''} ${shot.description || ''} ${shot.title || ''}`
  if (/空镜|过渡|转场/.test(text)) return 'transition'
  if (/全景|远景|建立|环境/.test(text)) return 'establishing'
  if (/过肩|肩后|肩越/.test(text)) return 'ots'
  if (/双人|两人|对视|关系镜/.test(text)) return 'two_shot'
  if (/反应|聆听|听着|皱眉|冷笑|震惊/.test(text)) return 'reaction'
  if (/道具|手部|信件|碗|书|刀|灯|琴/.test(text)) return 'insert'
  if (/特写/.test(text)) return 'single'
  return 'single'
}

function videoSrc(shot) {
  const url = shot.video_url || shot.videoUrl || shot.composed_video_url || shot.composedVideoUrl
  if (!url) return ''
  return /^https?:\/\//.test(url) ? url : `/${String(url).replace(/^\/+/, '')}`
}

const latestPlanByScene = computed(() => {
  const map = new Map()
  for (const plan of plans.value) {
    if (!plan.scene_id) continue
    const current = map.get(plan.scene_id)
    if (!current || Number(plan.version) >= Number(current.version)) map.set(plan.scene_id, plan)
  }
  return map
})

const groups = computed(() => {
  const byScene = new Map()
  for (const shot of props.storyboards) {
    const sceneId = shot.scene_id ?? shot.sceneId ?? 0
    if (!byScene.has(sceneId)) byScene.set(sceneId, [])
    byScene.get(sceneId).push(shot)
  }
  const result = []
  for (const [sceneId, shots] of byScene) {
    const scene = props.scenes.find(item => item.id === sceneId) || null
    const plan = latestPlanByScene.value.get(sceneId)
    const unitMap = new Map()
    for (const unit of plan?.units || []) unitMap.set(unit.storyboard_id, unit)
    const enriched = shots
      .slice()
      .sort((a, b) => (a.storyboard_number ?? a.storyboardNumber) - (b.storyboard_number ?? b.storyboardNumber))
      .map(shot => {
        const unit = unitMap.get(shot.id)
        return {
          ...shot,
          coverageType: unit?.coverage_type || inferCoverageType(shot),
          castNames: castNames(shot),
          screenLeft: screenNames(shot, 'left'),
          screenRight: screenNames(shot, 'right'),
        }
      })
    const counts = {}
    for (const shot of enriched) counts[shot.coverageType] = (counts[shot.coverageType] || 0) + 1
    const gaps = plan?.summary?.gaps || []
    result.push({
      sceneId,
      scene: scene || { id: sceneId, location: shots[0]?.location || '未绑定场景' },
      name: scene?.location || shots[0]?.location || '未绑定场景',
      shots: enriched,
      counts,
      gaps,
      duration: Math.round(enriched.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0) * 10) / 10,
      planVersion: plan?.version || 0,
    })
  }
  return result.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'))
})

async function loadPlans() {
  if (!props.episodeId) return
  try {
    plans.value = await planningAPI.coveragePlans(props.episodeId)
  } catch {
    plans.value = []
  }
}

async function deriveAll() {
  if (!props.episodeId || deriving.value) return
  const sceneIds = [...new Set(props.storyboards.map(shot => shot.scene_id ?? shot.sceneId).filter(Boolean))]
  if (!sceneIds.length) return
  deriving.value = true
  try {
    for (const sceneId of sceneIds) {
      await planningAPI.deriveCoveragePlan(props.episodeId, sceneId, { save: true })
    }
    // 覆盖类型落库后同步合同，旧分镜也才能参与成对校验
    try { await storyboardAPI.syncContracts(props.episodeId) } catch { /* 合同同步失败不影响计划 */ }
    await loadPlans()
    toast.success('覆盖计划已刷新')
  } catch (error) {
    toastError(error)
  } finally {
    deriving.value = false
  }
}

onMounted(loadPlans)
watch(() => props.episodeId, loadPlans)
watch(() => props.storyboards, loadPlans)
</script>

<style scoped>
.coverage-board {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow: auto;
  padding: 4px 2px 16px;
}
.coverage-board-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
}
.coverage-board-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.coverage-board-copy strong { font-size: 12px; }
.coverage-board-copy span { font-size: 10px; color: var(--text-3); }
.coverage-empty {
  padding: 18px 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
}
.coverage-scene {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}
.coverage-scene-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 9px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--border);
}
.coverage-scene-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.coverage-scene-copy strong { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.coverage-scene-copy span { font-size: 10px; color: var(--text-3); }
.coverage-coverage-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 9px 0;
}
.coverage-chip {
  font-size: 9px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--text-2);
}
.coverage-chip.is-gap { color: var(--warning); background: var(--warning-bg, rgba(180,120,20,.1)); }
.coverage-chip.is-plan { color: var(--accent-text); background: var(--accent-bg); }
.coverage-shot-list { display: flex; flex-direction: column; gap: 5px; padding: 7px; }
.coverage-shot {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr) auto;
  gap: 7px;
  align-items: center;
  padding: 6px;
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: pointer;
}
.coverage-shot:hover { background: var(--bg-1); }
.coverage-shot.active { border-color: var(--accent); background: var(--accent-bg); }
.coverage-thumb {
  width: 58px; height: 36px; border-radius: 5px; overflow: hidden;
  background: var(--bg-2); display: grid; place-items: center;
}
.coverage-thumb video { width: 100%; height: 100%; object-fit: cover; }
.coverage-thumb-empty { font-size: 8px; color: var(--text-3); }
.coverage-shot-main { min-width: 0; }
.coverage-shot-title { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.coverage-shot-meta { margin-top: 2px; font-size: 9px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.coverage-type-select {
  height: 18px; padding: 0 2px; margin-right: 2px;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg-2); color: var(--text-2);
  font-size: 9px; line-height: 16px; cursor: pointer;
}
.coverage-shot-screen { margin-top: 2px; font-size: 9px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
