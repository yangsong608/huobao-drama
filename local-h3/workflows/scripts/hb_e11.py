#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E11：单条 Director timeline（3 段，每段独立 refs + prompt）
- 8 步 LoRA（fl2v_turbo_8step）
- 1024x576
- 提示词全英文（中文全部移出，避免烧字幕）
- 参考图：场景 + 角色正脸肖像（新生成的干净肖像），refMaxSize=1024
- 唐奕加性别锚定：14-year-old boy, masculine features
"""
import json, os, subprocess, sys, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
OUT = "/data/comfyui/ComfyUI/output/hb_e11"
WORK = "/data/comfyui/ep001/sd/e11_work"
NEG = ("bad video, distorted face, extra fingers, deformed hands, subtitles, captions, "
       "on-screen text, chinese characters, watermark, logo")

STYLE = ("Chinese guofeng 2.5D illustration style, semi-realistic donghua-quality character art, "
         "elegant flowing line work, rich traditional Chinese aesthetic elements, layered ink-wash inspired "
         "atmospheric backgrounds, refined silk and fabric textures, soft luminous lighting with gentle haze, "
         "sophisticated muted jewel-tone palette, xianxia drama poster quality, consistent character design across shots, "
         "avoid flat cel shading, avoid western comic ink style, avoid photorealism, avoid plastic 3D look")

J = "<Picture 2> (the gaunt woman in her forties: thin face, dark grey cloth headscarf, dark ochre short jacket, grey apron)"
L = "<Picture 3> (the plump neighbour woman in her fifties: round face, dark hair bun with a gold pin, jade earrings, purple jacket with gold floral pattern)"
T = "<Picture 2> (a fourteen-year-old boy with masculine, clear-cut features, dark hair tied in a topknot with a dark blue band, grey-blue cross-collar robe)"

SEGS = [
    dict(id="s2", frames=294, refs=["es_shop.png", "p_jiapo.png", "p_liu.png"], prompt=(
        f"[Shot 1] At 0.00 seconds, a medium tracking shot outside a steamed-bun shop in a Northern Song market at dawn (the shop is <Picture 1>): "
        f"{J} looks up brightly and hurries forward with a fawning smile as {L} strolls over slowly, waving a silk handkerchief. "
        f"{J} greets her warmly, mouth moving. "
        f"[Shot 2] At 00:03.000, the camera cuts to a close shot: {L} curls her lip in disdain and flicks the handkerchief, speaking dismissively. "
        f"[Shot 3] At 00:06.000, the camera cuts back to a medium shot: {J}'s smile freezes, her mouth flattens, and she glances sourly toward the busy shop "
        f"across the street where a crowd is queueing; she mutters under her breath. Warm dawn light, steam drifting.")),
    dict(id="s3", frames=209, refs=["es_shop.png", "p_jiapo.png", "p_liu.png"], prompt=(
        f"[Shot 1] At 0.00 seconds, a close shot outside the steamed-bun shop (<Picture 1>): {L} lifts her chin and sneers, speaking down her nose. "
        f"[Shot 2] At 00:03.000, a medium tracking shot: {L} flicks her silk handkerchief and turns to walk toward the busy shop; after two steps she looks back over her shoulder and tosses out one more remark. "
        f"[Shot 3] At 00:06.000, a close shot: {J} spits quietly at her retreating back and mutters under her breath with a sour face. Steam curls in the morning light.")),
    dict(id="s4", frames=209, refs=["es_street.png", "p_jiapo.png", "p_tang.png"], prompt=(
        f"[Shot 1] At 0.00 seconds, a medium shot inside the steamed-bun shop: {J} turns back inside after the argument, tidies the bamboo steamers and drapes a white cloth over the buns, grumbling to herself. "
        f"[Shot 2] At 00:03.000, a close shot: she lifts her eyes and looks across the street, her gaze bitter and weary. "
        f"[Shot 3] At 00:06.000, a slow pan: across the street in front of the busy food shop (<Picture 1>) a long winding queue stands in the steam, and {T} can be seen working behind the counter; "
        f"{J} stands by her steamers staring blankly, the shop interior dim, white steam drifting around her.")),
]


def log(s):
    print(f"[{time.strftime('%H:%M:%S')}] {s}", flush=True)


def build(w, h, steps, seed_base):
    segs, start = [], 0
    for s in SEGS:
        n = s["frames"]
        prompt = STYLE + "\n\n" + s["prompt"] + "\n\noverall_soundscape: morning market murmur, steam hissing, cloth flapping.\n\nnon_diegetic_music: N/A"
        segs.append({"id": s["id"], "start": start, "length": n, "frameCount": n, "durationSec": round(n / 24, 2),
                     "prompt": prompt, "negativePrompt": NEG, "continuityFromPrev": False, "loras": [],
                     "isStartFrame": False, "isEndFrame": False,
                     "genImage": {"imageFile": None, "width": 0, "height": 0}, "endImage": None, "taskType": "",
                     "refs": [{"index": i, "imageFile": f} for i, f in enumerate(s["refs"])]})
        start += n
    tl = {"version": 4, "editMode": "segment", "timelineMode": "r2v", "totalFrames": start, "frameRate": 24.0,
          "width": w, "height": h, "refMaxSize": 1024,
          "output": {"mode": "fixed", "longEdge": max(w, h), "width": w, "height": h, "maxExportFrames": 0,
                     "exportMode": "all", "continuityEnabled": False, "continuityOverlapFrames": 9},
          "videoClips": [], "video": {"fileName": "", "videoFile": "", "subfolder": "", "type": "input", "frames": [], "frameMap": []},
          "global": {"taskType": "r2v — 参考主体生视频(Reference to Video)", "prompt": "", "refs": [],
                     "referenceVideo": {}, "continuousReference": False, "genImage": {"imageFile": ""}},
          "shots": [], "keyframes": [], "segments": segs, "gen": {"defaultFrameCount": 209},
          "runSelectEnabled": False, "runSelection": []}
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "6": {"class_type": "MiniMaxH3Director", "inputs": {
            "model": ["2", 0], "video_vae": ["4", 0], "audio_vae": ["5", 0], "clip": ["3", 0],
            "task_type": "r2v — 参考主体生视频(Reference to Video)",
            "global_prompt": "Natural synchronized sound, no text.",
            "cfg": 1.0, "bd_grp_sample": "采样设置", "bd_grp_advanced": "高级采样 Advanced", "bd_grp_perf": "性能 Performance",
            "frame_rate": 24.0, "width": w, "height": h, "ref_max_size": 1024,
            "total_frames": start, "timeline_data": json.dumps(tl, ensure_ascii=False),
            "steps": steps, "sampler": "euler", "scheduler": "beta", "shift_video": 12.0, "shift_audio": 3.0,
            "seed": seed_base, "clear_vram_between_segments": True}},
        "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "audio": ["6", 1], "fps": 24, "bit_depth": 8}},
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0], "filename_prefix": "hb_e11/e11", "format": "auto", "codec": "auto"}},
    }


def check(wf):
    """静态检查：不提交，只验证图与参数。"""
    errs, warns = [], []
    tl = json.loads(wf["6"]["inputs"]["timeline_data"])
    # 1 参数
    ins = wf["6"]["inputs"]
    if ins["steps"] != 8: errs.append(f"steps={ins['steps']}（应为 8）")
    if "8step" not in wf["2"]["inputs"]["lora_name"]: errs.append("LoRA 不是 8step")
    if (ins["width"], ins["height"]) != (1024, 576): errs.append(f"分辨率 {ins['width']}x{ins['height']}")
    # 2 中文检查
    import re
    for s in tl["segments"]:
        if re.search(r"[\u4e00-\u9fff]", s["prompt"]):
            errs.append(f"{s['id']} 提示词含中文")
        if len(s["prompt"]) > 6000:
            warns.append(f"{s['id']} 提示词长度 {len(s['prompt'])}")
        if not s["refs"]: errs.append(f"{s['id']} 没有参考图")
    # 3 帧偏移
    expect = 0
    for s in tl["segments"]:
        if s["start"] != expect: errs.append(f"{s['id']} start={s['start']} 应为 {expect}")
        expect += s["length"]
    if tl["totalFrames"] != expect: errs.append(f"totalFrames={tl['totalFrames']} 应为 {expect}")
    # 4 参考图文件存在
    for s in tl["segments"]:
        for r in s["refs"]:
            p = os.path.join("/data/comfyui/ComfyUI/input", r["imageFile"])
            if not os.path.exists(p): errs.append(f"缺参考图 {r['imageFile']}")
    return errs, warns, tl


if __name__ == "__main__":
    wf = build(1024, 576, 8, 20275001)
    errs, warns, tl = check(wf)
    print(f"段数 {len(tl['segments'])} | 总帧 {tl['totalFrames']} ≈ {tl['totalFrames']/24:.1f}s")
    print("错误:", errs or "无")
    print("警告:", warns or "无")
    if errs:
        raise SystemExit(1)
    if "--run" not in sys.argv:
        print("静态检查通过（未提交）。加 --run 提交。")
        raise SystemExit(0)
    os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": wf}).encode(),
                                 headers={"Content-Type": "application/json"})
    pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
    log(f"提交 {pid}")
    t0 = time.time()
    while time.time() - t0 < 5400:
        h = json.loads(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=60).read())
        if pid in h:
            ok = h[pid].get("status", {}).get("status_str") == "success"
            log(f"{'完成' if ok else '失败'} {round(time.time()-t0)}s")
            if ok:
                for o in h[pid].get("outputs", {}).values():
                    for im in o.get("images", []):
                        if im.get("filename", "").endswith(".mp4"):
                            q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                            data = urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=900).read()
                            dst = os.path.join(WORK, "e11_output.mp4")
                            with open(dst, "wb") as f:
                                f.write(data)
                            log(f"产物已拷出 {dst} ({len(data)} 字节)")
                            if len(data) < 100000:
                                log("警告：产物过小，可能下载失败")
            else:
                for m in h[pid].get("status", {}).get("messages", [])[-2:]:
                    log(str(m)[:300])
            break
        time.sleep(8)
