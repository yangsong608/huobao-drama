#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E3：fl2v 首帧（滚动+注噪） + MotionContext 上下文继承 + Trim，三镜。"""
import json, os, subprocess, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
IN = "/data/comfyui/ComfyUI/input"
WORK = "/data/comfyui/ep001/sd/e3_work"
OUT = "/data/comfyui/ComfyUI/output/hb_e3"

P1 = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."

SHOTS = [
    dict(no=1, first="e3_s1.png", clip=1, load=0,
         prompt=(P1 + "\n\nintegrated_multimodal_description: [Shot 1] 3D CG, cinematic, a medium shot begins in the framing of Picture 1: "
                 "the young man in a grey-blue cross-collar robe stands behind two iron pans, a bun resting in his floured palm. "
                 "He pinches the pleats closed one by one, turns his wrist and presses, then sets the bun into the pan; steam rises past his jaw. "
                 "The camera holds a static shot. warm practical light, natural and steady contrast, saturated earthy tones. He does not speak."),
         sound="oil sizzling, dough pressed, steam hissing"),
    dict(no=2, first=None, clip=2, load=1,
         prompt=(P1 + "\n\nintegrated_multimodal_description: [Shot 1] 3D CG, cinematic, the shot continues in the same space and framing as Picture 1, "
                 "which is the final frame of the previous moment: the gaunt woman in a dark ochre robe steps in and sets a stack of bamboo steamers down hard on the bench; "
                 "the baskets knock and a burst of steam puffs out. She lifts her chin toward the stove and calls out loud. "
                 "The camera holds a static shot, same warm practical light and steady contrast. "
                 "The gaunt woman in her forties, sharp and loud (S1) shouts: <d>[Chinese] 都等等——唐大郎！</d>"),
         sound="bamboo baskets knocking, steam burst, crowd stirring"),
    dict(no=3, first=None, clip=3, load=2,
         prompt=(P1 + "\n\nintegrated_multimodal_description: [Shot 1] 3D CG, cinematic, the shot continues in the same space and framing as Picture 1, "
                 "which is the final frame of the previous moment: the young man hears the shout and lifts his head, sets the half-finished bun on the board, "
                 "wipes his hands twice on his apron, then turns slightly and answers evenly. The camera holds a static shot with the same warm light. "
                 "The young man in his late teens, calm and clear (S2) says: <d>[Chinese] 婶子，您说。</d>"),
         sound="cloth wiping, oil sizzling, market murmur"),
]


def log(s):
    line = f"[{time.strftime('%H:%M:%S')}] {s}"
    print(line, flush=True)


def graph(first, s, seed):
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "20": {"class_type": "LoadImage", "inputs": {"image": first}},
        "6": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["3", 0], "vae": ["4", 0],
            "prompt": s["prompt"] + f"\noverall_soundscape: {s['sound']}.\nnon_diegetic_music: N/A",
            "width": 864, "height": 480, "length": 124, "first_frame": ["20", 0]}},
        "7": {"class_type": "MiniMaxH3MotionContextLoadLatent",
              "inputs": {"latent_path": "e3", "clip_index": s["load"], "stock_format": False, "folder": "output"}},
        "8": {"class_type": "MiniMaxH3MotionContext", "inputs": {
            "conditioning": ["6", 0], "vae": ["4", 0], "latent": ["6", 1],
            "context_length": "22", "audio_context_length": 18,
            "context_latent": ["7", 0], "audio_vae": ["5", 0]}},
        "9": {"class_type": "BasicGuider", "inputs": {"model": ["2", 0], "conditioning": ["8", 0]}},
        "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "11": {"class_type": "BasicScheduler", "inputs": {"model": ["2", 0], "scheduler": "beta", "steps": 4, "denoise": 1.0}},
        "12": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "13": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["12", 0], "guider": ["9", 0],
                                                                  "sampler": ["10", 0], "sigmas": ["11", 0],
                                                                  "latent_image": ["6", 1]}},
        "14": {"class_type": "MiniMaxH3MotionContextSaveLatent", "inputs": {"latent": ["13", 0], "filename_prefix": "e3/clip", "clip_index": s["clip"]}},
        "15": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["4", 0]}},
        "16": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["13", 0], "vae": ["5", 0]}},
        "17": {"class_type": "MiniMaxH3MotionContextTrim", "inputs": {"images": ["15", 0], "trim_frames": ["8", 1], "audio": ["16", 0], "fps": 24.0, "match_tail": True}},
        "18": {"class_type": "CreateVideo", "inputs": {"images": ["17", 0], "audio": ["17", 1], "fps": 24, "bit_depth": 8}},
        "19": {"class_type": "SaveVideo", "inputs": {"video": ["18", 0], "filename_prefix": f"hb_e3/s{s['no']}", "format": "auto", "codec": "auto"}},
    }
    return wf


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
    parts, first = [], "e3_s1.png"
    for s in SHOTS:
        if s["first"]:
            first = s["first"]
        t0 = time.time()
        try:
            req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": graph(first, s, 20267600 + s["no"])}).encode(),
                                         headers={"Content-Type": "application/json"})
            pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
        except urllib.error.HTTPError as e:
            log(f"镜{s['no']} 提交失败 {e.read().decode()[:300]}"); return
        hist = wait(pid)
        if not hist or hist.get("status", {}).get("status_str") != "success":
            msgs = (hist or {}).get("status", {}).get("messages", [])[-1:]
            log(f"镜{s['no']} 失败 {str(msgs)[:300]}"); return
        dst = os.path.join(WORK, f"e3_{s['no']}.mp4")
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
        nxt = f"e3_s{s['no']+1}.png"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.2", "-i", dst,
                        "-vf", "noise=alls=8:allf=t", "-frames:v", "1", os.path.join(IN, nxt)], check=True)
        log(f"镜{s['no']} 完成 {round(time.time()-t0)}s -> {nxt}（首帧+上下文）")
        first = nxt
    if len(parts) == len(SHOTS):
        lst = os.path.join(WORK, "list.txt")
        open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
        out = os.path.join(OUT, "e3_3shots_00001_.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                        "-c:v", "libx264", "-crf", "18", "-c:a", "aac", out], check=True)
        log(f"拼接完成 {out}")
    log("=== E3 结束 ===")


if __name__ == "__main__":
    main()
