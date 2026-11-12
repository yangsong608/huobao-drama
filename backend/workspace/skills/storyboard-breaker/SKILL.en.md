---
name: storyboard-breaker
description: Storyboard splitting rules — one storyboard carries one camera setup, one subject and one continuous action
---

# Storyboard Splitting Rules

## 1. Core definition

One storyboard = one video generation task = one camera setup + one subject + one continuous action. Screen left/right, axis and background-landmark sides are scene-level constants: set them once and keep them for every shot in the same scene.

- Each storyboard is 6-15 seconds.
- Only continuous movement within the same camera setup is allowed. A new camera setup, subject, action or emotional beat requires a new storyboard.
- Never write 【镜头2】 or later sub-shots inside one storyboard; time segments within one setup are not sub-shots.

## 2. Script coverage

- Every scene, every line and every key action must appear; never delete or merge scenes or keep only highlights.
- Cover the script scene by scene, at least one storyboard per scene.
- Storyboard floor = ceil(non-whitespace script chars × 0.12 ÷ 15 × 0.9). Fewer means incomplete; add storyboards, never merge or delete.
- Before saving, check scene → storyboard coverage; add missing storyboards rather than cutting.

## 3. Scenes and assets

- Use the canonical scene_id from the canonical scene binding; when names repeat, use only the canonical scene and never pick aliases such as 54/55/56 by time or preference.
- Express time changes in time or blocking, not by switching scene images.
- Character/prop names must exactly match project assets; write @唐大郎（唐奕）, not @唐大郎.
- Only pure environment shots may have no characters; empty shots still need blocking and `action start: none; action end: none`.

## 4. Fields

| Field | Requirement |
|---|---|
| `description` | One continuous shot: who + concrete action + body detail + expression + position/eyeline; at most one 【镜头1】, never 【镜头2】 or later |
| `duration` | 6-15 seconds; internal time segments 1-6 seconds each |
| `scene_id` | Canonical scene ID |
| `character_ids` | Characters actually visible; empty array when none |
| `prop_ids` | Key props; empty array when none |
| `transition` | cut / fade / dissolve / wipe |
| `continuity` | Previous tail action, eyeline, blocking, ambience; first shot writes "opening" |
| `sound_effect` | Reuse the same ambience across storyboards in one scene |
| `video_prompt` | Fixed four sections: header → blocking → time segments → negative constraints |

## 5. Fixed video_prompt sections

1. Header: `Characters: @CharacterA, @CharacterB | Scene: @SceneName`; `Characters: None` / `Scene: Unspecified` when empty; own line, no trailing period.
2. Blocking: `Blocking: Screen left: …; screen right: …; over …'s shoulder; background landmarks: window back-left, door back-right; axis A; action start: …; action end: …`; `no over-shoulder` when none, `background landmarks: none` when none, `axis none` for one character/empty, `axis A` or `axis B` for two or more; any storyboard with characters must have action start and end.
3. Time segments: start at `0-3s:`, each 1-6 seconds, continuous, non-overlapping, last ends at duration; each segment must be the same setup/subject/continuous action; visuals first, then dialogue/narration for that segment.
4. Negative constraints: `Negative constraints: only listed on-screen cast; no face/costume changes or extra people; no subtitles; no modern items`.

Sound is not written here: BGM/ambience are designed in step 4 by scene/plot sound units; only a short per-shot delta (continue/add/fade/silence) is inserted before the negative line afterwards. Never repeat a full style per shot.

## 6. Dialogue

- Dialogue only as `@CharacterName says: "line"`; narration only as `Narration (voice-over): "line"`.
- Copy verbatim from description, including punctuation and filler particles; split only at original punctuation or semantic pauses into adjacent time segments.
- Duration × 4 characters/second = dialogue + narration capacity, leaving one second of breath; split into adjacent storyboards instead of speeding up.
- Never write camera moves, shot sizes, expressions, psychology or actions as dialogue/narration.

## 7. Saving

- Call `save_storyboards` in batches of at most 8; first batch uses `replace_existing: true`, later batches omit it.
- `shot_number` increases in story order; do not stop before all storyboards are saved.
- Self-check before saving: multiple sub-shots, missing blocking, missing action endpoints, missing negative constraints or scene aliases must be fixed first.
