#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探测 MiniMaxH3ReferenceToVideo 的 autogrow ref_images 在 API 里的写法。
只提交一次；被接受就立刻中断，避免真跑。"""
import json, sys, urllib.request, urllib.error

COMFY = "http://127.0.0.1:8188"


def graph(fmt):
    refs = {
        "ref_images": {f"ref_image_{i}": [n, 0] for i, n in enumerate(["e2_tangyi.png", "e2_jiapo.png", "e2_scene.png"])},
        "ref_images.ref_image_0": ["9", 0],
    }
    node = {
        "class_type": "MiniMaxH3ReferenceToVideo",
        "inputs": {"clip": ["3", 0], "vae": ["4", 0], "audio_vae": ["5", 0],
                   "prompt": "test", "width": 864, "height": 480, "length": 124, "ref_image_size": "match"},
    }
    if fmt == "dict":
        node["inputs"]["ref_images"] = {"ref_image_0": ["9", 0], "ref_image_1": ["10", 0]}
    elif fmt == "dotted":
        node["inputs"]["ref_images.ref_image_0"] = ["9", 0]
        node["inputs"]["ref_images.ref_image_1"] = ["10", 0]
    elif fmt == "list":
        node["inputs"]["ref_images"] = [["9", 0], ["10", 0]]
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "9": {"class_type": "LoadImage", "inputs": {"image": "e2_tangyi.png"}},
        "10": {"class_type": "LoadImage", "inputs": {"image": "e2_jiapo.png"}},
        "6": node,
        "7": {"class_type": "PreviewImage", "inputs": {"images": ["9", 0]}},
    }


def try_fmt(fmt):
    wf = graph(fmt)
    req = urllib.request.Request(COMFY + "/prompt", data=json.dumps({"prompt": wf}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        r = json.loads(urllib.request.urlopen(req, timeout=30).read())
        pid = r.get("prompt_id")
        urllib.request.urlopen(urllib.request.Request(COMFY + "/interrupt", data=b"", method="POST"), timeout=10)
        return f"ACCEPTED（已中断）pid={pid}"
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            err = json.loads(body)
            ne = err.get("node_errors") or {}
            msgs = []
            for nid, info in ne.items():
                for x in info.get("errors", []):
                    msgs.append(f"{nid}:{x.get('message')}/{x.get('details')}")
            return f"REJECTED {msgs[:2] or body[:200]}"
        except Exception:
            return f"REJECTED {body[:200]}"


for fmt in ("dict", "dotted", "list"):
    print(fmt, "->", try_fmt(fmt), flush=True)
