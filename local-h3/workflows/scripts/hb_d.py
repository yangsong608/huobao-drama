#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""D 组：滚动首帧（镜 N+1 的首帧 = 镜 N 生成的最后一帧），串行生成后拼接。

在服务器上运行：python3 hb_d.py
"""
import json, os, subprocess, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
IN_DIR = "/data/comfyui/ComfyUI/input"
OUT_DIR = "/data/comfyui/ComfyUI/output/hb_d"
WORK = "/data/comfyui/ep001/sd/hb_d_work"
NEG = "bad video, distorted face, extra fingers, text, watermark, subtitles"
PROMPTS = "/data/comfyui/ep001/sd/d_prompts.json"


def log(s):
    line = f"[{time.strftime('%H:%M:%S')}] {s}"
    print(line, flush=True)


def submit(wf):
    req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": wf}).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]


def wait(pid, timeout=2400):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = json.loads(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=60).read())
        if pid in h:
            return h[pid]
        time.sleep(6)
    return None


def fetch_output(hist, dst):
    for o in hist.get("outputs", {}).values():
        for im in o.get("images", []):
            if im.get("filename", "").endswith(".mp4"):
                q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""),
                                            "type": im.get("type", "output")})
                raw = urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=600).read()
                open(dst, "wb").write(raw)
                return True
    return False


def graph(first_file, frames, prompt, seed):
    si = {"imageFile": first_file, "width": 1672, "height": 941}
    shot = {"id": "s0", "durationSec": round(frames / 24, 2), "prompt": prompt, "negativePrompt": NEG,
            "continuityFromPrev": False, "loras": [], "startImage": si, "endImage": None}
    seg = {"id": "s0", "start": 0, "length": frames, "frameCount": frames, "durationSec": round(frames / 24, 2),
           "prompt": prompt, "negativePrompt": NEG, "continuityFromPrev": False, "loras": [],
           "isStartFrame": True, "isEndFrame": False, "genImage": si, "endImage": None, "taskType": "", "refs": []}
    tl = {"version": 4, "editMode": "segment", "timelineMode": "fl2v", "totalFrames": frames, "frameRate": 24.0,
          "width": 864, "height": 480, "refMaxSize": 864,
          "output": {"mode": "fixed", "longEdge": 864, "width": 864, "height": 480, "maxExportFrames": 0,
                     "exportMode": "all", "continuityEnabled": False, "continuityOverlapFrames": 9},
          "videoClips": [], "video": {"fileName": "", "videoFile": "", "subfolder": "", "type": "input", "frames": [], "frameMap": []},
          "global": {"taskType": "fl2v — 首尾帧生视频(First-Last Frame)", "prompt": "", "refs": [],
                     "referenceVideo": {}, "continuousReference": False, "genImage": {"imageFile": ""}},
          "shots": [shot], "keyframes": [], "segments": [seg], "gen": {"defaultFrameCount": frames},
          "runSelectEnabled": False, "runSelection": []}
    return {
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
            "total_frames": frames, "timeline_data": json.dumps(tl, ensure_ascii=False),
            "steps": 4, "sampler": "euler", "scheduler": "beta", "shift_video": 12.0, "shift_audio": 3.0,
            "seed": seed, "clear_vram_between_segments": True}},
        "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "audio": ["6", 1], "fps": 24, "bit_depth": 8}},
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0], "filename_prefix": f"hb_d/s{seed}", "format": "auto", "codec": "auto"}},
    }


def main():
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    shots = json.load(open(PROMPTS))
    first = "d_first1.png"
    parts = []
    for s in shots:
        no = s["no"]
        t0 = time.time()
        wf = graph(first, s["frames"], s["prompt"], 20267300 + no)
        pid = submit(wf)
        hist = wait(pid)
        if not hist:
            log(f"镜{no} 超时"); break
        dst = os.path.join(WORK, f"d{no}.mp4")
        if not fetch_output(hist, dst):
            log(f"镜{no} 无产物"); break
        # 取最后一帧作为下一镜首帧
        nxt = f"d_first{no+1}.png"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.2", "-i", dst,
                        "-frames:v", "1", os.path.join(IN_DIR, nxt)], check=True)
        log(f"镜{no} 完成 {round(time.time()-t0)}s -> 首帧 {nxt}")
        parts.append(dst)
        first = nxt
    if len(parts) == len(shots):
        lst = os.path.join(WORK, "list.txt")
        open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
        out = os.path.join(OUT_DIR, "d_roll_00001_.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                        "-c:v", "libx264", "-crf", "18", "-c:a", "aac", out], check=True)
        log(f"拼接完成 {out}")
    log("=== D 组结束 ===")


if __name__ == "__main__":
    main()
