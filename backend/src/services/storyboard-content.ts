/**
 * 分镜内容分类器（低层共享）
 *
 * 拆分器、意图计划、卡片标签共用同一套动作/战斗/比拼判定，
 * 避免各层正则漂移；战斗/比拼只影响镜头结构与特效，不由题材决定。
 */
export const COMBAT_RE = /(?:战斗|打斗|交手|过招|厮杀|对决|比武|拔刀|拔剑|亮剑|出剑|挥剑|舞剑|剑拔弩张|出拳|拳赛|格斗|枪战|爆炸|追击|追杀|追逐|法术|灵力|真气|剑气|刀光|拳风|冲击|碰撞|斩击|劈砍|刺出|格挡|闪避|围攻|伏击|开火|射击|炮火|轰炸|炸开|扭打|搏斗|突袭|冲锋|飞踢|膝撞|肘击|锁喉|擒拿|激光|能量束|导弹|鱼雷|机甲|战车|战机)/

/** 真正的攻击/对抗动作；机甲、战车、激光等只算战斗语境，不能单独把竞速/比赛判成战斗 */
export const COMBAT_STRONG_RE = /(?:战斗|打斗|交手|过招|厮杀|比武|拔刀|拔剑|亮剑|出剑|挥剑|舞剑|剑拔弩张|出拳|格斗|枪战|爆炸|追击|追杀|法术|灵力|真气|剑气|剑锋|相撞|刀光|拳风|斩击|劈砍|刺出|格挡|闪避|围攻|伏击|开火|射击|炮火|轰炸|炸开|扭打|搏斗|突袭|冲锋|飞踢|膝撞|肘击|锁喉|擒拿)/

export const COMPETITION_RE = /(?:比赛|竞速|比拼|竞技|擂台|棋局|考场|厨艺|舞蹈|辩论|球赛|赛道|计时|比分|裁判|评委|观众席|选手|挑战赛|锦标赛|决赛|初赛|复赛|总决赛|夺冠|得分|进球|冠军|亚军|赛点|竞标|招标|考核|测验)/

export function combatEvidence(text: string): string[] {
  return [...new Set([...String(text || '').matchAll(new RegExp(COMBAT_RE.source, 'g'))].map(match => match[0]))]
}

export function strongCombatEvidence(text: string): string[] {
  return [...new Set([...String(text || '').matchAll(new RegExp(COMBAT_STRONG_RE.source, 'g'))].map(match => match[0]))]
}

export function competitionEvidence(text: string): string[] {
  return [...new Set([...String(text || '').matchAll(new RegExp(COMPETITION_RE.source, 'g'))].map(match => match[0]))]
}

/** 该段是否属于战斗/比拼动作段；用于豁免连续无声压缩和时长封顶。 */
export function isCombatOrCompetitionText(text: string): boolean {
  return COMBAT_STRONG_RE.test(String(text || '')) || COMPETITION_RE.test(String(text || ''))
}
