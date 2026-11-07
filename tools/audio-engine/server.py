#!/usr/bin/env python3
"""本地 UVR 音频分离服务（MossHuobao sidecar）。

实现 backend/src/services/audio-engine.ts 使用的 HTTP 契约：
  GET  /v1/health
  POST /v1/separate
  GET  /v1/jobs/{id}
  POST /v1/jobs/{id}/cancel

只监听本机回环地址；同一时间只跑一个分离任务，其余排队。
模型默认 UVR-MDX-NET-Inst_HQ_3（UVR MDX-Net），首次使用会下载到模型缓存目录。
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_MODEL = "UVR-MDX-NET-Inst_HQ_3"
DEFAULT_MODEL_DIR = os.path.expanduser("~/.cache/huobao-audio-engine/models")
MEDIA_EXTS = {
    ".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".aiff", ".aif",
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
}
STEM_KINDS = {"vocals", "instrumental", "drums", "bass", "other"}
MAX_BODY_BYTES = 1 << 20

LOG = logging.getLogger("audio-engine")


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


@dataclass
class Config:
    host: str = os.environ.get("AUDIO_ENGINE_HOST", "127.0.0.1")
    port: int = int(os.environ.get("AUDIO_ENGINE_PORT", "8199"))
    token: str = os.environ.get("AUDIO_ENGINE_TOKEN", "").strip()
    model_dir: str = os.environ.get("AUDIO_ENGINE_MODEL_DIR", DEFAULT_MODEL_DIR)
    default_model: str = os.environ.get("AUDIO_ENGINE_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
    allow_download: bool = env_flag("AUDIO_ENGINE_ALLOW_MODEL_DOWNLOAD", True)
    allowed_roots: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def load(cls) -> "Config":
        raw_roots = os.environ.get("AUDIO_ENGINE_ALLOWED_ROOTS", "")
        roots = tuple(
            str(Path(item).expanduser().resolve())
            for item in raw_roots.split(os.pathsep)
            if item.strip()
        )
        return cls(allowed_roots=roots)


@dataclass
class Job:
    id: str
    source_path: str
    output_dir: str
    engine: str
    model: str
    status: str = "queued"
    progress: int = 0
    note: str = "排队中"
    error: str | None = None
    confidence: float | None = None
    stems: list[dict] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "progress": self.progress,
            "note": self.note,
            "error": self.error,
            "engine": self.engine,
            "model": self.model,
            "confidence": self.confidence,
            "stems": [
                {
                    "kind": stem["kind"],
                    "path": stem["path"],
                    "duration_ms": stem["duration_ms"],
                    "sample_rate": stem["sample_rate"],
                    "channels": stem["channels"],
                }
                for stem in self.stems
            ],
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
JOB_QUEUE: "queue.Queue[str]" = queue.Queue()
CONFIG = Config.load()


def update_job(job: Job, **patch) -> None:
    with JOBS_LOCK:
        for key, value in patch.items():
            setattr(job, key, value)


def is_allowed(path: Path) -> bool:
    if not CONFIG.allowed_roots:
        return True
    return any(path == Path(root) or path.is_relative_to(Path(root)) for root in CONFIG.allowed_roots)


def validate_source(raw: object) -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("source_path 不能为空")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError("source_path 必须是绝对路径")
    resolved = path.resolve()
    if not resolved.is_file():
        raise ValueError(f"原声文件不存在：{resolved}")
    if resolved.suffix.lower() not in MEDIA_EXTS:
        raise ValueError(f"不支持的文件类型：{resolved.suffix}")
    if not is_allowed(resolved):
        raise ValueError("source_path 不在允许的目录内")
    return resolved


def validate_output(raw: object) -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("output_dir 不能为空")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError("output_dir 必须是绝对路径")
    resolved = path.resolve()
    if not is_allowed(resolved):
        raise ValueError("output_dir 不在允许的目录内")
    resolved.mkdir(parents=True, exist_ok=True)
    if not resolved.is_dir():
        raise ValueError(f"output_dir 不是目录：{resolved}")
    return resolved


def stem_kind(filename: str) -> str | None:
    name = filename.lower()
    if "instrumental" in name or "no_vocals" in name or "accompaniment" in name:
        return "instrumental"
    if "vocals" in name or "vocal" in name:
        return "vocals"
    if "drums" in name:
        return "drums"
    if "bass" in name:
        return "bass"
    if "other" in name:
        return "other"
    return None


def probe_audio(path: Path) -> tuple[int, int, int]:
    """返回 duration_ms / sample_rate / channels；优先 soundfile，失败时回落 ffprobe。"""
    try:
        import soundfile  # type: ignore

        info = soundfile.info(str(path))
        if info.samplerate > 0:
            return int(round(info.frames / info.samplerate * 1000)), int(info.samplerate), int(info.channels)
    except Exception:
        pass
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=sample_rate,channels:format=duration",
                "-of", "json", str(path),
            ],
            check=True, capture_output=True, text=True, timeout=30,
        )
        data = json.loads(out.stdout or "{}")
        stream = (data.get("streams") or [{}])[0]
        duration = float((data.get("format") or {}).get("duration") or 0)
        return int(round(duration * 1000)), int(stream.get("sample_rate") or 0), int(stream.get("channels") or 0)
    except Exception:
        return 0, 0, 0


def convert_source(source: Path, target: Path) -> None:
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-vn", "-ac", "2", "-ar", "44100",
            "-c:a", "pcm_s16le", str(target),
        ],
        check=True, capture_output=True, timeout=600,
    )


def cleanup_paths(paths: list[Path]) -> None:
    for path in paths:
        try:
            if path.is_file():
                path.unlink()
        except OSError:
            LOG.warning("清理临时文件失败：%s", path)


def run_job(job: Job) -> None:
    output_dir = Path(job.output_dir)
    temp_wav = output_dir / f".source-{job.id}.wav"
    written: list[Path] = []

    def report(progress: int, note: str) -> None:
        update_job(job, progress=max(0, min(100, progress)), note=note)

    try:
        if job.cancel_event.is_set():
            update_job(job, status="cancelled", note="已取消", finished_at=time.time())
            return

        report(5, "读取原声")
        convert_source(Path(job.source_path), temp_wav)

        if job.cancel_event.is_set():
            update_job(job, status="cancelled", note="已取消", finished_at=time.time())
            return

        model_filename = job.model if job.model.lower().endswith((".onnx", ".pth", ".ckpt", ".yaml", ".yml")) else f"{job.model}.onnx"
        model_path = Path(CONFIG.model_dir) / model_filename
        if not model_path.exists() and not CONFIG.allow_download:
            raise RuntimeError(f"模型不存在：{model_path}（已禁用自动下载）")

        report(10, "加载分离模型")
        from audio_separator.separator import Separator  # 延迟导入，健康检查无需加载 torch

        Path(CONFIG.model_dir).mkdir(parents=True, exist_ok=True)
        separator = Separator(
            model_file_dir=CONFIG.model_dir,
            output_dir=str(output_dir),
            output_format="WAV",
        )
        separator.load_model(model_filename=model_filename)

        if job.cancel_event.is_set():
            update_job(job, status="cancelled", note="已取消", finished_at=time.time())
            return

        report(25, "分离人声与伴奏")
        raw_outputs = separator.separate(str(temp_wav))
        if isinstance(raw_outputs, str):
            raw_outputs = [raw_outputs]
        if not isinstance(raw_outputs, list) or not raw_outputs:
            raise RuntimeError("分离引擎没有返回音轨")

        candidates: list[tuple[str, Path]] = []
        for item in raw_outputs:
            candidate = Path(str(item))
            if not candidate.is_absolute():
                candidate = output_dir / candidate
            if not candidate.is_file():
                raise RuntimeError(f"分离结果文件不存在：{candidate}")
            kind = stem_kind(candidate.name)
            if kind not in STEM_KINDS:
                LOG.warning("忽略无法识别的音轨：%s", candidate.name)
                continue
            candidates.append((kind, candidate))

        if job.cancel_event.is_set():
            cleanup_paths([path for _, path in candidates])
            update_job(job, status="cancelled", note="已取消", finished_at=time.time())
            return

        if not candidates:
            raise RuntimeError("分离结果中没有 vocals/instrumental 音轨")

        report(90, "写出音轨")
        stems: list[dict] = []
        used: set[str] = set()
        for kind, candidate in candidates:
            canonical = output_dir / f"{kind}.wav"
            if kind in used:
                canonical = output_dir / f"{kind}-{len(used) + 1}.wav"
            used.add(kind)
            if candidate != canonical:
                if canonical.exists():
                    canonical.unlink()
                shutil.move(str(candidate), str(canonical))
                written.append(canonical)
            duration_ms, sample_rate, channels = probe_audio(canonical)
            stems.append({
                "kind": kind,
                "path": str(canonical.resolve()),
                "duration_ms": duration_ms,
                "sample_rate": sample_rate,
                "channels": channels,
            })

        update_job(
            job,
            status="done",
            progress=100,
            note="分离完成",
            stems=stems,
            model=job.model,
            finished_at=time.time(),
        )
    except Exception as exc:  # noqa: BLE001 - 任务错误必须原样回传
        LOG.error("分离任务失败：%s\n%s", exc, traceback.format_exc())
        cleanup_paths(written)
        update_job(
            job,
            status="failed",
            progress=100,
            note="分离失败",
            error=str(exc) or exc.__class__.__name__,
            finished_at=time.time(),
        )
    finally:
        cleanup_paths([temp_wav])


def worker_loop() -> None:
    while True:
        job_id = JOB_QUEUE.get()
        try:
            if job_id is None:
                return
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                if job is None or job.status != "queued":
                    continue
                job.status = "running"
                job.started_at = time.time()
            LOG.info("开始分离任务 %s", job_id)
            run_job(job)
            LOG.info("分离任务 %s 结束：%s", job_id, job.status)
        finally:
            JOB_QUEUE.task_done()


class Handler(BaseHTTPRequestHandler):
    server_version = "HuobaoAudioEngine/1.0"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - 基类接口
        LOG.info("%s %s", self.address_string(), fmt % args)

    def _send_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not CONFIG.token:
            return True
        header = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix):
            return False
        return hmac.compare_digest(header[len(prefix):], CONFIG.token)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("请求体为空或过大")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"请求体不是合法 JSON：{exc}") from exc
        if not isinstance(data, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return data

    def do_GET(self) -> None:  # noqa: N802 - 基类接口
        if not self._authorized():
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path == "/v1/health":
            self._send_json(HTTPStatus.OK, {
                "ok": True,
                "device": "cpu",
                "engines": ["uvr"],
                "models": [CONFIG.default_model],
                "model_dir": CONFIG.model_dir,
                "ffmpeg": shutil.which("ffmpeg") is not None,
            })
            return
        match = re.fullmatch(r"/v1/jobs/([^/]+)", path)
        if match:
            with JOBS_LOCK:
                job = JOBS.get(match.group(1))
                snapshot = job.snapshot() if job else None
            if not snapshot:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "job not found"})
            else:
                self._send_json(HTTPStatus.OK, snapshot)
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - 基类接口
        if not self._authorized():
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path == "/v1/separate":
            self._handle_separate()
            return
        match = re.fullmatch(r"/v1/jobs/([^/]+)/cancel", path)
        if match:
            job_id = match.group(1)
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                if job is None:
                    found = False
                else:
                    found = True
                    if job.status in {"queued", "running"}:
                        job.cancel_event.set()
                        job.status = "cancelled"
                        job.note = "已取消"
                        job.finished_at = time.time()
            if not found:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "job not found"})
            else:
                self._send_json(HTTPStatus.OK, {"ok": True})
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def _handle_separate(self) -> None:
        try:
            payload = self._read_json()
            source = validate_source(payload.get("source_path"))
            output_dir = validate_output(payload.get("output_dir"))
            engine = str(payload.get("engine") or "uvr").strip().lower()
            if engine != "uvr":
                raise ValueError("本 sidecar 只启用 UVR；如需 Demucs 请另配服务")
            model = str(payload.get("model") or CONFIG.default_model).strip() or CONFIG.default_model
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        job = Job(
            id=uuid.uuid4().hex,
            source_path=str(source),
            output_dir=str(output_dir),
            engine=engine,
            model=model,
        )
        with JOBS_LOCK:
            JOBS[job.id] = job
        JOB_QUEUE.put(job.id)
        self._send_json(HTTPStatus.ACCEPTED, {"id": job.id, "status": job.status})


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("AUDIO_ENGINE_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    if CONFIG.host not in {"127.0.0.1", "localhost", "::1"}:
        LOG.warning("sidecar 绑定在非回环地址 %s，请确认网络边界", CONFIG.host)
    worker = threading.Thread(target=worker_loop, name="separator-worker", daemon=True)
    worker.start()
    server = ThreadingHTTPServer((CONFIG.host, CONFIG.port), Handler)
    server.daemon_threads = True
    LOG.info(
        "音频分离服务已启动 http://%s:%s（model=%s, model_dir=%s）",
        CONFIG.host, CONFIG.port, CONFIG.default_model, CONFIG.model_dir,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOG.info("收到中断，退出")
    finally:
        server.server_close()
        JOB_QUEUE.put(None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
