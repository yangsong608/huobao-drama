---
name: storyboard-auditor
description: Storyboard action audit standard — five checks, issue localization, evidence requirements and controlled repair boundaries
---

# Storyboard Action Audit Guide

## 1. Scope and boundaries

The audit covers one episode's storyboard: live shots, dialogue/narration, character/scene/prop bindings, asset images and the current breakdown method.

- Window audit phase is read-only: report checks 1/5 only through report_storyboard_issues; never report check 2 here, and never modify shots, lines, bindings or assets.
- Pair audit phase: each round judges exactly one adjacent pair of real shots and must submit connected or broken through report_continuity_verdict; a missing verdict fails the round.
- Repair phase only accepts whitelisted actions through apply_storyboard_repair, and every action must reference an issueId from the current issue list; storyboardId may be omitted because the server locates the shot by issueId.
- Transition-shot insertion is performed by the server from the pair verdict; the repair phase must not submit insertion actions or change shot count/numbering.
- Per-shot status, issue counts, repairs and rollbacks are server-maintained; never output these fields.

## 2. Operational guidance for the five checks

### Check 1: camera work, dialogue, action, expression, narration of each shot

Rules already cover: empty description, empty prompt, missing camera fields, missing 【Shot N】 structure, missing header, broken timeline, >12-character dialogue in a 3-second segment, action written as dialogue.

Semantic focus:

1. Is the description shootable? Who, where, doing what, how (physical detail), expression and gaze, and the result. Abstract emotion only ("he is angry", "the mood is tense") is not shootable.
2. Do camera movement, shot size and angle serve the action? Emotional outbursts suit close-ups, spatial relations suit wide shots, following action suits tracking; a static medium shot for a fierce fight is usually wrong.
3. Role-placement errors:
   - Camera language written as dialogue: `@A says: "camera pushes in"`.
   - Narration written as a character speaking: an inner voice that should be narration appears as `@A says: "Three years later…"`.
   - Action/psychology written as narration: `Narration: "He turns his head in disappointment"` — unless the script explicitly asks for narrated action.
4. Sub-shot actions inside one segment contradicting each other (standing up then already seated).
5. Is the sub-shot count reasonable for an 8-15 second segment (normally 2-4)? Too many leaves each under 2 seconds; too few drags.

Issue code: `semantic_shot_description`, check 1.

Severity:
- error: wrong speaker/narration placement, unshootable description, self-contradictory action.
- warning: camera/action mismatch, vague description, unbalanced sub-shot pacing.
- info: worth improving but not generation-blocking.

### Check 2: continuity between adjacent shots (pair verdict)

Each round the prompt gives exactly one pair of adjacent real shots, never a full window. Read both video prompts completely and judge only this pair.

1. Ending action carry-over: what the character was doing, what was in hand, which way they faced; does the next shot's first segment visibly carry it through action, gaze, position or prop? Break example: previous shot "@A pushes the door and rushes out", next shot "@A sits at the table drinking tea" with no transition.
   - Judge by the video-prompt timeline: compare the previous shot's last segment with the next shot's first segment.
   - The continuity field is only a claim, not evidence; if it claims a carry-over that the first segment does not show, it is still a break.
   - A table change, location change, character-group change or time jump without a transitional action or transition shot is broken.
2. Gaze and axis: dialogue eyelines crossing the line; if A looks right, B should look back from the opposite side.
3. Space and blocking: left/right positions, door/window positions within the same scene.
4. Time: day/night, lighting, costume, injuries, prop state; flashbacks and time jumps need a transition or caption.
5. Cross-scene hard cut: a direct cut to a new scene without continuity notes or transition is broken.
6. Ambience: same-scene consecutive segments should share the same environment sound; abrupt changes feel spliced.

Submit the verdict only through report_continuity_verdict:
- pairKey must exactly match `P<previousShotId>-<currentShotId>` from the prompt title.
- verdict is connected or broken; submit exactly once per round, otherwise the round fails.
- For broken, provide severity, evidence (the concrete difference between both prompts) and suggestion; if evidence is thin, still state where the difference is.
- The prompt states how existing transition shots are handled; do not assume otherwise.

Transition shots and insertion:
- Shots marked "transition shot" are existing solutions; never audit them and never report issues on them.
- When a transition shot already sits between two real shots, still judge the pair: if the transition explains it well, connected; if not, broken with `suggestedTransition` must be null because the server will not insert another card.
- When no transition shot exists and the pair is broken, you may set `suggestedTransition`:
  - `empty`: empty-shot buffer (landscape, object close-up, environment).
  - `scene`: a location transition generated from an already bound scene.
  - `text`: a text card (time, place, chapter).
- Do not always pick empty: use text when the time/era/hour clearly jumps; use scene when the location clearly changes and the next shot has a bound scene; use empty only when the same place and time merely lack an action buffer. Across consecutive breaks, vary the type instead of making a whole episode empty shots; the server rotates empty-shot framing, so do not describe the same empty shot repeatedly.
- The server decides per policy whether to insert one transition shot and renumber; never create one yourself or submit insertion in the repair phase.
- The rule-layer time-jump issue is only an info hint (adjacent_time_jump); the pair verdict decides insertion. When a transition shot already exists, treat that hint as resolved and do not repeat it.

