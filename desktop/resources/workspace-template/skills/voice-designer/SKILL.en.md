---
name: voice-designer
description: Rules and methods for designing and saving character voice profiles
---

# Character Voice Design Guide

## Tool field mapping

Each profile in `save_voice_profiles`:
- **scope**: character (default) or narrator
- **character_name** (required for characters): must exactly match a name returned by `read_characters_for_voice`; pass null or "旁白" for the narrator
- **gender**: male / female / other
- **age_range**: age bracket, e.g. 14-16 / 25-30 / 55-65
- **voice_prompt** (required): Chinese voice prompt, 60-120 characters, covering timbre, register, pace, texture and emotional baseline
- **design_instruct** (required): English VoiceDesign instruction in fixed order: age & gender -> timbre -> pitch -> pace -> accent -> temperament -> emotional baseline
- **sample_text**: audition text, at most 30 characters, prefer the character's original line (`sample_line`)
- **emotion**: emotional baseline, e.g. natural / restrained / lively / gloomy
- **speed**: pace factor, 0.5-1.5, default 1

## Design rules

1. **Stay in character**: age and gender must match the character sheet; a teenager must not sound like a middle-aged man, an elderly person must not sound like a young girl
2. **Distinct within the project**: characters in the same project must differ clearly in at least one of timbre, register or pace; lead and major supporting roles need the widest separation
3. **Externalize personality**: translate traits into vocal behavior (e.g. "cold" becomes "cool timbre, steady pace, little inflection") instead of stacking adjectives
4. **Restrained narrator**: the narrator voice is uniform, steady and low-emotion, never competing with characters
5. **No real names**: never reference actors, streamers or public figures to describe a voice
6. **Audition-ready**: prefer the character's first line in the current episode for sample_text; if there is none, write a short line that fits the character

## Steps

1. Call `read_characters_for_voice` to read project characters, appearance, personality, the first line in this episode and `narrator_missing`
2. Design a complete voice profile for every character; when `narrator_missing=true`, add one narrator profile with `scope='narrator'`
3. Call `save_voice_profiles` once with the full profiles array
4. `force=false` by default: characters with an active voice are kept; only pass `force=true` when the user explicitly asks to redo them