#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""参考图是否生效的决定性测试：品红方块。
变体 A：ref_images 嵌套 dict（我们一直用的写法）
变体 B：ref_images.ref_image_0 点号写法
变体 C：完全不传参考图（对照）
判据：输出画面里是否出现大面积品红像素。
"""
import json, os, subprocess, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
WORK = "/data/comfyui/ep001/sd/probe_work"
OUT = "/data/comfyui/ComfyUI/output/hb_probe"
REF = "ref_magenta.png"
PROMPT = ("subject_definitions:\n<Picture 1>: a bright magenta square with a black border and green diagonal cross.\n\n"
          "[Shot 1] 3D CG, a bright magenta square with a black border and green diagonal cross is held up in the foreground "
          "of a Northern Song market street at dawn; the camera holds a static shot. "
          "Nothing is written on screen: no subtitles, no captions, no text of any kind.")


def log(s):
    print(f"[{time.strftime('%H:%M:%S')}] {s}", flush=True)


def graph(variant, seed=20271001):
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "20": {"class_type": "LoadImage", "inputs": {"image": REF}},
    }
    inputs = {"clip": ["3", 0], "vae": ["4", 0], "audio_vae": ["5", 0], "prompt": PROMPT,
              "width": 864, "height": 480, "length": 124, "ref_image_size": "match"}
    if variant == "A":
        inputs["ref_images"] = {"ref_image_0": ["20", 0]}
    elif variant == "B":
        inputs["ref_images.ref_image_0"] = ["20", 0]
    wf["6"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": inputs}
    wf["7"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["3", 0], "text": "subtitles, captions, text"}}
    wf["8"] = {"class_type": "CFGGuider", "inputs": {"model": ["2", 0], "positive": ["6", 0], "negative": ["7", 0], "cfg": 1.0}}
    wf["9"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}}
    wf["10"] = {"class_type": "BasicScheduler", "inputs": {"model": ["2", 0], "scheduler": "beta", "steps": 4, "denoise": 1.0}}
    wf["11"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
    wf["12"] = {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["11", 0], "guider": ["8", 0], "sampler": ["9", 0],
                                                                   "sigmas": ["10", 0], "latent_image": ["6", 1]}}
    wf["13"] = {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["4", 0]}}
    wf["14"] = {"class_type": "SaveImage", "inputs": {"images": ["13", 0], "filename_prefix": f"hb_probe/{variant}"}}
    return wf


def wait(pid, timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = json.loads(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=60).read())
        if pid in h:
            return h[pid]
        time.sleep(6)
    return None


def magenta_ratio(png):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", png, "-vf", "scale=160:90", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                       capture_output=True).stdout
    import array
    n = len(r) // 3
    hit = 0
    for i in range(n):
        R, G, B = r[3 * i], r[3 * i + 1], r[3 * i + 2]
        if R > 150 and B > 150 and G < 110:
            hit += 1
    return hit / max(1, n)


if __name__ == "__main__":
    os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    for v in ("A", "B", "C"):
        t0 = time.time()
        req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": graph(v)}).encode(),
                                     headers={"Content-Type": "application/json"})
        pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
        hist = wait(pid)
        if not hist or hist.get("status", {}).get("status_str") != "success":
            log(f"{v} 失败 {str((hist or {}).get('status',{}).get('messages',[])[-1:])[:200]}"); continue
        png = None
        for o in hist.get("outputs", {}).values():
            for im in o.get("images", []):
                q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                png = os.path.join(WORK, f"{v}.png")
                open(png, "wb").write(urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=120).read())
        ratio = magenta_ratio(png) if png else 0
        log(f"{v} 完成 {round(time.time()-t0)}s  品红占比 {ratio:.3f}")
    log("=== 结束 ===")
