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
import hashlib, json, os, re, shutil, subprocess, tempfile, time, uuid
import urllib.error, urllib.request, urllib.parse, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COMFY = "http://127.0.0.1:8188"
PORT = 8190
HERE = os.path.dirname(os.path.abspath(__file__))

# H3 画布必须是 32 的倍数（VAE ÷16 后再 2×2 patch），否则 patchify_video 直接报错
CANVAS_STRIDE = 32
DEFAULT_RATIO = 16 / 9

# H3 只接受 5+17k 帧；24fps 下覆盖 0.21s .. 15.08s
FRAME_GRID = [5 + 17 * k for k in range(22)]

# 参考图处理长边上限：超过 1024 只会拖慢编码，对身份保持没有额外收益
REF_MAX_CAP = 1024

# 上行慢链路保护：大图先压到长边内再上传；超时后先校验服务端是否已落盘再重试
UPLOAD_TIMEOUT = float(os.environ.get("H3_UPLOAD_TIMEOUT", "600"))
UPLOAD_RETRIES = 1
UPLOAD_RETRY_DELAY = 2
COMPRESS_MIN_BYTES = 400 * 1024
UPLOAD_CACHE_PATH = os.path.join(HERE, "upload_cache.json")
UPLOAD_CACHE = {}
UPLOAD_CACHE_LIMIT = 500
UPLOAD_LOCK = threading.Lock()

# 质量档：preview 用 4 步 LoRA 快速迭代，final 用 8 步 LoRA 交付
QUALITY_PRESETS = {
    "preview": {
        "lora": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
        "steps": 4,
    },
    "final": {
        "lora": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
        "steps": 8,
    },
}
DEFAULT_QUALITY = "preview"

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

# 全局音频指令：H3 音画同生成，对白/环境音只能在这里下要求。
# 只有提示词里真的描述了画外音旁白时才允许旁白，否则模型会自行加旁白。
# 明确「无背景音乐」是给后期 BGM 留空间，避免模型自带音乐盖住人声。
# 注意：分段模式下节点只用 segments[].prompt，global_prompt 只是兜底，
# 所以真正生效的是下面 with_audio_directive 拼进每段提示词的那一行。
AUDIO_DIRECTIVE = (
    "Audio: clear, intelligible Mandarin dialogue with accurate lip sync, natural ambience, "
    "no voice-over narration unless the prompt explicitly describes an off-screen narrator, "
    "no background music, no subtitles, no captions, no on-screen text."
)
# 后期配音模式：不生成可辨识人声，但保留说话口型，方便后期对轨
AMBIENT_DIRECTIVE = (
    "Audio: ambient sound only, no intelligible speech, no dialogue, no voice-over, "
    "no background music; characters may move their mouths and gesture as if speaking, "
    "but their speech must stay unintelligible. "
    "No subtitles, no captions, no on-screen text."
)
# 静音模式：连音轨都不要（CreateVideo 也不接 audio 输入），留给后期整轨配音
SILENT_DIRECTIVE = (
    "Audio: silent video, no audio track at all; no speech, no dialogue, no voice-over, "
    "no ambience, no sound effects, no background music; characters do not speak and keep their mouths closed. "
    "No subtitles, no captions, no on-screen text."
)
GLOBAL_PROMPT = (
    "Natural synchronized audio: clear, intelligible Mandarin dialogue with accurate lip sync, "
    "natural ambience, no voice-over narration unless the prompt explicitly describes an off-screen narrator, "
    "no background music, no subtitles, no on-screen text."
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
    if text.startswith(directive):
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


def load_upload_cache():
    try:
        data = json.load(open(UPLOAD_CACHE_PATH))
    except Exception:
        return
    if isinstance(data, dict):
        UPLOAD_CACHE.update({k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)})


def save_upload_cache():
    try:
        items = list(UPLOAD_CACHE.items())[-UPLOAD_CACHE_LIMIT:]
        tmp = UPLOAD_CACHE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(dict(items), f, ensure_ascii=False)
        os.replace(tmp, UPLOAD_CACHE_PATH)
    except Exception as e:
        print("[shim] save_upload_cache failed", e, flush=True)


