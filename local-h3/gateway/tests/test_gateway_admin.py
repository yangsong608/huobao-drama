#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""命名工作流与管理端数据层测试：SQLite 注册表、API Key、/v1/jobs。"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
GATEWAY_DIR = os.path.dirname(HERE)
sys.path.insert(0, GATEWAY_DIR)
sys.path.insert(0, HERE)

import h3_gateway as gw  # noqa: E402
from admin import db as admin_db  # noqa: E402
from test_gateway import (  # noqa: E402
    PNG_1X1,
    TOKEN,
    FakeComfy,
    Harness,
    multipart_body,
)

AUDIO_WORKFLOW = {
    "1": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": "stable-audio-open-1.0.safetensors"},
    },
    "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
    "4": {
        "class_type": "ConditioningStableAudio",
        "inputs": {
            "positive": ["2", 0],
            "negative": ["3", 0],
            "seconds_start": 0.0,
            "seconds_total": 30.0,
        },
    },
    "5": {"class_type": "EmptyLatentAudio", "inputs": {"seconds": 30.0, "batch_size": 1}},
    "6": {
        "class_type": "KSampler",
        "inputs": {"seed": 1, "steps": 100, "cfg": 6.0, "sampler_name": "euler", "scheduler": "simple",
                   "denoise": 1.0, "model": ["1", 0], "positive": ["4", 0], "negative": ["4", 1], "latent_image": ["5", 0]},
    },
    "7": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
    "8": {"class_type": "SaveAudio", "inputs": {"audio": ["7", 0], "filename_prefix": "audio/h3"}},
}

AUDIO_INPUT_MAP = {
    "prompt": {"node": "2", "input": "text", "type": "text"},
    "negative_prompt": {"node": "3", "input": "text", "type": "text", "optional": True},
    "seconds": {
        "targets": [{"node": "4", "input": "seconds_total"}, {"node": "5", "input": "seconds"}],
        "type": "number",
    },
    "seed": {"node": "6", "input": "seed", "type": "integer"},
}


def seed_audio_workflow(db_path, slug="stable-audio", active=True):
    return admin_db.upsert_workflow(db_path, {
        "slug": slug,
        "name": "Stable Audio Open",
        "kind": "audio",
        "description": "环境声测试工作流",
        "workflow": AUDIO_WORKFLOW,
        "input_map": AUDIO_INPUT_MAP,
        "output_node": "8",
        "output_key": "audio",
        "output_exts": ["wav", "mp3", "flac"],
        "example": {"prompt": "rain on a tin roof", "negative_prompt": "music", "seconds": 30, "seed": 7},
        "source": "manual",
        "is_active": active,
    })


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="h3admin-store-")
        self.db_path = os.path.join(self.tmp, "gateway.db")
        admin_db.init_db(self.db_path)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_init_db_is_idempotent_and_keeps_comfy_url_unset(self):
        admin_db.init_db(self.db_path)
        store = admin_db.GatewayStore(self.db_path)
        # 空设置 = 沿用网关环境变量；管理端显式保存后才覆盖
        self.assertEqual(store.get_setting("comfy_url"), "")
        admin_db.set_setting(self.db_path, "comfy_url", "http://127.0.0.1:9000")
        self.assertEqual(admin_db.get_setting(self.db_path, "comfy_url"), "http://127.0.0.1:9000")

    def test_api_key_hash_is_stored_and_revocable(self):
        key, record = admin_db.create_api_key(self.db_path, "剪辑机")
        self.assertTrue(key.startswith("h3_"))
        self.assertEqual(record["name"], "剪辑机")
        store = admin_db.GatewayStore(self.db_path)
        self.assertEqual(store.api_key_hashes(), {admin_db.hash_api_key(key)})
        admin_db.revoke_api_key(self.db_path, record["id"])
        self.assertEqual(admin_db.GatewayStore(self.db_path).api_key_hashes(), set())

    def test_workflow_roundtrip_keeps_types_and_hides_json(self):
        row = seed_audio_workflow(self.db_path)
        store = admin_db.GatewayStore(self.db_path)
        loaded = store.get_workflow("stable-audio")
        self.assertEqual(loaded["kind"], "audio")
        self.assertEqual(loaded["input_map"]["seconds"]["type"], "number")
        self.assertEqual(loaded["workflow"]["8"]["class_type"], "SaveAudio")
        public = admin_db.public_workflow(row)
        self.assertNotIn("workflow", public)
        self.assertEqual(public["inputs"]["prompt"]["type"], "text")

    def test_admin_user_password_roundtrip(self):
        admin_db.create_admin_user(self.db_path, "admin", "correct horse")
        self.assertTrue(admin_db.verify_admin_user(self.db_path, "admin", "correct horse"))
        self.assertFalse(admin_db.verify_admin_user(self.db_path, "admin", "wrong"))
        self.assertFalse(admin_db.verify_admin_user(self.db_path, "admin", ""))


