<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Loader2, LogOut, RotateCcw, Video } from 'lucide-vue-next'
import StudioEmptyState from '~/components/studio/StudioEmptyState.vue'
import {
  cameraHeight,
  lensToVerticalFov,
  normalizeLens,
  STAGE_GRID_STEP_M,
  STAGE_HALF_EXTENT_M,
  stageVec3,
} from '~/utils/director-camera'

const props = defineProps<{
  shots: any[]
  scenes: any[]
  characters: any[]
  selectedShotId: number | null
  selectedEntity: { type: 'character' | 'camera'; characterId?: number } | null
  maxAssets: number
}>()

const emit = defineEmits<{
  'select-shot': [shotId: number]
  'select-entity': [entity: { type: 'character' | 'camera'; characterId?: number } | null]
  fallback: [reason: 'load-failed' | 'webgl-unavailable' | 'context-lost' | 'render-failed', detail?: string]
}>()

const { t } = useI18n()

const host = ref<HTMLElement | null>(null)
const loading = ref(true)
const cameraView = ref(false)
const assetNotice = ref('')

const ACCENT = 0xf97316
const ACCENT_BRIGHT = 0xffb076
const GROUND_COLOR = 0x334155
const STAGE_EXTENT = STAGE_HALF_EXTENT_M

const maxAssets = computed(() => Math.max(1, Math.round(Number(props.maxAssets) || 20)))
const selectedShot = computed(() => (
  props.shots.find((shot) => Number(shot.storyboard_id) === Number(props.selectedShotId)) || null
))
const sceneMap = computed(() => new Map(props.scenes.map((item) => [Number(item.id), item])))
const characterMap = computed(() => new Map(props.characters.map((item) => [Number(item.id), item])))
const selectedScene = computed(() => {
  const sceneId = Number(selectedShot.value?.scene_id)
  return sceneId ? sceneMap.value.get(sceneId) || null : null
})
const blocking = computed(() => (Array.isArray(selectedShot.value?.blocking) ? selectedShot.value.blocking : []))
const camera = computed(() => selectedShot.value?.camera || null)

const hint = computed(() => (
  cameraView.value ? t('director.stage3d.cameraViewHint') : t('director.stage3d.orbitHint')
))

interface ThreeRuntime {
  THREE: any
  renderer: any
  scene: any
  orbit: any
  orbitCamera: any
  shotCamera: any
  world: any
  raycaster: any
  pointer: any
  textures: any[]
  frame: number
  observer: ResizeObserver
  onContextLost: (event: Event) => void
  onPointerDown: (event: PointerEvent) => void
  onPointerUp: (event: PointerEvent) => void
  pickables: any[]
  charEntries: Map<number, { sprite: any; ring: any }>
  cameraEntry: { group: any; body: any } | null
  markerEntries: Map<number, any>
  helpers: any[]
  stageHelpers: any[]
}

let runtime: ThreeRuntime | null = null
let mounted = false
let buildToken = 0
let pointerStart: { x: number; y: number } | null = null

