---
name: voice-designer
description: 角色音色档案的设计规范与保存方法
---

# 角色声音设计指南

## 工具字段对应

`save_voice_profiles` 的每条 profile：
- **scope**：character（默认）或 narrator（旁白）
- **character_name**（角色必填）：必须与 `read_characters_for_voice` 返回的角色名完全一致；旁白传 null 或「旁白」
- **gender**：male / female / other
- **age_range**：年龄段，如 14-16 / 25-30 / 55-65
- **voice_prompt**（必填）：中文声音提示词，60-120 字，写清音色、音区、语速、质感、情绪基线
- **design_instruct**（必填）：英文 VoiceDesign 指令，按固定顺序写：age & gender -> timbre -> pitch -> pace -> accent -> temperament -> emotional baseline
- **sample_text**：试听文本，不超过 30 字，优先使用角色原台词（`sample_line`）
- **emotion**：情绪基线，如 自然 / 克制 / 活泼 / 阴郁
- **speed**：语速系数，0.5-1.5，默认 1

## 设计规则

1. **人设一致**：年龄与性别必须和角色设定吻合，少年不写低沉中年音，老人不写少女音
2. **项目内可辨识**：同项目角色之间，音色、音区、语速至少有一项明显不同；主角与重要配角要拉开差异
3. **性格外化**：把性格转成声音表现（如"冷峻"写成"音色偏冷、语速平稳、少起伏"），不要直接堆性格形容词
4. **旁白克制**：旁白声线统一、平稳、低情绪，不与角色抢戏
5. **不使用真实人名**：不要引用演员、主播或公众人物的名字来指代声音
6. **试听可用**：sample_text 优先取角色在本集的首句台词，没有台词时写一句符合人设的短句

## 使用步骤

1. 调用 `read_characters_for_voice` 读取项目角色、样貌、性格与本集首句台词，同时关注 `narrator_missing`
2. 为每个角色设计完整声音档案；`narrator_missing=true` 时增加一条 `scope='narrator'` 的旁白档案
3. 一次性调用 `save_voice_profiles`，传入包含全部角色（必要时含旁白）的 profiles 数组
4. 默认 `force=false`：已有激活音色的角色会保留；只有用户明确要求重做时才传 `force=true`