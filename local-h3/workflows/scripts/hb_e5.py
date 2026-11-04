#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E5：R2V(角色/场景参考图) + AddGuide(首帧钉在第0帧) + MotionContext + CFG负条件 + Trim。

用法：python3 hb_e5.py manifest.json [w h]
manifest 每镜：
 {"no":1,"frames":209,"first":"es01.png","refs":["ref_ji","ref_liu","ref_scene"],
  "prompt":"...","atmos":"...","sound":"...","music":"..."}
"""
import json, os, subprocess, sys, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
WORK = "/data/comfyui/ep001/sd/e5_work"
OUT = "/data/comfyui/ComfyUI/output/hb_e5"
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
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "20": {"class_type": "LoadImage", "inputs": {"image": s["first"]}},
    }
    # 参考图
    ref_inputs = {}
    for i, name in enumerate(s["refs"]):
        nid = str(30 + i)
        wf[nid] = {"class_type": "LoadImage", "inputs": {"image": name}}
        ref_inputs[f"ref_image_{i}"] = [nid, 0]
    wf["6"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
        "clip": ["3", 0], "vae": ["4", 0], "audio_vae": ["5", 0],
        "prompt": build_prompt(s), "width": w, "height": h, "length": s["frames"],
        "ref_image_size": "match", "ref_images": ref_inputs}}
    # 首帧钉到第 0 帧
    wf["7"] = {"class_type": "MiniMaxH3AddGuide", "inputs": {
        "positive": ["6", 0], "latent": ["6", 1], "frame_idx": 0,
        "vae": ["4", 0], "audio_vae": ["5", 0], "image": ["20", 0]}}
    wf["8"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["3", 0], "text": NEG}}
    wf["9"] = {"class_type": "MiniMaxH3MotionContextLoadLatent",
               "inputs": {"latent_path": "e5", "clip_index": s.get("load", s["no"] - 1), "stock_format": False, "folder": "output"}}
    wf["10"] = {"class_type": "MiniMaxH3MotionContext", "inputs": {
        "conditioning": ["7", 0], "vae": ["4", 0], "latent": ["6", 1],
        "context_length": "22", "audio_context_length": 18,
        "context_latent": ["9", 0], "audio_vae": ["5", 0]}}
    wf["11"] = {"class_type": "CFGGuider", "inputs": {"model": ["2", 0], "positive": ["10", 0], "negative": ["8", 0], "cfg": cfg}}
    wf["12"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}}
    wf["13"] = {"class_type": "BasicScheduler", "inputs": {"model": ["2", 0], "scheduler": "beta", "steps": 4, "denoise": 1.0}}
    wf["14"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
    wf["15"] = {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["14", 0], "guider": ["11", 0],
                                                                   "sampler": ["12", 0], "sigmas": ["13", 0],
                                                                   "latent_image": ["6", 1]}}
    wf["16"] = {"class_type": "MiniMaxH3MotionContextSaveLatent", "inputs": {"latent": ["15", 0], "filename_prefix": "e5/clip", "clip_index": s["no"]}}
    wf["17"] = {"class_type": "VAEDecode", "inputs": {"samples": ["15", 0], "vae": ["4", 0]}}
    wf["18"] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["15", 0], "vae": ["5", 0]}}
    wf["19"] = {"class_type": "MiniMaxH3MotionContextTrim", "inputs": {"images": ["17", 0], "trim_frames": ["10", 1], "audio": ["18", 0], "fps": 24.0, "match_tail": True}}
    wf["21"] = {"class_type": "CreateVideo", "inputs": {"images": ["19", 0], "audio": ["19", 1], "fps": 24, "bit_depth": 8}}
    wf["22"] = {"class_type": "SaveVideo", "inputs": {"video": ["21", 0], "filename_prefix": f"hb_e5/s{s['no']}", "format": "auto", "codec": "auto"}}
    return wf


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
    w = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    h = int(sys.argv[3]) if len(sys.argv) > 3 else 576
    os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    log(f"共 {len(mf)} 镜 / {w}x{h} / R2V+AddGuide+MotionContext")
    parts = []
    for s in mf:
        t0 = time.time()
        try:
            req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": graph(s, w, h, 1.0, 20269000 + s["no"])}).encode(),
                                         headers={"Content-Type": "application/json"})
            pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
        except urllib.error.HTTPError as e:
            log(f"镜{s['no']} 提交失败 {e.read().decode()[:300]}"); return
        hist = wait(pid)
        if not hist or hist.get("status", {}).get("status_str") != "success":
            log(f"镜{s['no']} 失败 {str((hist or {}).get('status',{}).get('messages',[])[-1:])[:300]}"); return
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
        out = os.path.join(OUT, "e5_00001_.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                        "-c:v", "libx264", "-crf", "18", "-c:a", "aac", out], check=True)
        log(f"拼接完成 {out}")
    log("=== 结束 ===")


if __name__ == "__main__":
    main()