function imageSrc(raw: unknown): string {
  const value = String(raw || '')
  if (!value) return ''
  if (/^https?:\/\//i.test(value) || value.startsWith('/')) return value
  return `/${value}`
}

function sceneImage(): string {
  return imageSrc(selectedScene.value?.imageUrl || selectedScene.value?.image_url)
}

function sceneLabel(): string {
  return String(selectedScene.value?.location || '')
}

function characterImage(item: any): string {
  return imageSrc(characterMap.value.get(Number(item.character_id))?.imageUrl)
}

function displayName(item: any): string {
  return String(item.name || characterMap.value.get(Number(item.character_id))?.name || t('director.stage3d.character'))
}

// 当前镜头优先；超出上限时按“场景 → 主要角色 → 其他角色”的顺序截断。
const shotAssetOrder = computed(() => {
  const urls: string[] = []
  const push = (url: string) => {
    if (url && !urls.includes(url)) urls.push(url)
  }
  push(sceneImage())
  for (const item of blocking.value) push(characterImage(item))
  return urls
})

const episodeAssetCount = computed(() => {
  const urls = new Set<string>()
  for (const shot of props.shots) {
    const scene = sceneMap.value.get(Number(shot.scene_id))
    const sceneUrl = imageSrc(scene?.imageUrl || scene?.image_url)
    if (sceneUrl) urls.add(sceneUrl)
    for (const item of Array.isArray(shot.blocking) ? shot.blocking : []) {
      const url = imageSrc(characterMap.value.get(Number(item.character_id))?.imageUrl)
      if (url) urls.add(url)
    }
  }
  return urls.size
})

function updateAssetNotice(loaded: number, total: number) {
  if (episodeAssetCount.value > maxAssets.value) {
    assetNotice.value = t('director.stage3d.budgetEpisode', {
      total: episodeAssetCount.value,
      max: maxAssets.value,
      loaded,
    })
  } else if (total > maxAssets.value) {
    assetNotice.value = t('director.stage3d.budgetShot', {
      total,
      max: maxAssets.value,
      loaded,
    })
  } else {
    assetNotice.value = ''
  }
}

function canvasTexture(THREE: any, draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void, width = 256, height = 256): any {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) draw(ctx, width, height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function placeholderCharacterTexture(THREE: any, name: string): any {
  return canvasTexture(THREE, (ctx, width, height) => {
    ctx.fillStyle = '#131a24'
    ctx.fillRect(0, 0, width, height)
    ctx.strokeStyle = '#f97316'
    ctx.lineWidth = 8
    ctx.strokeRect(4, 4, width - 8, height - 8)
    ctx.fillStyle = '#f97316'
    ctx.font = 'bold 96px "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(name.slice(0, 1) || '?', width / 2, height / 2 - 12)
    ctx.fillStyle = '#e2e8f0'
    ctx.font = '28px "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.fillText(name.slice(0, 8), width / 2, height - 34)
  })
}

function placeholderSceneTexture(THREE: any, label: string): any {
  return canvasTexture(THREE, (ctx, width, height) => {
    ctx.fillStyle = '#0e141d'
    ctx.fillRect(0, 0, width, height)
    ctx.strokeStyle = 'rgba(148,163,184,0.4)'
    ctx.lineWidth = 6
    ctx.strokeRect(3, 3, width - 6, height - 6)
    ctx.fillStyle = '#8b94a3'
    ctx.font = '32px "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label || '', width / 2, height / 2)
  }, 512, 288)
}

function loadTextureInto(THREE: any, url: string, material: any, token: number) {
  if (!url) return
  const loader = new THREE.TextureLoader()
  loader.setCrossOrigin('anonymous')
  loader.load(url, (texture: any) => {
    if (!runtime || token !== buildToken) {
      texture.dispose()
      return
    }
    texture.colorSpace = THREE.SRGBColorSpace
    runtime.textures.push(texture)
    material.map = texture
    material.needsUpdate = true
  }, undefined, () => {
    // 单张纹理失败只保留占位，不整体降级。
  })
}

function disposeGroup(group: any) {
  if (!group) return
  group.traverse((object: any) => {
    object.geometry?.dispose?.()
    const materials = Array.isArray(object.material)
      ? object.material
      : object.material ? [object.material] : []
    for (const material of materials) {
      for (const key of ['map', 'alphaMap']) {
        material[key]?.dispose?.()
      }
      material.dispose?.()
    }
  })
  group.clear?.()
}

function disposeTextures(target: ThreeRuntime) {
  for (const texture of target.textures) texture.dispose?.()
  target.textures = []
}

function disposeWorld(target: ThreeRuntime) {
  if (target.world) {
    target.scene.remove(target.world)
    disposeGroup(target.world)
    target.world = null
  }
  disposeTextures(target)
  target.pickables = []
  target.charEntries.clear()
  target.cameraEntry = null
  target.markerEntries.clear()
  target.helpers = [...target.stageHelpers]
}

function buildCharacters(THREE: any, world: any, loadedUrls: Set<string>, token: number) {
  if (!runtime) return
  for (const item of blocking.value) {
    const characterId = Number(item.character_id)
    const url = characterImage(item)
    const name = displayName(item)
    const x = Number(item.x) || 0
    const z = Number(item.z) || 0

    const placeholder = placeholderCharacterTexture(THREE, name)
    runtime.textures.push(placeholder)
    const material = new THREE.SpriteMaterial({ map: placeholder, transparent: true, depthWrite: false })
    const sprite = new THREE.Sprite(material)
    sprite.position.set(x, 1.1, z)
    sprite.scale.set(1.5, 2, 1)
    sprite.userData.pick = { type: 'character', characterId }
    world.add(sprite)
    runtime.pickables.push(sprite)
    if (url && loadedUrls.has(url)) loadTextureInto(THREE, url, material, token)

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.52, 0.68, 32),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.set(x, 0.02, z)
    ring.visible = false
    world.add(ring)

    const radians = ((Number(item.rotation) || 0) * Math.PI) / 180
    const direction = new THREE.Vector3(Math.sin(radians), 0, -Math.cos(radians)).normalize()
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.42, 12),
      new THREE.MeshBasicMaterial({ color: ACCENT }),
    )
    arrow.position.set(x + direction.x * 0.72, 0.32, z + direction.z * 0.72)
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction)
    world.add(arrow)
    runtime.helpers.push(arrow)

    runtime.charEntries.set(characterId, { sprite, ring })
  }
}

