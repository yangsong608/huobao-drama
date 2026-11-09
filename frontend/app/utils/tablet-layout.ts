/**
 * 平板端响应式与触控基础常量
 *
 * 断点与触控尺寸只在这里定义一次，供 composable / 组件引用，避免散落魔法数。
 * 纯函数不读取 window，服务端与单元测试可直接调用。
 */

/** 平板适配上限：<= 1180 进入平板视图（与桌面 1181 起完全隔离） */
export const TABLET_MAX = 1180
/** 紧凑平板：<= 900 压缩间距与次要信息 */
export const COMPACT_MAX = 900
/** 窄平板：<= 744 收起导航/品牌文字，744 本身仍属窄平板 */
export const NARROW_MAX = 744

/** 长按判定时长（毫秒） */
export const LONG_PRESS_MS = 500
/** 长按期间允许的手指位移（像素），超出视为滚动 */
export const LONG_PRESS_MOVE_PX = 8

/** 触控最小命中区（像素） */
export const TAP_MIN = 44
/** 紧凑触控命中区（像素） */
export const TAP_COMPACT = 36
/** 触控输入框最小字号（像素），低于 16 时 iOS 聚焦会自动放大页面 */
export const TOUCH_INPUT_FONT_MIN = 16

/** 分享/上传单文件上限（字节） */
export const SHARE_FILE_LIMIT = 100 * 1024 * 1024
/** 视频上传上限（MB） */
export const VIDEO_UPLOAD_MAX_MB = 50
/** 音频上传上限（MB） */
export const AUDIO_UPLOAD_MAX_MB = 20

/** 是否为平板宽度（含 1180 边界） */
export function isTablet(width: number): boolean {
  return width <= TABLET_MAX
}

/** 是否为紧凑平板宽度（含 900 边界） */
export function isCompact(width: number): boolean {
  return width <= COMPACT_MAX
}

/** 是否为窄平板宽度（含 744 边界，745 起不再是窄平板） */
export function isNarrow(width: number): boolean {
  return width <= NARROW_MAX
}
