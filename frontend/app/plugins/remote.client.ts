/**
 * 远程角色与统一错误处理（客户端启动）：
 * - 读取 `/api/v1/remote/session` 决定 host / guest；服务器模式或旧后端 404 视为 host。
 * - 已配对访客收到 401：标记配对失效、停止后续重试（派发 remote-unpaired），保留当前页面到 `next` 后跳转 `/pair`。
 * - 主机/服务器模式 401 不跳转；只读 403 只提示，不跳转。
 * - 角色就绪后派发 `huobao:remote-role-ready`，实时同步（P13）按角色决定是否连接。
 */
import { toast } from 'vue-sonner'
import {
  isRemoteGuest,
  refreshRemoteSession,
  remoteErrorMessage,
  sanitizeRemoteNext,
  useRemoteRole,
} from '~/composables/useRemoteGuest'

let redirecting = false

export default defineNuxtPlugin(() => {
  if (typeof window === 'undefined') return
  const role = useRemoteRole()

  function onUnauthorized() {
    if (role.role !== 'guest' || !role.paired || redirecting) return
    if (window.location.pathname === '/pair') return

    redirecting = true
    role.paired = false
    role.readonly = false
    window.dispatchEvent(new CustomEvent('huobao:remote-unpaired'))

    const next = sanitizeRemoteNext(`${window.location.pathname}${window.location.search}${window.location.hash}`)
    window.location.assign(`/pair?next=${encodeURIComponent(next)}`)
  }

  function onReadonly() {
    if (!isRemoteGuest()) return
    toast.error(remoteErrorMessage('REMOTE_READONLY'), { duration: 5000 })
  }

  window.addEventListener('huobao:remote-unauthorized', onUnauthorized)
  window.addEventListener('huobao:remote-readonly', onReadonly)

  void refreshRemoteSession().then(() => {
    if (!role.ready) return
    window.dispatchEvent(new CustomEvent('huobao:remote-role-ready', {
      detail: { role: role.role, paired: role.paired, readonly: role.readonly },
    }))
    if (role.role === 'guest' && role.readonly) {
      toast.info(remoteErrorMessage('REMOTE_READONLY'), { id: 'remote-readonly', duration: 8000 })
    }
  })
})