function buildCamera(THREE: any, world: any) {
  if (!runtime) return
  const data = camera.value
  if (!data) return

  const position = stageVec3(data.position?.x, cameraHeight(data), data.position?.z)
  const target = stageVec3(data.look_at?.x, data.look_at?.y, data.look_at?.z)

  const group = new THREE.Group()
  group.position.set(position.x, Math.max(0.4, position.y), position.z)
  group.lookAt(target.x, target.y, target.z)

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.36, 0.42),
    new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.4, metalness: 0.1 }),
  )
  group.add(body)

  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.18, 0.32, 16),
    new THREE.MeshStandardMaterial({ color: 0x1f2a38, roughness: 0.6 }),
  )
  lens.rotation.x = Math.PI / 2
  lens.position.set(0, 0, -0.34)
  group.add(lens)

  const pick = { type: 'camera' as const }
  group.traverse((object: any) => {
    if (object.isMesh) {
      object.userData.pick = pick
      runtime!.pickables.push(object)
    }
  })
  world.add(group)
  runtime.helpers.push(group)

  const distance = Math.max(1, group.position.distanceTo(new THREE.Vector3(target.x, target.y, target.z)))
  const helperCamera = new THREE.PerspectiveCamera(
    lensToVerticalFov(normalizeLens(data.lens_mm)),
    16 / 9,
    0.2,
    Math.min(60, distance + 6),
  )
  helperCamera.position.copy(group.position)
  helperCamera.lookAt(target.x, target.y, target.z)
  helperCamera.updateMatrixWorld(true)
  const frustum = new THREE.CameraHelper(helperCamera)
  frustum.material.transparent = true
  frustum.material.opacity = 0.45
  frustum.material.depthTest = false
  frustum.setColors(ACCENT, ACCENT, ACCENT, ACCENT, ACCENT)
  world.add(frustum)
  runtime.helpers.push(frustum)

  const pathGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(group.position.x, group.position.y, group.position.z),
    new THREE.Vector3(target.x, target.y, target.z),
  ])
  const pathLine = new THREE.Line(pathGeometry, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.65 }))
  world.add(pathLine)
  runtime.helpers.push(pathLine)

  const targetMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 12, 12),
    new THREE.MeshBasicMaterial({ color: ACCENT_BRIGHT }),
  )
  targetMarker.position.set(target.x, target.y, target.z)
  world.add(targetMarker)
  runtime.helpers.push(targetMarker)

  const subshots = Array.isArray(selectedShot.value?.subshots) ? selectedShot.value.subshots : []
  const total = subshots.reduce((sum: number, item: any) => sum + (Number(item.duration_sec) || 0), 0)
  if (total > 0) {
    const start = new THREE.Vector3(group.position.x, group.position.y, group.position.z)
    const end = new THREE.Vector3(target.x, target.y, target.z)
    let cumulative = 0
    for (const item of subshots) {
      cumulative += Number(item.duration_sec) || 0
      const ratio = Math.min(1, cumulative / total)
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 10, 10),
        new THREE.MeshBasicMaterial({ color: ACCENT_BRIGHT }),
      )
      marker.position.lerpVectors(start, end, ratio)
      world.add(marker)
      runtime.helpers.push(marker)
    }
  }

  runtime.cameraEntry = { group, body }
}

