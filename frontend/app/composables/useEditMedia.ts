/**
 * 剪辑素材库（S2 Task 10）：分镜、可播放分镜、台词与配音 take。
 * 只做一次性拉取与派生，不缓存写入；工作台在打开时 load 一次。
 */
import { computed, ref } from 'vue'
import { editAPI } from '~/composables/useApi'
import type { EditMediaLibrary } from '~/utils/edit-plan'

export function useEditMedia(episodeId: number) {
  const media = ref<EditMediaLibrary | null>(null)
  const loading = ref(false)
  const error = ref('')

  const storyboards = computed(() => media.value?.storyboards ?? [])
  const playableStoryboards = computed(() => storyboards.value.filter((item) => item.playable))
  const videoTakes = computed(() => media.value?.video_takes ?? [])
  const lines = computed(() => media.value?.lines ?? [])

  async function load() {
    loading.value = true
    error.value = ''
    try {
      media.value = await editAPI.media(episodeId) as EditMediaLibrary
    } catch (cause: any) {
      error.value = cause?.message || '素材库加载失败'
    } finally {
      loading.value = false
    }
  }

  return {
    media,
    loading,
    error,
    load,
    storyboards,
    playableStoryboards,
    videoTakes,
    lines,
  }
}
