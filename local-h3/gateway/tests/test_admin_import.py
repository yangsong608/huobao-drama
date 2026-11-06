#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ComfyUI UI 工作流 → API 工作流转换与依赖校验。"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from admin import comfy  # noqa: E402

CONNECT = {
    "CheckpointLoaderSimple": {
        "required": {"ckpt_name": [["model.safetensors"]]},
        "optional": {},
    },
    "CLIPTextEncode": {
        "required": {"text": ["STRING", {}], "clip": ["CLIP"]},
        "optional": {},
    },
    "ConditioningStableAudio": {
        "required": {
            "positive": ["CONDITIONING"], "negative": ["CONDITIONING"],
            "seconds_start": ["FLOAT", {}], "seconds_total": ["FLOAT", {}],
        },
        "optional": {},
    },
    "EmptyLatentAudio": {
        "required": {"seconds": ["FLOAT", {}], "batch_size": ["INT", {}]},
        "optional": {},
    },
    "KSampler": {
        "required": {
            "model": ["MODEL"], "seed": ["INT", {"control_after_generate": True}],
            "steps": ["INT", {}], "cfg": ["FLOAT", {}],
            "sampler_name": [["euler", "heun"], {}], "scheduler": [["simple", "karras"], {}],
            "positive": ["CONDITIONING"], "negative": ["CONDITIONING"],
            "latent_image": ["LATENT"], "denoise": ["FLOAT", {}],
        },
        "optional": {},
    },
    "VAEDecodeAudio": {
        "required": {"samples": ["LATENT"], "vae": ["VAE"]},
        "optional": {},
    },
    "SaveAudio": {
        "required": {"audio": ["AUDIO"], "filename_prefix": ["STRING", {}]},
        "optional": {},
    },
    "Reroute": {"required": {"": ["*"]}, "optional": {}},
    "PrimitiveNode": {"required": {}, "optional": {}},
    "Note": {"required": {}, "optional": {}},
}

OBJECT_INFO = {}
for name, spec in CONNECT.items():
    OBJECT_INFO[name] = {
        "input": {"required": spec["required"], "optional": spec["optional"]},
        "input_order": {
            "required": list(spec["required"].keys()),
            "optional": list(spec["optional"].keys()),
        },
    }


def audio_ui_graph():
    return {
        "last_node_id": 8,
        "nodes": [
            {"id": 1, "type": "CheckpointLoaderSimple", "mode": 0,
             "inputs": [], "widgets_values": ["stable-audio-open-1.0.safetensors"]},
            {"id": 2, "type": "CLIPTextEncode", "mode": 0,
             "inputs": [{"name": "clip", "type": "CLIP", "link": 10}],
             "widgets_values": ["rain on a tin roof"]},
            {"id": 3, "type": "CLIPTextEncode", "mode": 0,
             "inputs": [{"name": "clip", "type": "CLIP", "link": 11}],
             "widgets_values": ["music"]},
            {"id": 4, "type": "ConditioningStableAudio", "mode": 0,
             "inputs": [
                 {"name": "positive", "type": "CONDITIONING", "link": 12},
                 {"name": "negative", "type": "CONDITIONING", "link": 13},
             ],
             "widgets_values": [0.0, 30.0]},
            {"id": 5, "type": "EmptyLatentAudio", "mode": 0,
             "inputs": [], "widgets_values": [30.0, 1]},
            {"id": 6, "type": "KSampler", "mode": 0,
             "inputs": [
                 {"name": "model", "type": "MODEL", "link": 14},
                 {"name": "positive", "type": "CONDITIONING", "link": 15},
                 {"name": "negative", "type": "CONDITIONING", "link": 16},
                 {"name": "latent_image", "type": "LATENT", "link": 17},
             ],
             "widgets_values": [123, "randomize", 100, 6.0, "euler", "simple", 1.0]},
            {"id": 7, "type": "VAEDecodeAudio", "mode": 0,
             "inputs": [
                 {"name": "samples", "type": "LATENT", "link": 18},
                 {"name": "vae", "type": "VAE", "link": 19},
             ], "widgets_values": []},
            {"id": 8, "type": "SaveAudio", "mode": 0,
             "inputs": [{"name": "audio", "type": "AUDIO", "link": 20}],
             "widgets_values": ["audio/h3"]},
            {"id": 99, "type": "Note", "mode": 0, "inputs": [], "widgets_values": ["备注"]},
        ],
        "links": [
            [10, 1, 1, 2, 0, "CLIP"],
            [11, 1, 1, 3, 0, "CLIP"],
            [12, 2, 0, 4, 0, "CONDITIONING"],
            [13, 3, 0, 4, 1, "CONDITIONING"],
            [14, 1, 0, 6, 0, "MODEL"],
            [15, 4, 0, 6, 1, "CONDITIONING"],
            [16, 4, 1, 6, 2, "CONDITIONING"],
            [17, 5, 0, 6, 3, "LATENT"],
            [18, 6, 0, 7, 0, "LATENT"],
            [19, 1, 2, 7, 1, "VAE"],
            [20, 7, 0, 8, 0, "AUDIO"],
        ],
        "groups": [],
    }