function buildOtherShotMarkers(THREE: any, world: any) {
  if (!runtime) return
  for (const shot of props.shots) {
    const shotId = Number(shot.storyboard_id)
    if (!shotId || shotId === Number(props.selectedShotId)) continue
    const position = shot.camera?.position
    if (!position) continue
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0x64748b }),
    )
    marker.position.set(Number(position.x) || 0, 0.22, Number(position.z) || 0)
    marker.userData.pick = { type: 'shot', shotId }
    world.add(marker)
    runtime.pickables.push(marker)
    runtime.markerEntries.set(shotId, marker)
    runtime.helpers.push(marker)
  }
}

function applySelection() {
  if (!runtime) return
  for (const [characterId, entry] of runtime.charEntries) {
    const selected = props.selectedEntity?.type === 'character'
      && Number(props.selectedEntity?.characterId) === Number(characterId)
    entry.ring.visible = selected && !cameraView.value
    entry.sprite.scale.set(selected ? 1.8 : 1.5, selected ? 2.4 : 2, 1)
  }
  if (runtime.cameraEntry) {
    const selected = props.selectedEntity?.type === 'camera'
    runtime.cameraEntry.body.material.color.set(selected ? ACCENT_BRIGHT : ACCENT)
    runtime.cameraEntry.group.scale.setScalar(selected ? 1.25 : 1)
  }
  for (const [shotId, marker] of runtime.markerEntries) {
    const selected = Number(shotId) === Number(props.selectedShotId)
    marker.material.color.set(selected ? ACCENT_BRIGHT : 0x64748b)
    marker.scale.setScalar(selected ? 1.6 : 1)
  }
}

function applyCameraViewVisibility() {
  if (!runtime) return
  const visible = !cameraView.value
  for (const helper of runtime.helpers) helper.visible = visible
}

function updateShotCamera() {
  if (!runtime) return
  const data = camera.value
  if (!data) return
  const position = stageVec3(data.position?.x, cameraHeight(data), data.position?.z)
  const target = stageVec3(data.look_at?.x, data.look_at?.y, data.look_at?.z)
  const shotCamera = runtime.shotCamera
  shotCamera.fov = lensToVerticalFov(data.lens_mm)
  shotCamera.aspect = 16 / 9
  shotCamera.updateProjectionMatrix()
  shotCamera.position.set(position.x, Math.max(0.4, position.y), position.z)
  shotCamera.lookAt(target.x, target.y, target.z)
}

