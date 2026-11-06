#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""火宝 H3 网关：服务端常驻的 MiniMax v2 / OpenAI Images 兼容接口。

- 视频：POST /v2/video_generation + GET /v2/query/video_generation/<id>
- 图片：POST /v1/images/generations | /v1/images/edits + GET /v1/images/task/<id>
- 产物：GET /files/<name>?expires=&sig=（HMAC 签名，下载不带 Authorization）
- ComfyUI：/comfyui/* 受控反向代理（Bearer 或 ?token=）
- 工作流：H3_WORKFLOW_DIR 下的 manifest.json + ComfyUI API 格式模板

只依赖 Python 标准库；单 GPU 队列顺序执行；任务与产物落盘。
"""
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import queue
import re
import select
import shutil
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from email import policy as email_policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from admin.db import GatewayStore, hash_api_key, public_workflow

VERSION = "1.0.0"
SERVICE = "huobao-h3-gateway"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

CANVAS_STRIDE = 32
DEFAULT_RATIO = 16 / 9
FRAME_GRID = [5 + 17 * k for k in range(22)]
MAX_REF_IMAGES = 9
MAX_REFERENCE_BYTES = 32 * 1024 * 1024

RESOLUTION_SHORT_EDGE = {
    "480p": 480, "480": 480, "sd": 480,
    "720p": 768, "720": 768, "768p": 768, "768": 768, "hd": 768,
    "1080p": 1080, "1080": 1080, "2k": 1080, "fhd": 1080,
}

AUDIO_LINE_RE = re.compile(r"(?im)^\s*(?:音频|audio)\s*[：:].*(?:\n|$)")
PLACEHOLDER_RE = re.compile(r"__[A-Z0-9_]+__")
TASK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
HOST_RE = re.compile(r"^[A-Za-z0-9.\-:\[\]]+$")

MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

TERMINAL_STATES = ("succeeded", "failed", "cancelled")
PERSIST_FIELDS = (
    "id", "kind", "mode", "state", "created_at", "updated_at", "pid", "file",
    "duration", "error", "warning", "response_format", "frames", "width",
    "height", "quality", "workflow", "workflow_kind", "output_node",
    "output_key", "output_exts",
)
DEFAULT_WORKFLOW_EXTS = {
    "video": [".mp4", ".webm"],
    "image": [".png", ".jpg", ".jpeg", ".webp"],
    "audio": [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"],
}


def log(message):
    print(f"[h3-gateway] {message}", flush=True)


class BadRequest(Exception):
    pass


class PayloadTooLarge(Exception):
    pass


class Unauthorized(Exception):
    pass


class QueueFull(Exception):
    pass


class NotFound(Exception):
    pass


class ComfyError(Exception):
    pass


class Cancelled(Exception):
    pass


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

class Settings:
    def __init__(self, **values):
        self.host = "0.0.0.0"
        self.port = 8192
        self.token = ""
        self.sign_key = b""
        self.comfy_url = "http://127.0.0.1:8188"
        self.workflow_dir = os.path.join(SCRIPT_DIR, "workflows")
        self.data_dir = os.path.join(SCRIPT_DIR, "data")
        self.db_path = os.path.join(self.data_dir, "gateway.db")
        self.public_base_url = ""
        self.workers = 1
        self.queue_limit = 32
        self.max_body_bytes = 64 * 1024 * 1024
        self.sign_ttl = 3600
        self.ui_session_ttl = 43200
        self.retention_days = 7
        self.upstream_timeout = 1800
        self.upload_timeout = 600
        self.poll_interval = 2.0
        for key, value in values.items():
            setattr(self, key, value)

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env

        def text(name, default=""):
            raw = env.get(name)
            return default if raw in (None, "") else str(raw).strip()

        def number(name, default, minimum=0, cast=int):
            raw = env.get(name)
            if raw in (None, ""):
                return default
            try:
                value = cast(raw)
            except (TypeError, ValueError):
                return default
            return max(minimum, value)

        token = text("H3_GATEWAY_TOKEN")
        sign_raw = text("H3_GATEWAY_SIGN_KEY")
        sign_key = sign_raw.encode() if sign_raw else hashlib.sha256(
            f"h3-gateway:{token}".encode()
        ).digest()
        data_dir = text("H3_DATA_DIR", os.path.join(SCRIPT_DIR, "data"))

        return cls(
            host=text("H3_GATEWAY_HOST", "0.0.0.0"),
            port=number("H3_GATEWAY_PORT", 8192, 1),
            token=token,
            sign_key=sign_key,
            comfy_url=text("H3_COMFY_URL", "http://127.0.0.1:8188").rstrip("/"),
            workflow_dir=text("H3_WORKFLOW_DIR", os.path.join(SCRIPT_DIR, "workflows")),
            data_dir=data_dir,
            db_path=text("H3_DB_PATH", os.path.join(data_dir, "gateway.db")),
            public_base_url=text("H3_PUBLIC_BASE_URL").rstrip("/"),
            workers=number("H3_WORKERS", 1, 0),
            queue_limit=number("H3_QUEUE_LIMIT", 32, 0),
            max_body_bytes=number("H3_MAX_BODY_BYTES", 64 * 1024 * 1024, 1024),
            sign_ttl=number("H3_SIGN_TTL", 3600, 1),
            ui_session_ttl=number("H3_UI_SESSION_TTL", 43200, 60),
            retention_days=number("H3_RETENTION_DAYS", 7, 0),
            upstream_timeout=number("H3_UPSTREAM_TIMEOUT", 1800, 1),
            upload_timeout=number("H3_UPLOAD_TIMEOUT", 600, 1),
            poll_interval=number("H3_POLL_INTERVAL", 2.0, 0.01, float),
        )


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------

def safe_error(exc):
    if isinstance(exc, ComfyError):
        return str(exc)
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code} {exc.reason}"
    if isinstance(exc, urllib.error.URLError):
        return f"网络请求失败: {exc.reason}"
    if isinstance(exc, TimeoutError):
        return "生成超时，请稍后重试"
    if isinstance(exc, (BadRequest, PayloadTooLarge, NotFound)):
        return str(exc)
    return f"{type(exc).__name__}: {exc}"


def token_ok(expected, provided):
    if not expected or not provided:
        return False
    return hmac.compare_digest(str(expected).encode(), str(provided).encode())


def media_signature(sign_key, name, expires):
    message = f"{name}:{int(expires)}".encode()
    return hmac.new(sign_key, message, hashlib.sha256).hexdigest()


def ui_session_ticket(sign_key, expires):
    """ComfyUI 页面会话票据：放在 URL 路径里，静态资源/API/WS 自动携带。"""
    message = f"comfyui-ui:{int(expires)}".encode()
    digest = hmac.new(sign_key, message, hashlib.sha256).hexdigest()
    return f"{int(expires)}.{digest}"


def ui_session_valid(sign_key, ticket, now=None):
    try:
        expires_raw, signature = str(ticket).split(".", 1)
        expires = int(expires_raw)
    except (AttributeError, TypeError, ValueError):
        return False
    if expires <= (time.time() if now is None else now):
        return False
    try:
        provided = signature.encode("ascii")
    except UnicodeEncodeError:
        return False
    expected = hmac.new(sign_key, f"comfyui-ui:{expires}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(provided, expected.encode())


def describe_http_error(err):
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


# ---------------------------------------------------------------------------
# 画布 / 帧 / 尺寸
# ---------------------------------------------------------------------------

def snap_dimension(value):
    v = int((float(value) + CANVAS_STRIDE / 2) // CANVAS_STRIDE) * CANVAS_STRIDE
    return max(CANVAS_STRIDE, min(8192, v))


def parse_ratio(raw):
    if raw is None:
        return None
    text = str(raw).strip().lower().replace("：", ":")
    match = re.match(r"^(\d+(?:\.\d+)?)\s*[:x*/]\s*(\d+(?:\.\d+)?)$", text)
    if not match:
        return None
    width, height = float(match.group(1)), float(match.group(2))
    if width <= 0 or height <= 0:
        return None
    return width / height


def resolve_canvas(resolution=None, ratio=None):
    key = str(resolution or "").strip().lower().replace(" ", "")
    short_edge = RESOLUTION_SHORT_EDGE.get(key, 480)
    aspect = parse_ratio(ratio) or DEFAULT_RATIO
    aspect = min(max(aspect, 0.2), 5.0)
    if aspect >= 1:
        return snap_dimension(short_edge * aspect), snap_dimension(short_edge)
    return snap_dimension(short_edge), snap_dimension(short_edge / aspect)


def frames_for(duration):
    try:
        seconds = float(5 if duration in (None, "") else duration)
    except (TypeError, ValueError):
        seconds = 5.0
    raw = int(round(seconds * 24))
    k = int(round((raw - 5) / 17))
    k = max(0, min(len(FRAME_GRID) - 1, k))
    return FRAME_GRID[k]


