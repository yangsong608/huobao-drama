#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""内置工作流种子：E12 整集时间线与 Stable Audio Open。"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from admin import db, seed  # noqa: E402

SEED_DIR = os.path.join(os.path.dirname(HERE), "seed")


class SeedCase(unittest.TestCase):
    def test_loads_both_workflows(self):
        items = {item["slug"]: item for item in seed.load_seeds(SEED_DIR)}
        self.assertEqual(set(items), {"e12-timeline", "stable-audio"})
        self.assertEqual(items["e12-timeline"]["kind"], "video")
        self.assertEqual(items["stable-audio"]["kind"], "audio")

    def test_graphs_are_api_format_and_links_resolve(self):
        for item in seed.load_seeds(SEED_DIR):
            workflow = item["workflow"]
            self.assertTrue(workflow, item["slug"])
            for node_id, node in workflow.items():
                self.assertTrue(node.get("class_type"), f"{item['slug']} 节点 {node_id}")
                self.assertIsInstance(node.get("inputs"), dict, f"{item['slug']} 节点 {node_id}")
                for name, value in node["inputs"].items():
                    if (
                        isinstance(value, list) and len(value) == 2
                        and isinstance(value[0], str) and isinstance(value[1], int)
                    ):
                        self.assertIn(value[0], workflow, f"{item['slug']} {node_id}.{name}")
            for name, spec in item["input_map"].items():
                targets = spec.get("targets") or [{"node": spec.get("node"), "input": spec.get("input")}]
                self.assertTrue(targets, name)
                for target in targets:
                    node_id = str(target.get("node"))
                    self.assertIn(node_id, workflow, f"{item['slug']} 输入 {name}")
                    self.assertIn(
                        target.get("input"), workflow[node_id]["inputs"],
                        f"{item['slug']} 输入 {name}",
                    )

    def test_timeline_seed_matches_director_inputs(self):
        item = {i["slug"]: i for i in seed.load_seeds(SEED_DIR)}["e12-timeline"]
        workflow = item["workflow"]
        director = workflow["6"]
        self.assertEqual(director["class_type"], "MiniMaxH3Director")
        timeline = json.loads(director["inputs"]["timeline_data"])
        self.assertEqual(timeline["version"], 4)
        self.assertEqual(timeline["totalFrames"], sum(seg["frameCount"] for seg in timeline["segments"]))
        self.assertEqual(director["inputs"]["total_frames"], timeline["totalFrames"])
        self.assertEqual(director["inputs"]["frame_rate"], timeline["frameRate"])
        self.assertEqual(item["output_node"], "8")
        self.assertEqual(workflow["8"]["class_type"], "SaveVideo")
        self.assertEqual(json.loads(json.dumps(item["example"]["timeline_data"])), timeline)
        for name in ("timeline_data", "total_frames", "width", "height", "frame_rate", "seed", "global_prompt"):
            self.assertIn(name, item["input_map"])
        self.assertEqual(item["input_map"]["timeline_data"]["type"], "json")
        self.assertEqual(item["input_map"]["timeline_data"]["node"], "6")

    def test_audio_seed_targets_seconds(self):
        item = {i["slug"]: i for i in seed.load_seeds(SEED_DIR)}["stable-audio"]
        workflow = item["workflow"]
        self.assertEqual(item["output_node"], "8")
        self.assertEqual(item["output_key"], "audio")
        self.assertIn("wav", item["output_exts"])
        self.assertIn("flac", item["output_exts"])
        seconds = item["input_map"]["seconds"]
        self.assertEqual(seconds["type"], "number")
        self.assertEqual(
            {(str(t["node"]), t["input"]) for t in seconds["targets"]},
            {("4", "seconds_total"), ("5", "seconds")},
        )
        self.assertEqual(item["input_map"]["prompt"]["node"], "2")
        self.assertEqual(workflow["8"]["class_type"], "SaveAudio")
        self.assertEqual(workflow["1"]["inputs"]["ckpt_name"], "stable-audio-open-1.0.safetensors")

    def test_audio_seed_loads_text_encoder_separately(self):
        item = {i["slug"]: i for i in seed.load_seeds(SEED_DIR)}["stable-audio"]
        workflow = item["workflow"]
        clip_ids = [
            nid for nid, node in workflow.items()
            if node["class_type"] == "CLIPLoader"
        ]
        self.assertEqual(len(clip_ids), 1)
        clip_node = workflow[clip_ids[0]]
        self.assertEqual(clip_node["inputs"]["clip_name"], "t5-base.safetensors")
        self.assertEqual(clip_node["inputs"]["type"], "stable_audio")
        for nid in ("2", "3"):
            self.assertEqual(workflow[nid]["inputs"]["clip"], [clip_ids[0], 0])

    def test_import_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "gateway.db")
            imported = seed.import_seeds(path, SEED_DIR)
            self.assertEqual(set(imported), {"e12-timeline", "stable-audio"})
            seed.import_seeds(path, SEED_DIR)
            rows = db.list_workflows(path)
            self.assertEqual(len(rows), 2)
            self.assertEqual({row["source"] for row in rows}, {"seed"})
            self.assertTrue(all(row["is_active"] for row in rows))
            public = {row["slug"]: db.public_workflow(row) for row in rows}
            self.assertIn("timeline_data", public["e12-timeline"]["inputs"])
            self.assertIn("seconds", public["stable-audio"]["inputs"])
            self.assertNotIn("workflow", public["stable-audio"])


if __name__ == "__main__":
    unittest.main()
