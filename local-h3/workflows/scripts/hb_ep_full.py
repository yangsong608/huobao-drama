#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""正式版 · E4 路线：huobao 分镜（原词）+ 我们链路

每镜：首帧(huobao 分镜图) → ImageToVideo → MotionContext(继承上一镜 latent)
      → CFGGuider(负条件压字幕) → 采样 → SaveLatent → 解码 → Trim → 保存
最后 concat。

用法：python3 hb_ep_full.py manifest.json [width height cfg]
manifest: [{"no":1,"frames":209,"first":"hb_s1.png","prompt":"...","sound":"...","music":"...","atmos":"..."}]
"""
import json, os, subprocess, sys, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
WORK = "/data/comfyui/ep001/sd/ep_full_work"
OUT = "/data/comfyui/ComfyUI/output/ep_full"
NEG = ("subtitles, captions, on-screen text, chinese characters, watermark, logo, "
       "distorted face, extra fingers, deformed hands")


def log(s):
    print(f"[{time.strftime('%H:%M:%S')}] {s}", flush=True)


def build_prompt(s):
    parts = [s["prompt"]]
    if s.get("atmos"):
        parts.append(f"atmosphere: {s['atmos']}")
    parts.append(f"overall_soundscape: {s.get('sound') or 'ambient market sound'}")
    parts.append(f"non_diegetic_music: {s.get('music') or 'N/A'}")
    return "\n\n".join(parts)


def graph(s, w, h, cfg, seed):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "20": {"class_type": "LoadImage", "inputs": {"image": s["first"]}},
        "6": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["3", 0], "vae": ["4", 0], "prompt": build_prompt(s),
            "width": w, "height": h, "length": s["frames"], "first_frame": ["20", 0]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["3", 0], "text": NEG}},
        "8": {"class_type": "MiniMaxH3MotionContextLoadLatent",
              "inputs": {"latent_path": "ep_full", "clip_index": s["no"] - 1, "stock_format": False, "folder": "output"}},
        "9": {"class_type": "MiniMaxH3MotionContext", "inputs": {
            "conditioning": ["6", 0], "vae": ["4", 0], "latent": ["6", 1],
            "context_length": "22", "audio_context_length": 18,
            "context_latent": ["8", 0], "audio_vae": ["5", 0]}},
        "10": {"class_type": "CFGGuider", "inputs": {"model": ["2", 0], "positive": ["9", 0], "negative": ["7", 0], "cfg": cfg}},
        "11": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "12": {"class_type": "BasicScheduler", "inputs": {"model": ["2", 0], "scheduler": "beta", "steps": 4, "denoise": 1.0}},
        "13": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "14": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["13", 0], "guider": ["10", 0],
                                                                  "sampler": ["11", 0], "sigmas": ["12", 0],
                                                                  "latent_image": ["6", 1]}},
        "15": {"class_type": "MiniMaxH3MotionContextSaveLatent", "inputs": {"latent": ["14", 0], "filename_prefix": "ep_full/clip", "clip_index": s["no"]}},
        "16": {"class_type": "VAEDecode", "inputs": {"samples": ["14", 0], "vae": ["4", 0]}},
        "17": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["14", 0], "vae": ["5", 0]}},
        "18": {"class_type": "MiniMaxH3MotionContextTrim", "inputs": {"images": ["16", 0], "trim_frames": ["9", 1], "audio": ["17", 0], "fps": 24.0, "match_tail": True}},
        "19": {"class_type": "CreateVideo", "inputs": {"images": ["18", 0], "audio": ["18", 1], "fps": 24, "bit_depth": 8}},
        "21": {"class_type": "SaveVideo", "inputs": {"video": ["19", 0], "filename_prefix": f"ep_full/s{s['no']}", "format": "auto", "codec": "auto"}},
    }


def wait(pid, timeout=3600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = json.loads(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=60).read())
        if pid in h:
            return h[pid]
        time.sleep(8)
    return None


def main():
    mf = json.load(open(sys.argv[1]))
    w = int(sys.argv[2]) if len(sys.argv) > 2 else 864
    h = int(sys.argv[3]) if len(sys.argv) > 3 else 480
    cfg = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    log(f"共 {len(mf)} 镜 / {w}x{h} / cfg={cfg}")
    parts = []
    for s in mf:
        t0 = time.time()
        try:
            req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": graph(s, w, h, cfg, 20268000 + s["no"])}).encode(),
                                         headers={"Content-Type": "application/json"})
            pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
        except urllib.error.HTTPError as e:
            log(f"镜{s['no']} 提交失败 {e.read().decode()[:250]}"); return
        hist = wait(pid)
        if not hist or hist.get("status", {}).get("status_str") != "success":
            log(f"镜{s['no']} 失败 {str((hist or {}).get('status',{}).get('messages',[])[-1:])[:250]}"); return
        dst = os.path.join(WORK, f"s{s['no']}.mp4")
        got = False
        for o in hist.get("outputs", {}).values():
            for im in o.get("images", []):
                if im.get("filename", "").endswith(".mp4"):
                    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                    open(dst, "wb").write(urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=600).read())
                    got = True
        if not got:
            log(f"镜{s['no']} 无产物"); return
        parts.append(dst)
        log(f"镜{s['no']} 完成 {round(time.time()-t0)}s")
    if len(parts) == len(mf):
        lst = os.path.join(WORK, "list.txt")
        open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
        out = os.path.join(OUT, "ep_full_00001_.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                        "-c:v", "libx264", "-crf", "18", "-c:a", "aac", out], check=True)
        log(f"拼接完成 {out}")
    log("=== 结束 ===")


if __name__ == "__main__":
    main()
