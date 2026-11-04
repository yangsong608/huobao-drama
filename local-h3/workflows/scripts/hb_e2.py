#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E2：Ref2VA + Motion-Context 链路（3 镜）。

每镜：R2V(角色/场景参考图) → MotionContext(继承上一镜 latent) → 采样
      → SaveLatent → 解码 → Trim(剪掉钉住的头帧) → 保存
最后 ffmpeg 拼接；SeamProbe 量化接缝。
"""
import json, os, subprocess, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
WORK = "/data/comfyui/ep001/sd/e2_work"
OUT = "/data/comfyui/ComfyUI/output/hb_e2"
NEG = "bad video, distorted face, extra fingers, text, watermark, subtitles"

SHOTS = [
    dict(no=1, refs=["e2_tangyi.png", "e2_scene.png"], clip=1, load=0,
         prompt=("[Shot 1] 3D CG, cinematic, a medium shot at a Northern Song street stove: the young man in a grey-blue cross-collar robe stands behind two iron pans, "
                 "pinches the pleats of a bun closed, turns his wrist and presses, then sets the bun into the pan. Steam rises past his jaw. "
                 "The camera holds a static shot with warm practical light, natural and steady contrast, saturated earthy tones. He does not speak."),
         sound="oil sizzling, dough pressed, steam hissing"),
    dict(no=2, refs=["e2_jiapo.png", "e2_tangyi.png", "e2_scene.png"], clip=2, load=1,
         prompt=("[Shot 2] 3D CG, cinematic, the same space continues: the gaunt woman in a dark ochre robe steps in and sets a stack of bamboo steamers down hard on the bench; "
                 "the baskets knock and a burst of steam puffs out. She lifts her chin toward the stove and calls out loud. "
                 "The camera holds a static shot, same warm practical light and steady contrast. "
                 "The gaunt woman in her forties, sharp and loud (S1) shouts: <d>[Chinese] 都等等——唐大郎！</d>"),
         sound="bamboo baskets knocking, steam burst, crowd stirring"),
    dict(no=3, refs=["e2_tangyi.png", "e2_jiapo.png", "e2_scene.png"], clip=3, load=2,
         prompt=("[Shot 3] 3D CG, cinematic, the same space continues: the young man hears the shout and lifts his head, sets the half-finished bun on the board, "
                 "wipes his hands twice on his apron, then turns slightly and answers evenly. The camera holds a static shot with the same warm light. "
                 "The young man in his late teens, calm and clear (S2) says: <d>[Chinese] 婶子，您说。</d>"),
         sound="cloth wiping, oil sizzling, market murmur"),
]


def log(s):
    line = f"[{time.strftime('%H:%M:%S')}] {s}"
    print(line, flush=True)


def graph(s, seed):
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
    }
    # 参考图
    for i, name in enumerate(s["refs"]):
        wf[str(20 + i)] = {"class_type": "LoadImage", "inputs": {"image": name}}
    r2v_inputs = {"clip": ["3", 0], "vae": ["4", 0], "audio_vae": ["5", 0],
                  "prompt": s["prompt"] + f"\noverall_soundscape: {s['sound']}.\nnon_diegetic_music: N/A",
                  "width": 864, "height": 480, "length": 124, "ref_image_size": "match",
                  "ref_images": {f"ref_image_{i}": [str(20 + i), 0] for i in range(len(s["refs"]))}}
    wf["6"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": r2v_inputs}
    wf["7"] = {"class_type": "MiniMaxH3MotionContextLoadLatent",
               "inputs": {"latent_path": "e2", "clip_index": s["load"], "stock_format": False, "folder": "output"}}
    wf["8"] = {"class_type": "MiniMaxH3MotionContext", "inputs": {
        "conditioning": ["6", 0], "vae": ["4", 0], "latent": ["6", 1],
        "context_length": "22", "audio_context_length": 18,
        "context_latent": ["7", 0], "audio_vae": ["5", 0]}}
    wf["9"] = {"class_type": "BasicGuider", "inputs": {"model": ["2", 0], "conditioning": ["8", 0]}}
    wf["10"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}}
    wf["11"] = {"class_type": "BasicScheduler", "inputs": {"model": ["2", 0], "scheduler": "beta", "steps": 4, "denoise": 1.0}}
    wf["12"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
    wf["13"] = {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["12", 0], "guider": ["9", 0],
                                                                   "sampler": ["10", 0], "sigmas": ["11", 0],
                                                                   "latent_image": ["6", 1]}}
    wf["14"] = {"class_type": "MiniMaxH3MotionContextSaveLatent", "inputs": {
        "latent": ["13", 0], "filename_prefix": "e2/clip", "clip_index": s["clip"]}}
    wf["15"] = {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["4", 0]}}
    wf["16"] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["13", 0], "vae": ["5", 0]}}
    wf["17"] = {"class_type": "MiniMaxH3MotionContextTrim", "inputs": {
        "images": ["15", 0], "trim_frames": ["8", 1], "audio": ["16", 0], "fps": 24.0, "match_tail": True}}
    wf["18"] = {"class_type": "CreateVideo", "inputs": {"images": ["17", 0], "audio": ["17", 1], "fps": 24, "bit_depth": 8}}
    wf["19"] = {"class_type": "SaveVideo", "inputs": {"video": ["18", 0], "filename_prefix": f"hb_e2/c{s['no']}", "format": "auto", "codec": "auto"}}
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
    parts = []
    for s in SHOTS:
        t0 = time.time()
        try:
            req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": graph(s, 20267500 + s["no"])}).encode(),
                                         headers={"Content-Type": "application/json"})
            pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
        except urllib.error.HTTPError as e:
            log(f"镜{s['no']} 提交失败: {e.read().decode()[:300]}")
            return
        hist = wait(pid)
        if not hist:
            log(f"镜{s['no']} 超时"); return
        if hist.get("status", {}).get("status_str") != "success":
            for m in hist.get("status", {}).get("messages", [])[-2:]:
                log(f"镜{s['no']} 错误 {str(m)[:300]}")
            return
        dst = os.path.join(WORK, f"e2_{s['no']}.mp4")
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
        log(f"镜{s['no']} 完成 {round(time.time()-t0)}s（含上下文继承 + Trim）")
    if len(parts) == len(SHOTS):
        lst = os.path.join(WORK, "list.txt")
        open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
        out = os.path.join(OUT, "e2_3shots_00001_.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                        "-c:v", "libx264", "-crf", "18", "-c:a", "aac", out], check=True)
        log(f"拼接完成 {out}")
    log("=== E2 结束 ===")


if __name__ == "__main__":
    main()