def _sips_convert(raw, max_edge, src_ext=".png"):
    """macOS 自带 sips 压成 JPEG；失败返回 None 由调用方回退原图"""
    sips = shutil.which("sips")
    if not sips:
        return None
    try:
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, "in" + src_ext)
            dst = os.path.join(td, "out.jpg")
            with open(src, "wb") as f:
                f.write(raw)
            subprocess.run(
                [sips, "-Z", str(int(max_edge)), "--setProperty", "format", "jpeg",
                 "--setProperty", "formatOptions", "88", src, "--out", dst],
                check=True, capture_output=True, timeout=30,
            )
            if not os.path.exists(dst):
                return None
            with open(dst, "rb") as f:
                return f.read()
    except Exception as e:
        print(f"[shim] sips compress failed: {type(e).__name__}: {e}", flush=True)
        return None


def prepare_image(raw, ctype, max_edge):
    """上传前压缩：大图压到长边内，小图/非图片原样返回"""
    ctype = (ctype or "").split(";")[0].strip().lower()
    if "jpeg" in ctype or "jpg" in ctype:
        ext = ".jpg"
    elif "webp" in ctype:
        ext = ".webp"
    elif "bmp" in ctype:
        ext = ".bmp"
    else:
        ext = ".png"
    if not ctype.startswith("image/") or len(raw) <= COMPRESS_MIN_BYTES:
        return raw, ctype or "application/octet-stream", ext
    out = _sips_convert(raw, max_edge, ext)
    if out and len(out) < len(raw):
        return out, "image/jpeg", ".jpg"
    return raw, ctype, ext


