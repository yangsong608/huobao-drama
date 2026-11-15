export interface VideoSwapRouteDescription {
  mode: 'face' | 'character'
  engine: 'h3' | 'facefusion'
  face_workflow: string | null
  facefusion_model: string | null
  facefusion_provider: string | null
  character_short_workflow: string | null
  character_long_workflow: string | null
  character_short_max_seconds: number
  character_relay_warmup_seconds: number
}

type Translate = (key: string, params?: Record<string, unknown>) => string

export function videoSwapRouteText(
  t: Translate,
  mode: 'face' | 'character',
  route: VideoSwapRouteDescription | null | undefined,
): string {
  if (!route) return t('video.route.loading')
  if (mode === 'face') {
    if (route.engine === 'facefusion') {
      return t('video.route.faceFusion', {
        model: route.facefusion_model || 'FaceFusion',
        provider: route.facefusion_provider || 'cpu',
      })
    }
    return t('video.route.faceH3', {
      workflow: route.face_workflow || t('video.route.workflowMissing'),
    })
  }
  const short = route.character_short_workflow || route.character_long_workflow
  const long = route.character_long_workflow || route.character_short_workflow
  return t('video.route.character', {
    short: short || t('video.route.workflowMissing'),
    long: long || t('video.route.workflowMissing'),
    max: route.character_short_max_seconds,
    warmup: route.character_relay_warmup_seconds,
  })
}