class ConvertCase(unittest.TestCase):
    def test_convert_widgets_and_links(self):
        graph = comfy.convert_ui_workflow(audio_ui_graph(), OBJECT_INFO)
        self.assertEqual(graph["1"]["inputs"]["ckpt_name"], "stable-audio-open-1.0.safetensors")
        self.assertEqual(graph["2"]["inputs"]["text"], "rain on a tin roof")
        self.assertEqual(graph["2"]["inputs"]["clip"], ["1", 1])
        self.assertEqual(graph["4"]["inputs"]["positive"], ["2", 0])
        self.assertEqual(graph["4"]["inputs"]["seconds_total"], 30.0)
        self.assertEqual(graph["6"]["inputs"]["seed"], 123)
        self.assertEqual(graph["6"]["inputs"]["steps"], 100)
        self.assertEqual(graph["6"]["inputs"]["model"], ["1", 0])
        self.assertNotIn("control_after_generate", graph["6"]["inputs"])
        self.assertEqual(graph["8"]["inputs"]["audio"], ["7", 0])
        self.assertNotIn("99", graph)

    def test_muted_and_bypassed_nodes_rejected(self):
        graph = audio_ui_graph()
        graph["nodes"][0]["mode"] = 2
        with self.assertRaises(comfy.WorkflowImportError) as ctx:
            comfy.convert_ui_workflow(graph, OBJECT_INFO)
        self.assertIn("静音", str(ctx.exception))

    def test_reroute_and_primitive_resolved(self):
        graph = {
            "nodes": [
                {"id": 1, "type": "CheckpointLoaderSimple", "mode": 0,
                 "inputs": [], "widgets_values": ["m.safetensors"]},
                {"id": 2, "type": "CLIPTextEncode", "mode": 0,
                 "inputs": [{"name": "clip", "type": "CLIP", "link": 40}],
                 "widgets_values": ["x"]},
                {"id": 3, "type": "Reroute", "mode": 0,
                 "inputs": [{"name": "", "type": "*", "link": 39}], "widgets_values": []},
                {"id": 4, "type": "PrimitiveNode", "mode": 0,
                 "inputs": [], "widgets_values": ["positive text", "fixed"]},
            ],
            "links": [
                [39, 1, 1, 3, 0, "CLIP"],
                [40, 3, 0, 2, 0, "CLIP"],
            ],
        }
        graph["nodes"][1]["widgets_values"] = []
        graph = comfy.convert_ui_workflow(graph, OBJECT_INFO)
        self.assertEqual(graph["2"]["inputs"]["clip"], ["1", 1])

    def test_unknown_class_reports_missing_dependency(self):
        graph = audio_ui_graph()
        graph["nodes"][0]["type"] = "MissingCustomNode"
        with self.assertRaises(comfy.WorkflowImportError) as ctx:
            comfy.convert_ui_workflow(graph, OBJECT_INFO)
        self.assertIn("MissingCustomNode", str(ctx.exception))

    def test_suggest_output_and_kind(self):
        graph = comfy.convert_ui_workflow(audio_ui_graph(), OBJECT_INFO)
        output = comfy.suggest_output(graph)
        self.assertEqual(output["node"], "8")
        self.assertEqual(output["key"], "audio")
        self.assertIn("wav", output["exts"])
        self.assertEqual(comfy.suggest_kind(graph), "audio")

    def test_suggest_input_map(self):
        graph = comfy.convert_ui_workflow(audio_ui_graph(), OBJECT_INFO)
        mapping = comfy.suggest_input_map(graph)
        self.assertEqual(mapping["prompt"]["node"], "2")
        self.assertEqual(mapping["negative_prompt"]["node"], "3")
        self.assertEqual(mapping["seed"]["node"], "6")
        self.assertEqual(mapping["seconds"]["node"], "5")

    def test_validate_dependencies_accepts_complete_graph(self):
        graph = comfy.convert_ui_workflow(audio_ui_graph(), OBJECT_INFO)
        comfy.validate_dependencies(graph, OBJECT_INFO)

    def test_validate_dependencies_reports_missing_required_input(self):
        graph = comfy.convert_ui_workflow(audio_ui_graph(), OBJECT_INFO)
        graph["6"]["inputs"].pop("seed")
        with self.assertRaises(comfy.WorkflowImportError) as ctx:
            comfy.validate_dependencies(graph, OBJECT_INFO)
        self.assertIn("seed", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
