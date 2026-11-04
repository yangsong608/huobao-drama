#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E4：火宝 8 分镜的**完整提示词**（3–4 段景别 + 氛围 + 音效 + BGM，忠实翻译）
走我们的管线：首帧（我们的关键帧）+ MotionContext 上下文继承 + Trim。"""
import json, os, subprocess, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
IN = "/data/comfyui/ComfyUI/input"
WORK = "/data/comfyui/ep001/sd/e4_work"
OUT = "/data/comfyui/ComfyUI/output/hb_e4"

SHOTS = [
    dict(no=1, frames=209, first="c2_1.png", clip=1, load=0,
         atmos="Thin morning mist, stone slabs glazed by dew, cool grey breaking into warm gold dawn light, the market just waking.",
         d=("[Shot 1] 3D CG, cinematic, at 0.00 seconds a wide high-angle shot of a Northern Song market street at dawn: thin mist lies over the stone slabs, "
            "cloth banners stir on both sides, breakfast stalls send up white steam.\n"
            "[Shot 2] At 00:03.000, the camera pans down and right across the crowd in front of the busy shop, where five or six customers stand in a winding queue "
            "and steam drifts out from under the eaves.\n"
            "[Shot 3] At 00:06.000, the camera cuts to a side close shot: a wooden banner lifts in the wind, morning light falls through the gap onto a water stain on the stone, "
            "oil sizzles softly in the pan."),
         snd="Crowd murmur, steam hissing from bamboo steamers, oil sizzling, light footsteps on wet stone.",
         mus="N/A"),
    dict(no=2, frames=209, first="c2_2.png", clip=2, load=1,
         atmos="Cold morning light, steam whitening against her face, her expression like someone doing sums in her head.",
         d=("[Shot 1] 3D CG, cinematic, at 0.00 seconds a medium side shot: the gaunt woman in a dark ochre robe and dark grey apron steps over her own shop threshold "
            "carrying a tall stack of steaming bamboo steamers in both hands, shoulders leaning forward, brows faintly knit.\n"
            "[Shot 2] At 00:03.000, a close tracking shot follows her along the street; steam curls up and breaks across her face, she narrows her eyes and presses her lips.\n"
            "[Shot 3] At 00:06.000, a medium shot: she walks past her own empty stall, the grey apron hem lifting in the wind, her steps steady and quick, the steamers swaying slightly."),
         snd="Footsteps on stone, steam hissing, distant market chatter.",
         mus="N/A"),
    dict(no=3, frames=209, first="c2_3.png", clip=3, load=2,
         atmos="High-contrast morning light, foreground occlusion, the market noise continues but her sudden stillness stands out.",
         d=("[Shot 1] 3D CG, cinematic, at 0.00 seconds a medium shot from behind: a customer carrying a bundled pole brushes past the gaunt woman and heads straight for the long queue "
            "at the busy shop, his steps never slowing.\n"
            "[Shot 2] At 00:03.000, a close shot: her step suddenly stops, the fingers holding the steamers tighten, she turns her head to follow his back, her lashes flicker, "
            "steam still curling from the baskets.\n"
            "[Shot 3] At 00:06.000, a close-up: her gaze slides from the man's back to the long queue at the shop door, her lips press tight, her nostrils move."),
         snd="Footsteps, crowd murmur, steam hissing.",
         mus="N/A"),
    dict(no=4, frames=209, first="c2_4.png", clip=4, load=3,
         atmos="Orange-red stove fire lighting one side of his face, steam rising, oil glinting.",
         d=("[Shot 1] 3D CG, cinematic, at 0.00 seconds a medium shot: the young man in a grey-blue cross-collar robe stands behind the iron pans, pinching the pleats of a bun shut "
            "one by one, wrist turning and pressing, steam striking his jaw.\n"
            "[Shot 2] At 00:03.000, the camera cuts to a top-down close shot of his hands: the dough is folded into even pleats in his palm, fingertips dusted with flour, "
            "then he sets the bun gently into the pan.\n"
            "[Shot 3] At 00:06.000, the camera cuts back to a close shot of his face: he lifts his eyes toward the queue at the door, calm, a trace of steadiness at the corner of his mouth, "
            "oil sizzling in the pan."),
         snd="Oil sizzling, dough pressed, steam hissing.",
         mus="N/A"),
    dict(no=5, frames=209, first="c2_5.png", clip=5, load=4,
         atmos="Bright morning light, steam whitening against the backlight; the mood snaps tight, the chatter cut off by one shout.",
         d=("[Shot 1] 3D CG, cinematic, at 0.00 seconds a wide shot: the gaunt woman strides to the bench outside the busy shop and slams the stack of bamboo steamers down on it; "
            "the baskets knock together with a dull thud and a burst of steam blows out.\n"
            "[Shot 2] At 00:03.000, the camera cuts to a low-angle close shot: she lifts her chin past the queueing customers toward the stove, her neck taut, and raises her voice. "
            "The gaunt woman in her forties, sharp and loud (S1) shouts: <d>[Chinese] 都等等——唐大郎！</d>\n"
            "[Shot 3] At 00:06.000, a medium shot: she braces one hand on the bench, customers in the queue turn their heads to look, steam churning in the morning light."),
         snd="Bamboo steamers thudding onto the bench, steam bursting out, the crowd drawing breath and whispering.",
         mus="A lively market melody suddenly breaks off, one string note rising."),
    dict(no=6, frames=209, first="c2_6.png", clip=6, load=5,
         atmos="Stove fire warm red crossing the cold white morning light, steam drifting slowly between the two people.",
         d=("[Shot 1] 3D CG, cinematic, at 0.00 seconds a close shot: the young man hears the shout and lifts his head, sets the half-finished bun softly back on the board, "
            "not a trace of panic in his face.\n"
            "[Shot 2] At 00:03.000, a close shot: he wipes his hands again and again on the apron at his waist, palm and between the fingers, the leather wrist guard rubbed bright.\n"
            "[Shot 3] At 00:06.000, a medium shot: he straightens up, turns toward the door, bows his head slightly and speaks evenly. "
            "The young man in his late teens, calm and clear (S2) says: <d>[Chinese] 婶子，您说。</d>"),
         snd="Cloth being wiped, oil sizzling, market murmur.",
         mus="N/A"),
    dict(no=7, frames=260, first="c2_7.png", clip=7, load=6,
         atmos="Morning light cutting in at an angle, steam against the oil sheen, the challenge hanging in the air.",
         d=("[Shot 1] 3D CG, cinematic, at 0.00 seconds a medium shot: the gaunt woman slaps the lid of her own steamer; the lid jumps, white steam bursts out and reveals rows of neat buns inside.\n"
            "[Shot 2] At 00:03.000, a close side shot: her hand turns toward the stove, fingertip stabbing the air, chin tilted. "
            "The gaunt woman (S1) says: <d>[Chinese] 我这炊饼，才出锅的，三文一个。</d>\n"
            "[Shot 3] At 00:06.000, still a close side shot: she presses on, her voice rising. "
            "<d>[Chinese] 你那生煎，八文一个，凭的是什么？</d>\n"
            "[Shot 4] At 00:09.000, the camera cuts to a close shot of the pan: a ring of buns with crisp browned bases, oil glinting in the morning light."),
         snd="Steamer lid clacking, steam bursting, oil sizzling.",
         mus="N/A"),
    dict(no=8, frames=311, first="c2_8.png", clip=8, load=7,
         atmos="Morning light and stove fire crossing, the two facing off, steam curling slowly around them.",
         d=("[Shot 1] 3D CG, cinematic, at 0.00 seconds a medium shot: the young man does not argue; he wipes the flour from his hands on the apron, his shoulders loosen, "
            "and he lifts his eyes toward the door.\n"
            "[Shot 2] At 00:03.000, a close shot with a slight low angle: he looks at the gaunt woman and raises one hand toward the stove, palm open.\n"
            "[Shot 3] At 00:06.000, a medium shot: his open hand indicates the ring of buns in the pan, his manner calm. "
            "The young man (S2) says: <d>[Chinese] 您站这儿看三分钟。</d>\n"
            "[Shot 4] At 00:09.000, the camera cuts to a close shot of the gaunt woman: her brow lifts, her eyes slide to the pan, her lips part, steam curls slowly around the rim."),
         snd="Cloth wiping, oil sizzling, steam hissing.",
         mus="N/A"),
]


def log(s):
    print(f"[{time.strftime('%H:%M:%S')}] {s}", flush=True)


def prompt_of(s):
    return (f"{s['d']}\n\natmosphere: {s['atmos']}\n\noverall_soundscape: {s['snd']}\n\nnon_diegetic_music: {s['mus']}")


def graph(s, seed):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "20": {"class_type": "LoadImage", "inputs": {"image": s["first"]}},
        "6": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["3", 0], "vae": ["4", 0], "prompt": prompt_of(s),
            "width": 864, "height": 480, "length": s["frames"], "first_frame": ["20", 0]}},
        "7": {"class_type": "MiniMaxH3MotionContextLoadLatent",
              "inputs": {"latent_path": "e4", "clip_index": s["load"], "stock_format": False, "folder": "output"}},
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
        "14": {"class_type": "MiniMaxH3MotionContextSaveLatent", "inputs": {"latent": ["13", 0], "filename_prefix": "e4/clip", "clip_index": s["clip"]}},
        "15": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["4", 0]}},
        "16": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["13", 0], "vae": ["5", 0]}},
        "17": {"class_type": "MiniMaxH3MotionContextTrim", "inputs": {"images": ["15", 0], "trim_frames": ["8", 1], "audio": ["16", 0], "fps": 24.0, "match_tail": True}},
        "18": {"class_type": "CreateVideo", "inputs": {"images": ["17", 0], "audio": ["17", 1], "fps": 24, "bit_depth": 8}},
        "19": {"class_type": "SaveVideo", "inputs": {"video": ["18", 0], "filename_prefix": f"hb_e4/s{s['no']}", "format": "auto", "codec": "auto"}},
    }


def wait(pid, timeout=2400):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = json.loads(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=60).read())
        if pid in h:
            return h[pid]
        time.sleep(8)
    return None


def main():
    os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    parts = []
    for s in SHOTS:
        t0 = time.time()
        try:
            req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": graph(s, 20267700 + s["no"])}).encode(),
                                         headers={"Content-Type": "application/json"})
            pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
        except urllib.error.HTTPError as e:
            log(f"镜{s['no']} 提交失败 {e.read().decode()[:300]}"); return
        hist = wait(pid)
        if not hist or hist.get("status", {}).get("status_str") != "success":
            log(f"镜{s['no']} 失败 {str((hist or {}).get('status',{}).get('messages',[])[-1:])[:300]}"); return
        dst = os.path.join(WORK, f"e4_{s['no']}.mp4")
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
    if len(parts) == len(SHOTS):
        lst = os.path.join(WORK, "list.txt")
        open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
        out = os.path.join(OUT, "e4_8shots_00001_.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                        "-c:v", "libx264", "-crf", "18", "-c:a", "aac", out], check=True)
        log(f"拼接完成 {out}")
    log("=== E4 结束 ===")


if __name__ == "__main__":
    main()
