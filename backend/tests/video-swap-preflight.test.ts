import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-preflight-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = path.join(root, 'data')
process.env.STORAGE_PATH = path.join(root, 'data', 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const storage = await import('../src/services/video-project-storage.ts')
const { preflightVideoProject } = await import('../src/services/video-swap-preflight.ts')
const { refreshFfmpegConfig, resolveFfmpegSuite } = await import('../src/utils/ffmpeg.ts')
refreshFfmpegConfig()

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const config = {
  id: 9,
  provider: 'comfyui',
  baseUrl: 'http://gateway.local:8194',
  apiKey: 'test-key',
  model: '',
  settings: {
    face_workflow_slug: 'h3-face-swap',
    character_workflow_slug: 'h3-recast',
    analysis_config_id: 1,
  },
}

async function makeProject(mode: 'face' | 'character' = 'face') {
  await storage.ensureVideoProjectStorageLayout(11)
  await fs.writeFile(
    storage.resolveVideoProjectStorageFile(11, 'source/source-test.mp4'),
    Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]),
  )
  await fs.writeFile(
    storage.resolveVideoProjectStorageFile(11, 'faces/face-test.png'),
    Buffer.from('fake-image'),
  )
  return {
    id: 11,
    title: '预检',
    mode,
    status: 'draft',
    sourceVideoPath: 'static/video-projects/11/source/source-test.mp4',
    sourceVideoMeta: null,
    referenceFacePaths: JSON.stringify(['static/video-projects/11/faces/face-test.png']),
    prompt: '',
    configId: null,
    latestRunId: null,
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
    deletedAt: null,
  } as any
}

