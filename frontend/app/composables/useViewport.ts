/**
 * 视口与指针能力（平板基础）
 *
 * - 只读暴露宽度/高度/方向/粗指针与三档断点，组件不直接读 window
 * - resize / orientationchange / matchMedia change 用 rAF 合并，避免一帧多次渲染
 * - visualViewport 的 resize / scroll 用独立 rAF 合并，写入根元素 --app-vvh，
 *   供需要跟随软键盘/地址栏收缩的高度使用；该变量不参与断点判断
 * - 组件卸载时移除全部监听并取消挂起的 rAF
 * - SSR 安全：typeof window === 'undefined' 时直接返回默认值，不访问 document
 */
import { computed, onBeforeUnmount, onMounted, readonly, ref } from 'vue'
import {
  isCompact as isCompactWidth,
  isNarrow as isNarrowWidth,
  isShortLandscape as isShortLandscapeSize,
  isTablet as isTabletWidth,
} from '~/utils/tablet-layout'

export type ViewportOrientation = 'portrait' | 'landscape'

const COARSE_POINTER_QUERY = '(hover: none) and (pointer: coarse)'

// --app-vvh 写在根元素上，由全部 useViewport 实例共享：最后一个实例卸载时才允许清除
let vvhConsumers = 0

export function useViewport() {
  // 客户端 setup 阶段同步初始化：首帧即拿到真实宽高与指针能力，避免 0 宽导致的布局闪烁
  const hasWindow = typeof window !== 'undefined'
  const width = ref(hasWindow ? window.innerWidth : 0)
  const height = ref(hasWindow ? window.innerHeight : 0)
  const isCoarsePointer = ref(hasWindow ? window.matchMedia(COARSE_POINTER_QUERY).matches : false)

  const orientation = computed<ViewportOrientation>(() =>
    width.value > height.value ? 'landscape' : 'portrait')
  const isTablet = computed(() => isTabletWidth(width.value))
  const isCompact = computed(() => isCompactWidth(width.value))
  const isNarrow = computed(() => isNarrowWidth(width.value))
  const isShortLandscape = computed(() => isShortLandscapeSize(width.value, height.value))

  // SSR：不注册监听、不访问 document，直接给默认值
  if (!hasWindow) {
    return {
      width: readonly(width),
      height: readonly(height),
      orientation,
      isCoarsePointer: readonly(isCoarsePointer),
      isTablet,
      isCompact,
      isNarrow,
      isShortLandscape,
    }
  }

  let metricsRaf = 0
  let vvhRaf = 0
  let coarsePointerQuery: MediaQueryList | null = null

  function readViewport() {
    width.value = window.innerWidth
    height.value = window.innerHeight
    if (coarsePointerQuery) isCoarsePointer.value = coarsePointerQuery.matches
  }

  function scheduleMetrics() {
    if (metricsRaf) return
    metricsRaf = window.requestAnimationFrame(() => {
      metricsRaf = 0
      readViewport()
      // 无 visualViewport 时旋转/缩放宽高也要刷新 --app-vvh；
      // 有 visualViewport 时该值来自 visualViewport，重复写入无副作用
      applyAppVvh()
    })
  }

  function applyAppVvh() {
    const visual = window.visualViewport
    const raw = visual ? visual.height : window.innerHeight
    const px = Number.isFinite(raw) && raw > 0 ? raw : window.innerHeight
    document.documentElement.style.setProperty('--app-vvh', `${px}px`)
  }

  function scheduleAppVvh() {
    if (vvhRaf) return
    vvhRaf = window.requestAnimationFrame(() => {
      vvhRaf = 0
      applyAppVvh()
    })
  }

  // 指针能力变化同样并入 metrics rAF，避免与 resize 各触发一帧
  function onCoarsePointerChange() {
    scheduleMetrics()
  }

  onMounted(() => {
    vvhConsumers += 1
    coarsePointerQuery = window.matchMedia(COARSE_POINTER_QUERY)
    readViewport()
    applyAppVvh()

    window.addEventListener('resize', scheduleMetrics, { passive: true })
    window.addEventListener('orientationchange', scheduleMetrics, { passive: true })
    coarsePointerQuery.addEventListener('change', onCoarsePointerChange)

    const visual = window.visualViewport
    if (visual) {
      visual.addEventListener('resize', scheduleAppVvh, { passive: true })
      visual.addEventListener('scroll', scheduleAppVvh, { passive: true })
    }
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', scheduleMetrics)
    window.removeEventListener('orientationchange', scheduleMetrics)
    coarsePointerQuery?.removeEventListener('change', onCoarsePointerChange)

    const visual = window.visualViewport
    if (visual) {
      visual.removeEventListener('resize', scheduleAppVvh)
      visual.removeEventListener('scroll', scheduleAppVvh)
    }

    if (metricsRaf) window.cancelAnimationFrame(metricsRaf)
    if (vvhRaf) window.cancelAnimationFrame(vvhRaf)
    metricsRaf = 0
    vvhRaf = 0
    coarsePointerQuery = null

    // 页面级实例卸载时外壳实例仍在用：只有最后一个使用者才清除共享变量
    vvhConsumers = Math.max(0, vvhConsumers - 1)
    if (vvhConsumers === 0) {
      document.documentElement.style.removeProperty('--app-vvh')
    }
  })

  return {
    width: readonly(width),
    height: readonly(height),
    orientation,
    isCoarsePointer: readonly(isCoarsePointer),
    isTablet,
    isCompact,
    isNarrow,
    isShortLandscape,
  }
}
