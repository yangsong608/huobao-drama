/** 动作事件时长估算：只看可见动作/速度，不按描述字数或固定节拍表分配。 */

const MOTION_RE = /(?:转身|回头|抬头|低头|点头|摇头|抬手|伸手|递|接住|收回|掏出|拿出|举起|放下|拍在|拍下|按住|按下|推|拉|甩|挥|走|跑|冲|退|进|站起|起身|坐下|蹲下|跪下|倒地|撞|踢|跳|抓|握住|抱住|放|拿|举|抬|低|转|回|看|望|盯|瞥|瞪|瞟|瞄|皱眉|撇嘴|笑|哭|闭|睁|翻|喝|吃|穿|脱|系|解|写|画|擦|摸|指|掀|揭|盖|铺|叠|折|敲|捶|撕|扯|拔|插|塞|收|伸|缩|停|按|碰|扶|抱|搂|拖|拽|扔|丢|捡)/
const SLOW_RE = /(?:慢慢|缓缓|轻轻|逐渐|一点一点|一字一顿|仔细|仔细地|认真地|迟疑|犹豫)/
const FAST_RE = /(?:突然|猛地|迅速|快速|立刻|马上|飞快|急忙|连忙|一把|抬手就|直接)/
const IMPACT_RE = /(?:撞|砸|摔|碎|击|踹|甩|拍在|拍下|按下|拔|刺|砍)/
const STATIC_START_RE = /^(?:@?[^\s，。；：]{1,8})?(?:穿着|穿|戴着|戴|挂着|挂|系着|系|斜挎|别着|别在|垂|挽|扣|摆|铺|贴|立|码|露|凝|散落|站在|坐在|躺在|蹲在|靠在|位于|背景|画面|桌上|墙上|窗|门|地标|嘴唇|眉头|眼睛|目光|眼神|表情|嘴角|下巴|脸色|神情|语气)/
const CHANGE_RE = /(?:起|上|下|过|出|进|向|往|到|了|把|将|被|一下|起来|过去|过来|转身|回头|抬头|低头|抬手|伸手|递|接|收|掏|拿|举|放|拍|按|推|拉|甩|挥|走|跑|冲|退|停)/

export interface ActionTiming {
  events: number
  seconds: number
}

function clauseSeconds(clause: string): number {
  if (!MOTION_RE.test(clause)) return 0
  if (STATIC_START_RE.test(clause) && !CHANGE_RE.test(clause)) return 0
  if (IMPACT_RE.test(clause)) return 0.5
  if (SLOW_RE.test(clause)) return 1.3
  if (FAST_RE.test(clause)) return 0.7
  return 1
}

/** 统计台词引号之外的动作事件；静态服装/背景/持物状态不计入动作时长。 */
export function estimateActionTiming(text: string | null | undefined): ActionTiming {
  const source = String(text || '').replace(/「[^」]*」|“[^”]*”|"[^"]*"/g, '')
  const clauses = source.split(/[，。！？；,.!?;]/).map(item => item.trim()).filter(Boolean)
  let events = 0
  let seconds = 0
  for (const clause of clauses) {
    const value = clauseSeconds(clause)
    if (value <= 0) continue
    events += 1
    seconds += value
  }
  return { events, seconds: Math.round(seconds * 10) / 10 }
}
