#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E9：完全按火宝的参数复刻。
UNET=fl2va, LoRA=fl2v_turbo_4step_v1.0, Director task_type=r2v,
segment.refs 顺序=场景→角色→道具, 正文 @名字 → @图片N名字, negative 用 Director 自带。
分辨率 864x480（与火宝一致）。
"""
import json, os, re, subprocess, sys, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
WORK = "/data/comfyui/ep001/sd/e9_work"
OUT = "/data/comfyui/ComfyUI/output/hb_e9"
NEG = "bad video, distorted face, extra fingers, text, watermark"

# 每镜：duration(秒)、场景图、角色图（按出场顺序）、道具图（无）、提示词
SHOTS = [
    dict(no=2, dur=12,
         refs=[("贾婆子炊饼铺前", "ref_shop.png"), ("贾婆子", "ref_jiapo.png"), ("六婶", "ref_liu.png")]),
    dict(no=3, dur=9,
         refs=[("贾婆子炊饼铺前", "ref_shop.png"), ("贾婆子", "ref_jiapo.png"), ("六婶", "ref_liu.png")]),
    dict(no=4, dur=9,
         refs=[("唐记食铺门前", "ref_street.png"), ("唐大郎", "ref_tang.png")]),
]

GRID = [5, 22, 39, 56, 73, 90, 107, 124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362]


def log(s):
    print(f"[{time.strftime('%H:%M:%S')}] {s}", flush=True)


def frames_for(dur):
    t = dur * 24
    return min(GRID, key=lambda g: abs(g - t))


def ms(s):
    """中文台词剔除，避免烧字幕；动作描述保留。"""
    return re.sub(r"「[^」]*」", "", s)


def retag(prompt, refs):
    """@名字 → @图片N名字"""
    idx = {name: i + 1 for i, (name, _) in enumerate(refs)}
    names = sorted(idx.keys(), key=len, reverse=True)
    def repl(m):
        raw = m.group(1)
        for n in names:
            if raw.startswith(n):
                return f"@图片{idx[n]}{n}{raw[len(n):]}"
        return m.group(0)
    return re.sub(r"@([^\s@#]+)", repl, prompt)


def build(shot, blobs, seed):
    db = blobs[shot["no"]]
    frames = frames_for(shot["dur"])
    prompt = retag(ms(db["video_prompt"]), shot["refs"])
    prompt = prompt + f"\n\natmosphere: {db['atmosphere']}\n\noverall_soundscape: {db['sound_effect']}\n\nnon_diegetic_music: {db['bgm_prompt']}"
    seg = {"id": "s0", "start": 0, "length": frames, "frameCount": frames, "durationSec": round(frames / 24, 2),
           "prompt": prompt, "negativePrompt": NEG, "continuityFromPrev": False, "loras": [],
           "isStartFrame": False, "isEndFrame": False, "genImage": {"imageFile": None, "width": 0, "height": 0},
           "endImage": None, "taskType": "", "refs": [{"index": i, "imageFile": f} for i, (_, f) in enumerate(shot["refs"])]}
    tl = {"version": 4, "editMode": "segment", "timelineMode": "r2v", "totalFrames": frames, "frameRate": 24.0,
          "width": 864, "height": 480, "refMaxSize": 864,
          "output": {"mode": "fixed", "longEdge": 864, "width": 864, "height": 480, "maxExportFrames": 0,
                     "exportMode": "all", "continuityEnabled": False, "continuityOverlapFrames": 9},
          "videoClips": [], "video": {"fileName": "", "videoFile": "", "subfolder": "", "type": "input", "frames": [], "frameMap": []},
          "global": {"taskType": "r2v — 参考主体生视频(Reference to Video)", "prompt": "", "refs": [],
                     "referenceVideo": {}, "continuousReference": False, "genImage": {"imageFile": ""}},
          "shots": [], "keyframes": [], "segments": [seg], "gen": {"defaultFrameCount": frames},
          "runSelectEnabled": False, "runSelection": []}
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "6": {"class_type": "MiniMaxH3Director", "inputs": {
            "model": ["2", 0], "video_vae": ["4", 0], "audio_vae": ["5", 0], "clip": ["3", 0],
            "task_type": "r2v — 参考主体生视频(Reference to Video)",
            "global_prompt": "Natural synchronized sound, no text.",
            "cfg": 1.0, "bd_grp_sample": "采样设置", "bd_grp_advanced": "高级采样 Advanced", "bd_grp_perf": "性能 Performance",
            "frame_rate": 24.0, "width": 864, "height": 480, "ref_max_size": 864,
            "total_frames": frames, "timeline_data": json.dumps(tl, ensure_ascii=False),
            "steps": 4, "sampler": "euler", "scheduler": "beta", "shift_video": 12.0, "shift_audio": 3.0,
            "seed": seed, "clear_vram_between_segments": True}},
        "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "audio": ["6", 1], "fps": 24, "bit_depth": 8}},
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0], "filename_prefix": f"hb_e9/s{shot['no']}", "format": "auto", "codec": "auto"}},
    }
    return wf


def wait(pid, timeout=2400):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = json.loads(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=60).read())
        if pid in h:
            return h[pid]
        time.sleep(8)
    return None


if __name__ == "__main__":
    blobs = {int(k): v for k, v in json.load(open(sys.argv[1])).items()}
    os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    log(f"E9 复刻火宝：{len(SHOTS)} 镜 / 864x480 / fl2va + 4step v1.0 / Director r2v")
    parts = []
    for s in SHOTS:
        t0 = time.time()
        req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": build(s, blobs, 20273000 + s["no"])}).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
        except urllib.error.HTTPError as e:
            log(f"镜{s['no']} 提交失败 {e.read().decode()[:300]}"); continue
        hist = wait(pid)
        if not hist or hist.get("status", {}).get("status_str") != "success":
            log(f"镜{s['no']} 失败 {str((hist or {}).get('status',{}).get('messages',[])[-1:])[:300]}"); continue
        dst = os.path.join(WORK, f"s{s['no']}.mp4")
        for o in hist.get("outputs", {}).values():
            for im in o.get("images", []):
                if im.get("filename", "").endswith(".mp4"):
                    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                    open(dst, "wb").write(urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=600).read())
        parts.append(dst)
        log(f"镜{s['no']} 完成 {round(time.time()-t0)}s")
    if len(parts) == len(SHOTS):
        lst = os.path.join(WORK, "list.txt")
        open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
        out = os.path.join(OUT, "e9_00001_.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                        "-c:v", "libx264", "-crf", "18", "-c:a", "aac", out], check=True)
        log(f"拼接完成 {out}")
    log("=== 结束 ===")
