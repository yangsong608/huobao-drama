#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E1：fl2v 三镜接力（滚动静帧 + 注噪 + 官方 I2VA 句式），验证多镜连贯性。"""
import json, os, subprocess, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
IN = "/data/comfyui/ComfyUI/input"
WORK = "/data/comfyui/ep001/sd/e1_work"
OUT = "/data/comfyui/ComfyUI/output/hb_e1"
NEG = "bad video, distorted face, extra fingers, text, watermark, subtitles"

P1 = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."

SHOTS = [
    dict(no=1, first="e1_s1.png", frames=124,
         desc=(P1 + "\n\nintegrated_multimodal_description: [Shot 1] 3D CG, cinematic, a medium shot begins in the framing of Picture 1: "
               "the young man in a grey-blue cross-collar robe stands behind two iron pans, a bun resting in his floured palm. "
               "He pinches the pleats closed one by one, turns his wrist and presses, then sets the bun into the pan; steam rises past his jaw. "
               "The camera holds a static shot. warm practical light, natural and steady contrast, saturated earthy tones. He does not speak."),
         sound="oil sizzling, dough pressed, steam hissing"),
    dict(no=2, first=None, frames=124,
         desc=(P1 + "\n\nintegrated_multimodal_description: [Shot 1] 3D CG, cinematic, the shot continues in the same space and framing as Picture 1, "
               "which is the final frame of the previous moment: the gaunt woman in a dark ochre robe steps in and sets a stack of bamboo steamers down hard on the bench; "
               "the baskets knock and a burst of steam puffs out. She lifts her chin toward the stove and calls out loud. "
               "The camera holds a static shot, keeping the same warm practical light and steady contrast. "
               "The gaunt woman in her forties, sharp and loud (S1) shouts: <d>[Chinese] 都等等——唐大郎！</d>"),
         sound="bamboo baskets knocking, steam burst, crowd stirring"),
    dict(no=3, first=None, frames=124,
         desc=(P1 + "\n\nintegrated_multimodal_description: [Shot 1] 3D CG, cinematic, the shot continues in the same space and framing as Picture 1, "
               "which is the final frame of the previous moment: the young man hears the shout and lifts his head, sets the half-finished bun on the board, "
               "wipes his hands twice on his apron, then turns slightly and answers evenly. The camera holds a static shot with the same warm light. "
               "The young man in his late teens, calm and clear (S2) says: <d>[Chinese] 婶子，您说。</d>"),
         sound="cloth wiping, oil sizzling, market murmur"),
]


def log(s):
    line = f"[{time.strftime('%H:%M:%S')}] {s}"
    print(line, flush=True)


def graph(first, frames, prompt, seed):
    si = {"imageFile": first, "width": 1672, "height": 941}
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
            "global_prompt": "Northern Song market, natural synchronized sound.",
            "cfg": 1.0, "bd_grp_sample": "采样设置", "bd_grp_advanced": "高级采样 Advanced", "bd_grp_perf": "性能 Performance",
            "frame_rate": 24.0, "width": 864, "height": 480, "ref_max_size": 864,
            "total_frames": frames, "timeline_data": json.dumps(tl, ensure_ascii=False),
            "steps": 4, "sampler": "euler", "scheduler": "beta", "shift_video": 12.0, "shift_audio": 3.0,
            "seed": seed, "clear_vram_between_segments": True}},
        "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "audio": ["6", 1], "fps": 24, "bit_depth": 8}},
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0], "filename_prefix": f"hb_e1/s{seed}", "format": "auto", "codec": "auto"}},
    }


def main():
    os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    first = "e1_s1.png"
    parts = []
    for s in SHOTS:
        if s["first"]:
            first = s["first"]
        t0 = time.time()
        wf = graph(first, s["frames"], s["desc"] + f"\noverall_soundscape: {s['sound']}.\nnon_diegetic_music: N/A", 20267400 + s["no"])
        req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": wf}).encode(),
                                     headers={"Content-Type": "application/json"})
        pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
        hist = None
        while True:
            h = json.loads(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=60).read())
            if pid in h:
                hist = h[pid]; break
            time.sleep(6)
        dst = os.path.join(WORK, f"e1_{s['no']}.mp4")
        ok = False
        for o in hist.get("outputs", {}).values():
            for im in o.get("images", []):
                if im.get("filename", "").endswith(".mp4"):
                    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                    open(dst, "wb").write(urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=600).read())
                    ok = True
        if not ok:
            log(f"镜{s['no']} 无产物，停止"); break
        # 抽最后一帧 + 注噪（社区做法：给参考帧加噪，防劣化）
        nxt = f"e1_s{s['no']+1}.png"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.2", "-i", dst,
                        "-vf", "noise=alls=8:allf=t", "-frames:v", "1", os.path.join(IN, nxt)], check=True)
        log(f"镜{s['no']} 完成 {round(time.time()-t0)}s -> {nxt}（已注噪）")
        parts.append(dst)
        first = nxt
    if len(parts) == len(SHOTS):
        lst = os.path.join(WORK, "list.txt")
        open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
        out = os.path.join(OUT, "e1_3shots_00001_.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                        "-c:v", "libx264", "-crf", "18", "-c:a", "aac", out], check=True)
        log(f"拼接完成 {out}")
    log("=== E1 结束 ===")


if __name__ == "__main__":
    main()
