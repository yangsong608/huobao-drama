/**
 * Solo 派生静音状态（设计 8.5）
 *
 * Solo 是试听/导出期的临时集合，不改写 muted 原值：
 * - 有任一轨道或总线 solo 时，只有被 solo 的轨道可听（轨道自身静音也让位）；
 * - 轨道 solo 必须打开所属总线，否则信号在总线层被截断；
 * - 总线 solo 让其上所有轨道可听；
 * - 主输出的 muted 始终生效。
 */
export interface SoloableTrack {
  busId: string
  muted: boolean
  solo: boolean
  effectiveMuted: boolean
}

export interface SoloableBus {
  key: string
  muted: boolean
  solo: boolean
  effectiveMuted: boolean
}

export function applySoloMuteState(tracks: SoloableTrack[], buses: SoloableBus[]): void {
  const busByKey = new Map(buses.map((bus) => [bus.key, bus]))
  const trackSoloActive = tracks.some((track) => track.solo)
  const busSoloActive = buses.some((bus) => bus.key !== 'master' && bus.solo)
  const soloActive = trackSoloActive || busSoloActive

  if (!soloActive) {
    for (const bus of buses) bus.effectiveMuted = bus.muted
    for (const track of tracks) {
      const bus = busByKey.get(track.busId)
      track.effectiveMuted = track.muted || Boolean(bus?.muted)
    }
    return
  }

  const soloedBusKeys = new Set<string>()
  for (const track of tracks) {
    const bus = busByKey.get(track.busId)
    if (track.solo) {
      track.effectiveMuted = false
      if (bus && bus.key !== 'master') soloedBusKeys.add(bus.key)
      continue
    }
    // 总线 solo 只隔离其他总线，轨自身的静音仍然生效
    if (bus?.solo) {
      track.effectiveMuted = track.muted
      continue
    }
    track.effectiveMuted = true
  }
  for (const bus of buses) {
    bus.effectiveMuted = bus.key === 'master'
      ? bus.muted
      : !(bus.solo || soloedBusKeys.has(bus.key))
  }
}