import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const api = read('app/composables/useApi.ts')
const session = read('app/composables/useExportSession.ts')
const stage = read('app/components/ExportStage.vue')
const dubbing = read('app/components/DubbingStage.vue')

test('export API covers checks, start, list, detail and lifecycle actions', () => {
  assert.match(api, /export type ExportKind/)
  assert.match(api, /export type ExportSubtitleMode/)
  assert.match(api, /export interface ExportRecord/)
  assert.match(api, /export interface ExportChecks/)
  assert.match(api, /export const exportAPI/)
  assert.match(api, /export-checks/)
  assert.match(api, /\/exports\/\$\{id\}\/cancel/)
  assert.match(api, /\/exports\/\$\{id\}\/retry/)
  assert.match(api, /\/exports\/\$\{id\}\/current/)
})

test('export session polls 1.5s while a record is pending or running', () => {
  assert.match(session, /export function useExportSession/)
  assert.match(session, /exportAPI/)
  assert.match(session, /POLL_INTERVAL_MS = 1500/)
  assert.match(session, /record\.status === 'pending'/)
  assert.match(session, /record\.status === 'running'/)
  assert.match(session, /async function start\(kind: ExportKind\)/)
  assert.match(session, /async function retry/)
  assert.match(session, /async function cancel/)
  assert.match(session, /async function setCurrent/)
  assert.match(session, /async function remove/)
  assert.match(session, /subtitleMode/)
  assert.match(session, /startPolling/)
  assert.match(session, /stopPolling/)
})

test('export session disposes without resurrecting polling', () => {
  assert.match(session, /let disposed = false/)
  assert.match(session, /function dispose\(\)/)
  assert.match(session, /if \(disposed\) return/)
  assert.match(stage, /onBeforeUnmount\(dispose\)/)
})

test('export stage shows checks, presets and three export entries without editing controls', () => {
  assert.match(stage, /useExportSession/)
  assert.match(stage, /checks\.lines|checks\?\.lines/)
  assert.match(stage, /checks\.video|checks\?\.video/)
  assert.match(stage, /checks\.mix|checks\?\.mix/)
  assert.match(stage, /presetOptions/)
  assert.match(stage, /subtitleOptions/)
  assert.match(stage, /setPreset/)
  assert.match(stage, /setSubtitleMode/)
  assert.match(stage, /start\('mix'\)/)
  assert.match(stage, /start\('video'\)/)
  assert.match(stage, /start\('stems'\)/)
  assert.match(stage, /go-stage/)
  assert.match(stage, /'lines'/)
  assert.match(stage, /'generate'/)
  assert.match(stage, /'preview'/)
  assert.match(stage, /setCurrent/)
  assert.match(stage, /remove/)
  assert.match(stage, /isCurrent/)
  assert.match(stage, /audio/)
  assert.doesNotMatch(stage, /startDub|stopDub/)
  assert.doesNotMatch(stage, /textarea/)
  assert.doesNotMatch(stage, /type="file"/)
})

test('dubbing stage mounts export stage as the only fifth-step surface', () => {
  assert.match(dubbing, /import ExportStage from '~\/components\/ExportStage\.vue'/)
  assert.match(dubbing, /<ExportStage/)
  assert.match(dubbing, /:episode-id="episodeId"/)
  assert.match(dubbing, /:drama-id="dramaId"/)
  assert.match(dubbing, /@go-stage="goStep"/)
  assert.match(dubbing, /@changed="exportDone = \$event"/)
  assert.doesNotMatch(dubbing, /@click="startDub"/)
  assert.doesNotMatch(dubbing, /@click="stopDub"/)
})

test('export strings resolve in all four locales', () => {
  const required = [
    'export.noEpisode',
    'export.checkTitle',
    'export.checks.lines',
    'export.checks.video',
    'export.checks.mix',
    'export.checks.subtitles',
    'export.checks.ffmpeg',
    'export.checks.disk',
    'export.presetTitle',
    'export.subtitleMode',
    'export.exportMix',
    'export.exportVideo',
    'export.exportStems',
    'export.progressTitle',
    'export.outputTitle',
    'export.records',
    'export.kind.mix',
    'export.kind.video',
    'export.kind.stems',
    'export.status.pending',
    'export.status.running',
    'export.status.completed',
    'export.status.failed',
    'export.status.cancelled',
    'export.preset.verticalHd',
    'export.preset.horizontalHd',
    'export.preset.verticalHigh',
    'export.preset.audioWav',
    'export.preset.stems',
    'export.subtitle.soft',
    'export.subtitle.burn',
    'export.subtitle.none',
  ]
  for (const match of stage.matchAll(/t\('(export\.[^'$]+)'\)/g)) {
    if (!required.includes(match[1])) required.push(match[1])
  }
  for (const name of ['zh', 'en', 'ja', 'ko']) {
    const messages = JSON.parse(read(`app/locales/${name}.json`))
    for (const key of required) {
      const value = key.split('.').reduce((node, part) => node?.[part], messages)
      assert.equal(typeof value, 'string', `${name} missing ${key}`)
    }
  }
})
