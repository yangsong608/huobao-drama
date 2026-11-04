#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenAI Images API 的本地兼容层：转给我们自己 ComfyUI 的 Qwen-Image 出图。

端点：
  GET  /v1/models                    -> {"object":"list","data":[{"id":"qwen-image"}]}
  POST /v1/images/generations        -> {"data":[{"url":"http://127.0.0.1:8191/files/x.png"}]}
  POST /v1/images/edits              -> 带参考图；用 img2img 近似（denoise 0.6）
  GET  /files/<name>.png             -> 图片
"""
import json, os, time, uuid, random, urllib.request, urllib.parse, threading, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COMFY = "http://127.0.0.1:8188"
PORT = 8191
HERE = os.path.dirname(os.path.abspath(__file__))
FILES = os.path.join(HERE, "files")
os.makedirs(FILES, exist_ok=True)

# Qwen-Image 只有 img2img 一条参考图通道，没有多图编辑节点；多传的图不能静默丢弃，
# 统一只取第一张并在响应里返回 warning，/health 也如实上报 maxReferences。
MAX_EDIT_REFS = 1

# 只做「质量兜底」：不再限制画风（旧的「写实/照片/真人实拍/胶片颗粒/文字」会和
# 风格预设里的正面描述直接对撞——例如「写实电影感」风格会被强制拉成动画）。
NEG = "低质量，模糊，噪点，压缩伪影，过曝，畸变，多余手指，多余肢体，畸形脸，水印，签名，低分辨率"


def http_json(url, payload=None, timeout=120):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"},
                                 method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def fetch_bytes(url, timeout=300):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def upload_image(raw, ctype="image/png"):
    boundary = "----img" + uuid.uuid4().hex
    ext = ".jpg" if "jpeg" in ctype else ".png"
    name = f"imgsrc_{uuid.uuid4().hex[:10]}{ext}"
    body = b""
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n".encode()
    body += f"Content-Type: {ctype}\r\n\r\n".encode() + raw + b"\r\n"
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n".encode()
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(COMFY + "/upload/image", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())["name"]


def parse_size(size, model):
    m = re.match(r"^\s*(\d+)\s*[xX*]\s*(\d+)\s*$", size or "")
    w, h = (int(m.group(1)), int(m.group(2))) if m else (1024, 1024)
    w = max(256, min(2048, (w // 8) * 8))
    h = max(256, min(2048, (h // 8) * 8))
    return w, h


def capabilities():
    """图片桥的真实能力，供健康检查与后端排查（不冒充多图编辑）"""
    return {
        "generations": True,
        "edits": True,
        "multiReference": False,
        "maxReferences": MAX_EDIT_REFS,
        "editSize": True,
        "models": ["qwen-image"],
    }


def select_edit_reference(images):
    """编辑只取第一张参考图；多传的图返回明确 warning，绝不静默丢弃"""
    if not images:
        return None, ""
    extra = len(images) - MAX_EDIT_REFS
    if extra <= 0:
        return images[0], ""
    warning = (f"本地图片桥每次编辑只使用第 1 张参考图，本次收到 {len(images)} 张，"
               f"其余 {extra} 张未参与生成")
    return images[0], warning


def multipart_text(raw, name):
    """从 multipart 请求体里提取普通文本字段（prompt / size 等）"""
    pattern = rb'name="' + re.escape(name.encode()) + rb'"[^\r]*\r\n(?:Content-Type:[^\r]*\r\n)?\r\n(.*?)\r\n--'
    match = re.search(pattern, raw, re.S)
    return match.group(1).decode("utf-8", "ignore").strip() if match else ""


def graph_t2i(prompt, w, h, seed):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_fp8_e4m3fn.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEG}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0],
                                                   "latent_image": ["6", 0], "seed": seed, "steps": 25, "cfg": 4.0,
                                                   "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "imgshim/qwen"}},
    }


def graph_img2img(prompt, src_name, seed, w, h, denoise=0.6):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_fp8_e4m3fn.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEG}},
        "6": {"class_type": "LoadImage", "inputs": {"image": src_name, "upload": "image"}},
        # 参考图原始尺寸不可控，先缩放到请求尺寸再编码，避免输出跟随源图分辨率
        "7": {"class_type": "ImageScale", "inputs": {"image": ["6", 0], "upscale_method": "lanczos",
                                                     "width": w, "height": h, "crop": "center"}},
        "8": {"class_type": "VAEEncode", "inputs": {"pixels": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0],
                                                   "latent_image": ["8", 0], "seed": seed, "steps": 25, "cfg": 4.0,
                                                   "sampler_name": "euler", "scheduler": "simple", "denoise": denoise}},
        "10": {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
        "11": {"class_type": "SaveImage", "inputs": {"images": ["10", 0], "filename_prefix": "imgshim/qwen_i2i"}},
    }


def run_graph(graph, tag):
    pid = http_json(COMFY + "/prompt", {"prompt": graph})["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < 900:
        hist = http_json(f"{COMFY}/history/{pid}")
        if pid in hist:
            for v in hist[pid].get("outputs", {}).values():
                for im in v.get("images", []):
                    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                    raw = fetch_bytes(f"{COMFY}/view?{q}")
                    name = f"{tag}_{uuid.uuid4().hex[:10]}.png"
                    open(os.path.join(FILES, name), "wb").write(raw)
                    return f"http://127.0.0.1:{PORT}/files/{name}"
            raise RuntimeError("no image in outputs")
        time.sleep(2)
    raise RuntimeError("timeout")


class H(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def log_message(self, fmt, *args):
        print("[imgshim]", fmt % args, flush=True)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            return self._json(200, {"object": "list", "data": [{"id": "qwen-image", "object": "model", "owned_by": "local"}]})
        if self.path.startswith("/files/"):
            name = os.path.basename(self.path.split("?")[0])
            p = os.path.join(FILES, name)
            if not os.path.exists(p):
                return self._json(404, {"error": "no file"})
            data = open(p, "rb").read()
            self.send_response(200); self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            return
        if self.path in ("/", "/health"):
            return self._json(200, {"ok": True, "script": os.path.abspath(__file__), "pid": os.getpid(),
                                    "capabilities": capabilities()})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        ctype = self.headers.get("Content-Type", "")
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n)
        try:
            if self.path.startswith("/v1/images/edits"):
                prompt = multipart_text(raw, "prompt")
                size = multipart_text(raw, "size")
                imgs = re.findall(rb"name=\"image\[\]\"[^\r]*\r\nContent-Type: ([^\r]+)\r\n\r\n(.*?)\r\n--", raw, re.S)
                if not imgs:
                    return self._json(400, {"error": {"message": "image[] required"}})
                (ctype_i, data), warning = select_edit_reference(imgs)
                if warning:
                    print(f"[imgshim] warning: {warning}", flush=True)
                w, h = parse_size(size, "qwen-image")
                src = upload_image(data, ctype_i.decode())
                url = run_graph(graph_img2img(prompt, src, random.randint(0, 2**31 - 1), w, h), "i2i")
                payload = {"data": [{"url": url}]}
                if warning:
                    payload["warning"] = warning
                return self._json(200, payload)
            # generations
            body = json.loads(raw or b"{}")
            prompt = (body.get("prompt") or "").strip()
            if not prompt:
                return self._json(400, {"error": {"message": "prompt required"}})
            w, h = parse_size(body.get("size"), body.get("model"))
            url = run_graph(graph_t2i(prompt, w, h, random.randint(0, 2**31 - 1)), "t2i")
            if body.get("response_format") == "b64_json":
                import base64
                b = base64.b64encode(open(os.path.join(FILES, os.path.basename(url)), "rb").read()).decode()
                return self._json(200, {"data": [{"b64_json": b}]})
            return self._json(200, {"data": [{"url": url}]})
        except Exception as e:
            return self._json(500, {"error": {"message": f"{type(e).__name__}: {e}"}})


if __name__ == "__main__":
    print(f"OpenAI-Images-compatible shim on :{PORT} -> ComfyUI {COMFY}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