Severity:
- error: clear action/space/time break with no explanation that confuses the audience.
- warning: axis, blocking, costume or ambience discontinuity.
- info: a transition would help but the cut still works.

### Check 3: long silent / empty shots

Rules report `silent_shot_long` / `empty_shot_long` by character presence and duration thresholds.

This check is fully rule-owned: the window phase must not report semantic issues for check 3 (tools accept checks 1/5 only) and must not submit rule-layer codes. Check 3 is never auto-repaired: the system cannot invent dialogue, and shortening or splitting is a creative decision.

### Check 4: duration of each line and whether to split

Rules compute required duration from pronounceable characters (about 4 chars/sec + 1 second breath per line) and report:
- `line_insufficient_duration`: effective duration too short.
- `line_overlong_duration`: effective duration clearly excessive.
- `line_requires_split`: a single line exceeds 6 seconds.
- `shot_dialogue_over_capacity`: total dialogue exceeds the shot duration.

This check is fully rule-owned: the window phase must not report semantic issues for check 4 and must not submit rule-layer codes. Split or duration-extension problems are routed by the server to controlled repair or manual handling.

### Check 5: assets used by the storyboard are correct and complete

Rules already cover: unbound scene, invalid binding, not linked to the episode, duplicate binding, missing @reference, missing asset image, missing image file, malformed reference.

Semantic focus:
1. Are all characters/scenes/props mentioned in the description or video prompt bound to this shot? Mentioned but unbound means no reference image at generation.
2. Do bound assets actually appear in this shot? Over-binding pollutes reference images.
3. Does each @name point to the right asset? Same-name different people, similar scene names, generic prop names ("knife" pointing to the wrong knife).
4. Do described appearances clearly conflict with asset images (age, costume, era of the scene)? The generated result will be inconsistent.

Issue code: `semantic_asset_mismatch`, check 5.

Check 5 is always report-only: never change bindings, generate asset images or delete duplicate bindings. Suggestions must point to manual actions (add images on the asset page, adjust bindings in the shot asset panel).

## 3. Evidence and suggestions

- evidence: quote the key original sentence, max 500 characters; identify the exact location (which 【Shot N】, which line, which 3-second segment).
- suggestion: an immediately actionable direction, max 300 characters; avoid empty phrases like "optimize" or "watch continuity".
- message: one sentence on what the problem is and why it affects generation.
- Do not report judgements without textual evidence.

## 4. Deduplication and window discipline

- The window phase reports checks 1/5 only; check 2 goes exclusively through the pair verdict, never through the window tool.
- Semantic windows hold 16 shots with overlapping context before/after; the same issue appears in two windows, report it once.
- Dedup key: check + primary shot + related shot + semantic category; keep the fuller evidence.
- Do not repeat issues already reported by rules at the same location; the semantic layer only adds what rules cannot judge.
- At most 30 issues per window; prefer errors, then warnings, keep info only when genuinely useful.
- Submit one verdict per pair; do not merge several pairs into one call or replace the tool call with prose.

## 5. Repair phase standard

### Allowed actions and fields

| Action | Applies to | Allowed fields | Key constraint |
|---|---|---|---|
| fill_camera_fields | missing camera/shot-size/angle | shot_type, angle, movement | infer only from existing description and prompt |
| normalize_video_prompt | missing header, broken timeline, action as dialogue | video_prompt, description | preserve every real line/narration and speaker |
| rewrite_description | unshootable or misplaced description | description, video_prompt, result | no new characters/props/plot |
| fix_continuity | uncarried action, unexplained cross-scene cut | continuity, transition, description, video_prompt | never change scene/character bindings |
| extend_duration | insufficient dialogue capacity | duration, video_prompt, description | increase only, within the per-segment max, timeline synchronized |

Transition-shot insertion is not in this table: the server performs it from the pair verdict. The repair phase must not submit insert_transition_shot or change shot count/numbering.

### Video prompt timeline hard constraints

- First line must be "Characters: @A, @B | Scene: @Name"; use "Characters: none" / "Scene: unspecified" when empty.
- Body starts at "0-3 seconds:" and continues in 3-second segments with no overlap or gap.
- The final segment's end must equal the shot duration.
- Dialogue only as `@Name says: "line"`; narration only as `Narration (voice-over): "line"`; never add lines or speakers.

### Repair boundaries

- At most 40 actions per task, 3 per shot, and the same field cannot be modified twice.
- Shots with any frame asset, video, subtitle, dubbing, locked line or active task are read-only; tools reject them—do not retry.
- The user may have edited a shot after the audit; the tool rejects actions when fingerprints differ—do not bypass.
- Asset issues, empty shots, line splitting, missing video prompts and unbound speakers are out of automatic repair scope.
- When unsure, skip and leave it to manual handling; do not force a different field after a rejection.

## 6. Common false positives to avoid

1. Reporting a long shot with environmental storytelling as an empty shot.
2. Reporting explicitly scripted narrated action as "action written as narration".
3. Reporting a cross-scene cut with continuity notes as a break.
4. Treating same-name different assets (two "Old Wang") as a binding error without checking IDs and descriptions.
5. Reporting intentional stylized camera work (static long take, surveillance angle) as a camera error.
6. Suggesting automatic binding changes for check 5, which exceeds authority.
