<template>
  <div class="chain-settings">
    <div class="chain-head">
      <div>
        <h2 class="chain-title">{{ t('settings.pipeline.title', '分镜流水线') }}</h2>
        <p class="chain-desc">{{ t('settings.pipeline.subtitle', '固定模板 + 开关/参数：必选步骤不可关闭，可选步骤与阈值可调；每次运行会固化快照。') }}</p>
      </div>
      <div class="chain-actions">
        <button class="btn btn-sm" :disabled="loading" @click="load">
          <RefreshCw :size="13" :class="{ 'animate-spin': loading }" />
          {{ t('settings.pipeline.refresh', '刷新') }}
        </button>
        <button class="btn btn-sm" :disabled="!selectedChain || saving" @click="reset">
          {{ t('settings.pipeline.reset', '恢复默认') }}
        </button>
        <button class="btn btn-primary btn-sm" :disabled="!selectedChain || saving" @click="save">
          <Loader2 v-if="saving" :size="13" class="animate-spin" />
          {{ saving ? t('settings.pipeline.saving', '保存中…') : t('settings.pipeline.save', '保存参数') }}
        </button>
      </div>
    </div>

    <p v-if="error" class="chain-error" role="alert">{{ error }}</p>
    <p v-else-if="saved" class="chain-saved">{{ t('settings.pipeline.saved', '参数已保存') }}</p>

    <div v-if="loading && !chains.length" class="chain-empty">{{ t('common.loading', '加载中…') }}</div>
    <template v-else>
      <section class="chain-section">
        <div class="chain-section-title">{{ t('settings.pipeline.templates', '流水线模板') }}</div>
        <div class="chain-template-grid">
          <button
            v-for="item in chains"
            :key="item.key"
            type="button"
            :class="['chain-template', { active: item.key === selectedKey }]"
            @click="selectChain(item.key)"
          >
            <strong>{{ item.name }}</strong>
            <span>{{ item.description }}</span>
            <small>{{ item.steps.length }} 步 · 版本 {{ item.version }}</small>
          </button>
        </div>
      </section>

      <section v-if="selectedChain" class="chain-section">
        <div class="chain-section-title">{{ t('settings.pipeline.steps', '步骤') }}</div>
        <p class="chain-hint">{{ t('settings.pipeline.stepsHint', '必选步骤显示锁定标记；预留步骤暂不可启用，后续批次接入。') }}</p>
        <div class="chain-step-list">
          <div v-for="(step, index) in selectedChain.steps" :key="step.key" class="chain-step">
            <div class="chain-step-main">
              <div class="chain-step-title">
                <span class="chain-step-index">{{ index + 1 }}</span>
                <strong>{{ step.name }}</strong>
                <span class="tag">{{ step.kind }}</span>
                <span class="tag">{{ step.scope }}</span>
                <span v-if="step.required" class="tag tag-success">{{ t('settings.pipeline.required', '必选') }}</span>
                <span v-else class="tag">{{ t('settings.pipeline.optional', '可选') }}</span>
                <span v-if="!step.available" class="tag chain-tag-muted">{{ t('settings.pipeline.reserved', '预留') }}</span>
              </div>
              <div class="chain-step-desc">{{ step.description }}</div>
              <div v-if="step.note" class="chain-step-note">{{ step.note }}</div>
              <div v-if="step.knowledgeRefs?.length" class="chain-step-knowledge">
                <span class="chain-step-label">{{ t('settings.pipeline.knowledge', '知识库') }}</span>
                <label v-for="knowledge in knowledgeItems" :key="knowledge.id" class="chain-check">
                  <input
                    type="checkbox"
                    :checked="(knowledgeRefs[step.key] || []).includes(knowledge.id)"
                    :disabled="!step.available"
                    @change="toggleKnowledge(step.key, knowledge.id, $event)"
                  >
                  <span>{{ knowledge.name }}</span>
                </label>
              </div>
            </div>
            <label v-if="!step.required" class="chain-switch">
              <input
                type="checkbox"
                :checked="stepToggles[step.key] !== false"
                :disabled="!step.available"
                :aria-label="step.name"
                @change="stepToggles[step.key] = $event.target.checked"
              >
              <span class="switch" :class="{ on: stepToggles[step.key] !== false }"></span>
            </label>
          </div>
        </div>
      </section>

      <section v-if="selectedChain" class="chain-section">
        <div class="chain-section-title">{{ t('settings.pipeline.parameters', '参数') }}</div>
        <div class="chain-param-grid">
          <label v-for="param in selectedChain.parameters" :key="param.key" class="chain-param">
            <span class="field-label">{{ param.label }}</span>
            <template v-if="param.type === 'boolean'">
              <span class="chain-switch-inline">
                <input v-model="params[param.key]" type="checkbox" :disabled="param.locked">
                <span class="switch" :class="{ on: params[param.key] }"></span>
              </span>
            </template>
            <template v-else-if="param.type === 'string'">
              <select v-model="params[param.key]" class="input" :disabled="param.locked">
                <option v-for="option in param.options || []" :key="option" :value="option">
                  {{ option === 'inherit' ? t('settings.pipeline.inherit', '跟随剧集设置') : option }}
                </option>
              </select>
            </template>
            <template v-else>
              <input v-model.number="params[param.key]" class="input" type="number" :min="param.min" :max="param.max" :step="param.step || 1" :disabled="param.locked">
            </template>
            <span v-if="param.description" class="chain-param-desc">{{ param.description }}</span>
            <span v-if="param.min !== undefined || param.max !== undefined" class="chain-param-range">
              {{ param.min }}–{{ param.max }}
            </span>
          </label>
        </div>
      </section>

      <section class="chain-section">
        <div class="chain-section-title">{{ t('settings.pipeline.rules', '规则包') }}</div>
        <p class="chain-hint">{{ t('settings.pipeline.rulesHint', '锁定规则不可关闭；阈值可在参数中调整，超出安全范围会被后端拒绝。') }}</p>
        <div class="chain-rule-list">
          <div v-for="pack in rulePacks" :key="pack.key" class="chain-rule-pack">
            <div class="chain-rule-title">
              <strong>{{ pack.name }}</strong>
              <span class="tag">{{ pack.key }}</span>
              <span class="tag">v{{ pack.version }}</span>
            </div>
            <ul>
              <li v-for="rule in pack.rules" :key="rule.key">
                <span :class="['tag', rule.locked ? 'tag-success' : '']">{{ rule.locked ? t('settings.pipeline.locked', '锁定') : t('settings.pipeline.adjustable', '可调') }}</span>
                <span>{{ rule.name }}</span>
                <span class="chain-rule-desc">{{ rule.description }}</span>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, Loader2 } from 'lucide-vue-next'
