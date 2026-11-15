import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-facefusion-'))

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('resolves the H3 default and FaceFusion settings', async () => {
  const facefusion = await import('../src/services/facefusion.ts')
  assert.equal(facefusion.resolveFaceEngine({}), 'h3')
  assert.equal(facefusion.resolveFaceEngine({ face_engine: 'facefusion' }), 'facefusion')
  const settings = facefusion.resolveFaceFusionSettings({
    face_engine: 'facefusion',
    facefusion_dir: '/tmp/facefusion',
    facefusion_model: 'inswapper_128',
    facefusion_execution_providers: 'coreml,cpu',
    facefusion_timeout_seconds: 120,
  })
  assert.equal(settings.python, '/tmp/facefusion/.venv/bin/python')
  assert.equal(settings.model, 'inswapper_128')
  assert.equal(settings.executionProviders, 'coreml,cpu')
  assert.equal(settings.timeoutMs, 120_000)
})

test('validates FaceFusion directory, python and model files', async () => {
  const facefusion = await import('../src/services/facefusion.ts')
  const dir = path.join(root, 'missing')
  const settings = {
    dir,
    python: path.join(dir, '.venv/bin/python'),
    model: 'hyperswap_1a_256',
    executionProviders: 'cpu',
    pixelBoost: '512x512',
    timeoutMs: 1000,
  }
  const blockers = facefusion.validateFaceFusionInstall(settings)
  assert.ok(blockers.length >= 3)
  assert.ok(blockers.some(item => item.includes('目录不存在')))
})

test('runs FaceFusion through the configured python command and writes output', async () => {
  const facefusion = await import('../src/services/facefusion.ts')
  const dir = path.join(root, 'installed')
  await fs.mkdir(path.join(dir, '.assets/models'), { recursive: true })
  await fs.writeFile(path.join(dir, 'facefusion.py'), '')
  await fs.writeFile(path.join(dir, '.assets/models/hyperswap_1a_256.onnx'), '')
  const python = path.join(dir, 'fake-python')
  await fs.writeFile(python, `#!/bin/sh
src=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -t) src="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$src" "$out"
`)
  await fs.chmod(python, 0o755)
  const settings = {
    dir,
    python,
    model: 'hyperswap_1a_256',
    executionProviders: 'cpu',
    pixelBoost: '512x512',
    timeoutMs: 10_000,
  }
  assert.deepEqual(facefusion.validateFaceFusionInstall(settings), [])
  const source = path.join(root, 'source.mp4')
  const reference = path.join(root, 'face.jpg')
  const output = path.join(root, 'out.mp4')
  await fs.writeFile(source, 'source-bytes')
  await fs.writeFile(reference, 'face-bytes')
  await facefusion.runFaceFusion({ sourcePath: source, referenceFacePath: reference, outputPath: output, settings })
  assert.equal(await fs.readFile(output, 'utf8'), 'source-bytes')
})