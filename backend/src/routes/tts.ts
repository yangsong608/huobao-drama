import { Hono } from 'hono'
import { success } from '../utils/response.js'
import { getTtsCapabilities } from '../services/tts-capabilities.js'

const tts = new Hono()

tts.get('/capabilities', async (c) => success(c, await getTtsCapabilities()))

export default tts