import { pipelineChainAPI, knowledgeAPI } from '~/composables/useApi'

const { t, locale } = useI18n()
const loading = ref(false)
const saving = ref(false)
const saved = ref(false)
const error = ref('')
const chains = ref([])
const selectedKey = ref('')
const selectedChain = ref(null)
const rulePacks = ref([])
const knowledgeItems = ref([])
const params = reactive({})
const stepToggles = reactive({})
const knowledgeRefs = reactive({})

function applyView(view) {
  selectedChain.value = view
  for (const key of Object.keys(params)) delete params[key]
  for (const param of view.parameters || []) {
    const value = param.value
    params[param.key] = typeof value === 'number' && Number(param.step || 1) < 1
      ? Number(value.toFixed(2))
      : value
  }
  for (const key of Object.keys(stepToggles)) delete stepToggles[key]
  for (const step of view.steps || []) stepToggles[step.key] = step.enabled
  for (const key of Object.keys(knowledgeRefs)) delete knowledgeRefs[key]
  for (const step of view.steps || []) {
    const override = view.overrides?.knowledgeRefs?.[step.key]
    knowledgeRefs[step.key] = Array.isArray(override) && override.length ? [...override] : [...(step.knowledgeRefs || [])]
  }
}

async function loadChainDetail(key) {
  if (!key) return
  loading.value = true
  error.value = ''
  try {
    const view = await pipelineChainAPI.chain(key, 'global', 0)
    applyView(view)
  } catch (err) {
    error.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

async function selectChain(key) {
  if (saving.value) return
  selectedKey.value = key
  await loadChainDetail(key)
}

async function load() {
  loading.value = true
  error.value = ''
  saved.value = false
  try {
    const [chainResult, packResult, knowledgeResult] = await Promise.all([
      pipelineChainAPI.chains('global', 0),
      pipelineChainAPI.rulePacks(),
      knowledgeAPI.list(locale.value || 'zh'),
    ])
    chains.value = chainResult?.list || []
    rulePacks.value = packResult?.list || []
    knowledgeItems.value = knowledgeResult || []
    if (!selectedKey.value || !chains.value.some(item => item.key === selectedKey.value)) {
      selectedKey.value = chains.value.some(item => item.key === 'standard-four-stage')
        ? 'standard-four-stage'
        : (chains.value[0]?.key || '')
    }
    await loadChainDetail(selectedKey.value)
  } catch (err) {
    error.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

function toggleKnowledge(stepKey, knowledgeId, event) {
  const checked = Boolean(event?.target?.checked)
  const current = new Set(knowledgeRefs[stepKey] || [])
  if (checked) current.add(knowledgeId)
  else current.delete(knowledgeId)
  knowledgeRefs[stepKey] = [...current]
}

async function save() {
  if (!selectedChain.value || saving.value) return
  saving.value = true
  saved.value = false
  error.value = ''
  try {
    const result = await pipelineChainAPI.saveOverrides(selectedChain.value.key, {
      scope_type: 'global',
      scope_id: 0,
      parameters: { ...params },
      step_toggles: { ...stepToggles },
      knowledge_refs: { ...knowledgeRefs },
    })
    if (result?.chain) applyView(result.chain)
    saved.value = true
  } catch (err) {
    error.value = err?.message || String(err)
  } finally {
    saving.value = false
  }
}

async function reset() {
  if (!selectedChain.value || saving.value) return
  saving.value = true
  error.value = ''
  saved.value = false
  try {
    const view = await pipelineChainAPI.resetOverrides(selectedChain.value.key, 'global', 0)
    if (view) applyView(view)
    saved.value = true
  } catch (err) {
    error.value = err?.message || String(err)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.chain-settings { display: flex; flex-direction: column; gap: 18px; }
.chain-head { display: flex; gap: 16px; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; }
.chain-title { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
.chain-desc { margin: 0; color: var(--seed-muted); font-size: 12px; max-width: 720px; line-height: 1.6; }
.chain-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.chain-error { margin: 0; padding: 8px 10px; border: 1px solid var(--danger, #d9534f); border-radius: 8px; color: var(--danger, #d9534f); font-size: 12px; }
.chain-saved { margin: 0; color: var(--success, #3c9d5d); font-size: 12px; }
.chain-empty { color: var(--seed-muted); font-size: 12px; padding: 12px 0; }
.chain-section { display: flex; flex-direction: column; gap: 8px; }
.chain-section-title { font-size: 13px; font-weight: 600; }
.chain-hint { margin: 0; color: var(--seed-muted); font-size: 12px; line-height: 1.6; }
.chain-template-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; }
.chain-template { text-align: left; border: 1px solid var(--border-standard); background: var(--card-bg); border-radius: 10px; padding: 10px; color: var(--seed-fg); cursor: pointer; display: flex; flex-direction: column; gap: 4px; min-height: 100px; }
.chain-template strong { font-size: 13px; font-weight: 600; }
.chain-template span { color: var(--seed-muted); font-size: 12px; line-height: 1.5; }
.chain-template small { color: var(--seed-muted); font-size: 11px; margin-top: auto; }
.chain-template.active { border-color: var(--seed-primary); box-shadow: 0 0 0 1px var(--seed-primary); }
.chain-step-list { display: flex; flex-direction: column; border: 1px solid var(--border-standard); border-radius: 10px; overflow: hidden; }
.chain-step { display: flex; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--border-subtle); }
.chain-step:last-child { border-bottom: none; }
.chain-step-main { flex: 1; min-width: 0; }
.chain-step-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.chain-step-index { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; background: var(--fill-2); color: var(--seed-muted); font-size: 11px; }
.chain-step-desc { color: var(--seed-muted); font-size: 12px; margin-top: 3px; line-height: 1.5; }
.chain-step-note { color: var(--warning, #b7791f); font-size: 11px; margin-top: 3px; }
.chain-step-knowledge { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.chain-step-label { color: var(--seed-muted); font-size: 11px; }
.chain-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--seed-muted); }
.chain-switch { display: inline-flex; align-items: center; gap: 6px; }
.chain-switch-inline { display: inline-flex; align-items: center; gap: 6px; }
.chain-tag-muted { opacity: .7; }
.chain-param-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.chain-param { display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--border-subtle); border-radius: 8px; padding: 8px 10px; }
.chain-param-desc { color: var(--seed-muted); font-size: 11px; line-height: 1.5; }
.chain-param-range { color: var(--seed-muted); font-size: 11px; }
.chain-rule-list { display: flex; flex-direction: column; gap: 8px; }
.chain-rule-pack { border: 1px solid var(--border-standard); border-radius: 10px; padding: 9px 11px; }
.chain-rule-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.chain-rule-pack ul { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px; }
.chain-rule-pack li { font-size: 12px; color: var(--seed-muted); }
.chain-rule-desc { margin-left: 6px; opacity: .8; }
@media (max-width: 640px) {
  .chain-step { flex-direction: column; }
  .chain-actions { width: 100%; }
}
</style>
