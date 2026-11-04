#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务器侧直接跑 Qwen-Image 生成角色肖像（不经过 Mac 桥接）。"""
import json, os, time, urllib.request, urllib.parse

COMFY = "http://127.0.0.1:8188"
OUT = "/data/comfyui/ComfyUI/output/hb_portrait"
STYLE = ("3D 国漫 CG 渲染，PBR 材质，皮肤次表面散射，柔和棚拍光，干净浅灰背景，半身正面肖像，面部占画面 40%，清晰五官")
JOBS = {
    "p_jiapo": "四十余岁瘦削妇人，深灰布头巾包发，深赭短褐，深灰围裙，薄唇，眼神精明，正面半身",
    "p_liu": "五十岁左右微胖妇人，深色发髻插金簪，紫底金花袄，玉耳坠，圆脸笑眼，正面半身",
    "p_tang": "十四岁少年，男性，眉眼清朗，深色发髻用暗蓝布带束起，灰蓝交领短褐，正面半身",
}
NEG = "写实，照片，真人实拍，胶片颗粒，水印，文字，现代元素，畸变手指"


def graph(prompt, seed):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_fp8_e4m3fn.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEG}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0],
                                                   "latent_image": ["6", 0], "seed": seed, "steps": 25, "cfg": 4.0,
                                                   "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": f"hb_portrait/{seed}"}},
    }


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for i, (name, desc) in enumerate(JOBS.items()):
        t0 = time.time()
        wf = graph(f"{STYLE}。{desc}", 20274000 + i)
        req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": wf}).encode(),
                                     headers={"Content-Type": "application/json"})
        pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
        while True:
            h = json.loads(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=60).read())
            if pid in h:
                break
            time.sleep(4)
        for o in h[pid]["outputs"].values():
            for im in o.get("images", []):
                q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                open(os.path.join(OUT, f"{name}.png"), "wb").write(urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=120).read())
        print(f"{name} 完成 {round(time.time()-t0)}s", flush=True)
    print("=== 肖像结束 ===")