function rebuildShot() {
  if (!runtime) return
  const target = runtime
  const THREE = target.THREE
  buildToken += 1
  const token = buildToken

  if (target.world) {
    target.scene.remove(target.world)
    disposeGroup(target.world)
  }
  disposeTextures(target)
  target.pickables = []
  target.charEntries.clear()
  target.cameraEntry = null
  target.markerEntries.clear()
  target.helpers = [...target.stageHelpers]

  const world = new THREE.Group()
  target.world = world
  target.scene.add(world)

  const shot = selectedShot.value
  if (!shot) {
    assetNotice.value = ''
    return
  }

  const ordered = shotAssetOrder.value
  const loadedUrls = new Set(ordered.slice(0, maxAssets.value))
  updateAssetNotice(loadedUrls.size, ordered.length)

  const sceneUrl = sceneImage()
  const scenePlaceholder = placeholderSceneTexture(THREE, sceneLabel() || t('director.stage3d.noScene'))
  target.textures.push(scenePlaceholder)
  const sceneMaterial = new THREE.MeshBasicMaterial({ map: scenePlaceholder })
  const scenePlane = new THREE.Mesh(new THREE.PlaneGeometry(STAGE_EXTENT * 0.8, STAGE_EXTENT * 0.45), sceneMaterial)
  scenePlane.rotation.x = -Math.PI / 2
  scenePlane.position.y = 0.005
  world.add(scenePlane)
  if (sceneUrl && loadedUrls.has(sceneUrl)) loadTextureInto(THREE, sceneUrl, sceneMaterial, token)

  buildCharacters(THREE, world, loadedUrls, token)
  buildCamera(THREE, world)
  buildOtherShotMarkers(THREE, world)
  updateShotCamera()
  applySelection()
  applyCameraViewVisibility()
}

function activeCamera(): any {
  if (!runtime) return null
  return cameraView.value ? runtime.shotCamera : runtime.orbitCamera
}

function hasShotCamera(): boolean {
  return Boolean(camera.value)
}

function toggleCameraView() {
  if (!hasShotCamera()) return
  cameraView.value = !cameraView.value
  if (runtime) runtime.orbit.enabled = !cameraView.value
}

function resetView() {
  if (!runtime) return
  cameraView.value = false
  runtime.orbit.enabled = true
  runtime.orbit.target.set(0, 1, 0)
  runtime.orbitCamera.position.set(STAGE_EXTENT * 0.7, STAGE_EXTENT * 0.65, STAGE_EXTENT * 0.8)
  runtime.orbit.update()
}

function resize() {
  if (!runtime || !host.value) return
  const width = Math.max(1, host.value.clientWidth)
  const height = Math.max(1, host.value.clientHeight)
  runtime.renderer.setSize(width, height, false)
  runtime.orbitCamera.aspect = width / height
  runtime.orbitCamera.updateProjectionMatrix()
  runtime.shotCamera.aspect = width / height
  runtime.shotCamera.updateProjectionMatrix()
}

function pickOf(object: any): any {
  let node = object
  while (node) {
    if (node.userData?.pick) return node.userData.pick
    node = node.parent
  }
  return null
}

function handlePointerAt(clientX: number, clientY: number) {
  if (!runtime || cameraView.value) return
  const rect = runtime.renderer.domElement.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  runtime.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
  runtime.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
  runtime.raycaster.setFromCamera(runtime.pointer, runtime.orbitCamera)
  const hits = runtime.raycaster.intersectObjects(runtime.pickables, true)
  for (const hit of hits) {
    const pick = pickOf(hit.object)
    if (!pick) continue
    if (pick.type === 'character') {
      emit('select-entity', { type: 'character', characterId: Number(pick.characterId) })
    } else if (pick.type === 'camera') {
      emit('select-entity', { type: 'camera' })
    } else if (pick.type === 'shot') {
      emit('select-shot', Number(pick.shotId))
    }
    return
  }
}

function animate() {
  if (!runtime) return
  const target = runtime
  target.frame = requestAnimationFrame(animate)
  try {
    if (!cameraView.value) target.orbit.update()
    target.renderer.render(target.scene, activeCamera())
    if (loading.value) loading.value = false
  } catch (error) {
    fail('render-failed', error instanceof Error ? error.message : String(error))
  }
}

