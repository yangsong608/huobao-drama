import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-scene-contract-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const contractSvc = await import('../src/services/scene-contract.ts')
const { validatePlanSequence } = await import('../src/services/storyboard-plan-contract.ts')

function plan(overrides = {}) {
  return {
    shotNumber: 1,
    sceneId: 38,
    location: '唐记食铺',
    time: '清晨',
    sourceExcerpt: '唐奕站在柜台后，店门在画面右，灶台在后景。',
    duration: 8,
    actionStart: '唐奕站在柜台后擦碗',
    actionEnd: '抬头看向店门',
    coverageType: 'action',
    speechSegments: [],
    boundaryType: 'action',
    boundaryWord: null,
    screenLeft: '柜台（唐奕）',
    screenRight: '店门（客人）',
    axisSide: '中轴线A',
    landmarkSide: '灶台在后景',
    ...overrides,
  }
}

test('deriveSceneGeography extracts sides, landmarks, entrances and fixtures', () => {
  const geography = contractSvc.deriveSceneGeography(plan())
  assert.match(geography.layout, /画面左=柜台/)
  assert.match(geography.layout, /画面右=店门/)
  assert.ok(geography.landmarks.some(item => item.name === '灶台' && item.side === '后景'))
  assert.ok(geography.entrances.includes('店门'))
  assert.ok(geography.fixedProps.includes('柜台'))
  assert.ok(geography.fixedProps.includes('灶台'))
  assert.equal(geography.light, '清晨')
  assert.equal(geography.depth.background, '灶台')
})

test('establishing shot creates one scene contract and later shots inherit its constants', async () => {
  const contracts = await contractSvc.syncSceneContractsFromPlans({
    dramaId: 7,
    episodeId: 52,
    jobId: 1,
    plans: [plan()],
  })
  const contract = contracts.get(38)
  assert.ok(contract)
  assert.equal(contract.screenLeft, '柜台（唐奕）')
  assert.equal(contract.screenRight, '店门（客人）')
  assert.equal(contract.sourceShotNumber, 1)
  assert.equal(contract.status, 'active')

  const later = contractSvc.applySceneContractToPlan(plan({
    shotNumber: 2,
    screenLeft: null,
    screenRight: null,
    axisSide: null,
    landmarkSide: null,
  }), contract)
  assert.equal(later.screenLeft, '柜台（唐奕）')
  assert.equal(later.landmarkSide, '灶台在后景')
})

test('plan gate rejects a shot that flips scene constants from the contract', () => {
  const contract = {
    sceneId: 38,
    sceneName: '唐记食铺',
    screenLeft: '柜台（唐奕）',
    screenRight: '店门（客人）',
    axisSide: '中轴线A',
    landmarkSide: '灶台在后景',
    sourceShotNumber: 1,
  }
  const result = validatePlanSequence([plan({
    shotNumber: 9,
    screenLeft: '店门（客人）',
    screenRight: '柜台（唐奕）',
  })], {
    minDuration: 6,
    maxDuration: 15,
    sceneContracts: new Map([[38, contract]]),
  })
  assert.ok(result.issues.some(item => item.code === 'scene_constant_flip' && item.severity === 'error'))
})

test('plan gate accepts later shots that carry the contract constants', () => {
  const contract = {
    sceneId: 38,
    sceneName: '唐记食铺',
    screenLeft: '柜台（唐奕）',
    screenRight: '店门（客人）',
    axisSide: '中轴线A',
    landmarkSide: '灶台在后景',
    sourceShotNumber: 1,
  }
  const later = contractSvc.applySceneContractToPlan(plan({
    shotNumber: 9,
    screenLeft: null,
    screenRight: null,
    axisSide: null,
    landmarkSide: null,
  }), contract)
  const result = validatePlanSequence([later], {
    minDuration: 6,
    maxDuration: 15,
    sceneContracts: new Map([[38, contract]]),
  })
  assert.equal(result.issues.filter(item => item.severity === 'error').length, 0)
})

test('scene contract block exposes geography constraints for prompts', async () => {
  const contracts = [...(await contractSvc.getSceneContractMap(7)).values()]
  const block = contractSvc.buildSceneContractBlock(contracts)
  assert.match(block, /场景地理契约/)
  assert.match(block, /scene_id=38/)
  assert.match(block, /画面左=柜台/)
  assert.match(block, /固定道具=.*柜台/)
})
