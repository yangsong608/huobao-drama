/**
 * 导出能力门控：A6 起统一读取服务端媒体能力，不再按设备类型判断。
 * 应用本机、未检测到 FFmpeg 的电脑、能力探测失败都按不可用处理；
 * 接力到具备 FFmpeg 的电脑时由该电脑的能力接口放行。
 */
import { computed } from 'vue'
import { useMediaCapabilities } from './useMediaCapabilities'

export function useExportCapability() {
  const caps = useMediaCapabilities()
  return { localOnly: computed(() => !caps.outputReady.value) }
}
