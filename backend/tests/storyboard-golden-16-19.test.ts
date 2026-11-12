import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateContractPairIssues } from '../src/services/storyboard-contract-audit.ts'

/**
 * 16–19 黄金样例（规则级）：
 * 16 范左/唐右 → 17 唐左/范右：越轴；
 * 17 窗在左后 → 18 窗在右后：反打场景翻面；
 * 18 唐左/范右 → 18 仍是唐左/范右：同侧不误报。
 */
function shot(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    storyboardNumber: 1,
    sceneId: 55,
    coverageType: 'single',
    axisSide: 'A',
    screenLeft: [] as string[],
    screenRight: [] as string[],
    foregroundShoulder: null as string | null,
    castOnScreen: [] as number[],
    backgroundLandmarks: [] as Array<{ name: string; side: string }>,
    sceneGeographyId: 1,
    contractVersion: 1,
    ...overrides,
  }
}

test('黄金样例 16→17：范左/唐右 切 唐左/范右，规则抓到屏幕翻转与轴线交叉', () => {
  const sixteen = shot({
    id: 319,
    storyboardNumber: 16,
    coverageType: 'ots',
    axisSide: 'A',
    screenLeft: ['范仲淹'],
    screenRight: ['唐大郎（唐奕）'],
    castOnScreen: [24, 39],
    backgroundLandmarks: [{ name: '窗', side: 'left' }],
  })
  const seventeen = shot({
    id: 320,
    storyboardNumber: 17,
    coverageType: 'ots',
    axisSide: 'B',
    screenLeft: ['唐大郎（唐奕）'],
    screenRight: ['范仲淹'],
    castOnScreen: [24, 39],
    backgroundLandmarks: [{ name: '窗', side: 'left' }],
  })
  const codes = evaluateContractPairIssues(sixteen as any, seventeen as any).map(issue => issue.code)
  assert.ok(codes.includes('screen_direction_flip'), `应抓到屏幕翻转：${codes.join(',')}`)
  assert.ok(codes.includes('axis_cross'), `应抓到轴线交叉：${codes.join(',')}`)
})

test('黄金样例 17→18：同侧正反打不误报，但窗从左后跑到右后要报场景翻面', () => {
  const seventeen = shot({
    id: 320,
    storyboardNumber: 17,
    coverageType: 'ots',
    axisSide: 'A',
    screenLeft: ['唐大郎（唐奕）'],
    screenRight: ['范仲淹'],
    castOnScreen: [24, 39],
    foregroundShoulder: '范仲淹右肩',
    backgroundLandmarks: [{ name: '窗', side: 'left' }, { name: '门', side: 'right' }],
  })
  const eighteen = shot({
    id: 321,
    storyboardNumber: 18,
    coverageType: 'ots',
    axisSide: 'A',
    screenLeft: ['唐大郎（唐奕）'],
    screenRight: ['范仲淹'],
    castOnScreen: [24, 39],
    foregroundShoulder: '范仲淹右肩',
    backgroundLandmarks: [{ name: '窗', side: 'right' }, { name: '门', side: 'left' }],
  })
  const codes = evaluateContractPairIssues(seventeen as any, eighteen as any).map(issue => issue.code)
  assert.ok(!codes.includes('screen_direction_flip'), `同侧不应报屏幕翻转：${codes.join(',')}`)
  assert.ok(!codes.includes('axis_cross'), `同轴不应报轴线交叉：${codes.join(',')}`)
  assert.ok(codes.includes('set_mirror'), `应抓到窗/门翻面：${codes.join(',')}`)
})

test('黄金样例 18→19：画内人物在场连续时不误报，换人且无过渡时提醒', () => {
  const eighteen = shot({
    id: 321,
    storyboardNumber: 18,
    coverageType: 'single',
    screenLeft: ['唐大郎（唐奕）'],
    screenRight: ['范仲淹'],
    castOnScreen: [24, 39],
    backgroundLandmarks: [{ name: '窗', side: 'left' }],
  })
  const nineteen = shot({
    id: 322,
    storyboardNumber: 19,
    coverageType: 'two_shot',
    screenLeft: ['唐大郎（唐奕）'],
    screenRight: ['范仲淹', '孙郎中'],
    castOnScreen: [24, 39, 38],
    backgroundLandmarks: [{ name: '窗', side: 'left' }],
  })
  const continuous = evaluateContractPairIssues(eighteen as any, nineteen as any)
  assert.ok(!continuous.some(issue => issue.code === 'cast_presence_break'))

  const replaced = evaluateContractPairIssues(
    shot({ id: 322, storyboardNumber: 19, coverageType: 'single', castOnScreen: [24] }) as any,
    shot({
      id: 323,
      storyboardNumber: 20,
      coverageType: 'two_shot',
      screenLeft: ['范公子'],
      screenRight: ['唐大郎（唐奕）'],
      castOnScreen: [39, 40],
    }) as any,
  )
  assert.ok(replaced.some(issue => issue.code === 'cast_presence_break'))
})
