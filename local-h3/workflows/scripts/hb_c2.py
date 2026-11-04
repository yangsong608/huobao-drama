#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""C′ 组：只把 1→2、2→3 串起来（同空间连续），其余硬切。"""
import json, os, subprocess, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
OUT_DIR = "/data/comfyui/ComfyUI/output/hb_c2"
LOG = "/data/comfyui/ep001/sd/hb_c2.log"
NEG = "bad video, distorted face, extra fingers, text, watermark, subtitles"
PROMPTS = "/data/comfyui/ep001/sd/d_prompts.json"


def log(s):
    line = f"[{time.strftime('%H:%M:%S')}] {s}"
    print(line, flush=True)
    open(LOG, "a", encoding="utf-8").write(line + "\n")


def build(shots):
    segs, timeline_shots, start = [], [], 0
    for i, s in enumerate(shots, 1):
        n = s["frames"]
        prompt = s["prompt"]
        si = {"imageFile": f"c2_{i}.png", "width": 1672, "height": 941}
        ei = None
        if i in (1, 2):
            ei = {"imageFile": f"c2_{i+1}.png", "width": 1672, "height": 941}
        cont = i in (2, 3)
        timeline_shots.append({"id": f"h{i}", "durationSec": round(n / 24, 2), "prompt": prompt,
                               "negativePrompt": NEG, "continuityFromPrev": cont, "loras": [],
                               "startImage": si, "endImage": ei})
        segs.append({"id": f"h{i}", "start": start, "length": n, "frameCount": n,
                     "durationSec": round(n / 24, 2), "prompt": prompt, "negativePrompt": NEG,
                     "continuityFromPrev": cont, "loras": [], "isStartFrame": True,
                     "isEndFrame": bool(ei), "genImage": si, "endImage": ei, "taskType": "", "refs": []})
        start += n
    tl = {"version": 4, "editMode": "segment", "timelineMode": "fl2v", "totalFrames": start,
          "frameRate": 24.0, "width": 864, "height": 480, "refMaxSize": 864,
          "output": {"mode": "fixed", "longEdge": 864, "width": 864, "height": 480, "maxExportFrames": 0,
                     "exportMode": "all", "continuityEnabled": False, "continuityOverlapFrames": 9},
          "videoClips": [], "video": {"fileName": "", "videoFile": "", "subfolder": "", "type": "input", "frames": [], "frameMap": []},
          "global": {"taskType": "fl2v — 首尾帧生视频(First-Last Frame)", "prompt": "", "refs": [],
                     "referenceVideo": {}, "continuousReference": False, "genImage": {"imageFile": ""}},
          "shots": timeline_shots, "keyframes": [], "segments": segs,
          "gen": {"defaultFrameCount": 209}, "runSelectEnabled": False, "runSelection": []}
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "6": {"class_type": "MiniMaxH3Director", "inputs": {
            "model": ["2", 0], "video_vae": ["4", 0], "audio_vae": ["5", 0], "clip": ["3", 0],
            "task_type": "fl2v — 首尾帧生视频(First-Last Frame)",
            "global_prompt": "Northern Song market at dawn, natural synchronized sound.",
            "cfg": 1.0, "bd_grp_sample": "采样设置", "bd_grp_advanced": "高级采样 Advanced", "bd_grp_perf": "性能 Performance",
            "frame_rate": 24.0, "width": 864, "height": 480, "ref_max_size": 864,
            "total_frames": start, "timeline_data": json.dumps(tl, ensure_ascii=False),
            "steps": 4, "sampler": "euler", "scheduler": "beta", "shift_video": 12.0, "shift_audio": 3.0,
            "seed": 20267204, "clear_vram_between_segments": True}},
        "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "audio": ["6", 1], "fps": 24, "bit_depth": 8}},
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0], "filename_prefix": "hb_c2/c2", "format": "auto", "codec": "auto"}},
    }
    return wf, start


if __name__ == "__main__":
    shots = json.load(open(PROMPTS))
    wf, total = build(shots)
    log(f"C′ 提交：8 镜 {total} 帧")
    req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": wf}).encode(),
                                 headers={"Content-Type": "application/json"})
    pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
    log(f"C′ prompt {pid}")
    t0 = time.time()
    while time.time() - t0 < 3600:
        h = json.loads(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=60).read())
        if pid in h:
            ok = h[pid].get("status", {}).get("status_str") == "success"
            log(f"C′ {'完成' if ok else '失败'} {round(time.time()-t0)}s")
            break
        time.sleep(8)
