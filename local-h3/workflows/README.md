# workflows · ComfyUI 调度与图（JSON）

## 目录

```
workflows/
├── graphs/   ← 可直接 POST /prompt 的 JSON（API 格式）
└── scripts/  ← 生成这些图的 Python 脚本（改参数后重跑即可再生成）
```

## graphs 清单

| 文件 | 场景 | 关键参数 |
|---|---|---|
| `01_bridge_r2v_864x480.json` | 桥接：参考图生视频 | Director, task=r2v, 864×480, 4 步, ambient 音频 |
| `01_bridge_fl2v_864x480.json` | 桥接：首帧生视频 | Director, task=fl2v |
| `01_bridge_t2v_864x480.json` | 桥接：文生视频 | Director, task=t2v |
| `02_single_timeline_3seg_8step_1024x576.json` | **单 timeline 3 段**（正式版候选） | 8 步 LoRA，每段独立 refs+prompt，1024×576 |
| `03_director_r2v_huobao_style_864x480.json` | 复刻火宝（r2v + `@图片N`） | 864×480，要 `/tmp/e9_blobs.json` 才能重建 |
| `04_img2video_motioncontext_cfg_trim_5s.json` | 手工链路：首帧+上下文+负条件+Trim | ImageToVideo → MotionContext → CFGGuider → Trim |
| `05_r2v_addguide_motioncontext_12s.json` | R2V + AddGuide 钉首帧 + 上下文 | 已验证“硬钉会压过参考图” |
| `06_subtitle_fix_{A,B,C}.json` | 字幕三方案对照 | A: cfg1 / B: cfg2 / C: 英文无中文 |

## 怎么用

```bash
# 1. 提交
curl -s -X POST http://127.0.0.1:8188/prompt \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\": $(cat graphs/02_single_timeline_3seg_8step_1024x576.json)}"

# 2. 轮询
curl -s http://127.0.0.1:8188/history/<prompt_id>

# 3. 取产物
curl -s "http://127.0.0.1:8188/view?filename=xxx.mp4&subfolder=hb_e12&type=output" -o out.mp4
```

## 注意

1. **参考图文件名**（`es01.png`、`ref_jiapo.png`…）必须在 `ComfyUI/input/` 里存在，否则 400；
2. **参考图传参**：JSON 里是 `segments[].refs = [{index, imageFile}]`（Director 用这个），
   而直接调 `MiniMaxH3ReferenceToVideo` 时必须是 `"ref_images.ref_image_0": [node,0]` 点号写法；
3. `02` 与 `05` 的差异就是“参考图 vs 首帧硬钉”，别混用；
4. 种子固定在同图里，复现时**不要改 seed**。
