#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""管理端 Web：登录、设置、工作流 CRUD/导入、API Key 与审计。"""
import json
import os
import re
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
GATEWAY_DIR = os.path.dirname(HERE)
sys.path.insert(0, GATEWAY_DIR)
sys.path.insert(0, HERE)

try:
    from starlette.testclient import TestClient
except ModuleNotFoundError:  # pragma: no cover - 依赖缺失时明确失败
    raise

from admin import app as admin_app, db  # noqa: E402
from test_admin_import import OBJECT_INFO, audio_ui_graph  # noqa: E402

API_JSON = json.dumps(
    {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": "stable-audio-open-1.0.safetensors"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
        "4": {"class_type": "ConditioningStableAudio",
              "inputs": {"positive": ["2", 0], "negative": ["3", 0],
                         "seconds_start": 0.0, "seconds_total": 30.0}},
        "5": {"class_type": "EmptyLatentAudio", "inputs": {"seconds": 30.0, "batch_size": 1}},
        "6": {"class_type": "KSampler",
              "inputs": {"model": ["1", 0], "seed": 1, "steps": 100, "cfg": 6.0,
                         "sampler_name": "euler", "scheduler": "simple",
                         "positive": ["4", 0], "negative": ["4", 1], "latent_image": ["5", 0],
                         "denoise": 1.0}},
        "7": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
        "8": {"class_type": "SaveAudio", "inputs": {"audio": ["7", 0], "filename_prefix": "audio/h3"}},
    },
    ensure_ascii=False,
)
INPUT_MAP = json.dumps({
    "prompt": {"node": "2", "input": "text", "type": "text"},
    "negative_prompt": {"node": "3", "input": "text", "type": "text", "optional": True},
    "seconds": {"targets": [{"node": "4", "input": "seconds_total"},
                            {"node": "5", "input": "seconds"}], "type": "number"},
    "seed": {"node": "6", "input": "seed", "type": "integer"},
})


class FakeComfyAdmin:
    def __init__(self):
        self.prompts = []
        self.requests = []
        handler = self._handler()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def _handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, payload, status=200):
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                fake.requests.append(self.path)
                parsed = urlparse(self.path)
                if parsed.path == "/object_info":
                    return self._send(OBJECT_INFO)
                if parsed.path == "/userdata":
                    return self._send([
                        {"name": "stable-audio.json", "path": "workflows/stable-audio.json",
                         "type": "file", "size": 100},
                        {"name": "folder", "path": "workflows/folder", "type": "directory"},
                    ])
                if parsed.path == "/userdata/workflows%2Fstable-audio.json":
                    return self._send(audio_ui_graph())
                if parsed.path.startswith("/history/"):
                    return self._send({})
                return self._send({"error": "not found"}, 404)

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b"{}"
                fake.prompts.append(json.loads(body or b"{}"))
                if urlparse(self.path).path == "/prompt":
                    return self._send({"prompt_id": "prompt-admin-test"})
                return self._send({"error": "not found"}, 404)

        return Handler


class AdminAppCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = FakeComfyAdmin()

    @classmethod
    def tearDownClass(cls):
        cls.fake.close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake.prompts.clear()
        self.db_path = os.path.join(self.tmp.name, "gateway.db")
        db.init_db(self.db_path)
        db.create_admin_user(self.db_path, "admin", "secret123")
        db.set_setting(self.db_path, "comfy_url", self.fake.url)
        self.app = admin_app.create_app(
            db_path=self.db_path, secret_key="test-secret-key", secure_cookies=False,
        )
        self.client = TestClient(self.app, base_url="http://testserver")

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    # -- 辅助 -------------------------------------------------------------

    def csrf(self, path="/login"):
        response = self.client.get(path)
        match = re.search(r'name="csrf" value="([^"]+)"', response.text)
        self.assertIsNotNone(match, "页面缺少 CSRF 字段")
        return match.group(1)

    def login(self, username="admin", password="secret123"):
        token = self.csrf("/login")
        return self.client.post(
            "/login", data={"username": username, "password": password, "csrf": token},
            follow_redirects=False,
        )

    def login_ok(self):
        response = self.login()
        self.assertEqual(response.status_code, 303, response.text)

    def token_after_login(self, path="/settings"):
        return self.csrf(path)

    # -- 认证 -------------------------------------------------------------

    def test_anonymous_redirected_to_login(self):
        response = self.client.get("/", follow_redirects=False)
        self.assertEqual(response.status_code, 303)
        self.assertTrue(response.headers["location"].startswith("/login"))

    def test_login_rejects_wrong_password(self):
        response = self.login(password="wrong-password")
        self.assertEqual(response.status_code, 400)
        self.assertIn("用户名或密码错误", response.text)

    def test_login_and_dashboard(self):
        self.login_ok()
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("工作流", response.text)
        self.assertIn("admin", response.text)

    def test_post_requires_csrf(self):
        self.login_ok()
        response = self.client.post("/settings", data={"comfy_url": "http://evil"})
        self.assertEqual(response.status_code, 403)

    def test_logout_clears_session(self):
        self.login_ok()
        token = self.token_after_login("/")
        response = self.client.post("/logout", data={"csrf": token}, follow_redirects=False)
        self.assertEqual(response.status_code, 303)
        self.assertEqual(
            self.client.get("/", follow_redirects=False).status_code, 303,
        )

    def test_login_rate_limited(self):
        token = self.csrf("/login")
        for _ in range(5):
            self.client.post(
                "/login", data={"username": "admin", "password": "nope", "csrf": token},
            )
        token = self.csrf("/login")
        response = self.client.post(
            "/login", data={"username": "admin", "password": "nope", "csrf": token},
        )
        self.assertEqual(response.status_code, 429)

    # -- 设置 -------------------------------------------------------------

    def test_save_settings_and_test_connectivity(self):
        self.login_ok()
        token = self.token_after_login("/settings")
        response = self.client.post(
            "/settings", data={"comfy_url": self.fake.url + "/", "csrf": token},
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 303)
        self.assertEqual(db.get_setting(self.db_path, "comfy_url"), self.fake.url + "/")

        token = self.token_after_login("/settings")
        response = self.client.post(
            "/settings/test", data={"comfy_url": self.fake.url, "csrf": token},
        )
        self.assertIn("可用", response.text)
        self.assertIn(str(len(OBJECT_INFO)), response.text)

    def test_settings_test_reports_unreachable(self):
        self.login_ok()
        token = self.token_after_login("/settings")
        response = self.client.post(
            "/settings/test",
            data={"comfy_url": "http://127.0.0.1:1", "csrf": token},
        )
        self.assertIn("不可达", response.text)

    # -- 工作流 -----------------------------------------------------------

    def create_workflow(self, slug="stable-audio"):
        self.login_ok()
        token = self.token_after_login("/workflows/new")
        response = self.client.post(
            "/workflows/new",
            data={
                "slug": slug, "name": "雨声生成", "kind": "audio", "description": "测试",
                "workflow_json": API_JSON, "input_map": INPUT_MAP,
                "output_node": "8", "output_key": "audio", "output_exts": "wav",
                "example_json": json.dumps({"prompt": "rain", "seconds": 12}),
                "is_active": "on", "csrf": token,
            },
            follow_redirects=False,
        )
        return response

    def test_create_workflow(self):
        response = self.create_workflow()
        self.assertEqual(response.status_code, 303, response.text)
        row = db.get_workflow(self.db_path, "stable-audio")
        self.assertEqual(row["kind"], "audio")
        self.assertEqual(row["output_node"], "8")
        self.assertEqual(row["output_exts"], ["wav"])
        page = self.client.get("/workflows")
        self.assertIn("stable-audio", page.text)

    def test_create_workflow_reports_validation_error(self):
        self.login_ok()
        token = self.token_after_login("/workflows/new")
        response = self.client.post(
            "/workflows/new",
            data={
                "slug": "broken", "name": "坏流程", "kind": "audio",
                "workflow_json": API_JSON,
                "input_map": json.dumps({"prompt": {"node": "99", "input": "text"}}),
                "csrf": token,
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("99", response.text)
        self.assertIsNone(db.get_workflow(self.db_path, "broken"))

    def test_toggle_and_delete_workflow(self):
        self.create_workflow()
        token = self.token_after_login("/workflows")
        response = self.client.post(
            "/workflows/stable-audio/toggle", data={"csrf": token}, follow_redirects=False,
        )
        self.assertEqual(response.status_code, 303)
        self.assertFalse(db.get_workflow(self.db_path, "stable-audio")["is_active"])

        token = self.token_after_login("/workflows")
        response = self.client.post(
            "/workflows/stable-audio/delete", data={"csrf": token}, follow_redirects=False,
        )
        self.assertEqual(response.status_code, 303)
        self.assertIsNone(db.get_workflow(self.db_path, "stable-audio"))

    def test_edit_workflow(self):
        self.create_workflow()
        token = self.token_after_login("/workflows/stable-audio/edit")
        response = self.client.post(
            "/workflows/stable-audio/edit",
            data={
                "slug": "stable-audio", "name": "雨声生成 v2", "kind": "audio",
                "workflow_json": API_JSON, "input_map": INPUT_MAP,
                "output_node": "8", "output_key": "audio", "output_exts": "wav,mp3",
                "is_active": "on", "csrf": token,
            },
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 303)
        row = db.get_workflow(self.db_path, "stable-audio")
        self.assertEqual(row["name"], "雨声生成 v2")
        self.assertEqual(row["output_exts"], ["wav", "mp3"])

    def test_validate_only_test_endpoint(self):
        self.create_workflow()
        token = self.token_after_login("/workflows/stable-audio/test")
        response = self.client.post(
            "/workflows/stable-audio/test",
            data={"inputs": "{}", "csrf": token},
        )
        self.assertIn("校验通过", response.text)
        self.assertEqual(self.fake.prompts, [])

    def test_run_test_endpoint_submits_prompt(self):
        self.create_workflow()
        token = self.token_after_login("/workflows/stable-audio/test")
        response = self.client.post(
            "/workflows/stable-audio/test",
            data={
                "inputs": json.dumps({"prompt": "rain", "seconds": 8, "seed": 42}),
                "run": "on", "csrf": token,
            },
        )
        self.assertIn("prompt-admin-test", response.text)
        self.assertEqual(len(self.fake.prompts), 1)
        graph = self.fake.prompts[0]["prompt"]
        self.assertEqual(graph["2"]["inputs"]["text"], "rain")
        self.assertEqual(graph["5"]["inputs"]["seconds"], 8)
        self.assertEqual(graph["6"]["inputs"]["seed"], 42)

    # -- 导入 -------------------------------------------------------------

    def test_import_lists_saved_workflows(self):
        self.login_ok()
        page = self.client.get("/workflows/import")
        self.assertEqual(page.status_code, 200)
        self.assertIn("stable-audio.json", page.text)

    def test_import_preview_and_save(self):
        self.login_ok()
        page = self.client.get(
            "/workflows/import/preview", params={"path": "workflows/stable-audio.json"},
        )
        self.assertEqual(page.status_code, 200)
        self.assertIn("stable-audio", page.text)
        self.assertIn("rain on a tin roof", page.text)

        token = re.search(r'name="csrf" value="([^"]+)"', page.text).group(1)
        response = self.client.post(
            "/workflows/import",
            data={
                "slug": "imported-audio", "name": "导入音频", "kind": "audio",
                "path": "workflows/stable-audio.json",
                "workflow_json": page.text.split('name="workflow_json">', 1)[1].split("</textarea>", 1)[0],
                "input_map": page.text.split('name="input_map">', 1)[1].split("</textarea>", 1)[0],
                "output_node": "8", "output_key": "audio", "output_exts": "wav",
                "is_active": "on", "csrf": token,
            },
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 303, response.text)
        row = db.get_workflow(self.db_path, "imported-audio")
        self.assertEqual(row["source"], "comfyui")
        self.assertEqual(row["source_file"], "workflows/stable-audio.json")
        self.assertEqual(row["workflow"]["8"]["class_type"], "SaveAudio")
        self.assertNotIn("99", row["workflow"])

    # -- API Key ----------------------------------------------------------

    def test_create_and_revoke_api_key(self):
        self.login_ok()
        token = self.token_after_login("/keys")
        response = self.client.post("/keys", data={"name": "剪辑端", "csrf": token})
        self.assertEqual(response.status_code, 200)
        match = re.search(r"(h3_[A-Za-z0-9_-]{10,})", response.text)
        self.assertIsNotNone(match, "创建后应一次性展示完整 Key")
        plain = match.group(1)
        keys = db.list_api_keys(self.db_path)
        self.assertEqual(len(keys), 1)
        self.assertEqual(keys[0]["name"], "剪辑端")
        self.assertTrue(keys[0]["is_active"])

        token = self.token_after_login("/keys")
        response = self.client.post(
            f"/keys/{keys[0]['id']}/revoke", data={"csrf": token}, follow_redirects=False,
        )
        self.assertEqual(response.status_code, 303)
        self.assertFalse(db.list_api_keys(self.db_path)[0]["is_active"])
        self.assertNotIn(
            db.hash_api_key(plain),
            db.GatewayStore(self.db_path).api_key_hashes(),
        )

    # -- 审计 -------------------------------------------------------------

    def test_actions_are_audited(self):
        self.create_workflow()
        logs = db.list_audit(self.db_path)
        actions = {row["action"] for row in logs}
        self.assertIn("workflow.create", actions)
        self.assertIn("login", actions)


if __name__ == "__main__":
    unittest.main()
