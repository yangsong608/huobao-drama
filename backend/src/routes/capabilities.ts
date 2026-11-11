/**
 * 只读媒体能力接口：全部客户端判断 FFmpeg/FFprobe 相关功能的唯一依据。
 * `?refresh=1` 强制重新探测；普通请求命中 30 秒缓存。
 */
import { Hono } from 'hono'
import { getMediaCapabilities } from '../services/media-capabilities.js'
import { success } from '../utils/response.js'

const app = new Hono()

app.get('/', async (c) => {
  const media = await getMediaCapabilities({ refresh: c.req.query('refresh') === '1' })
  return success(c, { media })
})

export default app
