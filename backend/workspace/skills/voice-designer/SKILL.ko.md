---
name: voice-designer
description: 캐릭터 음성 프로필 설계 규범과 저장 방법
---

# 캐릭터 음성 설계 가이드

## 도구 필드 대응

`save_voice_profiles`의 각 profile:
- **scope**: character(기본) 또는 narrator(내레이션)
- **character_name**(캐릭터 필수): `read_characters_for_voice`가 반환한 캐릭터 이름과 정확히 일치해야 함. 내레이션은 null 또는 "旁白"
- **gender**: male / female / other
- **age_range**: 연령대, 예 14-16 / 25-30 / 55-65
- **voice_prompt**(필수): 중국어 음성 프롬프트, 60-120자, 음색·음역·속도·질감·감정 기준선을 기술
- **design_instruct**(필수): 영어 VoiceDesign 지시, 고정 순서: age & gender -> timbre -> pitch -> pace -> accent -> temperament -> emotional baseline
- **sample_text**: 시청 텍스트, 30자 이내, 캐릭터 원래 대사(`sample_line`)를 우선 사용
- **emotion**: 감정 기준선, 예 자연 / 절제 / 활발 / 음울
- **speed**: 속도 계수, 0.5-1.5, 기본값 1

## 설계 규칙

1. **설정 일치**: 나이와 성별은 캐릭터 설정과 맞아야 한다. 소년을 낮은 중년 음성으로, 노인을 소녀 음성으로 쓰지 않는다
2. **프로젝트 내 식별성**: 같은 프로젝트 캐릭터끼리는 음색·음역·속도 중 최소 하나를 뚜렷하게 다르게 한다. 주연과 주요 조연은 차이를 크게 둔다
3. **성격의 외현화**: 성격을 음성 표현으로 바꾼다(예 "냉철" → "차가운 음색, 안정된 속도, 기복 적음"). 성격 형용사를 나열하지 않는다
4. **절제된 내레이션**: 내레이션은 통일되고 안정적이며 감정을 낮춰 캐릭터와 경쟁하지 않는다
5. **실명 사용 금지**: 배우·스트리머·공인의 이름으로 음성을 설명하지 않는다
6. **시청 가능**: sample_text는 현재 화의 첫 대사를 우선하고, 없으면 설정에 맞는 짧은 문장을 쓴다

## 사용 단계

1. `read_characters_for_voice`를 호출해 캐릭터·외모·성격·현재 화 첫 대사·`narrator_missing`을 읽는다
2. 모든 캐릭터의 완전한 음성 프로필을 설계한다. `narrator_missing=true`이면 `scope='narrator'` 내레이션을 하나 추가한다
3. 전체 캐릭터(필요하면 내레이션 포함)를 담은 profiles 배열로 `save_voice_profiles`를 한 번만 호출한다
4. 기본은 `force=false`: 활성 음성이 있는 캐릭터는 유지된다. 사용자가 명확히 재작업을 요청한 경우에만 `force=true`를 전달한다