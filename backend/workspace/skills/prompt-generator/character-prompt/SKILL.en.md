---
name: character-prompt
description: Final character prompt specification — front-face close-up + headless three-view turnaround (front / 90-degree side / back), serving as the appearance anchor for all subsequent generation
---

# Final Character Prompt (left: front-face close-up + right: headless three-view turnaround)

What is generated is a character reference sheet with a fixed composition:

- **Left: front-face close-up** — a frontal close view of head and shoulders, with facial features, hairstyle, and skin texture clearly visible, serving as the anchor for facial recognizability
- **Right: three equal-height headless full-body views side by side — front, 90-degree side, and back** — three headless body views of the same character, showing only neck-down, with the neck line and the soles of the feet aligned

**Core principle: consistency > beauty.** This image is the appearance anchor for all subsequent character images and video references; it must be neutral, clear, and reusable — do not pursue the artistry of a single image.

## Output Structure (assemble a single coherent passage in this order, following the session language directive)

```
Character reference sheet, left side a front-face close-up showing the complete head, face, hairstyle and shoulders,
right side three equal-height headless full-body views side by side showing front, 90-degree side, and back;
the three right-side views show only the neck-down torso, arms, legs and outfit, with no head, face or hair,
neck line and soles of feet aligned, all three views equal in height and side by side;
[age impression + gender impression + physique], [facial features], [hairstyle], [clothing + accessories];
the close-up and the body views share the same outfit, body proportions and colors;
pure white background, soft even lighting, cinematic quality
```

## Description Order Rules

Put the **most recognizable features first**, covering every key element of `appearance` (looks) and `styling` (hair/clothing/makeup) in this order, with no omissions:

1. Identity anchors: age impression (e.g. "early twenties"), gender impression, physique (height and build, posture habits)
2. Facial features: face shape, eyes, other notable features (scars, moles, glasses, etc.) — the front-face close-up depends on this part especially
3. Hairstyle: color, length, style
4. Clothing: style, color, material, condition (e.g. "a wrinkled work uniform with solder marks on the cuffs")
5. Accessories: write only the recognizable ones; do not pile them on

Convert the character's personality traits into outward bearing and expression descriptions (e.g. "haggard" → "weary eyes, slightly slumped shoulders"); personality words must not appear directly.

## Composition & Consistency

- Left front-face close-up: facing the camera directly, neutral expression, head to shoulders fully in frame
- Right three full-body views: front, 90-degree side, and back of the same character, **equal in height, side by side, evenly spaced**, neck line and soles of feet on the same horizontal lines
- The right three views are headless body views: show only the neck-down torso, arms, legs and outfit, with no head, face or hair; do not copy the head from the left close-up onto the right body views
- The close-up and the three body views must have the same outfit, body proportions and colors — explicitly state "the close-up and the body views share the same outfit, body proportions and colors"
- Neutral stance, natural expression — easy to reuse as a reference image
- Soft, even studio lighting; no dramatic light and shadow (the reference image must work in every kind of scene)
- Do not mix unrelated words into the output

## Prohibitions

- Dynamic poses, exaggerated expressions, props in hand, being in frame with other people
- Heads, faces or hair appearing in the right three body views; copying the close-up head onto the right body views
- Cropping the right body views (they must run from the neck to the soles of the feet, with the neck line and soles aligned)
- Text, labels, watermarks, signatures
- Heavy shadows, colored background lighting, background props

## Saving

Call `save_character_final_prompt`: the prompt parameter contains no style words — **the project's visual style is automatically injected by the tool at the very front of the final prompt**. Write the layout positively; do not put prohibition sentences into the prompt. For the right side, write “headless full-body views” and “only the neck-down body”.
