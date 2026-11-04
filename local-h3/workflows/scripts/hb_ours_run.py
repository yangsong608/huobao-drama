#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用huobao的剧本/资产/分镜，走我们的 ComfyUI 全导演台（fl2v 首帧驱动）。

8 镜沿用火宝的时长与提示词意图，改写成官方三段式（英文动作 + <d>中文台词），
每镜以火宝的分镜图为首帧。
"""
import json, time, urllib.request

API = "http://127.0.0.1:8188"
NEG = "bad video, distorted face, extra fingers, text, watermark, subtitles"

S1 = "The gaunt woman in her forties, sharp and loud (S1)"
S2 = "The young man in his late teens, calm and clear (S2)"

SHOTS = [
    dict(id="H1", frames=209, first="hb1.png", cont=False,
         desc=("[Shot 1] Wide shot of a Northern Song market street at dawn: pale mist lies over wet stone slabs, cloth banners stir, steam rises from breakfast stalls. "
               "The camera tilts down from the roofs and pans right at slow speed, revealing five or six customers queueing in front of a busy food shop where two iron pans hiss. "
               "The queue shifts forward one step; a wooden banner lifts in the wind and morning light falls through the gap onto a water stain. No dialogue."),
         sound="market murmur, oil sizzling, cloth flapping in wind"),
    dict(id="H2", frames=209, first="hb2.png", cont=False,
         desc=("[Shot 1] Medium side shot: the gaunt woman steps over the threshold of her own shop carrying a stack of steaming bamboo steamers in both hands, shoulders leaning forward, brows faintly knit. "
               "The camera tracks alongside her at normal speed; steam drifts up across her face and she narrows her eyes, lips pressed. She walks past her own empty stall, apron hem lifting, "
               "steps steady and quick. No dialogue."),
         sound="footsteps on stone, steam hissing, distant market"),
    dict(id="H3", frames=209, first="hb3.png", cont=False,
         desc=("[Shot 1] Medium shot from behind: a customer with a bundle on a pole brushes past the gaunt woman and heads straight for the long queue at the busy shop, never slowing. "
               "She stops short, her fingers tighten on the steamers, and she turns her head to follow his back, lashes flickering; steam still curls from the baskets. "
               "Then her gaze slides from the man to the queue. Camera pushes in with small amplitude at slow speed. No dialogue."),
         sound="footsteps, crowd murmur, steam hissing"),
    dict(id="H4", frames=209, first="hb4.png", cont=False,
         desc=("[Shot 1] Medium shot at the stove: the young man stands behind the iron pans pinching pleats shut on a bun, wrist turning and pressing; steam rises and strikes his jaw. "
               "Cut to a top-down close shot of his hands folding even pleats, fingertips dusted with flour, then he sets the bun into the pan. Cut back to a close shot of his face: he lifts his eyes "
               "toward the queue at the door, calm, the corner of his mouth steady. Oil hisses in the pan. No dialogue."),
         sound="oil sizzling, dough pressed, steam hissing"),
    dict(id="H5", frames=209, first="hb5.png", cont=False,
         desc=("[Shot 1] Wide shot: the gaunt woman strides to the bench outside the busy shop and sets the stack of steamers down hard; the baskets knock, a burst of steam puffs out. "
               "Cut to a low-angle close shot: she lifts her chin past the queue toward the stove, neck taut, and calls out loud. "
               f"{S1} shouts: <d>[Chinese] 都等等——唐大郎！</d> "
               "Cut to a medium shot as she braces one hand on the bench; customers in the queue turn their heads."),
         sound="bamboo baskets knocking, steam burst, crowd stirring"),
    dict(id="H6", frames=209, first="hb6.png", cont=False,
         desc=("[Shot 1] Close shot: the young man hears the shout and lifts his head, sets the half-finished bun back on the board without haste. "
               "Cut to a close shot of his hands as he wipes them again and again on his apron, palm and fingers, the leather wrist guard polished by the rubbing. "
               "Cut to a medium shot: he straightens, turns toward the door and inclines his head slightly, speaking evenly. "
               f"{S2} says: <d>[Chinese] 婶子，您说。</d> Steam drifts slowly between them."),
         sound="cloth wiping, oil sizzling, market murmur"),
    dict(id="H7", frames=260, first="hb7.png", cont=False,
         desc=("[Shot 1] Medium shot: the gaunt woman slaps the lid of her own steamer; the lid springs up and white steam bursts out, revealing rows of neat sesame buns. "
               "Cut to a close side shot: she turns her hand toward the stove, fingertip stabbing the air, chin tilted. "
               f"{S1} says: <d>[Chinese] 我这炊饼，才出锅的，三文一个。</d> "
               "She presses on, voice rising: "
               f"<d>[Chinese] 你那生煎，八文一个，凭的是什么？</d> "
               "Cut to a close shot of the pan: a ring of buns browned and crisp at the base, oil glinting in the morning light."),
         sound="steamer lid clack, steam burst, oil sizzling"),
    dict(id="H8", frames=311, first="hb8.png", cont=False,
         desc=("[Shot 1] Medium shot: the young man does not argue; he wipes the flour from his hands on his apron, shoulders loosening, and lifts his eyes to the door. "
               "Cut to a close shot with slight low angle: he raises one hand toward the stove, palm open, indicating the pan. "
               f"{S2} says: <d>[Chinese] 您站这儿看三分钟。</d> "
               "Cut to a close shot of the gaunt woman: her brow lifts, her eyes slide to the pan, lips parting; steam curls up slowly around the rim."),
         sound="cloth wipe, oil sizzling, steam hissing"),
]


def timeline():
    shots, segs, start = [], [], 0
    for s in SHOTS:
        n = s["frames"]
        prompt = s["desc"] + f"\noverall_soundscape: {s['sound']}.\nnon_diegetic_music: N/A"
        si = {"imageFile": s["first"], "width": 1672, "height": 941}
        shots.append({"id": s["id"], "durationSec": round(n / 24, 2), "prompt": prompt, "negativePrompt": NEG,
                      "continuityFromPrev": s["cont"], "loras": [], "startImage": si, "endImage": None})
        segs.append({"id": s["id"], "start": start, "length": n, "frameCount": n, "durationSec": round(n / 24, 2),
                     "prompt": prompt, "negativePrompt": NEG, "continuityFromPrev": s["cont"], "loras": [],
                     "isStartFrame": True, "isEndFrame": False, "genImage": si, "endImage": None, "taskType": "", "refs": []})
        start += n
    return {"version": 4, "editMode": "segment", "timelineMode": "fl2v", "totalFrames": start, "frameRate": 24.0,
            "width": 864, "height": 480, "refMaxSize": 864,
            "output": {"mode": "fixed", "longEdge": 864, "width": 864, "height": 480, "maxExportFrames": 0,
                       "exportMode": "all", "continuityEnabled": False, "continuityOverlapFrames": 9},
            "videoClips": [], "video": {"fileName": "", "videoFile": "", "subfolder": "", "type": "input", "frames": [], "frameMap": []},
            "global": {"taskType": "fl2v — 首尾帧生视频(First-Last Frame)", "prompt": "", "refs": [], "referenceVideo": {},
                       "continuousReference": False, "genImage": {"imageFile": ""}},
            "shots": shots, "keyframes": [], "segments": segs, "gen": {"defaultFrameCount": 209},
            "runSelectEnabled": False, "runSelection": []}


def build():
    tl = timeline()
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
            "total_frames": tl["totalFrames"], "timeline_data": json.dumps(tl, ensure_ascii=False),
            "steps": 4, "sampler": "euler", "scheduler": "beta", "shift_video": 12.0, "shift_audio": 3.0,
            "seed": 20267101, "clear_vram_between_segments": True}},
        "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "audio": ["6", 1], "fps": 24, "bit_depth": 8}},
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0], "filename_prefix": "hb_ours/from_huobao", "format": "auto", "codec": "auto"}},
    }


if __name__ == "__main__":
    wf = build()
    tl = json.loads(wf["6"]["inputs"]["timeline_data"])
    print("总帧数", tl["totalFrames"], "≈", round(tl["totalFrames"] / 24, 1), "秒")
    req = urllib.request.Request(API + "/prompt", data=json.dumps({"prompt": wf}).encode(), headers={"Content-Type": "application/json"})
    try:
        pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
    except urllib.error.HTTPError as e:
        print("提交失败", e.read().decode()[:700]); raise SystemExit(1)
    print("提交", pid, flush=True)
    t0 = time.time()
    while time.time() - t0 < 3600:
        h = json.loads(urllib.request.urlopen(f"{API}/history/{pid}", timeout=60).read())
        if pid in h:
            ok = h[pid].get("status", {}).get("status_str") == "success"
            print("完成" if ok else "失败", round(time.time() - t0), "s", flush=True)
            if not ok:
                for m in h[pid].get("status", {}).get("messages", [])[-2:]:
                    print(str(m)[:400])
            break
        time.sleep(6)