def parse_image_size(raw, default=None):
    width, height = default or (1024, 1024)
    match = re.match(r"^\s*(\d+)\s*[xX*]\s*(\d+)\s*$", str(raw or ""))
    if match:
        width, height = int(match.group(1)), int(match.group(2))
    width = max(256, min(2048, (width // 8) * 8))
    height = max(256, min(2048, (height // 8) * 8))
    return width, height


def normalize_quality(value, presets, default):
    quality = str(value or "").strip().lower()
    return quality if quality in presets else default


def normalize_seed(raw):
    try:
        seed = int(raw)
    except (TypeError, ValueError):
        seed = 0
    if not seed:
        seed = int(uuid.uuid4().int % 2_000_000_000)
    return abs(seed) % 2_147_483_647


def normalize_cfg(raw, default, bounds):
    try:
        cfg = float(raw)
    except (TypeError, ValueError):
        cfg = float(default)
    low, high = bounds
    return min(float(high), max(float(low), cfg))


# ---------------------------------------------------------------------------
# 音频指令 / 时间线 / 工作流渲染
# ---------------------------------------------------------------------------

def strip_audio_lines(text):
    return AUDIO_LINE_RE.sub("", text or "").strip()


def with_audio_directive(prompt, audio_mode, directives):
    text = (prompt or "").strip()
    mode = str(audio_mode or "native").strip().lower()
    directive = directives.get(mode) or directives.get("native") or ""
    if mode in ("ambient", "silent"):
        text = strip_audio_lines(text)
        return f"{directive}\n{text}" if text else directive
    if not text:
        return directive
    if directive and text.startswith(directive):
        return text
    return f"{directive}\n{text}" if directive else text


def build_timeline(prompt, negative, first_name, last_name, ref_names, frames,
                   width, height, ref_max, frame_rate, task_type, mode):
    r2v = mode == "r2v"
    t2v = mode == "t2v"
    start_image = None if t2v else {"imageFile": first_name, "width": 0, "height": 0}
    end_image = {"imageFile": last_name, "width": 0, "height": 0} if last_name else None
    duration = frames / float(frame_rate)
    shot = {
        "id": "s0", "durationSec": duration, "prompt": prompt,
        "negativePrompt": negative, "continuityFromPrev": False, "loras": [],
        "startImage": start_image, "endImage": end_image,
    }
    segment = {
        "id": "s0", "start": 0, "length": frames, "frameCount": frames,
        "durationSec": duration, "prompt": prompt, "negativePrompt": negative,
        "continuityFromPrev": False, "loras": [], "isStartFrame": bool(start_image),
        "isEndFrame": bool(end_image),
        "genImage": start_image or {"imageFile": ""}, "endImage": end_image,
        "taskType": "",
        "refs": [{"index": i, "imageFile": name} for i, name in enumerate(ref_names)],
    }
    return {
        "version": 4, "editMode": "segment", "timelineMode": mode,
        "totalFrames": frames, "frameRate": float(frame_rate),
        "width": width, "height": height, "refMaxSize": ref_max,
        "output": {
            "mode": "fixed", "longEdge": max(width, height), "width": width,
            "height": height, "maxExportFrames": 0, "exportMode": "all",
            "continuityEnabled": False, "continuityOverlapFrames": 9,
        },
        "videoClips": [],
        "video": {
            "fileName": "", "videoFile": "", "subfolder": "", "type": "input",
            "frames": [], "frameMap": [],
        },
        "global": {
            "taskType": task_type, "prompt": prompt, "refs": [],
            "referenceVideo": {}, "continuousReference": False,
            "genImage": {"imageFile": ""},
        },
        "shots": [] if r2v else [shot],
        "keyframes": [], "segments": [segment],
        "gen": {"defaultFrameCount": frames},
        "runSelectEnabled": False, "runSelection": [],
    }


def render_workflow(template, values):
    if isinstance(template, dict):
        return {key: render_workflow(value, values) for key, value in template.items()}
    if isinstance(template, list):
        return [render_workflow(value, values) for value in template]
    if isinstance(template, str):
        token = template.strip()
        if PLACEHOLDER_RE.fullmatch(token) and token in values:
            return values[token]
        return PLACEHOLDER_RE.sub(
            lambda match: str(values[match.group(0)]) if match.group(0) in values else match.group(0),
            template,
        )
    return template


class WorkflowRegistry:
    def __init__(self, directory):
        self.directory = directory
        self._lock = threading.Lock()
        self._stamp = None
        self._manifest = {}
        self._templates = {}

    def _signature(self):
        names = ["manifest.json"]
        try:
            names += sorted(
                name for name in os.listdir(self.directory)
                if name.endswith(".json") and name != "manifest.json"
            )
        except OSError:
            return (("missing", self.directory),)
        parts = []
        for name in names:
            path = os.path.join(self.directory, name)
            try:
                stat = os.stat(path)
                parts.append((name, stat.st_mtime_ns, stat.st_size))
            except OSError:
                parts.append((name, None, None))
        return tuple(parts)

    def _reload(self):
        with self._lock:
            stamp = self._signature()
            if stamp == self._stamp:
                return
            manifest_path = os.path.join(self.directory, "manifest.json")
            with open(manifest_path, encoding="utf-8") as fh:
                manifest = json.load(fh)
            templates = {}
            for name in os.listdir(self.directory):
                if name.endswith(".json") and name != "manifest.json":
                    with open(os.path.join(self.directory, name), encoding="utf-8") as fh:
                        templates[name] = json.load(fh)
            self._manifest = manifest
            self._templates = templates
            self._stamp = stamp

    def manifest(self):
        self._reload()
        return self._manifest

    def template(self, name):
        self._reload()
        if name not in self._templates:
            raise ComfyError(f"服务端缺少工作流模板: {name}")
        return self._templates[name]

    def modes(self):
        try:
            manifest = self.manifest()
        except Exception:
            return {"video": [], "image": []}
        return {
            "video": list((manifest.get("video") or {}).get("modes") or {}),
            "image": list((manifest.get("image") or {}).get("modes") or {}),
        }


# ---------------------------------------------------------------------------
# 素材：data URL / 公网 URL / SSRF
# ---------------------------------------------------------------------------

class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        assert_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def assert_public_url(url):
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError as exc:
        raise ValueError("参考素材地址不合法") from exc
    if parsed.scheme not in ("http", "https"):
        raise ValueError("参考素材仅支持 http(s) 地址或 data URL")
    if parsed.username or parsed.password:
        raise ValueError("参考素材地址不允许携带账号信息")
    host = parsed.hostname
    if not host:
        raise ValueError("参考素材地址缺少主机名")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"参考素材域名无法解析: {host}") from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if not address.is_global:
            raise ValueError("参考素材地址不允许访问内网或本机地址")


def decode_data_url(raw):
    if not isinstance(raw, str) or not raw.startswith("data:"):
        raise ValueError("不是合法的 data URL")
    header, sep, payload = raw.partition(",")
    if not sep:
        raise ValueError("data URL 缺少数据部分")
    meta = header[5:]
    parts = meta.split(";")
    content_type = (parts[0] or "application/octet-stream").strip().lower()
    if not content_type.startswith("image/"):
        raise ValueError("data URL 不是图片")
    is_base64 = any(part.strip().lower() == "base64" for part in parts[1:])
    try:
        data = base64.b64decode(payload, validate=False) if is_base64 else urllib.parse.unquote_to_bytes(payload)
    except Exception as exc:
        raise ValueError("data URL 解码失败") from exc
    if len(data) > MAX_REFERENCE_BYTES:
        raise ValueError("参考图片过大")
    return data, content_type


def is_image_bytes(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return True
    if data.startswith(b"\xff\xd8"):
        return True
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return True
    if data.startswith(b"BM"):
        return True
    return data[:6] in (b"GIF87a", b"GIF89a")


def image_extension(data, content_type="", fallback_url=""):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8"):
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data.startswith(b"BM"):
        return ".bmp"
    ctype = (content_type or "").split(";")[0].strip().lower()
    if "jpeg" in ctype or "jpg" in ctype:
        return ".jpg"
    if "webp" in ctype:
        return ".webp"
    if "bmp" in ctype:
        return ".bmp"
    if "png" in ctype:
        return ".png"
    suffix = os.path.splitext(urllib.parse.urlsplit(fallback_url or "").path)[1].lower()
    return suffix if suffix in (".png", ".jpg", ".jpeg", ".webp", ".bmp") else ".png"


def content_type_for_extension(ext):
    return {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".bmp": "image/bmp",
    }.get(ext.lower(), "application/octet-stream")


def parse_multipart(body, content_type):
    if "multipart/form-data" not in (content_type or "").lower():
        raise BadRequest("请求必须为 multipart/form-data")
    raw = (
        b"Content-Type: " + content_type.encode("latin-1", "replace")
        + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    try:
        message = BytesParser(policy=email_policy.default).parsebytes(raw)
    except Exception as exc:
        raise BadRequest("multipart 解析失败") from exc
    if not message.is_multipart():
        raise BadRequest("multipart 解析失败")
    fields, files = {}, []
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition") or ""
        filename = part.get_filename()
        data = part.get_payload(decode=True) or b""
        if filename is not None:
            files.append({
                "field": name,
                "filename": filename,
                "content_type": part.get_content_type(),
                "data": data,
            })
        else:
            fields[name] = data.decode("utf-8", "replace").strip()
    return fields, files


def parse_video_content(content):
    if content is None:
        content = []
    if not isinstance(content, list):
        raise ValueError("content 必须为数组")
    prompt_parts, first, last, refs = [], None, None, []
    for item in content:
        if not isinstance(item, dict):
            raise ValueError("content 中的每一项必须为对象")
        kind = item.get("type")
        if kind == "text":
            prompt_parts.append(str(item.get("text") or ""))
            continue
        if kind == "audio_url":
            raise ValueError("本地 H3 网关暂不支持参考音频（reference_audio）")
        if kind == "video_url":
            raise ValueError("本地 H3 网关暂不支持参考视频（reference_video）")
        if kind != "image_url":
            raise ValueError(f"本地 H3 网关暂不支持素材类型 {kind}")
        image = item.get("image_url")
        url = image.get("url") if isinstance(image, dict) else image
        if not url:
            raise ValueError("image_url 缺少 url")
        role = item.get("role")
        if role == "first_frame" and not first:
            first = url
        elif role == "last_frame" and not last:
            last = url
        elif role in ("reference_image", None):
            refs.append(url)
    return "".join(prompt_parts).strip(), first, last, refs


# ---------------------------------------------------------------------------
# 命名工作流：输入校验与节点注入
# ---------------------------------------------------------------------------

def input_targets(spec):
    targets = spec.get("targets") if isinstance(spec, dict) else None
    if isinstance(targets, list):
        return [item for item in targets if isinstance(item, dict)]
    return [{"node": (spec or {}).get("node"), "input": (spec or {}).get("input")}]


def coerce_input_value(kind, value):
    if kind == "text":
        return str(value)
    if kind == "json":
        if not isinstance(value, (dict, list)):
            raise ValueError("必须是 JSON 对象或数组")
        return json.dumps(value, ensure_ascii=False)
    if kind == "integer":
        if isinstance(value, bool):
            raise ValueError("必须是整数")
        number = float(value)
        if not number.is_integer():
            raise ValueError("必须是整数")
        return int(number)
    if kind == "number":
        if isinstance(value, bool):
            raise ValueError("必须是数字")
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, str) and re.fullmatch(r"-?\d+", value.strip()):
            return int(value.strip())
        return float(value)
    if kind == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)) and value in (0, 1):
            return bool(value)
        if isinstance(value, str) and value.strip().lower() in ("true", "false", "1", "0"):
            return value.strip().lower() in ("true", "1")
        raise ValueError("必须是布尔值")
    return str(value)


def validate_job_inputs(row, inputs):
    mapping = row.get("input_map") or {}
    for name, spec in mapping.items():
        if not isinstance(spec, dict):
            continue
        required = not bool(spec.get("optional"))
        value = inputs.get(name)
        if value is None or (isinstance(value, str) and not value.strip()):
            if required:
                raise BadRequest(f"缺少输入: {name}")
            continue
        kind = str(spec.get("type") or "text")
        if kind == "image":
            if not isinstance(value, str):
                raise BadRequest(f"输入 {name} 必须是图片 data URL 或 http(s) 地址")
            continue
        try:
            coerce_input_value(kind, value)
        except (TypeError, ValueError) as exc:
            raise BadRequest(f"输入 {name} {exc}") from exc


def build_job_graph(row, inputs, upload_image):
    try:
        graph = json.loads(json.dumps(row.get("workflow") or {}, ensure_ascii=False))
    except (TypeError, ValueError) as exc:
        raise ComfyError("工作流 JSON 已损坏，请在管理端重新保存") from exc
    mapping = row.get("input_map") or {}
    for name, spec in mapping.items():
        if not isinstance(spec, dict):
            continue
        value = inputs.get(name)
        if value is None or (isinstance(value, str) and not value.strip()):
            if spec.get("optional"):
                continue
            raise BadRequest(f"缺少输入: {name}")
        kind = str(spec.get("type") or "text")
        if kind == "image":
            value = upload_image(value)
        else:
            try:
                value = coerce_input_value(kind, value)
            except (TypeError, ValueError) as exc:
                raise BadRequest(f"输入 {name} {exc}") from exc
        for target in input_targets(spec):
            node = graph.get(str(target.get("node") or ""))
            if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
                raise ComfyError(f"输入映射 {name} 指向的节点 {target.get('node')} 不存在")
            node["inputs"][target.get("input")] = value
    return graph


# ---------------------------------------------------------------------------
# 网关
# ---------------------------------------------------------------------------

class Gateway:
    def __init__(self, settings):
        self.settings = settings
        self.registry = WorkflowRegistry(settings.workflow_dir)
        self.store = GatewayStore(settings.db_path)
        self._cancelled = set()
        self._cancel_lock = threading.Lock()
        self.files_dir = os.path.join(settings.data_dir, "files")
        self.tasks_path = os.path.join(settings.data_dir, "tasks.json")
        os.makedirs(self.files_dir, exist_ok=True)

        self.tasks = {}
        self._jobs = {}
        self._lock = threading.RLock()
        self._queue = queue.Queue()
        self._stop = threading.Event()
        self._uploaded = set()
        self._upload_lock = threading.Lock()
        self._comfy_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self._ref_opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _SafeRedirectHandler()
        )
        self._comfy_health = (0.0, False)
        self._health_lock = threading.Lock()

        self._load_tasks()
        self._workers = [
            threading.Thread(target=self._worker_loop, name=f"h3-worker-{i}", daemon=True)
            for i in range(settings.workers)
        ]
        for worker in self._workers:
            worker.start()
        self._cleanup_thread = threading.Thread(
            target=self._cleanup_loop, name="h3-cleanup", daemon=True
        )
        self._cleanup_thread.start()

    # -- 任务存储 ---------------------------------------------------------

    def auth_ok(self, provided):
        """环境变量 Token 或管理端签发的 API Key 均可访问业务接口。"""
        if not provided:
            return False
        if token_ok(self.settings.token, provided):
            return True
        digest = hash_api_key(provided)
        if digest in self.store.api_key_hashes():
            self.store.touch_api_key(digest)
            return True
        return False

    def _persist_locked(self):
        records = [
            {field: task.get(field) for field in PERSIST_FIELDS}
            for task in self.tasks.values()
        ]
        tmp = self.tasks_path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(records, fh, ensure_ascii=False)
            os.replace(tmp, self.tasks_path)
        except OSError as exc:
            log(f"save tasks failed: {type(exc).__name__}")

    def _load_tasks(self):
        try:
            with open(self.tasks_path, encoding="utf-8") as fh:
                records = json.load(fh)
        except (OSError, ValueError):
            return
        if not isinstance(records, list):
            return
        resume = []
        changed = False
        for record in records:
            if not isinstance(record, dict) or not record.get("id"):
                continue
            task = {field: record.get(field) for field in PERSIST_FIELDS}
            state = task.get("state")
            if state in ("queued",):
                task.update(state="failed", error="网关重启，请重新提交任务")
                changed = True
            elif state == "processing":
                if task.get("pid"):
                    resume.append(task["id"])
                else:
                    task.update(state="failed", error="网关重启，任务未提交，请重新提交")
                    changed = True
            elif state == "succeeded":
                filename = task.get("file") or ""
                path = os.path.join(self.files_dir, filename)
                if not filename or os.path.basename(filename) != filename or not os.path.isfile(path):
                    task.update(state="failed", error="产物已过期或丢失，请重新生成")
                    changed = True
            self.tasks[task["id"]] = task
        if changed:
            with self._lock:
                self._persist_locked()
        for task_id in resume:
            if task_id in self.tasks:
                threading.Thread(target=self._resume, args=(task_id,), daemon=True).start()

    def _update(self, task_id, **fields):
        with self._lock:
            task = self.tasks.get(task_id)
            if not task:
                return
            task.update(fields)
            task["updated_at"] = time.time()
            self._persist_locked()

    def get_task(self, task_id):
        with self._lock:
            return dict(self.tasks[task_id]) if task_id in self.tasks else None

    def _fail(self, task_id, exc):
        message = safe_error(exc)
        self._update(task_id, state="failed", error=message)
        log(f"task {task_id[:8]} failed ({type(exc).__name__})")

    def enqueue(self, kind, mode, payload, **meta):
        task_id = uuid.uuid4().hex
        now = time.time()
        task = {
            "id": task_id, "kind": kind, "mode": mode, "state": "queued",
            "created_at": now, "updated_at": now, "pid": None, "file": None,
            "duration": meta.get("duration"), "error": None,
            "warning": meta.get("warning"), "response_format": meta.get("response_format", "url"),
            "frames": meta.get("frames"), "width": meta.get("width"),
            "height": meta.get("height"), "quality": meta.get("quality"),
            "workflow": meta.get("workflow"), "workflow_kind": meta.get("workflow_kind"),
            "output_node": meta.get("output_node"), "output_key": meta.get("output_key"),
            "output_exts": meta.get("output_exts"),
        }
        with self._lock:
            if self._queue.qsize() >= self.settings.queue_limit:
                raise QueueFull("生成队列已满，请稍后重试")
            self.tasks[task_id] = task
            self._jobs[task_id] = payload
            self._persist_locked()
            self._queue.put(task_id)
        return task_id

    def _worker_loop(self):
        while not self._stop.is_set():
            try:
                task_id = self._queue.get(timeout=0.3)
            except queue.Empty:
                continue
            try:
                if task_id is None:
                    return
                with self._lock:
                    task = self.tasks.get(task_id)
                    payload = self._jobs.pop(task_id, None)
                if not task or task.get("state") != "queued" or payload is None:
                    continue
                self._update(task_id, state="processing")
                try:
                    if task["kind"] == "workflow":
                        self._run_workflow(task_id, payload)
                    elif task["kind"] == "video":
                        self._run_video(task_id, payload)
                    else:
                        self._run_image(task_id, payload)
                except Cancelled:
                    self._update(task_id, state="cancelled", error="已取消")
                except Exception as exc:  # noqa: BLE001 - 任务失败必须落状态
                    self._fail(task_id, exc)
            finally:
                self._queue.task_done()

    def close(self):
        self._stop.set()
        for _ in self._workers:
            self._queue.put(None)
        for worker in getattr(self, "_workers", []):
            worker.join(timeout=2)
        cleanup = getattr(self, "_cleanup_thread", None)
        if cleanup:
            cleanup.join(timeout=2)

    # -- ComfyUI ---------------------------------------------------------

    def _comfy_url(self, path):
        base = self.store.get_setting("comfy_url") or self.settings.comfy_url
        return base.rstrip("/") + path

    def _comfy_json(self, path, payload=None, timeout=120):
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            self._comfy_url(path), data=data,
            headers={"Content-Type": "application/json"},
            method="POST" if data is not None else "GET",
        )
        try:
            with self._comfy_opener.open(request, timeout=timeout) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            raise ComfyError(describe_http_error(exc)) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise ComfyError(f"ComfyUI 不可达: {getattr(exc, 'reason', exc)}") from exc
        except ValueError as exc:
            raise ComfyError("ComfyUI 返回了非 JSON 响应") from exc

    def _comfy_bytes(self, path, timeout=600):
        request = urllib.request.Request(self._comfy_url(path))
        try:
            with self._comfy_opener.open(request, timeout=timeout) as response:
                return response.read(), response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            raise ComfyError(describe_http_error(exc)) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise ComfyError(f"ComfyUI 不可达: {getattr(exc, 'reason', exc)}") from exc

    def _post_upload(self, data, name, content_type):
        boundary = "----h3" + uuid.uuid4().hex
        body = b"".join([
            f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\n'.encode(),
            f"Content-Type: {content_type}\r\n\r\n".encode(),
            data, b"\r\n",
            f'--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'.encode(),
            f"--{boundary}--\r\n".encode(),
        ])
        request = urllib.request.Request(
            self._comfy_url("/upload/image"), data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        try:
            with self._comfy_opener.open(request, timeout=self.settings.upload_timeout) as response:
                result = json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            raise ComfyError(describe_http_error(exc)) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise ComfyError(f"ComfyUI 不可达: {getattr(exc, 'reason', exc)}") from exc
        stored = result.get("name") if isinstance(result, dict) else None
        if not stored:
            raise ComfyError("ComfyUI 上传参考图失败：响应缺少文件名")
        return stored

    def _upload_bytes(self, data, content_type):
        if not data:
            raise ValueError("参考图片为空")
        ext = image_extension(data, content_type)
        name = f"h3_{hashlib.sha256(data).hexdigest()[:20]}{ext}"
        with self._upload_lock:
            if name in self._uploaded:
                return name
            self._post_upload(data, name, content_type_for_extension(ext) or content_type or "image/png")
            self._uploaded.add(name)
            if len(self._uploaded) > 500:
                self._uploaded = set(list(self._uploaded)[-500:])
        return name

    def _upload_source(self, source):
        if isinstance(source, str) and source.startswith("data:"):
            data, content_type = decode_data_url(source)
        elif isinstance(source, str) and source.lower().startswith(("http://", "https://")):
            data, content_type = self._fetch_public(source)
        else:
            raise ValueError("参考素材仅支持 data URL 或公网 http(s) 地址")
        if not is_image_bytes(data):
            raise ValueError("参考素材不是图片")
        return self._upload_bytes(data, content_type)

    def _fetch_public(self, url):
        assert_public_url(url)
        request = urllib.request.Request(url, headers={"User-Agent": f"{SERVICE}/{VERSION}"})
        try:
            with self._ref_opener.open(request, timeout=120) as response:
                content_type = response.headers.get("Content-Type", "")
                data = response.read(MAX_REFERENCE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raise ValueError(f"参考图片下载失败: HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise ValueError(f"参考图片下载失败: {exc.reason}") from exc
        if len(data) > MAX_REFERENCE_BYTES:
            raise ValueError("参考图片过大")
        return data, content_type

    def _wait_history(self, prompt_id, should_stop=None):
        deadline = time.time() + self.settings.upstream_timeout
        while time.time() < deadline:
            if should_stop and should_stop():
                raise Cancelled()
            history = self._comfy_json(f"/history/{prompt_id}", timeout=30)
            if prompt_id in history:
                return history[prompt_id]
            time.sleep(self.settings.poll_interval)
        raise TimeoutError("ComfyUI 执行超时")

    @staticmethod
    def _find_output(entry, extensions, node=None, key=None):
        outputs = (entry or {}).get("outputs") or {}
        node_ids = [str(node)] if node else list(outputs.keys())
        keys = [key] if key else ["images", "videos", "gifs", "audio", "audios"]
        for node_id in node_ids:
            node_output = outputs.get(node_id)
            if not isinstance(node_output, dict):
                continue
            for output_key in keys:
                for item in node_output.get(output_key) or []:
                    filename = str((item or {}).get("filename") or "")
                    if filename.lower().endswith(tuple(extensions)):
                        return item
        return None

    def _download_output(self, item, filename, timeout=600):
        query = urllib.parse.urlencode({
            "filename": item.get("filename"),
            "subfolder": item.get("subfolder", ""),
            "type": item.get("type", "output"),
        })
        data, _ = self._comfy_bytes(f"/view?{query}", timeout=timeout)
        if not data:
            raise ComfyError("ComfyUI 产物为空")
        path = os.path.join(self.files_dir, filename)
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
        return filename

    # -- 视频任务 ---------------------------------------------------------

    def _run_video(self, task_id, payload):
        started = time.time()
        manifest = self.registry.manifest()
        video = manifest.get("video") or {}
        modes = video.get("modes") or {}
        mode = payload.get("mode")
        spec = modes.get(mode)
        if not spec:
            raise ComfyError(f"工作流清单缺少视频模式: {mode}")

        task = self.get_task(task_id) or {}
        width, height = int(task.get("width") or 0), int(task.get("height") or 0)
        frames = int(task.get("frames") or 0)
        if not width or not height or not frames:
            raise ComfyError("任务缺少画布参数")
        frame_rate = int(video.get("frame_rate", 24))
        ref_cap = int(video.get("ref_max_cap", 1024))
        frame_cap = max(width, height)
        ref_max = min(ref_cap, frame_cap)
        max_refs = int(video.get("max_reference_images", MAX_REF_IMAGES))

        first_name = self._upload_source(payload["first"]) if payload.get("first") else None
        last_name = self._upload_source(payload["last"]) if payload.get("last") else None
        ref_names = [
            self._upload_source(url) for url in (payload.get("refs") or [])[:max_refs] if url
        ]

        quality = normalize_quality(
            payload.get("quality"), video.get("quality_presets") or {},
            video.get("default_quality", "preview"),
        )
        preset = (video.get("quality_presets") or {}).get(quality) or {}
        audio_mode = payload.get("audio_mode") or "native"
        directives = (video.get("audio") or {}).get("directives") or {}
        global_prompts = (video.get("audio") or {}).get("global_prompts") or {}
        prompt = with_audio_directive(payload.get("prompt") or "", audio_mode, directives)
        negative = (payload.get("negative") or "").strip() or (video.get("negative") or "")
        cfg = normalize_cfg(payload.get("cfg"), video.get("default_cfg", 1.0), video.get("cfg_range") or [0.5, 5.0])
        seed = payload["seed"]

        timeline = build_timeline(
            prompt=prompt, negative=negative, first_name=first_name,
            last_name=last_name, ref_names=ref_names, frames=frames,
            width=width, height=height, ref_max=ref_max,
            frame_rate=frame_rate, task_type=spec.get("task_type") or mode, mode=mode,
        )
        values = {
            "__TASK_TYPE__": spec.get("task_type") or mode,
            "__GLOBAL_PROMPT__": global_prompts.get(audio_mode) or global_prompts.get("native") or "",
            "__TIMELINE_JSON__": json.dumps(timeline, ensure_ascii=False),
            "__NEGATIVE__": negative,
            "__WIDTH__": int(width),
            "__HEIGHT__": int(height),
            "__REF_MAX__": int(ref_max),
            "__FRAMES__": int(frames),
            "__SEED__": int(seed),
            "__STEPS__": int(preset.get("steps", 4)),
            "__CFG__": float(cfg),
            "__LORA__": preset.get("lora") or "",
            "__FILENAME_PREFIX__": f"h3/{task_id}",
        }
        graph = render_workflow(self.registry.template(spec.get("workflow")), values)
        if audio_mode == "silent":
            for node in graph.values():
                if isinstance(node, dict) and node.get("class_type") == "CreateVideo":
                    (node.get("inputs") or {}).pop("audio", None)

        result = self._comfy_json("/prompt", {"prompt": graph})
        prompt_id = result.get("prompt_id") if isinstance(result, dict) else None
        if not prompt_id:
            raise ComfyError("ComfyUI 未返回 prompt_id")
        self._update(task_id, pid=prompt_id)
        log(
            f"video {task_id[:8]} submitted mode={mode} canvas={width}x{height} "
            f"frames={frames} quality={quality} seed={seed}"
        )
        entry = self._wait_history(prompt_id)
        self._finish_video(task_id, entry)
        log(f"video {task_id[:8]} done in {time.time() - started:.1f}s")

    def _finish_video(self, task_id, entry):
        error = history_error(entry)
        if error:
            self._update(task_id, state="failed", error=error)
            return
        item = self._find_output(entry, (".mp4", ".webm"))
        if not item:
            nodes = ", ".join((entry.get("outputs") or {}).keys()) or "none"
            self._update(task_id, state="failed", error=f"ComfyUI 输出中没有视频（节点: {nodes}）")
            return
        suffix = os.path.splitext(str(item.get("filename") or ""))[1].lower()
        ext = suffix if suffix in (".mp4", ".webm") else ".mp4"
        filename = f"{task_id}{ext}"
        self._download_output(item, filename)
        task = self.get_task(task_id) or {}
        frames = task.get("frames")
        duration = (frames / 24.0) if frames else task.get("duration")
        self._update(task_id, state="succeeded", file=filename, error=None, duration=duration)

    # -- 图片任务 ---------------------------------------------------------

    def _run_image(self, task_id, payload):
        started = time.time()
        manifest = self.registry.manifest()
        image = manifest.get("image") or {}
        source = payload.get("source")
        mode = "i2i" if source else "t2i"
        spec = (image.get("modes") or {}).get(mode)
        if not spec:
            raise ComfyError(f"工作流清单缺少图片模式: {mode}")

        width, height = payload["width"], payload["height"]
        prompt = payload.get("prompt") or ""
        negative = image.get("negative") or ""
        denoise = float(image.get("edit_denoise", 0.6))
        source_name = None
        if source:
            source_name = self._upload_bytes(source["data"], source.get("content_type") or "image/png")

        values = {
            "__PROMPT__": prompt,
            "__NEGATIVE__": negative,
            "__WIDTH__": int(width),
            "__HEIGHT__": int(height),
            "__SEED__": int(payload["seed"]),
            "__FILENAME_PREFIX__": f"h3/{task_id}",
            "__SOURCE_IMAGE__": source_name or "",
            "__DENOISE__": denoise,
        }
        graph = render_workflow(self.registry.template(spec.get("workflow")), values)
        result = self._comfy_json("/prompt", {"prompt": graph})
        prompt_id = result.get("prompt_id") if isinstance(result, dict) else None
        if not prompt_id:
            raise ComfyError("ComfyUI 未返回 prompt_id")
        self._update(task_id, pid=prompt_id)
        log(f"image {task_id[:8]} submitted mode={mode} size={width}x{height}")
        entry = self._wait_history(prompt_id)
        self._finish_image(task_id, entry)
        log(f"image {task_id[:8]} done in {time.time() - started:.1f}s")

    def _finish_image(self, task_id, entry):
        error = history_error(entry)
        if error:
            self._update(task_id, state="failed", error=error)
            return
        item = self._find_output(entry, (".png", ".jpg", ".jpeg", ".webp"))
        if not item:
            nodes = ", ".join((entry.get("outputs") or {}).keys()) or "none"
            self._update(task_id, state="failed", error=f"ComfyUI 输出中没有图片（节点: {nodes}）")
            return
        suffix = os.path.splitext(str(item.get("filename") or ""))[1].lower()
        ext = suffix if suffix in (".png", ".jpg", ".jpeg", ".webp") else ".png"
        filename = f"{task_id}{ext}"
        self._download_output(item, filename)
        self._update(task_id, state="succeeded", file=filename, error=None)

    # -- 命名工作流任务 ---------------------------------------------------

    def _is_cancelled(self, task_id):
        with self._cancel_lock:
            return task_id in self._cancelled

    def _delete_prompt(self, prompt_id):
        try:
            self._comfy_json("/queue", {"delete": [prompt_id]}, timeout=10)
        except Exception:  # noqa: BLE001 - 取消是尽力而为
            pass

    def cancel_job(self, task_id):
        task = self.get_task(task_id)
        if not task or task.get("kind") != "workflow":
            return None
        if task.get("state") in TERMINAL_STATES:
            return task
        with self._cancel_lock:
            self._cancelled.add(task_id)
        if task.get("state") == "queued":
            self._update(task_id, state="cancelled", error="已取消")
        else:
            prompt_id = task.get("pid")
            if prompt_id:
                self._delete_prompt(prompt_id)
        return self.get_task(task_id)

    def list_jobs(self, limit=20):
        with self._lock:
            items = [dict(task) for task in self.tasks.values() if task.get("kind") == "workflow"]
        items.sort(key=lambda task: task.get("created_at") or 0, reverse=True)
        return items[:max(1, min(int(limit), 100))]

    def job_payload(self, task, base_url):
        state = task.get("state")
        return {
            "job_id": task.get("id"),
            "id": task.get("id"),
            "workflow": task.get("workflow"),
            "kind": task.get("workflow_kind"),
            "status": state,
            "state": state,
            "created_at": task.get("created_at"),
            "updated_at": task.get("updated_at"),
            "file": task.get("file"),
            "file_url": self.signed_file_url(base_url, task) if state == "succeeded" else None,
            "duration": round(float(task["duration"]), 3) if task.get("duration") else None,
            "error": task.get("error"),
            "warning": task.get("warning"),
        }

    def _run_workflow(self, task_id, payload):
        started = time.time()
        row = payload.get("workflow") or {}
        inputs = payload.get("inputs") or {}
        if self._is_cancelled(task_id):
            raise Cancelled()
        graph = build_job_graph(row, inputs, self._upload_source)
        result = self._comfy_json("/prompt", {"prompt": graph})
        prompt_id = result.get("prompt_id") if isinstance(result, dict) else None
        if not prompt_id:
            raise ComfyError("ComfyUI 未返回 prompt_id")
        self._update(task_id, pid=prompt_id)
        log(f"job {task_id[:8]} submitted workflow={row.get('slug')} kind={row.get('kind')}")
        entry = self._wait_history(
            prompt_id, should_stop=lambda: self._is_cancelled(task_id),
        )
        if self._is_cancelled(task_id):
            self._delete_prompt(prompt_id)
            raise Cancelled()
        self._finish_workflow(task_id, entry)
        log(f"job {task_id[:8]} done in {time.time() - started:.1f}s")

    def _finish_workflow(self, task_id, entry):
        error = history_error(entry)
        if error:
            self._update(task_id, state="failed", error=error)
            return
        task = self.get_task(task_id) or {}
        kind = task.get("workflow_kind") or "video"
        exts = tuple(
            "." + str(ext).lower().lstrip(".")
            for ext in (task.get("output_exts") or [])
            if str(ext).strip()
        ) or tuple(DEFAULT_WORKFLOW_EXTS.get(kind, (".mp4",)))
        item = self._find_output(
            entry, exts, task.get("output_node") or None, task.get("output_key") or None,
        )
        if not item:
            nodes = ", ".join((entry.get("outputs") or {}).keys()) or "none"
            self._update(
                task_id, state="failed",
                error=f"ComfyUI 输出中没有匹配的 {kind} 产物（节点: {nodes}，后缀: {'/'.join(exts)}）",
            )
            return
        suffix = os.path.splitext(str(item.get("filename") or ""))[1].lower()
        ext = suffix if suffix in exts else exts[0]
        filename = f"{task_id}{ext}"
        self._download_output(item, filename)
        self._update(task_id, state="succeeded", file=filename, error=None)

    # -- 恢复与清理 -------------------------------------------------------

    def _resume(self, task_id):
        task = self.get_task(task_id)
        if not task:
            return
        prompt_id = task.get("pid")
        try:
            entry = self._wait_history(prompt_id)
            if task.get("kind") == "video":
                self._finish_video(task_id, entry)
            elif task.get("kind") == "workflow":
                self._finish_workflow(task_id, entry)
            else:
                self._finish_image(task_id, entry)
            log(f"task {task_id[:8]} resumed")
        except Exception as exc:  # noqa: BLE001 - 恢复失败要落状态
            self._fail(task_id, exc)

    def _cleanup_loop(self):
        self._cleanup_once()
        while not self._stop.wait(3600):
            self._cleanup_once()

    def _cleanup_once(self):
        if self.settings.retention_days <= 0:
            return
        cutoff = time.time() - self.settings.retention_days * 86400
        removed_files = 0
        removed_tasks = 0
        with self._lock:
            for task_id, task in list(self.tasks.items()):
                if task.get("state") not in TERMINAL_STATES:
                    continue
                if (task.get("updated_at") or 0) >= cutoff:
                    continue
                filename = task.get("file")
                if filename and os.path.basename(filename) == filename:
                    path = os.path.join(self.files_dir, filename)
                    try:
                        if os.path.isfile(path):
                            os.remove(path)
                            removed_files += 1
                    except OSError:
                        pass
                self.tasks.pop(task_id, None)
                removed_tasks += 1
            if removed_tasks:
                self._persist_locked()
        if removed_tasks:
            log(f"cleanup removed {removed_tasks} tasks, {removed_files} files")

    # -- 响应构造 ---------------------------------------------------------

    def _comfy_reachable(self):
        now = time.time()
        with self._health_lock:
            timestamp, cached = self._comfy_health
            if now - timestamp < 5:
                return cached
        try:
            self._comfy_json("/system_stats", timeout=2)
            reachable = True
        except Exception:
            reachable = False
        with self._health_lock:
            self._comfy_health = (now, reachable)
        return reachable

    def health_payload(self, deep=False):
        modes = self.registry.modes()
        with self._lock:
            pending = self._queue.qsize()
            processing = sum(1 for t in self.tasks.values() if t.get("state") == "processing")
            total = len(self.tasks)
            by_state = {}
            for task in self.tasks.values():
                by_state[task.get("state")] = by_state.get(task.get("state"), 0) + 1
        payload = {
            "ok": True,
            "service": SERVICE,
            "version": VERSION,
            "comfy": {"reachable": self._comfy_reachable()},
            "queue": {"pending": pending, "processing": processing},
            "workflows": modes,
        }
        if deep:
            usage = shutil.disk_usage(self.settings.data_dir)
            payload["disk"] = {
                "total": usage.total, "used": usage.used, "free": usage.free,
            }
            payload["tasks"] = {"total": total, "by_state": by_state}
        return payload

    def signed_file_url(self, base_url, task):
        filename = task.get("file")
        if not filename:
            return None
        expires = int(time.time()) + self.settings.sign_ttl
        signature = media_signature(self.settings.sign_key, filename, expires)
        return (
            f"{base_url}/files/{urllib.parse.quote(filename)}"
            f"?expires={expires}&sig={signature}"
        )

    def video_payload(self, task, base_url):
        state = task.get("state")
        if state == "succeeded":
            payload = {
                "status": "succeeded",
                "content": {"url": self.signed_file_url(base_url, task)},
            }
            if task.get("duration"):
                payload["duration"] = round(float(task["duration"]), 3)
            return {"task": payload}
        if state == "failed":
            return {"task": {"status": "failed", "error": {"message": task.get("error") or "生成失败"}}}
        return {"task": {"status": "processing"}}

    def image_payload(self, task, base_url):
        state = task.get("state")
        if state == "succeeded":
            payload = {"status": "completed", "image_url": self.signed_file_url(base_url, task)}
            if task.get("response_format") == "b64_json" and task.get("file"):
                try:
                    with open(os.path.join(self.files_dir, task["file"]), "rb") as fh:
                        payload["data"] = [{"b64_json": base64.b64encode(fh.read()).decode()}]
                except OSError:
                    pass
            return payload
        if state == "failed":
            return {"status": "failed", "error": {"message": task.get("error") or "生成失败"}}
        return {"status": "processing"}


# ---------------------------------------------------------------------------
# HTTP 层
# ---------------------------------------------------------------------------

def make_handler(gateway):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = f"HuobaoH3Gateway/{VERSION}"
        sys_version = ""
        # 浏览器会为排队中的 chunk 预开大量 socket；空闲连接必须回收，否则线程数暴涨
        timeout = 30

        def log_message(self, fmt, *args):
            return None

        # -- 响应 ---------------------------------------------------------

        def _start(self, status, content_type, length):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

        def _json(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode()
            self._start(status, "application/json; charset=utf-8", len(body))
            if self.command != "HEAD":
                self.wfile.write(body)

        def _error(self, status, code, message):
            self._json(status, {"error": {"message": message, "code": code}})

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Max-Age", "86400")
            self.send_header("Content-Length", "0")
            self.end_headers()
            self.close_connection = True

        def do_GET(self):
            self._dispatch()

        def do_HEAD(self):
            self._dispatch()

        def do_POST(self):
            self._dispatch()

        # -- 请求基础 -----------------------------------------------------

        def _read_body(self):
            limit = gateway.settings.max_body_bytes
            length = self.headers.get("Content-Length")
            if length is not None:
                try:
                    size = int(length)
                except ValueError as exc:
                    raise BadRequest("Content-Length 不合法") from exc
                if size > limit:
                    raise PayloadTooLarge("请求体超过上限")
                return self.rfile.read(size) if size > 0 else b""
            if (self.headers.get("Transfer-Encoding") or "").lower() == "chunked":
                chunks = bytearray()
                while True:
                    line = self.rfile.readline(65536).strip()
                    try:
                        size = int(line.split(b";")[0], 16)
                    except ValueError as exc:
                        raise BadRequest("chunked 请求体不合法") from exc
                    if size == 0:
                        self.rfile.readline()
                        break
                    if len(chunks) + size > limit:
                        raise PayloadTooLarge("请求体超过上限")
                    chunks += self.rfile.read(size)
                    self.rfile.readline()
                return bytes(chunks)
            return b""

        def _json_body(self):
            raw = self._read_body()
            if not raw.strip():
                return {}
            try:
                payload = json.loads(raw)
            except ValueError as exc:
                raise BadRequest("请求体不是合法 JSON") from exc
            if not isinstance(payload, dict):
                raise BadRequest("请求体必须为 JSON 对象")
            return payload

        def _token_ok(self, allow_query=False):
            header = self.headers.get("Authorization") or ""
            provided = ""
            if header.lower().startswith("bearer "):
                provided = header[7:].strip()
            elif allow_query:
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                provided = (query.get("token") or [""])[0]
            return gateway.auth_ok(provided)

        def _require_token(self, allow_query=False):
            if self._token_ok(allow_query):
                return True
            self._error(401, "unauthorized", "缺少或错误的 Bearer Token")
            return False

        def _public_base(self):
            if gateway.settings.public_base_url:
                return gateway.settings.public_base_url
            host = self.headers.get("Host") or ""
            if host and HOST_RE.fullmatch(host):
                return f"http://{host}"
            address = self.server.server_address
            return f"http://{address[0]}:{address[1]}"

        # -- 路由 ---------------------------------------------------------

        def _dispatch(self):
            try:
                path = urllib.parse.urlsplit(self.path).path
                if path in ("/", "/health"):
                    return self._health()
                if path == "/v2/video_generation":
                    return self._video_submit() if self.command == "POST" else self._not_found()
                if path.startswith("/v2/query/video_generation/"):
                    return self._video_poll() if self.command == "GET" else self._not_found()
                if path.startswith("/files/"):
                    return self._serve_file() if self.command in ("GET", "HEAD") else self._not_found()
                if path == "/comfyui/ui-session":
                    return self._ui_session() if self.command == "POST" else self._not_found()
                if path.startswith("/comfyui/ui/"):
                    return self._comfy_ui_proxy()
                if path == "/comfyui" or path.startswith("/comfyui/"):
                    return self._comfy_proxy()
                if path == "/v1/models":
                    return self._models() if self.command == "GET" else self._not_found()
                if path == "/v1/images/generations":
                    return self._image_generations() if self.command == "POST" else self._not_found()
                if path == "/v1/images/edits":
                    return self._image_edits() if self.command == "POST" else self._not_found()
                if path.startswith("/v1/images/task/"):
                    return self._image_poll() if self.command == "GET" else self._not_found()
                if path == "/v1/workflows":
                    return self._workflow_list() if self.command == "GET" else self._not_found()
                if path.startswith("/v1/workflows/"):
                    return self._workflow_detail() if self.command == "GET" else self._not_found()
                if path == "/v1/jobs":
                    if self.command == "POST":
                        return self._job_submit()
                    return self._job_list() if self.command == "GET" else self._not_found()
                if path.startswith("/v1/jobs/"):
                    rest = path[len("/v1/jobs/"):]
                    if rest.endswith("/cancel"):
                        return self._job_cancel() if self.command == "POST" else self._not_found()
                    return self._job_poll() if self.command == "GET" else self._not_found()
                if path == "/v1/uploads":
                    return self._upload() if self.command == "POST" else self._not_found()
                return self._not_found()
            except BadRequest as exc:
                return self._error(400, "bad_request", str(exc))
            except PayloadTooLarge as exc:
                return self._error(413, "payload_too_large", str(exc))
            except QueueFull as exc:
                return self._error(429, "queue_full", str(exc))
            except NotFound as exc:
                return self._error(404, "not_found", str(exc))
            except (BrokenPipeError, ConnectionResetError):
                return None
            except Exception as exc:  # noqa: BLE001 - 网关不能因单请求崩溃
                log(f"request failed: {type(exc).__name__}")
                try:
                    return self._error(500, "internal", "网关内部错误")
                except Exception:
                    return None

        def _not_found(self):
            if self._token_ok(True):
                return self._error(404, "not_found", "接口不存在")
            return self._error(404, "not_found", "接口不存在")

        def _health(self):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            deep = (query.get("deep") or [""])[0] == "1"
            if deep and not self._require_token():
                return
            self._json(200, gateway.health_payload(deep=deep))

        def _models(self):
            if not self._require_token():
                return
            try:
                models = (gateway.registry.manifest().get("image") or {}).get("models") or ["qwen-image"]
            except Exception:
                models = ["qwen-image"]
            self._json(200, {
                "object": "list",
                "data": [{"id": name, "object": "model", "owned_by": "local"} for name in models],
            })

        # -- 视频 ---------------------------------------------------------

        def _video_submit(self):
            if not self._require_token():
                return
            body = self._json_body()
            content = body.get("content") or []
            prompt_hint = str(body.get("prompt") or "").strip()
            if not content and not prompt_hint:
                return self._json(200, {"ok": True, "probe": True})
            try:
                prompt, first, last, refs = parse_video_content(content)
            except ValueError as exc:
                raise BadRequest(str(exc)) from exc
            prompt = prompt or prompt_hint
            if not prompt:
                raise BadRequest("prompt required")
            if last and not first:
                raise BadRequest("尾帧必须与首帧同时提供")

            try:
                video_manifest = gateway.registry.manifest().get("video") or {}
            except Exception:
                video_manifest = {}
            max_refs = int(video_manifest.get("max_reference_images", MAX_REF_IMAGES))
            if len(refs) > max_refs:
                raise BadRequest(f"参考图片超限：最多 {max_refs} 张")

            frames = frames_for(body.get("duration"))
            resolution = body.get("resolution_tier") or body.get("resolution")
            ratio = body.get("aspect_ratio") or body.get("ratio")
            width, height = resolve_canvas(resolution, ratio)
            audio_mode = str(body.get("audio_mode") or "native").strip().lower()
            if audio_mode not in ("native", "ambient", "silent"):
                audio_mode = "native"
            quality = normalize_quality(
                body.get("quality"), video_manifest.get("quality_presets") or {},
                video_manifest.get("default_quality", "preview"),
            )
            negative = str(body.get("negative_prompt") or "").strip()
            seed = normalize_seed(body.get("seed"))
            cfg = body.get("cfg")
            mode = "fl2v" if first else ("r2v" if refs else "t2v")

            task_id = gateway.enqueue(
                "video", mode,
                {
                    "prompt": prompt, "first": first, "last": last, "refs": refs,
                    "audio_mode": audio_mode, "quality": quality, "negative": negative,
                    "seed": seed, "cfg": cfg, "mode": mode,
                },
                duration=frames / 24.0, frames=frames, width=width, height=height,
                quality=quality, response_format="url",
            )
            log(
                f"video {task_id[:8]} queued mode={mode} canvas={width}x{height} "
                f"frames={frames} quality={quality}"
            )
            self._json(200, {"task_id": task_id})

        def _video_poll(self):
            if not self._require_token():
                return
            path = urllib.parse.urlsplit(self.path).path
            task_id = urllib.parse.unquote(path.rsplit("/", 1)[-1])
            if not TASK_ID_RE.fullmatch(task_id or ""):
                raise NotFound("任务不存在")
            task = gateway.get_task(task_id)
            if not task or task.get("kind") != "video":
                return self._json(404, {
                    "task": {"status": "failed", "error": {"message": "unknown task"}},
                })
            self._json(200, gateway.video_payload(task, self._public_base()))

        # -- 图片 ---------------------------------------------------------

        def _image_generations(self):
            if not self._require_token():
                return
            body = self._json_body()
            prompt = str(body.get("prompt") or "").strip()
            if not prompt:
                raise BadRequest("prompt required")
            try:
                image_manifest = gateway.registry.manifest().get("image") or {}
            except Exception:
                image_manifest = {}
            width, height = parse_image_size(
                body.get("size"), tuple(image_manifest.get("default_size") or (1024, 1024)),
            )
            response_format = str(body.get("response_format") or "url")
            task_id = gateway.enqueue(
                "image", "t2i",
                {
                    "prompt": prompt, "width": width, "height": height,
                    "seed": normalize_seed(body.get("seed")), "source": None,
                },
                width=width, height=height, response_format=response_format,
            )
            log(f"image {task_id[:8]} queued mode=t2i size={width}x{height}")
            self._json(200, {
                "id": task_id, "task_id": task_id, "status": "processing",
                "created": int(time.time()),
            })

        def _image_edits(self):
            if not self._require_token():
                return
            raw = self._read_body()
            fields, files = parse_multipart(raw, self.headers.get("Content-Type") or "")
            prompt = str(fields.get("prompt") or "").strip()
            if not prompt:
                raise BadRequest("prompt required")
            images = [f for f in files if f.get("field") in ("image[]", "image", "image[0]")]
            if not images:
                raise BadRequest("image[] required")
            try:
                image_manifest = gateway.registry.manifest().get("image") or {}
            except Exception:
                image_manifest = {}
            max_refs = int(image_manifest.get("max_edit_refs", 1))
            warning = ""
            if len(images) > max_refs:
                warning = (
                    f"自建 H3 网关每次编辑只使用第 1 张参考图，本次收到 {len(images)} 张，"
                    f"其余 {len(images) - max_refs} 张未参与生成"
                )
            width, height = parse_image_size(
                fields.get("size"), tuple(image_manifest.get("default_size") or (1024, 1024)),
            )
            first = images[0]
            task_id = gateway.enqueue(
                "image", "i2i",
                {
                    "prompt": prompt, "width": width, "height": height,
                    "seed": normalize_seed(fields.get("seed")),
                    "source": {
                        "data": first["data"],
                        "content_type": first.get("content_type") or "image/png",
                    },
                },
                width=width, height=height,
                response_format=str(fields.get("response_format") or "url"),
                warning=warning,
            )
            log(f"image {task_id[:8]} queued mode=i2i size={width}x{height}")
            body = {"id": task_id, "task_id": task_id, "status": "processing"}
            if warning:
                body["warning"] = warning
            self._json(200, body)

        def _image_poll(self):
            if not self._require_token():
                return
            path = urllib.parse.urlsplit(self.path).path
            task_id = urllib.parse.unquote(path.rsplit("/", 1)[-1])
            if not TASK_ID_RE.fullmatch(task_id or ""):
                raise NotFound("任务不存在")
            task = gateway.get_task(task_id)
            if not task or task.get("kind") != "image":
                return self._json(404, {
                    "status": "failed", "error": {"message": "unknown task"},
                })
            self._json(200, gateway.image_payload(task, self._public_base()))

        # -- 命名工作流 ---------------------------------------------------

        def _workflow_list(self):
            if not self._require_token():
                return
            items = [
                public_workflow(row)
                for row in gateway.store.list_workflows(active_only=True)
            ]
            self._json(200, {"object": "list", "data": items})

        def _workflow_detail(self):
            if not self._require_token():
                return
            path = urllib.parse.urlsplit(self.path).path
            slug = urllib.parse.unquote(path[len("/v1/workflows/"):]).strip("/")
            row = gateway.store.get_workflow(slug) if slug else None
            if not row:
                raise NotFound("工作流不存在或已停用")
            self._json(200, {"object": "workflow", "data": public_workflow(row)})

        def _job_submit(self):
            if not self._require_token():
                return
            body = self._json_body()
            slug = str(body.get("workflow") or "").strip()
            if not slug:
                raise BadRequest("workflow required")
            row = gateway.store.get_workflow(slug)
            if not row:
                raise NotFound("工作流不存在或已停用")
            inputs = body.get("inputs")
            if inputs is None:
                inputs = {}
            if not isinstance(inputs, dict):
                raise BadRequest("inputs 必须是对象")
            validate_job_inputs(row, inputs)
            duration = None
            if row.get("kind") == "audio" and isinstance(inputs.get("seconds"), (int, float)):
                duration = float(inputs["seconds"])
            elif isinstance(inputs.get("frames"), (int, float)) and isinstance(inputs.get("fps"), (int, float)):
                if inputs["fps"]:
                    duration = float(inputs["frames"]) / float(inputs["fps"])
            task_id = gateway.enqueue(
                "workflow", row.get("kind") or "video",
                {"workflow": row, "inputs": inputs},
                workflow=row.get("slug"),
                workflow_kind=row.get("kind"),
                output_node=row.get("output_node"),
                output_key=row.get("output_key"),
                output_exts=row.get("output_exts"),
                duration=duration,
                response_format=str(body.get("response_format") or "url"),
            )
            log(f"job {task_id[:8]} queued workflow={slug} kind={row.get('kind')}")
            self._json(200, {
                "job_id": task_id,
                "id": task_id,
                "status": "queued",
                "workflow": slug,
            })

        def _job_poll(self):
            if not self._require_token():
                return
            path = urllib.parse.urlsplit(self.path).path
            job_id = urllib.parse.unquote(path[len("/v1/jobs/"):]).strip("/")
            if not TASK_ID_RE.fullmatch(job_id or ""):
                raise NotFound("任务不存在")
            task = gateway.get_task(job_id)
            if not task or task.get("kind") != "workflow":
                raise NotFound("任务不存在")
            self._json(200, gateway.job_payload(task, self._public_base()))

        def _job_list(self):
            if not self._require_token():
                return
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            try:
                limit = int((query.get("limit") or ["20"])[0])
            except ValueError:
                limit = 20
            data = [
                gateway.job_payload(task, self._public_base())
                for task in gateway.list_jobs(limit)
            ]
            self._json(200, {"object": "list", "data": data})

        def _job_cancel(self):
            if not self._require_token():
                return
            path = urllib.parse.urlsplit(self.path).path
            rest = urllib.parse.unquote(path[len("/v1/jobs/"):]).strip("/")
            job_id = rest[: -len("/cancel")].strip("/") if rest.endswith("/cancel") else ""
            if not TASK_ID_RE.fullmatch(job_id or ""):
                raise NotFound("任务不存在")
            task = gateway.cancel_job(job_id)
            if not task:
                raise NotFound("任务不存在")
            self._json(200, gateway.job_payload(task, self._public_base()))

        def _upload(self):
            if not self._require_token():
                return
            raw = self._read_body()
            _, files = parse_multipart(raw, self.headers.get("Content-Type") or "")
            image = next((item for item in files if item.get("field") in ("image", "file")), None)
            if not image:
                raise BadRequest("image required")
            data = image.get("data") or b""
            if not is_image_bytes(data):
                raise BadRequest("上传内容不是有效图片")
            name = gateway._upload_bytes(data, image.get("content_type") or "image/png")
            self._json(200, {"name": name, "subfolder": ""})

        # -- 文件 ---------------------------------------------------------

        def _serve_file(self):
            path = urllib.parse.urlsplit(self.path).path
            name = urllib.parse.unquote(path[len("/files/"):])
            if (
                not name or name != os.path.basename(name)
                or name in (".", "..") or name.startswith(".")
                or "/" in name or "\\" in name
            ):
                raise NotFound("文件不存在")
            real_root = os.path.realpath(gateway.files_dir)
            full = os.path.realpath(os.path.join(real_root, name))
            if os.path.dirname(full) != real_root or not os.path.isfile(full):
                raise NotFound("文件不存在")

            header = self.headers.get("Authorization") or ""
            if header:
                if not self._token_ok():
                    return self._error(401, "unauthorized", "缺少或错误的 Bearer Token")
            else:
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                expires_raw = (query.get("expires") or [""])[0]
                signature = (query.get("sig") or [""])[0]
                try:
                    expires = int(expires_raw)
                except ValueError:
                    return self._error(403, "forbidden", "下载链接缺少有效签名")
                expected = media_signature(gateway.settings.sign_key, name, expires)
                if expires < time.time() or not hmac.compare_digest(signature, expected):
                    return self._error(403, "forbidden", "下载链接已过期或签名不匹配")

            size = os.path.getsize(full)
            content_type = MEDIA_TYPES.get(os.path.splitext(name)[1].lower(), "application/octet-stream")
            self._start(200, content_type, size)
            if self.command == "HEAD":
                return
            with open(full, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 256 * 1024)

        # -- ComfyUI 代理 -------------------------------------------------

        def _ui_session(self):
            if not self._require_token():
                return
            ttl = gateway.settings.ui_session_ttl
            expires = int(time.time()) + ttl
            ticket = ui_session_ticket(gateway.settings.sign_key, expires)
            self._json(200, {
                "path": f"/comfyui/ui/{ticket}/",
                "expires_at": expires,
                "ttl": ttl,
            })

        def _comfy_proxy(self):
            if not self._require_token(allow_query=True):
                return
            parsed = urllib.parse.urlsplit(self.path)
            target = parsed.path[len("/comfyui"):] or "/"
            if not target.startswith("/"):
                target = "/" + target
            if not self._proxy_allowed(self.command, target):
                return self._error(404, "not_found", "代理路径不在允许列表")
            self._forward_comfy(self.command, target, parsed.query, strip_token=True)

        def _comfy_ui_proxy(self):
            parsed = urllib.parse.urlsplit(self.path)
            prefix = "/comfyui/ui/"
            rest = parsed.path[len(prefix):]
            ticket, separator, target = rest.partition("/")
            if not ui_session_valid(gateway.settings.sign_key, ticket):
                return self._error(403, "forbidden", "ComfyUI 页面会话无效或已过期，请刷新监控页面")
            if not separator:
                # 尾斜杠决定前端 api_base/静态资源解析，缺省时重定向补齐
                query = ("?" + parsed.query) if parsed.query else ""
                self.send_response(301)
                self.send_header("Location", f"{prefix}{ticket}/{query}")
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                return
            target = "/" + target
            target = self._safe_ui_target(target)
            if target is None:
                return self._error(403, "forbidden", "监控页面路径不合法")
            upgrade = (self.headers.get("Upgrade") or "").lower()
            if target == "/ws" and upgrade == "websocket":
                return self._comfy_ws(parsed.query, int(ticket.split(".", 1)[0]))
            if not self._ui_proxy_allowed(self.command, target):
                return self._error(404, "not_found", "监控页面仅开放只读操作")
            self._forward_comfy(self.command, target, parsed.query, ui=True)

        @staticmethod
        def _safe_ui_target(target):
            """只读白名单与实际转发必须看同一条规范路径，拒绝点段和编码分隔符。"""
            if not target.startswith("/") or "\\" in target or "\x00" in target:
                return None
            lowered = target.lower()
            if any(token in lowered for token in ("%2e", "%2f", "%5c", "%00")):
                return None
            if "//" in target or ";" in target:
                return None
            decoded = urllib.parse.unquote(target)
            if "\\" in decoded or "\x00" in decoded:
                return None
            if any(segment in (".", "..") for segment in decoded.split("/")):
                return None
            return target

        def _forward_comfy(self, method, target, raw_query="", strip_token=False, ui=False):
            query_pairs = urllib.parse.parse_qsl(raw_query, keep_blank_values=True)
            if strip_token:
                query_pairs = [(k, v) for k, v in query_pairs if k != "token"]
            query = urllib.parse.urlencode(query_pairs)
            body = self._read_body() if method == "POST" else None
            headers = {}
            for name in ("Content-Type", "Accept", "Accept-Encoding", "Range", "If-None-Match", "If-Modified-Since"):
                value = self.headers.get(name)
                if value:
                    headers[name] = value
            url = gateway.settings.comfy_url.rstrip("/") + target
            if query:
                url += "?" + query
            request = urllib.request.Request(url, data=body, headers=headers, method=method)
            timeout = 600 if target == "/view" or target.startswith("/history/") else 120
            try:
                with gateway._comfy_opener.open(request, timeout=timeout) as response:
                    self.send_response(response.status)
                    for header in (
                        "Content-Type", "Content-Length", "Last-Modified", "ETag",
                        "Content-Encoding", "Accept-Ranges",
                        "Content-Range", "Content-Disposition",
                    ):
                        value = response.headers.get(header)
                        if value:
                            self.send_header(header, value)
                    if ui and target.startswith("/assets/"):
                        # 带 hash 的前端 chunk 可长期缓存；上游的 no-store 会让首屏每次重下 100+ 文件
                        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
                    else:
                        value = response.headers.get("Cache-Control")
                        if value:
                            self.send_header("Cache-Control", value)
                    if ui:
                        self.send_header("Referrer-Policy", "no-referrer")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    # 有 Content-Length 的只读响应允许复用连接；首屏 100+ chunk 不再每次重新握手
                    keep_alive = (
                        method in ("GET", "HEAD")
                        and bool(response.headers.get("Content-Length"))
                        and self.request_version != "HTTP/1.0"
                        and not self.close_connection
                    )
                    if keep_alive:
                        self.send_header("Connection", "keep-alive")
                    else:
                        self.send_header("Connection", "close")
                        self.close_connection = True
                    self.end_headers()
                    if method != "HEAD" and response.status not in (204, 304):
                        while True:
                            chunk = response.read(256 * 1024)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
            except urllib.error.HTTPError as exc:
                if exc.code in (204, 304):
                    self.send_response(exc.code)
                    for header in ("ETag", "Last-Modified", "Cache-Control"):
                        value = exc.headers.get(header)
                        if value:
                            self.send_header(header, value)
                    if ui:
                        self.send_header("Referrer-Policy", "no-referrer")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    return
                payload = exc.read()
                content_type = exc.headers.get("Content-Type") or "application/json"
                self._start(exc.code, content_type, len(payload))
                if method != "HEAD":
                    self.wfile.write(payload)
            except (urllib.error.URLError, OSError):
                self._error(502, "comfy_error", "ComfyUI 不可达")

        def _comfy_ws(self, raw_query, expires=0):
            key = (self.headers.get("Sec-WebSocket-Key") or "").strip()
            if not key:
                return self._error(400, "bad_request", "缺少 WebSocket 握手")
            upstream = urllib.parse.urlsplit(gateway.settings.comfy_url)
            host = upstream.hostname or "127.0.0.1"
            port = upstream.port or (443 if upstream.scheme == "https" else 80)
            query = urllib.parse.urlencode(urllib.parse.parse_qsl(raw_query, keep_blank_values=True))
            target = (upstream.path.rstrip("/") or "") + "/ws" + (("?" + query) if query else "")
            expected_accept = base64.b64encode(hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
            ).digest()).decode()
            sock = None
            try:
                sock = socket.create_connection((host, port), timeout=15)
                if upstream.scheme == "https":
                    sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
                sock.settimeout(None)
                handshake = (
                    f"GET {target} HTTP/1.1\r\n"
                    f"Host: {host}:{port}\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Key: {key}\r\n"
                    "Sec-WebSocket-Version: 13\r\n"
                    "\r\n"
                ).encode()
                sock.sendall(handshake)
                response = b""
                while b"\r\n\r\n" not in response:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    response += chunk
                    if len(response) > 65536:
                        break
            except OSError:
                if sock is not None:
                    try:
                        sock.close()
                    except OSError:
                        pass
                return self._error(502, "comfy_error", "ComfyUI WebSocket 不可达")

            head, _, tail = response.partition(b"\r\n\r\n")
            status_line = head.split(b"\r\n", 1)[0]
            upstream_accept = ""
            for line in head.split(b"\r\n")[1:]:
                name, _, value = line.partition(b":")
                if name.strip().lower() == b"sec-websocket-accept":
                    upstream_accept = value.strip().decode("latin-1")
                    break
            if b" 101 " not in status_line or upstream_accept != expected_accept:
                try:
                    sock.close()
                except OSError:
                    pass
                return self._error(502, "comfy_error", "ComfyUI WebSocket 握手失败")

            self.send_response_only(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", expected_accept)
            self.end_headers()
            self.wfile.flush()
            self.close_connection = True
            if tail:
                try:
                    self.connection.sendall(tail)
                except OSError:
                    pass
            self._relay_ws(sock, expires)

        def _relay_ws(self, upstream, expires=0):
            client = self.connection
            try:
                client.setblocking(False)
                upstream.setblocking(False)
                while True:
                    if expires and time.time() >= expires:
                        return
                    readable, _, _ = select.select([client, upstream], [], [], 30)
                    for source in readable:
                        try:
                            data = source.recv(65536)
                        except (BlockingIOError, InterruptedError):
                            continue
                        if not data:
                            return
                        target = upstream if source is client else client
                        view = memoryview(data)
                        while view:
                            try:
                                sent = target.send(view)
                            except (BlockingIOError, InterruptedError):
                                select.select([], [target], [], 5)
                                continue
                            view = view[sent:]
            except OSError:
                pass
            finally:
                try:
                    client.setblocking(True)
                except OSError:
                    pass
                try:
                    upstream.close()
                except OSError:
                    pass

        @staticmethod
        def _proxy_allowed(method, path):
            if method in ("GET", "HEAD"):
                return (
                    path == "/system_stats" or path == "/history"
                    or path.startswith("/history/") or path == "/view"
                )
            if method == "POST":
                return path in ("/prompt", "/upload/image")
            return False

        @staticmethod
        def _ui_proxy_allowed(method, path):
            if method in ("GET", "HEAD"):
                return True
            if method == "POST":
                # 只放行前端自身的设置/用户数据读写，生成类变更一律拒绝
                return (
                    path == "/api/settings" or path.startswith("/api/settings/")
                    or path == "/api/userdata" or path.startswith("/api/userdata/")
                )
            return False

    return Handler


class GatewayServer(ThreadingHTTPServer):
    # 默认 backlog=5，ComfyUI 首屏 100+ 并发 chunk 会丢 SYN；内核 somaxconn 为 4096
    request_queue_size = 256
    daemon_threads = True


def main():
    settings = Settings.from_env()
    if not settings.token:
        raise SystemExit("H3_GATEWAY_TOKEN 未设置，拒绝启动")
    gateway = Gateway(settings)
    server = GatewayServer((settings.host, settings.port), make_handler(gateway))
    log(
        f"{SERVICE} {VERSION} listening on {settings.host}:{settings.port} "
        f"comfy={settings.comfy_url} workers={settings.workers}"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        gateway.close()


if __name__ == "__main__":
    main()
