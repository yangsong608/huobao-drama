#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""H3 网关单元/集成测试：标准库 unittest + 本地假 ComfyUI，不依赖 GPU。"""
import base64
import hashlib
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
GATEWAY_DIR = os.path.dirname(HERE)
WORKFLOW_DIR = os.path.join(GATEWAY_DIR, "workflows")
sys.path.insert(0, GATEWAY_DIR)

import h3_gateway as gw  # noqa: E402

TOKEN = "test-token-123"
SIGN_KEY = b"test-sign-key"
PAYLOAD_MP4 = b"FAKE-MP4-" + b"x" * 4096
PAYLOAD_WAV = b"FAKE-WAV-" + b"x" * 4096
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1cAAAAASUVORK5CYII="
)
PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(PNG_1X1).decode()
BLUE_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"
)
PNG_DATA_URL_2 = "data:image/png;base64," + base64.b64encode(BLUE_PNG).decode()


class FakeComfy:
    """最小 ComfyUI：upload/prompt/history/view/system_stats。"""

    def __init__(self):
        self.graphs = []
        self.uploads = []
        self.outputs = {}
        self.counter = 0
        self.lock = threading.Lock()
        self.error_entry = None
        self.last_proxy_query = None
        self.last_proxy_body = None
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def register_output(self, pid, kind):
        with self.lock:
            self.outputs[pid] = kind

    def _handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, fmt, *args):
                pass

            def _send(self, code, body, ctype="application/json"):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                self.wfile.write(body)

            def do_POST(self):
                path = urllib.parse.urlsplit(self.path).path
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n)
                if path == "/upload/image":
                    match = re.search(rb'filename="([^"]+)"', raw)
                    name = match.group(1).decode() if match else "unknown.png"
                    with fake.lock:
                        fake.uploads.append({"name": name, "body": raw})
                    return self._send(200, json.dumps({"name": name}).encode())
                if path == "/api/settings":
                    fake.last_proxy_body = raw
                    return self._send(200, b'{"ok":true}')
                if path == "/api/prompt":
                    return self._send(404, b"{}")
                if path == "/prompt":
                    body = json.loads(raw or b"{}")
                    graph = body.get("prompt") or {}
                    with fake.lock:
                        fake.counter += 1
                        pid = f"pid{fake.counter}"
                        kind = "image"
                        for node in graph.values():
                            if not isinstance(node, dict):
                                continue
                            if node.get("class_type") == "SaveVideo":
                                kind = "video"
                                break
                            if node.get("class_type") == "SaveAudio":
                                kind = "audio"
                        fake.graphs.append(graph)
                        fake.outputs[pid] = kind
                    return self._send(200, json.dumps({"prompt_id": pid}).encode())
                return self._send(404, b"{}")

            def do_GET(self):
                parsed = urllib.parse.urlsplit(self.path)
                path = parsed.path
                if path == "/ws" and (self.headers.get("Upgrade") or "").lower() == "websocket":
                    key = (self.headers.get("Sec-WebSocket-Key") or "").strip()
                    accept = base64.b64encode(hashlib.sha1(
                        (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
                    ).digest()).decode()
                    self.send_response_only(101)
                    self.send_header("Upgrade", "websocket")
                    self.send_header("Connection", "Upgrade")
                    self.send_header("Sec-WebSocket-Accept", accept)
                    self.end_headers()
                    self.wfile.flush()
                    self.close_connection = True
                    self.connection.sendall(b"\x81\x05hello")
                    self.connection.recv(1024)
                    return None
                if path == "/":
                    return self._send(200, b"<html><script src=\"./assets/app.js\"></script></html>", "text/html")
                if path == "/assets/app.js":
                    return self._send(200, b"console.log('comfy')", "application/javascript")
                if path == "/api/system_stats":
                    return self._send(200, b'{"system":{"os":"fake-api"}}')
                if path == "/system_stats":
                    return self._send(200, b'{"system":{"os":"fake"}}')
                if path.startswith("/history/"):
                    pid = path.rsplit("/", 1)[-1]
                    with fake.lock:
                        kind = fake.outputs.get(pid)
                    if kind is None:
                        return self._send(200, b"{}")
                    if fake.error_entry is not None:
                        entry = fake.error_entry
                    else:
                        entry = {"status": {"status_str": "success", "messages": []}, "outputs": {}}
                        if kind == "audio":
                            entry["outputs"]["8"] = {
                                "audio": [{"filename": f"{pid}.wav", "subfolder": "", "type": "output"}],
                            }
                        else:
                            ext = ".mp4" if kind == "video" else ".png"
                            node = "8" if kind == "video" else "11"
                            entry["outputs"][node] = {
                                "images": [{"filename": f"{pid}{ext}", "subfolder": "", "type": "output"}],
                            }
                    return self._send(200, json.dumps({pid: entry}).encode())
                if path == "/view":
                    q = urllib.parse.parse_qs(parsed.query)
                    filename = (q.get("filename") or [""])[0]
                    if filename.endswith(".mp4"):
                        return self._send(200, PAYLOAD_MP4, "video/mp4")
                    if filename.endswith(".wav"):
                        return self._send(200, PAYLOAD_WAV, "audio/wav")
                    return self._send(200, PNG_1X1, "image/png")
                return self._send(404, b"{}")

            def do_HEAD(self):
                path = urllib.parse.urlsplit(self.path).path
                if path == "/system_stats":
                    self.send_response(200)
                    self.send_header("Content-Length", "2")
                    self.end_headers()
                    return None
                return self._send(404, b"{}")

        return Handler


class Harness:
    def __init__(self, data_dir, comfy_url, **overrides):
        env = {
            "H3_GATEWAY_TOKEN": TOKEN,
            "H3_GATEWAY_SIGN_KEY": SIGN_KEY.decode(),
            "H3_COMFY_URL": comfy_url,
            "H3_WORKFLOW_DIR": WORKFLOW_DIR,
            "H3_DATA_DIR": data_dir,
            "H3_WORKERS": "1",
            "H3_QUEUE_LIMIT": "32",
            "H3_POLL_INTERVAL": "0.02",
            "H3_UPSTREAM_TIMEOUT": "10",
            "H3_SIGN_TTL": "3600",
            "H3_RETENTION_DAYS": "7",
            "H3_MAX_BODY_BYTES": str(8 * 1024 * 1024),
        }
        env.update({k: str(v) for k, v in overrides.items()})
        self.settings = gw.Settings.from_env(env)
        self.gateway = gw.Gateway(self.settings)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), gw.make_handler(self.gateway))
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    @property
    def auth(self):
        return {"Authorization": f"Bearer {TOKEN}"}

    def request(self, method, path, json_body=None, body=None, headers=None, ctype=None):
        url = path if path.startswith("http") else self.base + path
        data = body
        hdrs = dict(headers or {})
        if json_body is not None:
            data = json.dumps(json_body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        if ctype:
            hdrs["Content-Type"] = ctype
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def json(self, method, path, json_body=None, headers=None, body=None, ctype=None):
        status, hdrs, raw = self.request(method, path, json_body=json_body, headers=headers, body=body, ctype=ctype)
        try:
            payload = json.loads(raw.decode())
        except Exception:
            payload = raw
        return status, hdrs, payload

    def wait_task(self, path, timeout=8):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            status, _, payload = self.json("GET", path, headers=self.auth)
            last = payload
            state = None
            if isinstance(payload, dict):
                state = (payload.get("task") or {}).get("status") or payload.get("status")
            if state in ("succeeded", "failed", "completed"):
                return payload
            time.sleep(0.03)
        raise AssertionError(f"task did not finish: {last}")

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.gateway.close()


def multipart_body(fields, files):
    boundary = "----h3test"
    chunks = []
    for name, value in fields.items():
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    for name, (filename, ctype, data) in files:
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n".encode()
            + data
            + b"\r\n"
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class BaseCase(unittest.TestCase):
    queue_limit = 32
    workers = 1

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="h3gw-")
        self.fake = FakeComfy()
        self.h = Harness(
            self.tmp,
            self.fake.url,
            H3_QUEUE_LIMIT=self.queue_limit,
            H3_WORKERS=self.workers,
        )

    def tearDown(self):
        self.h.close()
        self.fake.close()
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestAuth(BaseCase):
    def test_health_is_public_and_hides_secrets(self):
        status, _, payload = self.h.json("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["service"], "huobao-h3-gateway")
        self.assertNotIn(TOKEN, json.dumps(payload))
        self.assertEqual(payload["workflows"]["video"], ["t2v", "fl2v", "r2v"])

    def test_business_routes_require_token(self):
        status, _, _ = self.h.json("GET", "/v1/models")
        self.assertEqual(status, 401)
        status, _, _ = self.h.json("GET", "/v1/models", headers={"Authorization": "Bearer wrong"})
        self.assertEqual(status, 401)
        status, _, payload = self.h.json("GET", "/v1/models", headers=self.h.auth)
        self.assertEqual(status, 200)
        self.assertEqual(payload["data"][0]["id"], "qwen-image")

    def test_deep_health_requires_token(self):
        status, _, _ = self.h.json("GET", "/health?deep=1")
        self.assertEqual(status, 401)
        status, _, payload = self.h.json("GET", "/health?deep=1", headers=self.h.auth)
        self.assertEqual(status, 200)
        self.assertIn("disk", payload)


class TestVideoSubmit(BaseCase):
    def _submit(self, payload):
        status, _, body = self.h.json("POST", "/v2/video_generation", payload, headers=self.h.auth)
        self.assertEqual(status, 200, body)
        self.assertTrue(body.get("task_id"))
        return body["task_id"]

    def test_probe_does_not_create_task(self):
        status, _, body = self.h.json("POST", "/v2/video_generation", {}, headers=self.h.auth)
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True, "probe": True})
        status, _, body = self.h.json("POST", "/v2/video_generation", body=b"", headers=self.h.auth)
        self.assertEqual(status, 200)
        self.assertTrue(body.get("probe"))
        self.assertEqual(len(self.fake.graphs), 0)

    def test_t2v_submit_poll_download(self):
        task_id = self._submit({
            "model": "MiniMax-H3",
            "content": [{"type": "text", "text": "a cat walks on the moon"}],
            "duration": 5,
            "resolution_tier": "480p",
            "aspect_ratio": "16:9",
            "audio_mode": "native",
            "quality": "preview",
            "seed": 42,
        })
        result = self.h.wait_task(f"/v2/query/video_generation/{task_id}")
        task = result["task"]
        self.assertEqual(task["status"], "succeeded")
        self.assertAlmostEqual(task["duration"], 124 / 24, places=3)

        graph = self.fake.graphs[0]
        self.assertEqual(graph["6"]["class_type"], "MiniMaxH3Director")
        inputs = graph["6"]["inputs"]
        self.assertEqual(inputs["width"], 864)
        self.assertEqual(inputs["height"], 480)
        self.assertEqual(inputs["total_frames"], 124)
        self.assertEqual(inputs["steps"], 4)
        self.assertEqual(inputs["seed"], 42)
        self.assertEqual(inputs["cfg"], 1.0)
        self.assertEqual(graph["7"]["inputs"]["audio"], ["6", 1])
        self.assertIn("turbo_4step", graph["2"]["inputs"]["lora_name"])

        timeline = json.loads(inputs["timeline_data"])
        self.assertEqual(timeline["timelineMode"], "t2v")
        self.assertEqual(timeline["totalFrames"], 124)
        self.assertEqual(timeline["segments"][0]["prompt"][:5], "Audio")
        self.assertEqual(graph["8"]["inputs"]["filename_prefix"].split("/")[0], "h3")

        url = task["content"]["url"]
        parsed = urllib.parse.urlsplit(url)
        self.assertIn("expires", parsed.query)
        self.assertIn("sig", parsed.query)
        status, headers, body = self.h.request("GET", url)
        self.assertEqual(status, 200)
        self.assertEqual(body, PAYLOAD_MP4)
        self.assertEqual(headers.get("Content-Type"), "video/mp4")

    def test_fl2v_and_silent_quality_final(self):
        task_id = self._submit({
            "content": [
                {"type": "text", "text": "turn around"},
                {"type": "image_url", "image_url": {"url": PNG_DATA_URL}, "role": "first_frame"},
                {"type": "image_url", "image_url": {"url": PNG_DATA_URL_2}, "role": "last_frame"},
            ],
            "duration": 3,
            "resolution_tier": "720p",
            "aspect_ratio": "9:16",
            "audio_mode": "silent",
            "quality": "final",
        })
        result = self.h.wait_task(f"/v2/query/video_generation/{task_id}")
        self.assertEqual(result["task"]["status"], "succeeded")
        graph = self.fake.graphs[0]
        inputs = graph["6"]["inputs"]
        self.assertEqual((inputs["width"], inputs["height"]), (768, 1376))
        self.assertEqual(inputs["steps"], 8)
        self.assertIn("turbo_8step", graph["2"]["inputs"]["lora_name"])
        self.assertNotIn("audio", graph["7"]["inputs"])
        self.assertTrue(inputs["task_type"].startswith("fl2v"))
        self.assertIn("silent video", inputs["global_prompt"])

        timeline = json.loads(inputs["timeline_data"])
        self.assertEqual(timeline["timelineMode"], "fl2v")
        shot = timeline["shots"][0]
        self.assertTrue(shot["startImage"]["imageFile"])
        self.assertTrue(shot["endImage"]["imageFile"])
        self.assertEqual(len(self.fake.uploads), 2)

    def test_r2v_reference_timeline(self):
        task_id = self._submit({
            "content": [
                {"type": "text", "text": "two heroes fight"},
                {"type": "image_url", "image_url": {"url": PNG_DATA_URL}, "role": "reference_image"},
                {"type": "image_url", "image_url": {"url": PNG_DATA_URL_2}, "role": "reference_image"},
            ],
            "duration": 5,
            "resolution_tier": "480p",
            "aspect_ratio": "1:1",
            "quality": "preview",
        })
        result = self.h.wait_task(f"/v2/query/video_generation/{task_id}")
        self.assertEqual(result["task"]["status"], "succeeded")
        timeline = json.loads(self.fake.graphs[0]["6"]["inputs"]["timeline_data"])
        self.assertEqual(timeline["timelineMode"], "r2v")
        self.assertEqual(timeline["shots"], [])
        self.assertEqual(len(timeline["segments"][0]["refs"]), 2)
        self.assertEqual(len(self.fake.uploads), 2)

    def test_r2v_uses_ref2va_base_and_ref2v_lora(self):
        for quality in ("preview", "final"):
            with self.subTest(quality=quality):
                before = len(self.fake.graphs)
                task_id = self._submit({
                    "content": [
                        {"type": "text", "text": "two heroes fight"},
                        {"type": "image_url", "image_url": {"url": PNG_DATA_URL}, "role": "reference_image"},
                    ],
                    "duration": 5,
                    "resolution_tier": "480p",
                    "aspect_ratio": "16:9",
                    "quality": quality,
                })
                result = self.h.wait_task(f"/v2/query/video_generation/{task_id}")
                self.assertEqual(result["task"]["status"], "succeeded")
                graph = self.fake.graphs[before]
                self.assertEqual(
                    graph["1"]["inputs"]["unet_name"],
                    "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
                )
                self.assertIn("ref2v_turbo_4step", graph["2"]["inputs"]["lora_name"])
                self.assertNotIn("fl2v_turbo", graph["2"]["inputs"]["lora_name"])
                self.assertEqual(graph["6"]["inputs"]["steps"], 4)
                self.assertTrue(graph["6"]["inputs"]["task_type"].startswith("r2v"))

    def test_t2v_and_fl2v_stay_on_fl2va_base(self):
        cases = [
            ("preview", "turbo_4step", 4),
            ("final", "turbo_8step", 8),
        ]
        for quality, lora_part, steps in cases:
            with self.subTest(quality=quality):
                before = len(self.fake.graphs)
                task_id = self._submit({
                    "content": [{"type": "text", "text": "a cat walks on the moon"}],
                    "duration": 5,
                    "resolution_tier": "480p",
                    "aspect_ratio": "16:9",
                    "quality": quality,
                })
                result = self.h.wait_task(f"/v2/query/video_generation/{task_id}")
                self.assertEqual(result["task"]["status"], "succeeded")
                graph = self.fake.graphs[before]
                self.assertEqual(
                    graph["1"]["inputs"]["unet_name"],
                    "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
                )
                self.assertIn(lora_part, graph["2"]["inputs"]["lora_name"])
                self.assertEqual(graph["6"]["inputs"]["steps"], steps)

        before = len(self.fake.graphs)
        task_id = self._submit({
            "content": [
                {"type": "text", "text": "turn around"},
                {"type": "image_url", "image_url": {"url": PNG_DATA_URL}, "role": "first_frame"},
                {"type": "image_url", "image_url": {"url": PNG_DATA_URL_2}, "role": "last_frame"},
            ],
            "duration": 5,
            "resolution_tier": "480p",
            "aspect_ratio": "16:9",
            "quality": "final",
        })
        result = self.h.wait_task(f"/v2/query/video_generation/{task_id}")
        self.assertEqual(result["task"]["status"], "succeeded")
        graph = self.fake.graphs[before]
        self.assertEqual(
            graph["1"]["inputs"]["unet_name"],
            "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        )
        self.assertIn("fl2v_turbo_8step", graph["2"]["inputs"]["lora_name"])

    def test_rejects_video_and_audio_references(self):
        status, _, body = self.h.json("POST", "/v2/video_generation", {
            "content": [
                {"type": "text", "text": "x"},
                {"type": "video_url", "video_url": {"url": "http://example.com/a.mp4"}, "role": "reference_video"},
            ],
        }, headers=self.h.auth)
        self.assertEqual(status, 400)
        self.assertIn("参考视频", body["error"]["message"])
        status, _, body = self.h.json("POST", "/v2/video_generation", {
            "content": [
                {"type": "text", "text": "x"},
                {"type": "audio_url", "audio_url": {"url": "http://example.com/a.mp3"}, "role": "reference_audio"},
            ],
        }, headers=self.h.auth)
        self.assertEqual(status, 400)
        self.assertIn("参考音频", body["error"]["message"])

    def test_rejects_last_frame_without_first(self):
        status, _, body = self.h.json("POST", "/v2/video_generation", {
            "content": [
                {"type": "text", "text": "x"},
                {"type": "image_url", "image_url": {"url": PNG_DATA_URL}, "role": "last_frame"},
            ],
        }, headers=self.h.auth)
        self.assertEqual(status, 400)
        self.assertIn("尾帧", body["error"]["message"])

    def test_loopback_reference_is_rejected_by_ssrf_guard(self):
        task_id = self._submit({
            "content": [
                {"type": "text", "text": "x"},
                {"type": "image_url", "image_url": {"url": "http://127.0.0.1:5679/static/a.png"}, "role": "first_frame"},
            ],
            "duration": 1,
        })
        result = self.h.wait_task(f"/v2/query/video_generation/{task_id}")
        self.assertEqual(result["task"]["status"], "failed")
        self.assertIn("不允许", result["task"]["error"]["message"])

    def test_comfy_error_is_readable(self):
        self.fake.error_entry = {
            "status": {
                "status_str": "error",
                "messages": [["execution_error", {"node_type": "MiniMaxH3Director", "exception_message": "CUDA out of memory"}]],
            },
            "outputs": {},
        }
        task_id = self._submit({
            "content": [{"type": "text", "text": "x"}],
            "duration": 1,
        })
        result = self.h.wait_task(f"/v2/query/video_generation/{task_id}")
        self.assertEqual(result["task"]["status"], "failed")
        self.assertIn("CUDA out of memory", result["task"]["error"]["message"])

    def test_unknown_video_task_is_404(self):
        status, _, body = self.h.json("GET", "/v2/query/video_generation/nope", headers=self.h.auth)
        self.assertEqual(status, 404)
        self.assertEqual(body["task"]["status"], "failed")


class TestImageSubmit(BaseCase):
    def test_models_and_t2i(self):
        status, _, models = self.h.json("GET", "/v1/models", headers=self.h.auth)
        self.assertEqual(status, 200)
        self.assertEqual(models["data"][0]["id"], "qwen-image")

        status, _, body = self.h.json("POST", "/v1/images/generations", {
            "model": "qwen-image",
            "prompt": "a red fox",
            "size": "1024x768",
            "n": 1,
            "response_format": "url",
        }, headers=self.h.auth)
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "processing")
        self.assertTrue(body["id"])

        result = self.h.wait_task(f"/v1/images/task/{body['id']}")
        self.assertEqual(result["status"], "completed")
        self.assertIn("sig=", result["image_url"])
        status, headers, data = self.h.request("GET", result["image_url"])
        self.assertEqual(status, 200)
        self.assertEqual(data, PNG_1X1)
        self.assertEqual(headers.get("Content-Type"), "image/png")

        graph = self.fake.graphs[0]
        self.assertEqual(graph["4"]["inputs"]["text"], "a red fox")
        self.assertEqual(graph["6"]["inputs"], {"width": 1024, "height": 768, "batch_size": 1})
        self.assertEqual(graph["7"]["inputs"]["steps"], 25)
        self.assertEqual(graph["7"]["inputs"]["cfg"], 4.0)
        self.assertIn("低质量", graph["5"]["inputs"]["text"])

    def test_b64_response(self):
        status, _, body = self.h.json("POST", "/v1/images/generations", {
            "prompt": "a red fox",
            "size": "1024x1024",
            "response_format": "b64_json",
        }, headers=self.h.auth)
        self.assertEqual(status, 200)
        result = self.h.wait_task(f"/v1/images/task/{body['id']}")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(base64.b64decode(result["data"][0]["b64_json"]), PNG_1X1)

    def test_edits_multipart_uses_first_reference_and_warns(self):
        raw, ctype = multipart_body(
            {"model": "qwen-image", "prompt": "same fox in snow", "size": "512x512", "n": "1"},
            [
                ("image[]", ("a.png", "image/png", PNG_1X1)),
                ("image[]", ("b.jpg", "image/jpeg", b"\xff\xd8\xff" + b"y" * 128)),
            ],
        )
        status, _, body = self.h.json(
            "POST", "/v1/images/edits", body=raw, ctype=ctype, headers=self.h.auth,
        )
        self.assertEqual(status, 200, body)
        self.assertIn("只使用第 1 张", body["warning"])
        result = self.h.wait_task(f"/v1/images/task/{body['id']}")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(self.fake.uploads), 1)
        graph = self.fake.graphs[0]
        self.assertEqual(graph["6"]["class_type"], "LoadImage")
        self.assertEqual(graph["9"]["inputs"]["denoise"], 0.6)
        self.assertEqual(graph["7"]["inputs"]["width"], 512)
        self.assertIn("same fox in snow", graph["4"]["inputs"]["text"])

    def test_invalid_image_size_is_clamped(self):
        for requested, expected in [
            ("100x100", (256, 256)),
            ("4096x4096", (2048, 2048)),
            ("1001x999", (1000, 992)),
        ]:
            status, _, body = self.h.json("POST", "/v1/images/generations", {
                "prompt": "x", "size": requested,
            }, headers=self.h.auth)
            self.assertEqual(status, 200)
            result = self.h.wait_task(f"/v1/images/task/{body['id']}")
            self.assertEqual(result["status"], "completed")
            graph = self.fake.graphs[-1]
            self.assertEqual(
                (graph["6"]["inputs"]["width"], graph["6"]["inputs"]["height"]),
                expected,
                requested,
            )

    def test_image_requires_prompt_and_reference(self):
        status, _, body = self.h.json("POST", "/v1/images/generations", {"prompt": ""}, headers=self.h.auth)
        self.assertEqual(status, 400)
        raw, ctype = multipart_body({"prompt": "x"}, [])
        status, _, body = self.h.json("POST", "/v1/images/edits", body=raw, ctype=ctype, headers=self.h.auth)
        self.assertEqual(status, 400)

    def test_unknown_image_task_is_404(self):
        status, _, body = self.h.json("GET", "/v1/images/task/nope", headers=self.h.auth)
        self.assertEqual(status, 404)
        self.assertEqual(body["status"], "failed")


