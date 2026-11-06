#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""管理端命令行：初始化、建管理员、建 Key。"""
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GATEWAY_DIR = os.path.dirname(HERE)
sys.path.insert(0, GATEWAY_DIR)

from admin import db  # noqa: E402


class CliCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp.name, "gateway.db")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "admin.cli", "--db", self.db_path, *args],
            cwd=GATEWAY_DIR, text=True, capture_output=True,
        )

    def test_init_db_and_create_admin(self):
        result = self.run_cli("init-db")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(os.path.isfile(self.db_path))

        result = self.run_cli(
            "create-admin", "--username", "admin", "--password", "secret123",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("admin", result.stdout)
        self.assertTrue(db.verify_admin_user(self.db_path, "admin", "secret123"))

        result = self.run_cli(
            "create-admin", "--username", "admin", "--password", "secret123",
        )
        self.assertNotEqual(result.returncode, 0)

    def test_reset_password(self):
        self.run_cli("init-db")
        self.run_cli("create-admin", "--username", "admin", "--password", "secret123")
        result = self.run_cli(
            "reset-password", "--username", "admin", "--password", "newsecret1",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(db.verify_admin_user(self.db_path, "admin", "newsecret1"))

    def test_seed_workflows(self):
        result = self.run_cli("seed-workflows")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("e12-timeline", result.stdout)
        self.assertIn("stable-audio", result.stdout)
        rows = db.list_workflows(self.db_path)
        self.assertEqual({row["slug"] for row in rows}, {"e12-timeline", "stable-audio"})

    def test_create_key_prints_once(self):
        self.run_cli("init-db")
        result = self.run_cli("create-key", "--name", "剪辑端")
        self.assertEqual(result.returncode, 0, result.stderr)
        match = re.search(r"(h3_[A-Za-z0-9_-]{10,})", result.stdout)
        self.assertIsNotNone(match, result.stdout)
        keys = db.list_api_keys(self.db_path)
        self.assertEqual(len(keys), 1)
        self.assertEqual(keys[0]["name"], "剪辑端")
        self.assertIn(db.hash_api_key(match.group(1)),
                      db.GatewayStore(self.db_path).api_key_hashes())


if __name__ == "__main__":
    unittest.main()
