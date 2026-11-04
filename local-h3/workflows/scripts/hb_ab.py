#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A/B 对比：用火宝的剧本+分镜 + 我们的资产，跑我们的 Director。

A 组（无首帧）：r2v，用我们的角色卡/场景卡作参考图
B 组（带首帧）：fl2v，用我们的关键帧作首帧
另：补完火宝镜 7、镜 8 的基线视频。
"""
import json, os, sys, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
API = "http://127.0.0.1:5679/api/v1"
ASSETS = "/Volumes/软件目录/comfyui/设定集/可用"
LOG = "/tmp/hb_ab.log"
NEG = "bad video, distorted face, extra fingers, text, watermark, subtitles"

# 火宝 8 镜 → 我们的资产
FIRST_FRAME = {  # B 组首帧（16:9 关键帧）
    1: "关键帧/M12.png",   # 街景+长队
    2: "关键帧/M01.png",   # 她端屉走过街
    3: "关键帧/M04.png",   # 她近景（转头看）
    4: "关键帧/M03.png",   # 灶后唐奕半身
    5: "关键帧/M02.png",   # 她在灶前/长凳
    6: "关键帧/M10.png",   # 双人对话（唐奕手势）
    7: "关键帧/M07.png",   # 屉与锅、两人
    8: "关键帧/M11.png",   # 唐奕抬手让锅
}
REFS = {  # A 组参考图（角色/场景卡）
    1: ["场景/SCENE_DENGZHOU_MARKET_主视觉.png", "人物/JIAPO/JIAPO_正面全身.png"],
    2: ["人物/JIAPO/JIAPO_正面全身.png", "场景/SCENE_TANGJI_主视觉.png"],
    3: ["人物/JIAPO/JIAPO_正面特写.png", "场景/SCENE_DENGZHOU_MARKET_主视觉.png"],
    4: ["人物/TANGYI_正面.png", "场景/SCENE_TANGJI_主视觉.png"],
    5: ["人物/JIAPO/JIAPO_正面全身.png", "场景/SCENE_TANGJI_主视觉.png"],
    6: ["人物/TANGYI_正面.png", "人物/JIAPO/JIAPO_正面全身.png"],
    7: ["人物/JIAPO/JIAPO_正面特写.png", "场景/SCENE_TANGJI_主视觉.png"],
    8: ["人物/TANGYI_正面.png", "场景/SCENE_TANGJI_主视觉.png"],
}


def log(s):
    line = f"[{time.strftime('%H:%M:%S')}] {s}"
    print(line, flush=True)
    open(LOG, "a", encoding="utf-8").write(line + "\n")


def upload(local_path, name):
    raw = open(local_path, "rb").read()
    boundary = "----ab" + str(int(time.time() * 1000))
    body = b""
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n".encode()
    body += b"Content-Type: image/png\r\n\r\n" + raw + b"\r\n"
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n".encode()
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(COMFY + "/upload/image", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())["name"]


def load_shots():
    sys.path.insert(0, "/Volumes/软件目录/comfyui/设定集")
    import hb_ours_run as base
    return base.SHOTS


def build(mode, shots):
    """mode = 'ref'（r2v）/ 'first'（fl2v，只给首帧）/ 'chain'（fl2v，首尾相接全链）"""
    timeline_shots, segs, start = [], [], 0
    for i, s in enumerate(shots, 1):
        n = s["frames"]
        prompt = s["desc"] + f"\noverall_soundscape: {s['sound']}.\nnon_diegetic_music: N/A"
        if mode == "chain2":
            nm = upload(os.path.join(ASSETS, FIRST_FRAME[i]), f"ab_first{i}.png")
            chained_to_next = i in (1, 2)   # 只把 1→2、2→3 串起来
            nm_next = upload(os.path.join(ASSETS, FIRST_FRAME[i + 1]), f"ab_first{i+1}.png") if chained_to_next else None
            ref_list = []
            si = {"imageFile": nm, "width": 1672, "height": 941}
            ei = {"imageFile": nm_next, "width": 1672, "height": 941} if nm_next else None
            tl_mode, task = "fl2v", "fl2v — 首尾帧生视频(First-Last Frame)"
            chain_cont = i in (2, 3)        # 第 2、3 镜承接上一镜
        elif mode == "chain":
            nm = upload(os.path.join(ASSETS, FIRST_FRAME[i]), f"ab_first{i}.png")
            nm_next = upload(os.path.join(ASSETS, FIRST_FRAME[i + 1]), f"ab_first{i+1}.png") if i < len(shots) else None
            ref_list = []
            si = {"imageFile": nm, "width": 1672, "height": 941}
            ei = {"imageFile": nm_next, "width": 1672, "height": 941} if nm_next else None
            tl_mode, task = "fl2v", "fl2v — 首尾帧生视频(First-Last Frame)"
            chain_cont = i > 1
        elif mode == "ref":
            refs = REFS[i]
            names = [upload(os.path.join(ASSETS, p), f"ab{i}_{k}.png") for k, p in enumerate(refs)]
            prompt = "Keep the identity, face and costume of the people in the reference pictures. " + prompt
            ref_list = [{"index": k, "imageFile": nm} for k, nm in enumerate(names)]
            si = None
            ei = None
            chain_cont = False
            tl_mode, task = "r2v", "r2v — 参考主体生视频(Reference to Video)"
        else:
            nm = upload(os.path.join(ASSETS, FIRST_FRAME[i]), f"ab_first{i}.png")
            ref_list = []
            si = {"imageFile": nm, "width": 1672, "height": 941}
            ei = None
            tl_mode, task = "fl2v", "fl2v — 首尾帧生视频(First-Last Frame)"
            chain_cont = False
        shot = {"id": f"h{i}", "durationSec": round(n / 24, 2), "prompt": prompt, "negativePrompt": NEG,
                "continuityFromPrev": chain_cont, "loras": [], "startImage": si, "endImage": ei}
        seg = {"id": f"h{i}", "start": start, "length": n, "frameCount": n, "durationSec": round(n / 24, 2),
               "prompt": prompt, "negativePrompt": NEG, "continuityFromPrev": chain_cont, "loras": [],
               "isStartFrame": bool(si), "isEndFrame": bool(ei),
               "genImage": si or {"imageFile": ""}, "endImage": ei, "taskType": "", "refs": ref_list}
        timeline_shots.append(shot); segs.append(seg); start += n
    tl = {"version": 4, "editMode": "segment", "timelineMode": tl_mode, "totalFrames": start, "frameRate": 24.0,
          "width": 864, "height": 480, "refMaxSize": 864,
          "output": {"mode": "fixed", "longEdge": 864, "width": 864, "height": 480, "maxExportFrames": 0,
                     "exportMode": "all", "continuityEnabled": False, "continuityOverlapFrames": 9},
          "videoClips": [], "video": {"fileName": "", "videoFile": "", "subfolder": "", "type": "input", "frames": [], "frameMap": []},
          "global": {"taskType": task, "prompt": "", "refs": [], "referenceVideo": {},
                     "continuousReference": False, "genImage": {"imageFile": ""}},
          "shots": ([] if mode == "ref" else timeline_shots), "keyframes": [], "segments": segs,
          "gen": {"defaultFrameCount": 209}, "runSelectEnabled": False, "runSelection": []}
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "6": {"class_type": "MiniMaxH3Director", "inputs": {
            "model": ["2", 0], "video_vae": ["4", 0], "audio_vae": ["5", 0], "clip": ["3", 0],
            "task_type": task, "global_prompt": "Northern Song market at dawn, natural synchronized sound.",
            "cfg": 1.0, "bd_grp_sample": "采样设置", "bd_grp_advanced": "高级采样 Advanced", "bd_grp_perf": "性能 Performance",
            "frame_rate": 24.0, "width": 864, "height": 480, "ref_max_size": 864,
            "total_frames": start, "timeline_data": json.dumps(tl, ensure_ascii=False),
            "steps": 4, "sampler": "euler", "scheduler": "beta", "shift_video": 12.0, "shift_audio": 3.0,
            "seed": {"ref": 20267201, "first": 20267202, "chain": 20267203, "chain2": 20267204}[mode], "clear_vram_between_segments": True}},
        "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "audio": ["6", 1], "fps": 24, "bit_depth": 8}},
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0], "filename_prefix": f"hb_ab/{mode}", "format": "auto", "codec": "auto"}},
    }
    return wf, start


def run_comfy(wf, label):
    req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": wf}).encode(),
                                 headers={"Content-Type": "application/json"})
    pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
    log(f"{label} 提交 {pid}")
    t0 = time.time()
    while time.time() - t0 < 5400:
        h = json.loads(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=60).read())
        if pid in h:
            ok = h[pid].get("status", {}).get("status_str") == "success"
            log(f"{label} {'完成' if ok else '失败'} {round(time.time()-t0)}s")
            return ok
        time.sleep(8)
    log(f"{label} 超时")
    return False


def huobao_finish():
    """补完火宝镜 7、8 的视频（基线）"""
    def call(m, p, b=None, t=300):
        req = urllib.request.Request(API + p, data=json.dumps(b).encode() if b else None,
                                     headers={"Content-Type": "application/json"}, method=m)
        return json.loads(urllib.request.urlopen(req, timeout=t).read())
    sbs = call("GET", "/episodes/1/storyboards")["data"]
    for s in sbs:
        num = s.get("storyboard_number")
        if num not in (7, 8) or s.get("video_url"):
            continue
        try:
            v = call("POST", "/tasks", {"type": "video", "storyboard_id": s["id"], "drama_id": 1,
                                        "prompt": s.get("video_prompt") or s.get("description"),
                                        "duration": int(round(float(s.get("duration") or 9))),
                                        "resolution": "480p", "force_new": True})["data"]
            log(f"火宝镜{num} 提交 {v['id']}")
            t0 = time.time()
            while time.time() - t0 < 1200:
                d = call("GET", f"/tasks/{v['id']}")["data"]
                if d["status"] not in ("processing", "queued", "pending", "submitting"):
                    log(f"火宝镜{num} {d['status']} {str(d.get('localPath'))[:50]}")
                    break
                time.sleep(8)
        except Exception as e:
            log(f"火宝镜{num} 失败 {e}")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "ref"
    if mode == "baseline":
        huobao_finish()
    else:
        shots = load_shots()
        wf, total = build(mode, shots)
        log(f"=== {mode} 组：8 镜 {total} 帧 ≈ {round(total/24,1)}s")
        run_comfy(wf, mode)