def remote_input_exists(name):
    """HEAD /view 轻量校验 ComfyUI input 里是否已有同名文件（不下正文）"""
    q = urllib.parse.urlencode({"filename": name, "subfolder": "", "type": "input"})
    req = urllib.request.Request(f"{COMFY}/view?{q}", method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        return 200 <= e.code < 300
    except Exception:
        return False


def post_upload(data, name, ctype, timeout=None):
    boundary = "----mm" + uuid.uuid4().hex
    body = b""
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n".encode()
    body += f"Content-Type: {ctype}\r\n\r\n".encode()
    body += data + b"\r\n"
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n".encode()
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(COMFY + "/upload/image", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=timeout or UPLOAD_TIMEOUT) as r:
        return json.loads(r.read().decode())["name"]


def upload_image(url, max_edge=REF_MAX_CAP):
    """把外部图片压缩后上传到 ComfyUI input，返回文件名；同内容复用已上传文件"""
    raw, ctype = fetch_bytes(url)
    data, ctype, ext = prepare_image(raw, ctype, max_edge)
    key = hashlib.sha256(data).hexdigest()
    with UPLOAD_LOCK:
        cached = UPLOAD_CACHE.get(key)
        if cached and remote_input_exists(cached):
            print(f"[shim] upload cache hit {cached} ({len(data) / 1024:.0f}KB)", flush=True)
            return cached
        name = f"mm_{uuid.uuid4().hex[:10]}{ext}"
        last_error = None
        for attempt in range(UPLOAD_RETRIES + 1):
            started = time.time()
            try:
                stored = post_upload(data, name, ctype, timeout=UPLOAD_TIMEOUT)
                took = time.time() - started
                rate = len(data) / 1024 / took if took > 0 else 0
                print(f"[shim] uploaded {stored} {len(data) / 1024:.0f}KB in {took:.1f}s ({rate:.0f}KB/s)",
                      flush=True)
                UPLOAD_CACHE[key] = stored
                save_upload_cache()
                return stored
            except urllib.error.HTTPError as e:
                last_error = e
                print(f"[shim] upload rejected {name}: HTTP {e.code}", flush=True)
                break
            except (OSError, ValueError) as e:
                last_error = e
                took = time.time() - started
                print(f"[shim] upload attempt {attempt + 1} failed after {took:.1f}s: "
                      f"{type(e).__name__}: {e}", flush=True)
                # 客户端超时后服务端可能已收完整文件：先校验再重试
                if remote_input_exists(name):
                    UPLOAD_CACHE[key] = name
                    save_upload_cache()
                    print(f"[shim] upload recovered after timeout {name}", flush=True)
                    return name
                if attempt < UPLOAD_RETRIES:
                    time.sleep(UPLOAD_RETRY_DELAY)
        raise RuntimeError(
            f"上传参考图失败（{len(data) / 1024:.0f}KB，单次超时 {UPLOAD_TIMEOUT:.0f}s）："
            f"{type(last_error).__name__}: {last_error}；请检查到 ComfyUI 的上行带宽或 SSH 隧道"
        )


load_upload_cache()


def parse_content(content):
    """解析 MiniMax content[]；不支持的素材类型直接报错，绝不静默丢弃"""
    prompt = "".join(c.get("text", "") for c in content if c.get("type") == "text").strip()
    first = last = None
    ref_urls = []
    for c in content:
        kind = c.get("type")
        if kind == "text":
            continue
        if kind == "audio_url":
            raise ValueError("本地 H3 兼容层暂不支持参考音频（reference_audio）")
        if kind == "video_url":
            raise ValueError("本地 H3 兼容层暂不支持参考视频（reference_video）")
        if kind != "image_url":
            raise ValueError(f"本地 H3 兼容层暂不支持素材类型 {kind}")
        u = (c.get("image_url") or {}).get("url")
        role = c.get("role")
        if role == "first_frame" and not first:
            first = u
        elif role == "last_frame" and not last:
            last = u
        elif role in ("reference_image", None):
            ref_urls.append(u)
    return prompt, first, last, ref_urls


def capabilities():
    """本地 shim 的真实能力，供后端/前端握手，避免按云端能力误判"""
    return {
        "audioModes": ["native", "ambient", "silent"],
        "referenceImages": 9,
        "referenceVideos": 0,
        "referenceAudios": 0,
        "firstLastFrame": True,
        "frameGrid": list(FRAME_GRID),
        "durationRange": [round(FRAME_GRID[0] / 24.0, 3), round(FRAME_GRID[-1] / 24.0, 3)],
        "qualities": list(QUALITY_PRESETS.keys()),
        "defaultQuality": DEFAULT_QUALITY,
        "qualitySteps": {name: preset["steps"] for name, preset in QUALITY_PRESETS.items()},
        "negativePrompt": True,
        "seed": True,
        "cfg": True,
        "refMaxSize": REF_MAX_CAP,
    }


def frames_for(duration):
    """把请求时长吸附到最近的 5+17k 帧网格点（24fps）"""
    try:
        seconds = float(5 if duration in (None, "") else duration)
    except (TypeError, ValueError):
        seconds = 5.0
    raw = int(round(seconds * 24))
    k = int(round((raw - 5) / 17))
    k = max(0, min(len(FRAME_GRID) - 1, k))
    return FRAME_GRID[k]


def normalize_quality(value):
    quality = str(value or "").strip().lower()
    return quality if quality in QUALITY_PRESETS else DEFAULT_QUALITY


def build_graph(prompt, first_name, last_name, frames, seed, ref_names=None, size=None,
                audio_mode="native", quality=DEFAULT_QUALITY, negative=None, cfg=1.0):
    ref_names = ref_names or []
    width, height = size or (864, 480)
    long_edge = max(width, height)
    ref_max = min(REF_MAX_CAP, long_edge)
    preset = QUALITY_PRESETS[normalize_quality(quality)]
    negative = (str(negative).strip() if negative is not None else "") or NEG
    try:
        cfg = min(5.0, max(0.5, float(cfg)))
    except (TypeError, ValueError):
        cfg = 1.0
    mode = str(audio_mode or "native").strip().lower()
    prompt = with_audio_directive(prompt, mode)
    global_prompt = {"ambient": AMBIENT_DIRECTIVE, "silent": SILENT_DIRECTIVE}.get(mode, GLOBAL_PROMPT)
    r2v = bool(ref_names) and not first_name
    t2v = (not first_name) and not r2v
    si = None if t2v else {"imageFile": first_name, "width": 0, "height": 0}
    ei = {"imageFile": last_name, "width": 0, "height": 0} if last_name else None
    shot = {"id": "s0", "durationSec": frames / 24.0, "prompt": prompt, "negativePrompt": negative,
            "continuityFromPrev": False, "loras": [], "startImage": si, "endImage": ei}
    seg = {"id": "s0", "start": 0, "length": frames, "frameCount": frames, "durationSec": frames / 24.0,
           "prompt": prompt, "negativePrompt": negative, "continuityFromPrev": False, "loras": [],
           "isStartFrame": bool(si), "isEndFrame": bool(ei), "genImage": si or {"imageFile": ""}, "endImage": ei, "taskType": "",
           "refs": [{"index": i, "imageFile": n} for i, n in enumerate(ref_names)]}
    tl = {"version": 4, "editMode": "segment", "timelineMode": ("r2v" if r2v else ("t2v" if t2v else "fl2v")), "totalFrames": frames, "frameRate": 24.0,
          "width": width, "height": height, "refMaxSize": ref_max,
          "output": {"mode": "fixed", "longEdge": long_edge, "width": width, "height": height, "maxExportFrames": 0,
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
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": preset["lora"], "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "6": {"class_type": "MiniMaxH3Director", "inputs": {
            "model": ["2", 0], "video_vae": ["4", 0], "audio_vae": ["5", 0], "clip": ["3", 0],
            "task_type": ("r2v — 参考主体生视频(Reference to Video)" if r2v else ("t2v — 文生视频(Text to Video)" if t2v else "fl2v — 首尾帧生视频(First-Last Frame)")),
            "global_prompt": global_prompt,
            "cfg": cfg, "bd_grp_sample": "采样设置", "bd_grp_advanced": "高级采样 Advanced", "bd_grp_perf": "性能 Performance",
            "frame_rate": 24.0, "width": width, "height": height, "ref_max_size": ref_max,
            "total_frames": frames, "timeline_data": json.dumps(tl, ensure_ascii=False),
            "steps": preset["steps"], "sampler": "euler", "scheduler": "beta", "shift_video": 12.0, "shift_audio": 3.0,
            "seed": seed, "clear_vram_between_segments": True}},
        "7": create_video,
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0], "filename_prefix": f"mm/{seed}", "format": "auto", "codec": "auto"}},
    }


