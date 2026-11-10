import type { RemotePlatform } from '~/composables/useRemoteGuest'

/** 配对页只做平台粗分类；设备名仍由用户确认或修改，角色判定不依赖 UA */
export function detectRemotePlatform(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  maxTouchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
): RemotePlatform {
  if (/iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return 'ipad'
  if (/iPhone|iPod/i.test(userAgent)) return 'ios'
  if (/Android/i.test(userAgent)) return 'android'
  return 'web'
}
