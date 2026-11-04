#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""字幕修复验证：同一镜（她喊话）跑三种方案，看哪种不烧字幕。
A: 中文 <d> + 负条件 cfg=1.0（对照，预期仍有字幕）
B: 中文 <d> + 负条件 cfg=2.0
C: 不写中文，改成英文说话描述 + 明确 no on-screen text，cfg=1.0
"""
import json, os, subprocess, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
WORK = "/data/comfyui/ep001/sd/fix_work"
OUT = "/data/comfyui/ComfyUI/output/hb_fix"
FIRST = "c2_5.png"
FRAMES = 124

NEG_TEXT = "subtitles, captions, on-screen text, chinese characters, watermark, logo, distorted face, extra fingers"
BASE = ("[Shot 1] 3D CG, cinematic, the gaunt woman in a dark ochre robe strides to the bench outside the busy shop and slams a stack of bamboo steamers down on it; "
        "the baskets knock together with a dull thud and a burst of steam blows out. She lifts her chin past the queue toward the stove, her neck taut, and shouts. "
        "The camera holds a static shot. warm practical light, natural and steady contrast, saturated earthy tones.")

VARIANTS = [
    dict(tag="A_cn_cfg1", cfg=1.0,
         prompt=BASE + "\nThe gaunt woman in her forties, sharp and loud (S1) shouts: <d>[Chinese] 都等等——唐大郎！</d>"),
    dict(tag="B_cn_cfg2", cfg=2.0,
         prompt=BASE + "\nThe gaunt woman in her forties, sharp and loud (S1) shouts: <d>[Chinese] 都等等——唐大郎！</d>"),
    dict(tag="C_en_cfg1", cfg=1.0,
         prompt=(BASE.replace("and shouts.", "and shouts a short, sharp, angry line at the stove, jaw tight, mouth moving clearly.") +
                 "\nThe line is spoken in Mandarin, but nothing is written on screen: no subtitles, no captions, no text of any kind.")),
]


def log(s):
    print(f"[{time.strftime('%H:%M:%S')}] {s}", flush=True)


def graph(v, seed):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "20": {"class_type": "LoadImage", "inputs": {"image": FIRST}},
        "6": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["3", 0], "vae": ["4", 0], "prompt": v["prompt"] + "\noverall_soundscape: bamboo steamers thudding, steam bursting, crowd whispering.\nnon_diegetic_music: N/A",
            "width": 864, "height": 480, "length": FRAMES, "first_frame": ["20", 0]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["3", 0], "text": NEG_TEXT}},
        "8": {"class_type": "CFGGuider", "inputs": {"model": ["2", 0], "positive": ["6", 0], "negative": ["7", 0], "cfg": v["cfg"]}},
        "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "11": {"class_type": "BasicScheduler", "inputs": {"model": ["2", 0], "scheduler": "beta", "steps": 4, "denoise": 1.0}},
        "12": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "13": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["12", 0], "guider": ["8", 0],
                                                                  "sampler": ["10", 0], "sigmas": ["11", 0],
                                                                  "latent_image": ["6", 1]}},
        "15": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["4", 0]}},
        "16": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["13", 0], "vae": ["5", 0]}},
        "18": {"class_type": "CreateVideo", "inputs": {"images": ["15", 0], "audio": ["16", 0], "fps": 24, "bit_depth": 8}},
        "19": {"class_type": "SaveVideo", "inputs": {"video": ["18", 0], "filename_prefix": f"hb_fix/{v['tag']}", "format": "auto", "codec": "auto"}},
    }


def wait(pid, timeout=1800):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = json.loads(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=60).read())
        if pid in h:
            return h[pid]
        time.sleep(6)
    return None


def main():
    os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    for i, v in enumerate(VARIANTS):
        t0 = time.time()
        try:
            req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": graph(v, 20267800 + i)}).encode(),
                                         headers={"Content-Type": "application/json"})
            pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
        except urllib.error.HTTPError as e:
            log(f"{v['tag']} 提交失败 {e.read().decode()[:200]}"); continue
        hist = wait(pid)
        if not hist or hist.get("status", {}).get("status_str") != "success":
            log(f"{v['tag']} 失败 {str((hist or {}).get('status',{}).get('messages',[])[-1:])[:200]}"); continue
        dst = os.path.join(WORK, f"{v['tag']}.mp4")
        for o in hist.get("outputs", {}).values():
            for im in o.get("images", []):
                if im.get("filename", "").endswith(".mp4"):
                    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                    open(dst, "wb").write(urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=600).read())
        log(f"{v['tag']} 完成 {round(time.time()-t0)}s")
    log("=== 修复验证结束 ===")


if __name__ == "__main__":
    main()
