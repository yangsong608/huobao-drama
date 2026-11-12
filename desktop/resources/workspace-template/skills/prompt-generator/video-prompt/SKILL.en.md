---
name: video-prompt
description: Video prompt specification — generates a time-segmented video prompt from one continuous storyboard shot
---

# Video Prompt (storyboard segment → video_prompt)

From a single storyboard shot's description (the visuals and dialogue/narration of one continuous camera) / atmosphere / duration, generate the `video_prompt` that drives AI video generation. **One storyboard shot = one 6-15-second single-camera video with no cuts inside**: create a new shot when the camera setup, angle or subject must change; it **never crosses scenes** and never uses flashbacks; do not write 【镜头N】 numbering in the description.

## Format

The **first line of the `video_prompt` is the header**: first introduce which characters and scene appear in this video, then follow with the time segments. Characters and scenes are always referenced with @ (during generation they are replaced with the corresponding reference-image markers, so the video model first locks onto "who" and "where").

```
Characters: @Xiaoming, @Xiaohong | Scene: @Coffee Shop
Blocking: Screen left: @Xiaoming; screen right: @Xiaohong; over @Xiaohong's right shoulder; window back-left, door back-right; action start: @Xiaoming looks down at his phone; action end: @Xiaoming looks up at @Xiaohong
0-3s: @Coffee Shop, medium static shot; @Xiaoming sits screen-right looking down at his phone, fingers repeatedly tapping the table, expression anxious.
3-6s: The doorbell rings; @Xiaoming looks up toward the screen-left doorway and stops tapping.
6-9s: @Xiaohong pushes the door open, walks over and sits screen-right; @Xiaoming smiles and says: "You finally made it."
Negative constraints: only listed on-screen cast; no face/costume changes or extra people; no subtitles; no modern items
```

Header rules:
- Fixed format: `Characters: @CharacterA, @CharacterB | Scene: @SceneName`; only list characters who actually appear and are bound to this storyboard segment, plus the bound scene
- When there are no characters write `Characters: None`; when there is no scene write `Scene: Unspecified`
- The header is its own line with no trailing period; do not append props or any other field
- After the header write one `Blocking:` line: who is screen-left/right, over whose shoulder, which side the window/door/table is on, action start and action end; write `None` when there is no action endpoint
- Write one final `Negative constraints:` line: only listed on-screen cast; no face/costume changes or extra people; no subtitles; no modern items
- Do not write an "Audio:" requirement line or voice/tone/mix instructions (sound is controlled by generation parameters); when this shot genuinely has narration, write it only inside the corresponding time segment as `Narration (voice-over): "line"`

Split into 1-6 second segments (3 seconds by default), each segment on its own line separated by newlines, with time ranges starting at 0 and continuous (no overlaps, no gaps); the last segment's end time equals this storyboard's duration, and a final segment shorter than 1 second uses its actual duration.

## Mapping to the Storyboard Description

The `description` is the sole content source of the video_prompt (visuals, actions, dialogue, and narration are all in it). Conversion rules:

- The continuous `description` maps to **1-3 consecutive time frames (1-6 seconds each, 3 seconds by default)** — same order, no omissions, no cuts; do not write 【镜头N】 numbering in the description
- Dialogue/narration is extracted verbatim from the `@CharacterName says: "..."` / `Narration (voice-over): "..."` entries in the `description` (legacy `CharacterName says: ...` / `Narration: ...` is accepted but must be normalized on output) and assigned to the matching time frames; **do not invent new dialogue beyond the description**; camera moves, shot sizes, expressions, psychology, and actions must never become dialogue or narration
- Visual actions follow the `description`; `atmosphere` is only used to supplement each segment's lighting, color tone, and mood descriptions

## Within-Segment Structure

Organize each segment's content in this order (items with no content may be omitted, but action/visuals are mandatory):

**Time range + scene @reference + shot size/camera move + character @reference + main action·expression + dialogue/narration + mood and lighting**

- **The first segment must establish the space**: scene + camera position + each character's position and state, so the audience knows at a glance where we are and whom to watch
- **Continuous camera**: no cuts inside one storyboard shot and no changes of shot size/angle/subject; time frames only advance action and emotion within the same camera setup
- **Shot size/camera move**: one camera state for the whole shot (close shot / medium shot / wide shot / close-up; static / push / pull / pan / tracking) with one active camera move; create a new shot to change the camera move
- **Action**: one main action per segment, with concrete visible verbs (walk, turn around, look up, clench, pause)
- **All emotion must become visible description**: no abstract words like "he is very sad / the mood is tense" — write it as "he lowers his head, fingers clench the rim of the cup, breathing grows heavier"
- **Dialogue/narration**: dialogue is written only as `@CharacterName says: "line"`; narration/inner monologue only as `Narration (voice-over): "line"`; **keep the 3-second segments — 12 Chinese characters per segment is only a capacity hint**, never a reason to delete or reword: copy dialogue verbatim from the description, including every punctuation mark and filler particle; split long lines only at original punctuation or semantic pauses, and the segments concatenated must reproduce the original text character for character; a segment without dialogue may note ambient/action sounds (e.g. "machines keep roaring")

## Reference Rules

- `@SceneName` — scene reference; the name must exactly match the location in the scene list
- `@CharacterName` — character reference; the name must exactly match the name in the character list
- `@PropName` — prop reference; the name must exactly match the name in the prop list; reference a prop when it is clearly visible in frame, used, or shown in close-up
- During generation, each `@name` is automatically replaced with the corresponding reference-image marker (e.g. `@Xiaoming` → `@Image1Xiaoming`), so names must match exactly — do not abbreviate or add extra symbols
- **Every segment must have at least one @ reference anchoring the frame**; any segment in which a character appears must @ that character; only reference scenes/characters/props already bound to this storyboard segment

## Timeline Rules

- Split into 1-6 second segments (3 seconds by default, roughly duration ÷ 3), starting at 0 and continuous; the last segment's end time equals this storyboard's duration, and a final segment shorter than 1 second uses its actual duration
- Content pacing: the first segment establishes → middle segments advance the action/conflict → the final segment lands on the result or emotional beat

## Prohibitions

- Cross-scene switching, flashbacks (a segment takes place in a single scene only)
- Referencing scene/character names outside the lists
- Abstract psychological description, literary metaphor (the model only recognizes visible imagery)
- Language that does not match the session language directive

## Saving

Call `update_storyboard` to update only this storyboard segment's `video_prompt` field; do not modify any other field, and do not re-breakdown the whole episode.