class TestSignedFiles(BaseCase):
    def _write(self, name, data=PAYLOAD_MP4):
        path = os.path.join(self.h.settings.data_dir, "files", name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def test_valid_expired_and_tampered_signature(self):
        self._write("signed.mp4")
        expires = int(time.time()) + 60
        sig = gw.media_signature(SIGN_KEY, "signed.mp4", expires)
        url = f"/files/signed.mp4?expires={expires}&sig={sig}"
        status, _, body = self.h.request("GET", url)
        self.assertEqual(status, 200)
        self.assertEqual(body, PAYLOAD_MP4)

        expired = int(time.time()) - 1
        sig = gw.media_signature(SIGN_KEY, "signed.mp4", expired)
        status, _, _ = self.h.request("GET", f"/files/signed.mp4?expires={expired}&sig={sig}")
        self.assertEqual(status, 403)

        status, _, _ = self.h.request("GET", f"/files/signed.mp4?expires={expires}&sig=deadbeef")
        self.assertEqual(status, 403)

        status, _, _ = self.h.request("GET", "/files/signed.mp4")
        self.assertEqual(status, 403)

    def test_bearer_can_download_and_traversal_is_blocked(self):
        self._write("manual.png", PNG_1X1)
        status, _, body = self.h.request("GET", "/files/manual.png", headers=self.h.auth)
        self.assertEqual(status, 200)
        self.assertEqual(body, PNG_1X1)
        status, _, _ = self.h.request("GET", "/files/..%2F..%2Fetc%2Fpasswd", headers=self.h.auth)
        self.assertEqual(status, 404)

    def test_head_file(self):
        self._write("head.png", PNG_1X1)
        status, headers, body = self.h.request("HEAD", "/files/head.png", headers=self.h.auth)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Length"), str(len(PNG_1X1)))
        self.assertEqual(body, b"")


class TestComfyProxy(BaseCase):
    def test_proxy_requires_auth(self):
        status, _, _ = self.h.json("GET", "/comfyui/system_stats")
        self.assertEqual(status, 401)

    def test_proxy_bearer_and_query_token(self):
        status, _, payload = self.h.json("GET", "/comfyui/system_stats", headers=self.h.auth)
        self.assertEqual(status, 200)
        self.assertEqual(payload["system"]["os"], "fake")
        status, _, payload = self.h.json("GET", "/comfyui/system_stats?token=" + TOKEN)
        self.assertEqual(status, 200)

    def test_proxy_strips_token_and_blocks_other_paths(self):
        status, _, _ = self.h.json("GET", "/comfyui/prompt", headers=self.h.auth)
        self.assertEqual(status, 404)
        status, _, payload = self.h.json(
            "POST", "/comfyui/prompt", {"prompt": {"1": {"class_type": "X", "inputs": {}}}},
            headers=self.h.auth,
        )
        self.assertEqual(status, 200)
        self.assertIn("prompt_id", payload)

    def test_non_comfy_path_not_proxied(self):
        status, _, _ = self.h.json("GET", "/system_stats", headers=self.h.auth)
        self.assertEqual(status, 404)

    def _ui_path(self):
        status, _, payload = self.h.json("POST", "/comfyui/ui-session", headers=self.h.auth)
        self.assertEqual(status, 200)
        self.assertTrue(payload["path"].startswith("/comfyui/ui/"))
        self.assertTrue(payload["path"].endswith("/"))
        return payload["path"]

    def test_ui_session_requires_token(self):
        status, _, _ = self.h.json("POST", "/comfyui/ui-session")
        self.assertEqual(status, 401)
        status, _, _ = self.h.json("GET", "/comfyui/ui-session", headers=self.h.auth)
        self.assertEqual(status, 404)

    def test_ui_page_assets_and_api(self):
        path = self._ui_path()
        status, headers, body = self.h.request("GET", path)
        self.assertEqual(status, 200)
        self.assertIn(b"./assets/app.js", body)
        self.assertEqual(headers.get("Referrer-Policy"), "no-referrer")
        status, _, body = self.h.request("GET", path + "assets/app.js")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"console.log('comfy')")
        status, _, payload = self.h.json("GET", path + "api/system_stats")
        self.assertEqual(status, 200)
        self.assertEqual(payload["system"]["os"], "fake-api")

    def test_ui_missing_trailing_slash_redirects(self):
        path = self._ui_path()
        status, _, body = self.h.request("GET", path.rstrip("/"))
        self.assertEqual(status, 200)
        self.assertIn(b"./assets/app.js", body)

    def test_ui_readonly_policy(self):
        path = self._ui_path()
        status, _, _ = self.h.json("POST", path + "api/prompt", {"prompt": {}})
        self.assertEqual(status, 404)
        status, _, _ = self.h.json("POST", path + "prompt", {"prompt": {}})
        self.assertEqual(status, 404)
        status, _, payload = self.h.json("POST", path + "api/settings", {"theme": "dark"})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        # 白名单必须按归一化路径判断，点段/编码分隔符不得穿透到 /api/prompt
        for suffix in (
            "api/settings/../prompt",
            "api/settings/%2e%2e/prompt",
            "api/userdata/../prompt",
            "api/settings//../prompt",
            "api/settings;x/../prompt",
        ):
            status, _, _ = self.h.json("POST", path + suffix, {"prompt": {}})
            self.assertEqual(status, 403, suffix)

    def test_ui_ticket_expiry(self):
        expired = gw.ui_session_ticket(SIGN_KEY, int(time.time()) - 1)
        self.assertFalse(gw.ui_session_valid(SIGN_KEY, expired))
        valid = gw.ui_session_ticket(SIGN_KEY, int(time.time()) + 60)
        self.assertTrue(gw.ui_session_valid(SIGN_KEY, valid))
        self.assertFalse(gw.ui_session_valid(SIGN_KEY, "bad"))
        expires = int(time.time()) + 60
        ticket = gw.ui_session_ticket(SIGN_KEY, expires)
        self.assertTrue(gw.ui_session_valid(SIGN_KEY, ticket, now=expires - 1))
        self.assertFalse(gw.ui_session_valid(SIGN_KEY, ticket, now=expires))
        self.assertFalse(gw.ui_session_valid(SIGN_KEY, f"{expires}.éé"))

    def test_ui_websocket_relay(self):
        path = self._ui_path()
        url = urllib.parse.urlsplit(self.h.base)
        sock = socket.create_connection((url.hostname, url.port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET {path}ws HTTP/1.1\r\n"
            f"Host: {url.netloc}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        sock.sendall(request.encode())
        response = b""
        while b"\r\n\r\n" not in response:
            response += sock.recv(4096)
        head, _, tail = response.partition(b"\r\n\r\n")
        self.assertIn(b" 101 ", head.split(b"\r\n", 1)[0])
        while len(tail) < 7:
            tail += sock.recv(7 - len(tail))
        self.assertEqual(tail[:7], b"\x81\x05hello")
        sock.close()


class TestUnits(unittest.TestCase):
    def test_mode_quality_presets_override_global_without_touching_other_modes(self):
        video = {
            "quality_presets": {
                "preview": {"lora": "fl2v_4step.safetensors", "steps": 4},
                "final": {"lora": "fl2v_8step.safetensors", "steps": 8},
            },
            "mode_quality_presets": {
                "r2v": {
                    "preview": {"lora": "ref2v_4step.safetensors", "steps": 4},
                    "final": {"lora": "ref2v_4step.safetensors", "steps": 4},
                },
            },
            "default_quality": "preview",
        }
        self.assertEqual(
            gw.resolve_video_quality(video, "r2v", "final"),
            ("final", {"lora": "ref2v_4step.safetensors", "steps": 4}),
        )
        self.assertEqual(
            gw.resolve_video_quality(video, "t2v", "final"),
            ("final", {"lora": "fl2v_8step.safetensors", "steps": 8}),
        )
        self.assertEqual(
            gw.resolve_video_quality(video, "fl2v", None),
            ("preview", {"lora": "fl2v_4step.safetensors", "steps": 4}),
        )
        self.assertEqual(
            gw.resolve_video_quality(video, "r2v", "unknown"),
            ("preview", {"lora": "ref2v_4step.safetensors", "steps": 4}),
        )

    def test_frame_grid(self):
        cases = {1: 22, 3: 73, 5: 124, 10: 243, 15: 362}
        for duration, frames in cases.items():
            self.assertEqual(gw.frames_for(duration), frames, duration)
        self.assertEqual(gw.frames_for(None), 124)

    def test_canvas(self):
        cases = [
            (("480p", "16:9"), (864, 480)),
            (("480p", "9:16"), (480, 864)),
            (("720p", "16:9"), (1376, 768)),
            (("1080p", "16:9"), (1920, 1088)),
            (("1080p", "4:3"), (1440, 1088)),
            (("768P", "21:9"), (1792, 768)),
            (("480p", "1:1"), (480, 480)),
            (("", ""), (864, 480)),
        ]
        for args, expected in cases:
            self.assertEqual(gw.resolve_canvas(*args), expected, args)

    def test_image_size_parse(self):
        self.assertEqual(gw.parse_image_size("1024x768"), (1024, 768))
        self.assertEqual(gw.parse_image_size("100x100"), (256, 256))
        self.assertEqual(gw.parse_image_size("9999x1"), (2048, 256))
        self.assertEqual(gw.parse_image_size("abc"), (1024, 1024))

    def test_render_workflow_types_and_embedded_placeholders(self):
        template = {
            "a": "__STEPS__",
            "b": "__CFG__",
            "c": "prefix-__SEED__",
            "d": "__UNKNOWN__",
            "e": ["__WIDTH__", {"f": "__NEGATIVE__"}],
        }
        out = gw.render_workflow(template, {
            "__STEPS__": 8,
            "__CFG__": 1.0,
            "__SEED__": 42,
            "__WIDTH__": 864,
            "__NEGATIVE__": "bad",
        })
        self.assertEqual(out, {
            "a": 8, "b": 1.0, "c": "prefix-42", "d": "__UNKNOWN__",
            "e": [864, {"f": "bad"}],
        })
        self.assertIsInstance(out["a"], int)
        self.assertIsInstance(out["b"], float)

    def test_audio_directive_replaces_existing_lines(self):
        directives = {
            "native": "Audio: native.",
            "ambient": "Audio: ambient only.",
            "silent": "Audio: silent.",
        }
        self.assertEqual(gw.with_audio_directive("音频：说话\nscene", "ambient", directives), "Audio: ambient only.\nscene")
        self.assertTrue(gw.with_audio_directive("scene", "native", directives).startswith("Audio: native."))

    def test_ssrf_guard(self):
        for url in [
            "http://127.0.0.1/x.png",
            "http://localhost/x.png",
            "http://10.0.0.1/x.png",
            "http://[::1]/x.png",
            "file:///etc/passwd",
            "ftp://example.com/a.png",
        ]:
            with self.assertRaises(ValueError, msg=url):
                gw.assert_public_url(url)

    def test_data_url_decode(self):
        data, ctype = gw.decode_data_url(PNG_DATA_URL)
        self.assertEqual(data, PNG_1X1)
        self.assertEqual(ctype, "image/png")
        with self.assertRaises(ValueError):
            gw.decode_data_url("data:text/plain;base64,aGk=")

    def test_media_signature_is_stable(self):
        self.assertEqual(
            gw.media_signature(SIGN_KEY, "a.mp4", 100),
            gw.media_signature(SIGN_KEY, "a.mp4", 100),
        )
        self.assertNotEqual(
            gw.media_signature(SIGN_KEY, "a.mp4", 100),
            gw.media_signature(SIGN_KEY, "b.mp4", 100),
        )


class TestQueueLimit(BaseCase):
    queue_limit = 0

    def test_queue_full_returns_429(self):
        status, _, body = self.h.json("POST", "/v2/video_generation", {
            "content": [{"type": "text", "text": "x"}],
        }, headers=self.h.auth)
        self.assertEqual(status, 429)
        self.assertEqual(body["error"]["code"], "queue_full")


class TestRestartRecovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="h3gw-resume-")
        self.fake = FakeComfy()

    def tearDown(self):
        self.fake.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_processing_task_resumes_and_queued_task_fails(self):
        pid = "resume1"
        self.fake.register_output(pid, "video")
        tasks = [
            {
                "id": "processing1", "kind": "video", "mode": "t2v", "state": "processing",
                "created_at": time.time() - 10, "updated_at": time.time() - 10,
                "pid": pid, "file": None, "duration": 5.0, "error": None, "warning": None,
                "response_format": "url", "frames": 124, "width": 864, "height": 480,
                "quality": "preview",
            },
            {
                "id": "queued1", "kind": "video", "mode": "t2v", "state": "queued",
                "created_at": time.time() - 10, "updated_at": time.time() - 10,
                "pid": None, "file": None, "duration": 5.0, "error": None, "warning": None,
                "response_format": "url", "frames": 124, "width": 864, "height": 480,
                "quality": "preview",
            },
        ]
        os.makedirs(self.tmp, exist_ok=True)
        with open(os.path.join(self.tmp, "tasks.json"), "w") as fh:
            json.dump(tasks, fh)

        h = Harness(self.tmp, self.fake.url)
        try:
            result = h.wait_task("/v2/query/video_generation/processing1")
            self.assertEqual(result["task"]["status"], "succeeded")
            self.assertTrue(os.path.exists(os.path.join(self.tmp, "files", "processing1.mp4")))

            status, _, result = h.json("GET", "/v2/query/video_generation/queued1", headers=h.auth)
            self.assertEqual(status, 200)
            self.assertEqual(result["task"]["status"], "failed")
            self.assertIn("重启", result["task"]["error"]["message"])
        finally:
            h.close()

    def test_missing_output_marks_failed(self):
        tasks = [{
            "id": "gone1", "kind": "image", "mode": "t2i", "state": "succeeded",
            "created_at": time.time(), "updated_at": time.time(),
            "pid": "x", "file": "gone1.png", "duration": None, "error": None, "warning": None,
            "response_format": "url", "frames": None, "width": 512, "height": 512, "quality": None,
        }]
        with open(os.path.join(self.tmp, "tasks.json"), "w") as fh:
            json.dump(tasks, fh)
        h = Harness(self.tmp, self.fake.url)
        try:
            status, _, result = h.json("GET", "/v1/images/task/gone1", headers=h.auth)
            self.assertEqual(status, 200)
            self.assertEqual(result["status"], "failed")
        finally:
            h.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