function fail(reason: 'load-failed' | 'webgl-unavailable' | 'context-lost' | 'render-failed', detail?: string) {
  teardown()
  emit('fallback', reason, detail)
}

function teardown() {
  mounted = false
  buildToken += 1
  if (!runtime) return
  const target = runtime
  runtime = null
  cancelAnimationFrame(target.frame)
  target.observer.disconnect()
  target.renderer.domElement.removeEventListener('webglcontextlost', target.onContextLost)
  target.renderer.domElement.removeEventListener('pointerdown', target.onPointerDown)
  target.renderer.domElement.removeEventListener('pointerup', target.onPointerUp)
  target.orbit.dispose()
  disposeWorld(target)
  for (const helper of target.stageHelpers) {
    target.scene.remove(helper)
    disposeGroup(helper)
  }
  target.stageHelpers = []
  target.helpers = []
  const canvas = target.renderer.domElement
  target.renderer.dispose()
  target.renderer.forceContextLoss?.()
  canvas.remove?.()
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

async function boot() {
  if (!host.value || runtime) return
  if (!webglAvailable()) {
    fail('webgl-unavailable')
    return
  }

  let THREE: any
  let OrbitControls: any
  try {
    THREE = await import('three')
    const controls = await import('three/addons/controls/OrbitControls.js')
    OrbitControls = controls.OrbitControls
  } catch (error) {
    fail('load-failed', error instanceof Error ? error.message : String(error))
    return
  }
  if (!mounted || !host.value) return

  let renderer: any
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true })
  } catch (error) {
    fail('webgl-unavailable', error instanceof Error ? error.message : String(error))
    return
  }

  const container = host.value
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.domElement.className = 'director-stage3d-webgl'
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0d10)

  const orbitCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 200)
  orbitCamera.position.set(STAGE_EXTENT * 0.7, STAGE_EXTENT * 0.65, STAGE_EXTENT * 0.8)

  const orbit = new OrbitControls(orbitCamera, renderer.domElement)
  orbit.target.set(0, 1, 0)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.08
  orbit.enablePan = false
  orbit.minDistance = 4
  orbit.maxDistance = 80
  orbit.maxPolarAngle = Math.PI / 2 - 0.04
  orbit.update()

  const shotCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 120)
  shotCamera.position.set(0, 1.6, 6)
  shotCamera.lookAt(0, 1, 0)

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.6))
  const sun = new THREE.DirectionalLight(0xffffff, 1.2)
  sun.position.set(12, 18, 10)
  scene.add(sun)

  const grid = new THREE.GridHelper(STAGE_EXTENT * 2, (STAGE_EXTENT * 2) / STAGE_GRID_STEP_M, ACCENT, GROUND_COLOR)
  grid.material.opacity = 0.5
  grid.material.transparent = true
  grid.position.y = 0.002
  scene.add(grid)
  const axes = new THREE.AxesHelper(3)
  scene.add(axes)

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  const onContextLost = (event: Event) => {
    event.preventDefault()
    fail('context-lost')
  }
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || cameraView.value) return
    pointerStart = { x: event.clientX, y: event.clientY }
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!pointerStart || cameraView.value) {
      pointerStart = null
      return
    }
    const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y)
    pointerStart = null
    if (moved > 5) return
    handlePointerAt(event.clientX, event.clientY)
  }

  const target: ThreeRuntime = {
    THREE,
    renderer,
    scene,
    orbit,
    orbitCamera,
    shotCamera,
    world: null,
    raycaster,
    pointer,
    textures: [],
    frame: 0,
    observer: new ResizeObserver(() => resize()),
    onContextLost,
    onPointerDown,
    onPointerUp,
    pickables: [],
    charEntries: new Map(),
    cameraEntry: null,
    markerEntries: new Map(),
    helpers: [grid, axes],
    stageHelpers: [grid, axes],
  }
  runtime = target
  mounted = true

  renderer.domElement.addEventListener('webglcontextlost', onContextLost, false)
  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  renderer.domElement.addEventListener('pointerup', onPointerUp)
  target.observer.observe(container)

  resize()
  rebuildShot()
  animate()
}