def worker(task_id, prompt, first_url, last_url, frames, ref_urls=None, size=None, audio_mode="native",
           quality=DEFAULT_QUALITY, seed=None, negative=None, cfg=1.0):
    try:
        width, height = size or (864, 480)
        frame_cap = max(width, height)
        ref_cap = min(REF_MAX_CAP, frame_cap)
        first_name = upload_image(first_url, frame_cap) if first_url else None
        last_name = upload_image(last_url, frame_cap) if last_url else None
        ref_names = [upload_image(u, ref_cap) for u in (ref_urls or []) if u][:9]
        try:
            seed = int(seed) if seed not in (None, "") else int(uuid.uuid4().int % 2_000_000_000)
        except (TypeError, ValueError):
            seed = int(uuid.uuid4().int % 2_000_000_000)
        seed = abs(seed) % 2_147_483_647
        graph = build_graph(prompt, first_name, last_name, frames, seed, ref_names, size, audio_mode,
                            quality=quality, negative=negative, cfg=cfg)
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
        try:
            prompt, first, last, ref_urls = parse_content(content)
        except ValueError as exc:
            return self._send(400, {"error": str(exc)})
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
        quality = normalize_quality(body.get("quality"))
        negative = str(body.get("negative_prompt") or "").strip() or None
        seed = body.get("seed")
        cfg = body.get("cfg")
        task_id = uuid.uuid4().hex
        with LOCK:
            TASKS[task_id] = {"state": "processing", "url": None, "error": None, "pid": None,
                              "frames": frames, "duration": frames / 24.0}
        save_state()
        print(f"[shim] task {task_id[:8]} canvas={size[0]}x{size[1]} "
              f"resolution={resolution or '-'} ratio={ratio or '-'} audio={audio_mode} "
              f"frames={frames} quality={quality} seed={seed or 'random'} duration={body.get('duration')}", flush=True)
        threading.Thread(target=worker, args=(task_id, prompt, first, last, frames, ref_urls, size, audio_mode),
                         kwargs={"quality": quality, "seed": seed, "negative": negative, "cfg": cfg},
                         daemon=True).start()
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
                "capabilities": capabilities(),
                "canvases": {tier: "x".join(str(v) for v in resolve_canvas(tier, "16:9"))
                             for tier in ("480p", "720p", "1080p")},
            })
        return self._send(404, {"error": "not found"})


if __name__ == "__main__":
    load_state()
    print(f"MiniMax-compatible shim on :{PORT} -> ComfyUI {COMFY}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
