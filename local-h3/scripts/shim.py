#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MiniMax v2 视频生成 API 的本地兼容层：把请求转给自建 ComfyUI + H3 导演台。

端点（与 MiniMax 官方一致）：
  POST /v2/video_generation          -> {"task_id": "..."}
  GET  /v2/query/video_generation/<id> -> {"task": {"status": "...", "content": {"url": "..."}}}
  GET  /files/<name>.mp4             -> 成片

画布换算：官方 resolution 只有 768P / 2K，本地额外接受 resolution_tier（480p/720p/1080p）
与 aspect_ratio（16:9 / 9:16 / ...），按短边档位 + 比例算出 32 倍数的真实画布。
"""
import json, os, re, time, uuid, urllib.error, urllib.request, urllib.parse, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COMFY = "http://127.0.0.1:8188"
PORT = 8190
HERE = os.path.dirname(os.path.abspath(__file__))

# H3 画布必须是 32 的倍数（VAE ÷16 后再 2×2 patch），否则 patchify_video 直接报错
CANVAS_STRIDE = 32
DEFAULT_RATIO = 16 / 9

# 官方只给 768P / 2K 两档，本地按项目档位细分到短边像素。
# 480p→480、720p/768P→768（对齐 turbo LoRA 的 768p 训练分辨率）、1080p/2K→1080。
RESOLUTION_SHORT_EDGE = {
    "480p": 480, "480": 480, "sd": 480,
    "720p": 768, "720": 768, "768p": 768, "768": 768, "hd": 768,
    "1080p": 1080, "1080": 1080, "2k": 1080, "fhd": 1080,
}
FILES = os.path.join(HERE, "files")
os.makedirs(FILES, exist_ok=True)

TASKS = {}          # task_id -> dict(state, url, error, pid)
LOCK = threading.Lock()
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")


def save_state():
    try:
        with LOCK:
            data = {k: {"state": v.get("state"), "url": v.get("url"), "error": v.get("error"), "pid": v.get("pid"),
                        "frames": v.get("frames"), "duration": v.get("duration")}
                    for k, v in TASKS.items()}
        tmp = STATE + ".tmp"
        json.dump(data, open(tmp, "w"), ensure_ascii=False)
        os.replace(tmp, STATE)
    except Exception as e:
        print("[shim] save_state failed", e, flush=True)


def load_state():
    try:
        data = json.load(open(STATE))
    except Exception:
        return
    for k, v in data.items():
        TASKS[k] = {"state": v.get("state"), "url": v.get("url"), "error": v.get("error"), "pid": v.get("pid"),
                    "frames": v.get("frames"), "duration": v.get("duration")}
        if v.get("pid") and v.get("state") == "processing":
            threading.Thread(target=resume_worker, args=(k, v["pid"]), daemon=True).start()
    print(f"[shim] resumed {len(data)} tasks", flush=True)


def resume_worker(task_id, pid):
    """重启后接管仍在 ComfyUI 跑的任务"""
    try:
        t0 = time.time()
        while time.time() - t0 < 3600:
            hist = http_json(f"{COMFY}/history/{pid}")
            if pid in hist:
                err = history_error(hist[pid])
                if err:
                    with LOCK:
                        TASKS[task_id].update(state="failed", error=err)
                    save_state()
                    return
                for v in hist[pid].get("outputs", {}).values():
                    for im in v.get("images", []):
                        fn = im.get("filename")
                        if fn and fn.endswith(".mp4"):
                            q = urllib.parse.urlencode({"filename": fn, "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                            raw, _ = fetch_bytes(f"{COMFY}/view?{q}", timeout=600)
                            local = f"{task_id}.mp4"
                            open(os.path.join(FILES, local), "wb").write(raw)
                            with LOCK:
                                task = TASKS[task_id]
                                duration = task.get("duration") or (task.get("frames") or 0) / 24.0 or None
                                task.update(state="succeeded", url=f"http://127.0.0.1:{PORT}/files/{local}", duration=duration)
                            save_state()
                            return
                outputs = list(hist[pid].get("outputs", {}).keys())
                with LOCK:
                    TASKS[task_id].update(state="failed",
                                          error=f"no video in outputs (nodes: {', '.join(outputs) or 'none'})")
                save_state()
                return
            time.sleep(5)
    except Exception as e:
        with LOCK:
            TASKS[task_id].update(state="failed", error=f"{type(e).__name__}: {e}")
        save_state()

NEG = "bad video, distorted face, extra fingers, text, watermark, subtitles, muffled speech, distorted audio, loud background music"

# 全局音频指令：H3 音画同生成，旁白/对白清晰度只能在这里下要求。
# 明确「无背景音乐」是给后期 BGM 留空间，避免模型自带音乐盖住人声。
# 注意：分段模式下节点只用 segments[].prompt，global_prompt 只是兜底，
# 所以真正生效的是下面 with_audio_directive 拼进每段提示词的那一行。
AUDIO_DIRECTIVE = (
    "Audio: clear, intelligible Mandarin dialogue and voice-over narration, "
    "natural ambience, no background music."
)
# 后期配音模式：画面不要清晰人声，只留环境声，避免与 TTS 抢同一频段
AMBIENT_DIRECTIVE = (
    "Audio: ambient sound only, no intelligible speech, no dialogue, no voice-over, "
    "no background music; characters do not speak."
)
# 静音模式：连音轨都不要（CreateVideo 也不接 audio 输入），留给后期整轨配音
SILENT_DIRECTIVE = (
    "Audio: silent video, no audio track at all; no speech, no dialogue, no voice-over, "
    "no ambience, no sound effects, no background music."
)
GLOBAL_PROMPT = (
    "Natural synchronized audio: clear, intelligible Mandarin dialogue and voice-over narration, "
    "accurate lip sync, subtle natural ambience, no background music, no subtitles, no on-screen text."
)
# 提示词里可能已带中文「音频：」或英文 Audio 行，ambient/silent 必须整行替换
AUDIO_LINE_RE = re.compile(r"(?im)^\s*(?:音频|audio)\s*[：:].*(?:\n|$)")


def strip_audio_lines(text):
    """移除模型/提示词自带的音频要求行，避免与本次音频模式冲突"""
    return AUDIO_LINE_RE.sub("", text or "").strip()


def with_audio_directive(prompt, audio_mode="native"):
    """把音频要求放到提示词最前面；ambient/silent 覆盖提示词里已有的音频行"""
    text = (prompt or "").strip()
    mode = str(audio_mode or "native").strip().lower()
    if mode == "ambient":
        directive = AMBIENT_DIRECTIVE
    elif mode == "silent":
        directive = SILENT_DIRECTIVE
    else:
        directive = AUDIO_DIRECTIVE
    if mode in ("ambient", "silent"):
        text = strip_audio_lines(text)
        return f"{directive}\n{text}" if text else directive
    if not text:
        return directive
    if text.startswith(directive) or "音频：" in text or re.search(r"(?im)^\s*audio\s*[：:]", text):
        return text
    return f"{directive}\n{text}"


def snap_dimension(value):
    """吸附到 32 的倍数（H3 补丁网格），并夹在 32..8192。720→736、1080→1088。"""
    v = int((float(value) + CANVAS_STRIDE / 2) // CANVAS_STRIDE) * CANVAS_STRIDE
    return max(CANVAS_STRIDE, min(8192, v))


def parse_ratio(raw):
    """'16:9' / '9:16' / '4:3' / '21:9' → float；无法解析返回 None"""
    if raw is None:
        return None
    s = str(raw).strip().lower().replace("：", ":")
    m = re.match(r"^(\d+(?:\.\d+)?)\s*[:x*/]\s*(\d+(?:\.\d+)?)$", s)
    if not m:
        return None
    w, h = float(m.group(1)), float(m.group(2))
    if w <= 0 or h <= 0:
        return None
    return w / h


def resolve_canvas(resolution=None, ratio=None):
    """项目档位 + 画面比例 → H3 画布 (width, height)。

    - 短边由档位决定（480 / 768 / 1080），长边按比例换算，两边都吸附到 32 的倍数
    - 竖屏（9:16）自动把长边放到高度上，不再固定出横屏
    - 比例缺失时按 16:9，档位缺失时按老的 864×480（480p）
    """
    key = str(resolution or "").strip().lower().replace(" ", "")
    short_edge = RESOLUTION_SHORT_EDGE.get(key, 480)
    ar = parse_ratio(ratio) or DEFAULT_RATIO
    ar = min(max(ar, 0.2), 5.0)
    if ar >= 1:
        width = snap_dimension(short_edge * ar)
        height = snap_dimension(short_edge)
    else:
        width = snap_dimension(short_edge)
        height = snap_dimension(short_edge / ar)
    return width, height


def http_json(url, payload=None, method=None, timeout=120):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"},
                                 method=method or ("POST" if data else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(describe_http_error(e)) from e


def describe_http_error(err):
    """把 ComfyUI 的 HTTP 错误体（error/node_errors）还原成可读信息，别只留 HTTP 400"""
    try:
        raw = err.read().decode("utf-8", "replace")
    except Exception:
        raw = ""
    try:
        data = json.loads(raw)
    except Exception:
        data = None
    if isinstance(data, dict):
        info = data.get("error")
        parts = []
        if isinstance(info, dict):
            parts = [info.get("message"), info.get("details")]
        elif isinstance(info, str):
            parts = [info]
        node_errors = data.get("node_errors")
        if node_errors:
            parts.append(json.dumps(node_errors, ensure_ascii=False)[:2000])
        text = "；".join(str(p) for p in parts if p)
        if text:
            return f"HTTP {err.code}: {text}"
    return f"HTTP {err.code}: {raw[:2000] or err.reason}"


def history_error(entry):
    """从 ComfyUI history 条目提取执行错误；成功/无错误返回空串"""
    status = (entry or {}).get("status") or {}
    for item in status.get("messages") or []:
        if not (isinstance(item, (list, tuple)) and len(item) >= 2):
            continue
        kind, payload = item[0], item[1]
        if kind not in ("execution_error", "execution_interrupted"):
            continue
        data = payload if isinstance(payload, dict) else {}
        node = data.get("node_type") or data.get("node_id") or "ComfyUI"
        message = data.get("exception_message") or data.get("message") or kind
        return f"{node}: {str(message).strip()}"
    if status.get("status_str") == "error":
        return "ComfyUI execution failed (history has no error message)"
    return ""


def fetch_bytes(url, timeout=120):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")


def upload_image(url):
    """把外部图片下载后上传到 ComfyUI input，返回文件名"""
    raw, ctype = fetch_bytes(url)
    boundary = "----mm" + uuid.uuid4().hex
    ext = ".png"
    if "jpeg" in ctype or "jpg" in ctype:
        ext = ".jpg"
    name = f"mm_{uuid.uuid4().hex[:10]}{ext}"
    body = b""
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n".encode()
    body += f"Content-Type: {ctype or 'application/octet-stream'}\r\n\r\n".encode()
    body += raw + b"\r\n"
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n".encode()
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(COMFY + "/upload/image", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())["name"]


def frames_for(duration):
    d = float(duration or 5)
    if d <= 6:
        return 124
    if d <= 11:
        return 241
    return 362


def build_graph(prompt, first_name, last_name, frames, seed, ref_names=None, size=None, audio_mode="native"):
    ref_names = ref_names or []
    width, height = size or (864, 480)
    ref_max = max(width, height)
    mode = str(audio_mode or "native").strip().lower()
    prompt = with_audio_directive(prompt, mode)
    global_prompt = {"ambient": AMBIENT_DIRECTIVE, "silent": SILENT_DIRECTIVE}.get(mode, GLOBAL_PROMPT)
    r2v = bool(ref_names) and not first_name
    t2v = (not first_name) and not r2v
    si = None if t2v else {"imageFile": first_name, "width": 0, "height": 0}
    ei = {"imageFile": last_name, "width": 0, "height": 0} if last_name else None
    shot = {"id": "s0", "durationSec": frames / 24.0, "prompt": prompt, "negativePrompt": NEG,
            "continuityFromPrev": False, "loras": [], "startImage": si, "endImage": ei}
    seg = {"id": "s0", "start": 0, "length": frames, "frameCount": frames, "durationSec": frames / 24.0,
           "prompt": prompt, "negativePrompt": NEG, "continuityFromPrev": False, "loras": [],
           "isStartFrame": bool(si), "isEndFrame": bool(ei), "genImage": si or {"imageFile": ""}, "endImage": ei, "taskType": "",
           "refs": [{"index": i, "imageFile": n} for i, n in enumerate(ref_names)]}
    tl = {"version": 4, "editMode": "segment", "timelineMode": ("r2v" if r2v else ("t2v" if t2v else "fl2v")), "totalFrames": frames, "frameRate": 24.0,
          "width": width, "height": height, "refMaxSize": ref_max,
          "output": {"mode": "fixed", "longEdge": ref_max, "width": width, "height": height, "maxExportFrames": 0,
                     "exportMode": "all", "continuityEnabled": False, "continuityOverlapFrames": 9},
          "videoClips": [], "video": {"fileName": "", "videoFile": "", "subfolder": "", "type": "input", "frames": [], "frameMap": []},
          "global": {"taskType": ("r2v — 参考主体生视频(Reference to Video)" if r2v else ("t2v — 文生视频(Text to Video)" if t2v else "fl2v — 首尾帧生视频(First-Last Frame)")), "prompt": prompt, "refs": [],
                     "referenceVideo": {}, "continuousReference": False, "genImage": {"imageFile": ""}},
          "shots": ([] if r2v else [shot]), "keyframes": [], "segments": [seg], "gen": {"defaultFrameCount": frames},
          "runSelectEnabled": False, "runSelection": []}
    # 静音模式不接音频输入：CreateVideo 的 audio 是可选项，省略即输出无声视频
    create_video = {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "fps": 24, "bit_depth": 8}}
    if mode != "silent":
        create_video["inputs"]["audio"] = ["6", 1]
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "6": {"class_type": "MiniMaxH3Director", "inputs": {
            "model": ["2", 0], "video_vae": ["4", 0], "audio_vae": ["5", 0], "clip": ["3", 0],
            "task_type": ("r2v — 参考主体生视频(Reference to Video)" if r2v else ("t2v — 文生视频(Text to Video)" if t2v else "fl2v — 首尾帧生视频(First-Last Frame)")),
            "global_prompt": global_prompt,
            "cfg": 1.0, "bd_grp_sample": "采样设置", "bd_grp_advanced": "高级采样 Advanced", "bd_grp_perf": "性能 Performance",
            "frame_rate": 24.0, "width": width, "height": height, "ref_max_size": ref_max,
            "total_frames": frames, "timeline_data": json.dumps(tl, ensure_ascii=False),
            "steps": 4, "sampler": "euler", "scheduler": "beta", "shift_video": 12.0, "shift_audio": 3.0,
            "seed": seed, "clear_vram_between_segments": True}},
        "7": create_video,
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0], "filename_prefix": f"mm/{seed}", "format": "auto", "codec": "auto"}},
    }


def worker(task_id, prompt, first_url, last_url, frames, ref_urls=None, size=None, audio_mode="native"):
    try:
        first_name = upload_image(first_url) if first_url else None
        last_name = upload_image(last_url) if last_url else None
        ref_names = [upload_image(u) for u in (ref_urls or []) if u][:9]
        seed = int(uuid.uuid4().int % 2_000_000_000)
        graph = build_graph(prompt, first_name, last_name, frames, seed, ref_names, size, audio_mode)
        pid = http_json(COMFY + "/prompt", {"prompt": graph})["prompt_id"]
        with LOCK:
            TASKS[task_id]["pid"] = pid
        t0 = time.time()
        while time.time() - t0 < 3600:
            hist = http_json(f"{COMFY}/history/{pid}")
            if pid in hist:
                err = history_error(hist[pid])
                if err:
                    with LOCK:
                        TASKS[task_id].update(state="failed", error=err)
                    save_state()
                    return
                outs = hist[pid].get("outputs", {})
                for v in outs.values():
                    for im in v.get("images", []):
                        fn = im.get("filename")
                        if fn and fn.endswith(".mp4"):
                            q = urllib.parse.urlencode({"filename": fn, "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                            raw, _ = fetch_bytes(f"{COMFY}/view?{q}", timeout=600)
                            local = f"{task_id}.mp4"
                            open(os.path.join(FILES, local), "wb").write(raw)
                            with LOCK:
                                TASKS[task_id].update(state="succeeded", url=f"http://127.0.0.1:{PORT}/files/{local}",
                                                      duration=frames / 24.0)
                            save_state()
                            return
                nodes = ", ".join(outs.keys()) or "none"
                with LOCK:
                    TASKS[task_id].update(state="failed", error=f"no video in outputs (nodes: {nodes})")
                save_state()
                return
            time.sleep(5)
        with LOCK:
            TASKS[task_id].update(state="failed", error="timeout")
    except Exception as e:
        import traceback; traceback.print_exc()
        with LOCK:
            TASKS[task_id].update(state="failed", error=f"{type(e).__name__}: {e}")
        save_state()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("[shim]", self.address_string(), fmt % args, flush=True)

    def do_POST(self):
        if not self.path.startswith("/v2/video_generation"):
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        content = body.get("content") or []
        prompt = "".join(c.get("text", "") for c in content if c.get("type") == "text").strip()
        first = last = None
        ref_urls = []
        for c in content:
            if c.get("type") == "image_url":
                u = (c.get("image_url") or {}).get("url")
                role = c.get("role")
                if role == "first_frame" and not first:
                    first = u
                elif role == "last_frame" and not last:
                    last = u
                elif role in ("reference_image", None):
                    ref_urls.append(u)
        if not prompt:
            return self._send(400, {"error": "prompt required"})
        # 无首帧时走 t2v（文生视频），不再拒绝
        frames = frames_for(body.get("duration"))
        # 分辨率：优先本地扩展字段 resolution_tier（480p/720p/1080p），
        # 退到官方字段 resolution（768P/2K）；比例优先 aspect_ratio（竖屏项目必带）
        resolution = body.get("resolution_tier") or body.get("resolution")
        ratio = body.get("aspect_ratio") or body.get("ratio")
        size = resolve_canvas(resolution, ratio)
        audio_mode = str(body.get("audio_mode") or "").strip().lower()
        if audio_mode not in ("native", "ambient", "silent"):
            audio_mode = "native"
        task_id = uuid.uuid4().hex
        with LOCK:
            TASKS[task_id] = {"state": "processing", "url": None, "error": None, "pid": None,
                              "frames": frames, "duration": frames / 24.0}
        save_state()
        print(f"[shim] task {task_id[:8]} canvas={size[0]}x{size[1]} "
              f"resolution={resolution or '-'} ratio={ratio or '-'} audio={audio_mode} duration={body.get('duration')}", flush=True)
        threading.Thread(target=worker, args=(task_id, prompt, first, last, frames, ref_urls, size, audio_mode), daemon=True).start()
        return self._send(200, {"task_id": task_id})

    def do_GET(self):
        if self.path.startswith("/v2/query/video_generation/"):
            tid = self.path.rsplit("/", 1)[-1]
            t = TASKS.get(tid)
            if not t:
                return self._send(404, {"task": {"status": "failed", "error": {"message": "unknown task"}}})
            if t["state"] == "succeeded":
                payload = {"status": "succeeded", "content": {"url": t["url"]}}
                if t.get("duration"):
                    payload["duration"] = round(float(t["duration"]), 3)
                return self._send(200, {"task": payload})
            if t["state"] == "failed":
                return self._send(200, {"task": {"status": "failed", "error": {"message": t["error"]}}})
            return self._send(200, {"task": {"status": "processing"}})
        if self.path.startswith("/files/"):
            name = os.path.basename(self.path.split("?")[0])
            p = os.path.join(FILES, name)
            if not os.path.exists(p):
                return self._send(404, {"error": "no file"})
            data = open(p, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            self.wfile.write(data)
            return
        if self.path in ("/health", "/"):
            return self._send(200, {
                "ok": True,
                # 运行目录排查：确认健康检查背后的进程用的就是项目里的这份脚本
                "script": os.path.abspath(__file__),
                "pid": os.getpid(),
                "tasks": len(TASKS),
                "canvases": {tier: "x".join(str(v) for v in resolve_canvas(tier, "16:9"))
                             for tier in ("480p", "720p", "1080p")},
            })
        return self._send(404, {"error": "not found"})


if __name__ == "__main__":
    load_state()
    print(f"MiniMax-compatible shim on :{PORT} -> ComfyUI {COMFY}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