watch(selectedShot, () => rebuildShot(), { deep: true })
watch(() => props.selectedEntity, () => applySelection(), { deep: true })
watch(cameraView, (value) => {
  if (runtime) {
    runtime.orbit.enabled = !value
    if (!value) runtime.orbit.update()
    applyCameraViewVisibility()
    applySelection()
  }
})
watch(() => props.maxAssets, () => rebuildShot())

onMounted(() => {
  mounted = true
  void boot()
})

onBeforeUnmount(() => {
  teardown()
})
</script>

<template>
  <div class="director-stage3d">
    <div ref="host" class="director-stage3d-canvas" />

    <div v-if="loading" class="director-stage3d-loading">
      <Loader2 :size="18" class="animate-spin" />
      <span>{{ t('director.stage3d.loading') }}</span>
    </div>

    <div class="director-stage3d-toolbar">
      <span class="director-stage3d-hint">{{ hint }}</span>
      <div class="director-stage3d-actions">
        <button
          v-if="hasShotCamera()"
          type="button"
          class="director-stage3d-btn"
          @click="toggleCameraView"
        >
          <LogOut v-if="cameraView" :size="12" />
          <Video v-else :size="12" />
          {{ cameraView ? t('director.stage3d.exitCamera') : t('director.stage3d.enterCamera') }}
        </button>
        <button type="button" class="director-stage3d-btn" @click="resetView">
          <RotateCcw :size="12" />
          {{ t('director.stage3d.resetView') }}
        </button>
      </div>
    </div>

    <div v-if="assetNotice" class="director-stage3d-notice">{{ assetNotice }}</div>

    <div v-if="!selectedShot" class="director-stage3d-empty">
      <StudioEmptyState
        :title="t('director.stage3d.emptyTitle')"
        :description="t('director.stage3d.emptyDesc')"
      />
    </div>

    <div v-else class="director-stage3d-readonly">{{ t('director.stage3d.readonlyHint') }}</div>
  </div>
</template>

<style scoped>
.director-stage3d {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--media-surface, #0b0d10);
  overflow: hidden;
}
.director-stage3d-canvas {
  position: absolute;
  inset: 0;
}
.director-stage3d-canvas :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
  outline: none;
}
.director-stage3d-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--on-media, rgba(255, 255, 255, 0.85));
  font-size: var(--text-label);
  pointer-events: none;
}
.director-stage3d-toolbar {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  pointer-events: none;
}
.director-stage3d-hint {
  max-width: 60%;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  background: rgba(11, 13, 16, 0.66);
  color: var(--on-media, rgba(255, 255, 255, 0.85));
  font-size: var(--text-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.director-stage3d-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: auto;
}
.director-stage3d-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: var(--control-xs);
  padding: 0 8px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: var(--radius-sm);
  background: rgba(11, 13, 16, 0.72);
  color: #e2e8f0;
  font-size: var(--text-meta);
  cursor: pointer;
}
.director-stage3d-btn:hover { border-color: var(--accent); color: var(--accent); }
.director-stage3d-notice {
  position: absolute;
  top: 44px;
  left: 8px;
  max-width: 70%;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  background: rgba(217, 119, 6, 0.16);
  color: #fbbf24;
  font-size: var(--text-meta);
  line-height: 1.45;
}
.director-stage3d-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.director-stage3d-readonly {
  position: absolute;
  left: 8px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: rgba(11, 13, 16, 0.66);
  color: var(--on-media, rgba(255, 255, 255, 0.7));
  font-size: 11px;
  pointer-events: none;
}
.director-stage3d :is(button, input, select):focus-visible { outline: none; box-shadow: var(--focus-ring); }
</style>