class AdminCase(unittest.TestCase):
    workers = 1

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="h3gw-admin-")
        self.db_path = os.path.join(self.tmp, "gateway.db")
        admin_db.init_db(self.db_path)
        self.fake = FakeComfy()
        self.h = Harness(
            self.tmp,
            self.fake.url,
            H3_DB_PATH=self.db_path,
            H3_WORKERS=self.workers,
        )

    def tearDown(self):
        self.h.close()
        self.fake.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def wait_job(self, job_id, timeout=8, headers=None):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            status, _, payload = self.h.json("GET", f"/v1/jobs/{job_id}", headers=headers or self.h.auth)
            self.assertEqual(status, 200, payload)
            last = payload
            if payload.get("status") in ("succeeded", "failed", "cancelled"):
                return payload
            time.sleep(0.03)
        raise AssertionError(f"job did not finish: {last}")


class TestGatewayNamedWorkflows(AdminCase):
    def test_workflows_require_token_and_hide_workflow_json(self):
        seed_audio_workflow(self.db_path)
        status, _, _ = self.h.json("GET", "/v1/workflows")
        self.assertEqual(status, 401)
        status, _, payload = self.h.json("GET", "/v1/workflows", headers=self.h.auth)
        self.assertEqual(status, 200, payload)
        self.assertEqual([item["slug"] for item in payload["data"]], ["stable-audio"])
        item = payload["data"][0]
        self.assertEqual(item["kind"], "audio")
        self.assertIn("seconds", item["inputs"])
        self.assertNotIn("workflow", item)

    def test_workflow_detail_is_scoped_to_slug(self):
        seed_audio_workflow(self.db_path)
        status, _, payload = self.h.json("GET", "/v1/workflows/stable-audio", headers=self.h.auth)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["data"]["slug"], "stable-audio")
        status, _, _ = self.h.json("GET", "/v1/workflows/missing", headers=self.h.auth)
        self.assertEqual(status, 404)

    def test_database_api_key_authorizes_and_revoke_cuts_access(self):
        key, record = admin_db.create_api_key(self.db_path, "app")
        headers = {"Authorization": f"Bearer {key}"}
        status, _, payload = self.h.json("GET", "/v1/workflows", headers=headers)
        self.assertEqual(status, 200, payload)
        admin_db.revoke_api_key(self.db_path, record["id"])
        status, _, _ = self.h.json("GET", "/v1/workflows", headers=headers)
        self.assertEqual(status, 401)

    def test_audio_job_injects_numeric_inputs_and_returns_signed_file(self):
        seed_audio_workflow(self.db_path)
        status, _, created = self.h.json("POST", "/v1/jobs", {
            "workflow": "stable-audio",
            "inputs": {"prompt": "rain on a tin roof", "negative_prompt": "music", "seconds": 12, "seed": 42},
        }, headers=self.h.auth)
        self.assertEqual(status, 200, created)
        job_id = created["job_id"]
        payload = self.wait_job(job_id)
        self.assertEqual(payload["status"], "succeeded", payload)
        self.assertEqual(payload["workflow"], "stable-audio")
        self.assertEqual(payload["kind"], "audio")
        graph = self.fake.graphs[-1]
        self.assertEqual(graph["2"]["inputs"]["text"], "rain on a tin roof")
        self.assertEqual(graph["3"]["inputs"]["text"], "music")
        self.assertEqual(graph["5"]["inputs"]["seconds"], 12)
        self.assertIsInstance(graph["5"]["inputs"]["seconds"], int)
        self.assertEqual(graph["4"]["inputs"]["seconds_total"], 12)
        self.assertEqual(graph["6"]["inputs"]["seed"], 42)
        self.assertIsInstance(graph["6"]["inputs"]["seed"], int)
        url = payload["file_url"]
        parsed = urllib.parse.urlsplit(url)
        self.assertTrue(parsed.path.startswith("/files/"))
        status, _, body = self.h.request("GET", url)
        self.assertEqual(status, 200)
        self.assertTrue(body.startswith(b"FAKE-WAV-"))

    def test_unknown_and_inactive_workflow_rejected(self):
        status, _, payload = self.h.json("POST", "/v1/jobs", {
            "workflow": "missing", "inputs": {},
        }, headers=self.h.auth)
        self.assertEqual(status, 404, payload)
        seed_audio_workflow(self.db_path, active=False)
        status, _, payload = self.h.json("POST", "/v1/jobs", {
            "workflow": "stable-audio", "inputs": {"prompt": "x", "seconds": 5, "seed": 1},
        }, headers=self.h.auth)
        self.assertEqual(status, 404, payload)

    def test_missing_required_input_rejected_synchronously(self):
        seed_audio_workflow(self.db_path)
        status, _, payload = self.h.json("POST", "/v1/jobs", {
            "workflow": "stable-audio", "inputs": {"prompt": "x"},
        }, headers=self.h.auth)
        self.assertEqual(status, 400, payload)
        self.assertIn("seconds", json.dumps(payload, ensure_ascii=False))

    def test_upload_endpoint_forwards_to_comfy_and_returns_name(self):
        body, ctype = multipart_body({}, [("image", ("ref.png", "image/png", PNG_1X1))])
        status, _, payload = self.h.json(
            "POST", "/v1/uploads", body=body, ctype=ctype, headers=self.h.auth,
        )
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["name"])
        self.assertTrue(any(u["name"] == payload["name"] for u in self.fake.uploads))

    def test_jobs_list_newest_first_and_respects_limit(self):
        seed_audio_workflow(self.db_path)
        ids = []
        for index in range(2):
            status, _, created = self.h.json("POST", "/v1/jobs", {
                "workflow": "stable-audio",
                "inputs": {"prompt": f"p{index}", "seconds": 5, "seed": index},
            }, headers=self.h.auth)
            self.assertEqual(status, 200, created)
            ids.append(created["job_id"])
            self.wait_job(created["job_id"])
        status, _, payload = self.h.json("GET", "/v1/jobs?limit=1", headers=self.h.auth)
        self.assertEqual(status, 200, payload)
        self.assertEqual(len(payload["data"]), 1)
        self.assertEqual(payload["data"][0]["job_id"], ids[-1])


class TestGatewayCancel(AdminCase):
    workers = 0

    def test_cancel_queued_job_marks_cancelled(self):
        seed_audio_workflow(self.db_path)
        status, _, created = self.h.json("POST", "/v1/jobs", {
            "workflow": "stable-audio",
            "inputs": {"prompt": "wind", "seconds": 30, "seed": 3},
        }, headers=self.h.auth)
        self.assertEqual(status, 200, created)
        job_id = created["job_id"]
        status, _, payload = self.h.json("POST", f"/v1/jobs/{job_id}/cancel", {}, headers=self.h.auth)
        self.assertEqual(status, 200, payload)
        status, _, payload = self.h.json("GET", f"/v1/jobs/{job_id}", headers=self.h.auth)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["status"], "cancelled")
        self.assertEqual(self.fake.graphs, [])

    def test_cancel_unknown_job_is_404(self):
        status, _, _ = self.h.json("POST", "/v1/jobs/nope/cancel", {}, headers=self.h.auth)
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
