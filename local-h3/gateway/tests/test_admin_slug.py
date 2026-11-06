#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""工作流标识规则：管理端生成与客户端校验保持一致。"""
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from admin import app as admin_app, db  # noqa: E402


def workflow_payload(slug):
    return {
        "slug": slug,
        "name": "雨声生成",
        "kind": "audio",
        "workflow": {
            "1": {"class_type": "SaveAudio", "inputs": {"audio": ["2", 0]}},
            "2": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["3", 0]}},
        },
        "input_map": {},
    }


class WorkflowSlugTest(unittest.TestCase):
    def test_slugify_keeps_ascii_and_replaces_punctuation(self):
        self.assertEqual(admin_app._slugify("My Sound.v2.json"), "my-sound-v2")
        self.assertEqual(admin_app._slugify("rain_on-roof.json"), "rain_on-roof")

    def test_slugify_non_ascii_names_fall_back_to_stable_hash(self):
        first = admin_app._slugify("雨声生成.json")
        second = admin_app._slugify("雨声生成.json")
        other = admin_app._slugify("环境声.json")
        self.assertRegex(first, r"^workflow-[0-9a-f]{8}$")
        self.assertEqual(first, second)
        self.assertNotEqual(first, other)

    def test_db_rejects_dotted_slug(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "gateway.db")
            db.init_db(path)
            with self.assertRaisesRegex(ValueError, "工作流标识"):
                db.upsert_workflow(path, workflow_payload("rain.v2"))

    def test_db_accepts_plain_slug(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "gateway.db")
            db.init_db(path)
            row = db.upsert_workflow(path, workflow_payload("rain-v2"))
            self.assertTrue(re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", row["slug"]))

    def test_edit_form_hint_matches_actual_slug_rule(self):
        template = os.path.join(os.path.dirname(HERE), "admin", "templates", "workflow_form.html")
        text = open(template, encoding="utf-8").read()
        self.assertNotIn("点、下划线", text)
        self.assertIn("小写字母、数字、下划线、短横线", text)


if __name__ == "__main__":
    unittest.main()