function okFetch(expectedSlug = 'h3-face-swap') {
  return (async () => new Response(JSON.stringify({
    object: 'list',
    data: [{ slug: expectedSlug, is_active: true }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

function okFetchMany(slugs: string[]) {
  return (async () => new Response(JSON.stringify({
    object: 'list',
    data: slugs.map(slug => ({ slug, is_active: true })),
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

test('passes with config, gateway workflow, source and face present', async () => {
  const project = await makeProject('face')
  const result = await preflightVideoProject(project, {
    config,
    fetchImpl: okFetch(),
    minFreeBytes: 0,
  })
  assert.equal(result.ok, true, JSON.stringify(result.blockers))
  assert.equal(result.expected_workflow, 'h3-face-swap')
  assert.equal(result.gateway.reachable, true)
  assert.equal(result.gateway.workflow_found, true)
  assert.equal(result.warnings.length, 0)
})

test('reports missing config, source and face', async () => {
  const project = await makeProject('face')
  project.sourceVideoPath = null
  project.referenceFacePaths = '[]'
  const result = await preflightVideoProject(project, {
    config: null,
    fetchImpl: okFetch(),
    minFreeBytes: 0,
  })
  assert.equal(result.ok, false)
  assert.ok(result.blockers.some(item => item.code === 'VIDEO_SWAP_CONFIG_MISSING'))
  assert.ok(result.blockers.some(item => item.code === 'VIDEO_SOURCE_MISSING'))
  assert.ok(result.blockers.some(item => item.code === 'VIDEO_FACE_MISSING'))
})

test('reports unreachable gateway and missing workflow', async () => {
  const project = await makeProject('face')
  const unreachable = await preflightVideoProject(project, {
    config,
    fetchImpl: (async () => { throw new Error('offline') }) as typeof fetch,
    minFreeBytes: 0,
  })
  assert.equal(unreachable.ok, false)
  assert.ok(unreachable.blockers.some(item => item.code === 'VIDEO_GATEWAY_UNREACHABLE'))

  const missing = await preflightVideoProject(project, {
    config,
    fetchImpl: okFetch('other-workflow'),
    minFreeBytes: 0,
  })
  assert.equal(missing.ok, false)
  assert.ok(missing.blockers.some(item => item.code === 'VIDEO_WORKFLOW_MISSING'))
})

test('character mode warns about scene reference and disk block is reported', async () => {
  const project = await makeProject('character')
  const result = await preflightVideoProject(project, {
    config,
    fetchImpl: okFetch('h3-recast'),
    minFreeBytes: 0,
  })
  assert.equal(result.ok, true, JSON.stringify(result.blockers))
  assert.equal(result.expected_workflow, 'h3-recast')
  assert.ok(result.warnings.some(item => item.code === 'VIDEO_SCENE_REF_PENDING'))

  const lowDisk = await preflightVideoProject(project, {
    config,
    fetchImpl: okFetch('h3-recast'),
    minFreeBytes: 1e18,
  })
  assert.equal(lowDisk.ok, false)
  assert.ok(lowDisk.blockers.some(item => item.code === 'VIDEO_DISK_LOW'))
})

test('face mode with FaceFusion checks the local install instead of the gateway', async () => {
  const dir = path.join(root, 'facefusion')
  await fs.mkdir(path.join(dir, '.assets/models'), { recursive: true })
  await fs.writeFile(path.join(dir, 'facefusion.py'), '')
  await fs.writeFile(path.join(dir, '.assets/models/hyperswap_1a_256.onnx'), '')
  await fs.writeFile(path.join(dir, 'python'), '')
  const project = await makeProject('face')
  const faceFusionConfig = {
    ...config,
    settings: {
      ...config.settings,
      face_engine: 'facefusion',
      facefusion_dir: dir,
      facefusion_python: path.join(dir, 'python'),
      facefusion_model: 'hyperswap_1a_256',
      facefusion_execution_providers: 'cpu',
    },
  }
  const result = await preflightVideoProject(project, {
    config: faceFusionConfig,
    fetchImpl: (async () => { throw new Error('gateway should not be called') }) as typeof fetch,
    minFreeBytes: 0,
  })
  assert.equal(result.ok, true, JSON.stringify(result.blockers))
  assert.equal(result.face_engine, 'facefusion')
  assert.deepEqual(result.expected_workflows, [])
  assert.equal(result.facefusion?.ok, true)
  assert.equal(result.gateway.reachable, false)
})

test('character mode preflights both the short and long workflows', async () => {
  const project = await makeProject('character')
  const multiWorkflowConfig = {
    ...config,
    settings: {
      ...config.settings,
      character_workflow_slug: 'h3-recast-relay',
      character_short_workflow_slug: 'h3-recast',
      character_short_max_seconds: 6,
    },
  }
  const complete = await preflightVideoProject(project, {
    config: multiWorkflowConfig,
    fetchImpl: okFetchMany(['h3-recast', 'h3-recast-relay']),
    minFreeBytes: 0,
  })
  assert.equal(complete.ok, true, JSON.stringify(complete.blockers))
  assert.equal(complete.expected_workflow, 'h3-recast-relay')
  assert.deepEqual(complete.expected_workflows, ['h3-recast-relay', 'h3-recast'])
  assert.equal(complete.gateway.workflow_found, true)

  const missingShort = await preflightVideoProject(project, {
    config: multiWorkflowConfig,
    fetchImpl: okFetchMany(['h3-recast-relay']),
    minFreeBytes: 0,
  })
  assert.equal(missingShort.ok, false)
  assert.ok(missingShort.blockers.some(item =>
    item.code === 'VIDEO_WORKFLOW_MISSING' && item.message.includes('h3-recast')))
})

function execFfmpeg(args: string[]): Promise<void> {
  const binary = resolveFfmpegSuite().ffmpeg.path
  if (!binary) return Promise.reject(new Error('ffmpeg 不可用'))
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `ffmpeg exit ${code}`))
    })
  })
}

test('warns when the source video has no audio track', async () => {
  await storage.ensureVideoProjectStorageLayout(12)
  const silentSource = storage.resolveVideoProjectStorageFile(12, 'source/silent.mp4')
  await execFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    silentSource,
  ])
  await fs.writeFile(
    storage.resolveVideoProjectStorageFile(12, 'faces/face-test.png'),
    Buffer.from('fake-image'),
  )
  const project = {
    id: 12,
    title: '无音轨预检',
    mode: 'face',
    status: 'draft',
    sourceVideoPath: 'static/video-projects/12/source/silent.mp4',
    sourceVideoMeta: null,
    referenceFacePaths: JSON.stringify(['static/video-projects/12/faces/face-test.png']),
    prompt: '',
    configId: null,
    latestRunId: null,
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
    deletedAt: null,
  } as any
  const result = await preflightVideoProject(project, {
    config,
    fetchImpl: okFetch(),
    minFreeBytes: 0,
  })
  assert.equal(result.ok, true, JSON.stringify(result.blockers))
  assert.ok(result.warnings.some(item => item.code === 'VIDEO_SOURCE_NO_AUDIO'))
})
