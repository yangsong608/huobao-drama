# -*- coding: utf-8 -*-
"""本地 H3 桥接纯函数回归测试：音频指令覆盖、帧网格、错误透传。"""
import hashlib
import json
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))

import shim  # noqa: E402
import img_shim  # noqa: E402


class AudioDirectiveTest(unittest.TestCase):
    def test_ambient_overrides_existing_chinese_audio_line(self):
        prompt = "信息头\n音频：人声清晰靠前，环境音压低，无背景音乐。\n[Shot 1] 雨夜破庙。"
        out = shim.with_audio_directive(prompt, "ambient")
        self.assertIn(shim.AMBIENT_DIRECTIVE, out)
        self.assertNotIn("音频：", out)
        self.assertIn("[Shot 1] 雨夜破庙。", out)

    def test_silent_overrides_existing_chinese_audio_line(self):
        prompt = "信息头\n音频：人声清晰靠前。\n[Shot 1] 雨夜破庙。"
        out = shim.with_audio_directive(prompt, "silent")
        self.assertIn(shim.SILENT_DIRECTIVE, out)
        self.assertNotIn("音频：", out)

    def test_native_prepends_directive_and_keeps_chinese_audio_line(self):
        prompt = "信息头\n音频：人声清晰靠前。\n[Shot 1] 雨夜破庙。"
        out = shim.with_audio_directive(prompt, "native")
        self.assertIn(shim.AUDIO_DIRECTIVE, out)
        self.assertIn("音频：", out)
        self.assertTrue(out.endswith(prompt))

    def test_empty_prompt_returns_directive(self):
        self.assertEqual(shim.with_audio_directive("", "ambient"), shim.AMBIENT_DIRECTIVE)
        self.assertEqual(shim.with_audio_directive("", "silent"), shim.SILENT_DIRECTIVE)

    def test_native_directive_does_not_request_voice_over(self):
        directive = shim.AUDIO_DIRECTIVE.lower()
        self.assertNotIn("and voice-over narration", directive)
        self.assertIn("no voice-over narration unless the prompt explicitly describes an off-screen narrator", directive)
        self.assertIn("natural ambience", directive)
        self.assertIn("mandarin dialogue", directive)

    def test_global_prompt_matches_native_voice_over_policy(self):
        global_prompt = shim.GLOBAL_PROMPT.lower()
        self.assertNotIn("and voice-over narration", global_prompt)
        self.assertIn("no voice-over narration unless the prompt explicitly describes an off-screen narrator", global_prompt)

    def test_all_directives_forbid_subtitles(self):
        for directive in (shim.AUDIO_DIRECTIVE, shim.AMBIENT_DIRECTIVE, shim.SILENT_DIRECTIVE):
            self.assertIn("no subtitles", directive.lower())
        self.assertIn("mouth", shim.AMBIENT_DIRECTIVE.lower())
        self.assertNotIn("do not speak", shim.AMBIENT_DIRECTIVE.lower())

    def test_silent_directive_keeps_mouths_closed(self):
        directive = shim.SILENT_DIRECTIVE.lower()
        self.assertIn("do not speak", directive)
        self.assertIn("mouths closed", directive)


class ContentParseTest(unittest.TestCase):
    def test_parses_text_and_image_roles(self):
        prompt, first, last, refs = shim.parse_content([
            {"type": "text", "text": "hello"},
            {"type": "image_url", "image_url": {"url": "a.png"}, "role": "first_frame"},
            {"type": "image_url", "image_url": {"url": "b.png"}, "role": "last_frame"},
            {"type": "image_url", "image_url": {"url": "c.png"}, "role": "reference_image"},
            {"type": "image_url", "image_url": {"url": "d.png"}},
        ])
        self.assertEqual(prompt, "hello")
        self.assertEqual(first, "a.png")
        self.assertEqual(last, "b.png")
        self.assertEqual(refs, ["c.png", "d.png"])

    def test_rejects_audio_and_video_references_instead_of_dropping_them(self):
        for item, label in (
            ({"type": "audio_url", "audio_url": {"url": "a.wav"}, "role": "reference_audio"}, "参考音频"),
            ({"type": "video_url", "video_url": {"url": "v.mp4"}, "role": "reference_video"}, "参考视频"),
        ):
            with self.assertRaises(ValueError) as ctx:
                shim.parse_content([{"type": "text", "text": "hello"}, item])
            self.assertIn(label, str(ctx.exception))


class CapabilityTest(unittest.TestCase):
    def test_health_capabilities_state_local_limits(self):
        caps = shim.capabilities()
        self.assertEqual(caps["referenceAudios"], 0)
        self.assertEqual(caps["referenceVideos"], 0)
        self.assertEqual(caps["referenceImages"], 9)
        self.assertEqual(caps["audioModes"], ["native", "ambient", "silent"])
        self.assertTrue(caps["firstLastFrame"])
        self.assertIn("preview", caps["qualities"])
        self.assertEqual(caps["frameGrid"][0], 5)
        self.assertEqual(caps["frameGrid"][-1], 362)


class GridTest(unittest.TestCase):
    def test_frames_for_snaps_to_full_5_plus_17k_grid(self):
        cases = {0: 5, 4: 90, 5: 124, 5.2: 124, 10: 243, 12: 294, 15: 362, 99: 362}
        for duration, expected in cases.items():
            self.assertEqual(shim.frames_for(duration), expected, duration)
        for k, frames in enumerate(shim.FRAME_GRID):
            self.assertEqual(shim.frames_for(frames / 24.0), frames, k)

    def test_local_480p_canvas(self):
        self.assertEqual(shim.resolve_canvas("480p", "16:9"), (864, 480))
        self.assertEqual(shim.resolve_canvas("720p", "16:9"), (1376, 768))


class GraphParamsTest(unittest.TestCase):
    def _graph(self, **kwargs):
        defaults = dict(prompt="[Shot 1] A woman speaks.", first_name=None, last_name=None,
                        frames=124, seed=42, ref_names=None, size=(864, 480), audio_mode="native")
        defaults.update(kwargs)
        return shim.build_graph(**defaults)

    def test_preview_uses_4step_lora(self):
        graph = self._graph(quality="preview")
        self.assertIn("4step", graph["2"]["inputs"]["lora_name"])
        self.assertEqual(graph["6"]["inputs"]["steps"], 4)

    def test_final_uses_8step_lora(self):
        graph = self._graph(quality="final")
        self.assertIn("8step", graph["2"]["inputs"]["lora_name"])
        self.assertEqual(graph["6"]["inputs"]["steps"], 8)

    def test_unknown_quality_falls_back_to_preview(self):
        graph = self._graph(quality="ultra")
        self.assertEqual(graph["6"]["inputs"]["steps"], 4)
        self.assertEqual(shim.normalize_quality("FINAL"), "final")

    def test_ref_max_size_capped_at_1024_without_shrinking_output(self):
        graph = self._graph(size=(1920, 1088))
        self.assertEqual(graph["6"]["inputs"]["width"], 1920)
        self.assertEqual(graph["6"]["inputs"]["height"], 1088)
        self.assertEqual(graph["6"]["inputs"]["ref_max_size"], 1024)
        timeline = json.loads(graph["6"]["inputs"]["timeline_data"])
        self.assertEqual(timeline["refMaxSize"], 1024)
        self.assertEqual(timeline["output"]["longEdge"], 1920)

    def test_seed_negative_and_cfg_pass_through(self):
        graph = self._graph(seed=123456, negative="custom negative", cfg=2.5)
        self.assertEqual(graph["6"]["inputs"]["seed"], 123456)
        self.assertEqual(graph["6"]["inputs"]["cfg"], 2.5)
        self.assertEqual(graph["8"]["inputs"]["filename_prefix"], "mm/123456")
        timeline = json.loads(graph["6"]["inputs"]["timeline_data"])
        self.assertEqual(timeline["segments"][0]["negativePrompt"], "custom negative")

    def test_default_negative_is_used_when_blank(self):
        graph = self._graph(negative="   ")
        timeline = json.loads(graph["6"]["inputs"]["timeline_data"])
        self.assertEqual(timeline["segments"][0]["negativePrompt"], shim.NEG)


class HistoryErrorTest(unittest.TestCase):
    def test_extracts_execution_error_message(self):
        entry = {
            "status": {
                "status_str": "error",
                "messages": [
                    ["execution_error", {"node_type": "MiniMaxH3Director", "exception_message": "CUDA out of memory"}],
                ],
            }
        }
        message = shim.history_error(entry)
        self.assertIn("CUDA out of memory", message)
        self.assertIn("MiniMaxH3Director", message)

    def test_returns_empty_for_success(self):
        self.assertEqual(shim.history_error({"status": {"status_str": "success", "messages": []}}), "")


class ImgShimTest(unittest.TestCase):
    def test_parse_size_snaps_to_8_and_clamps(self):
        self.assertEqual(img_shim.parse_size("1001x999", "qwen-image"), (1000, 992))
        self.assertEqual(img_shim.parse_size("64x64", "qwen-image"), (256, 256))
        self.assertEqual(img_shim.parse_size("4096x4096", "qwen-image"), (2048, 2048))
        self.assertEqual(img_shim.parse_size(None, "qwen-image"), (1024, 1024))

    def test_img2img_scales_source_to_requested_size(self):
        graph = img_shim.graph_img2img("a portrait", "src.png", 7, 832, 1216)
        self.assertEqual(graph["6"]["class_type"], "LoadImage")
        self.assertEqual(graph["7"]["class_type"], "ImageScale")
        self.assertEqual(graph["7"]["inputs"]["width"], 832)
        self.assertEqual(graph["7"]["inputs"]["height"], 1216)
        self.assertEqual(graph["7"]["inputs"]["image"], ["6", 0])
        self.assertEqual(graph["8"]["inputs"]["pixels"], ["7", 0])
        self.assertEqual(graph["9"]["inputs"]["latent_image"], ["8", 0])

    def test_multipart_text_reads_prompt_and_size(self):
        raw = (
            b'--b\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n'
            b'a rainy night\r\n--b\r\nContent-Disposition: form-data; name="size"\r\n\r\n'
            b'832x1216\r\n--b\r\n'
        )
        self.assertEqual(img_shim.multipart_text(raw, "prompt"), "a rainy night")
        self.assertEqual(img_shim.multipart_text(raw, "size"), "832x1216")
        self.assertEqual(img_shim.multipart_text(raw, "missing"), "")

    def test_extra_references_are_reported_not_dropped_silently(self):
        primary, warning = img_shim.select_edit_reference([("a", b"1"), ("b", b"2"), ("c", b"3")])
        self.assertEqual(primary, ("a", b"1"))
        self.assertIn("只使用第 1 张", warning)
        self.assertIn("2 张未参与生成", warning)
        self.assertEqual(img_shim.select_edit_reference([("a", b"1")])[1], "")
        self.assertEqual(img_shim.select_edit_reference([]), (None, ""))

    def test_health_capabilities_do_not_claim_multi_reference(self):
        caps = img_shim.capabilities()
        self.assertFalse(caps["multiReference"])
        self.assertEqual(caps["maxReferences"], 1)
        self.assertTrue(caps["editSize"])


class UploadPipelineTest(unittest.TestCase):
    """上行慢链路：压缩、内容哈希复用、超时校验与重试"""

    def setUp(self):
        self._cache = dict(shim.UPLOAD_CACHE)
        shim.UPLOAD_CACHE.clear()
        self._save = shim.save_upload_cache
        shim.save_upload_cache = lambda: None

    def tearDown(self):
        shim.UPLOAD_CACHE.clear()
        shim.UPLOAD_CACHE.update(self._cache)
        shim.save_upload_cache = self._save

    def _patched(self, *, prepared=(b"prepared", "image/jpeg", ".jpg"), exists=False, post=None):
        stack = mock.patch.object(shim, "fetch_bytes", return_value=(b"raw-bytes", "image/png"))
        stack.start()
        self.addCleanup(stack.stop)
        stack = mock.patch.object(shim, "prepare_image", return_value=prepared)
        stack.start()
        self.addCleanup(stack.stop)
        stack = mock.patch.object(shim, "remote_input_exists", return_value=exists)
        stack.start()
        self.addCleanup(stack.stop)
        if post is not None:
            stack = mock.patch.object(shim, "post_upload", side_effect=post)
            stack.start()
            self.addCleanup(stack.stop)

    def test_upload_reuses_cache_when_remote_input_exists(self):
        prepared = b"compressed-bytes"
        shim.UPLOAD_CACHE[hashlib.sha256(prepared).hexdigest()] = "mm_cached.jpg"
        self._patched(prepared=(prepared, "image/jpeg", ".jpg"), exists=True)
        with mock.patch.object(shim, "post_upload") as post:
            name = shim.upload_image("static/a.png", 1024)
        self.assertEqual(name, "mm_cached.jpg")
        post.assert_not_called()

    def test_upload_posts_compressed_payload_and_records_cache(self):
        prepared = b"jpeg-small"
        seen = {}

        def fake_post(payload, name, ctype, timeout=None):
            seen.update(payload=payload, name=name, ctype=ctype, timeout=timeout)
            return name

        self._patched(prepared=(prepared, "image/jpeg", ".jpg"), exists=False, post=fake_post)
        name = shim.upload_image("static/a.png", 1024)
        self.assertTrue(name.startswith("mm_") and name.endswith(".jpg"))
        self.assertEqual(seen["payload"], prepared)
        self.assertEqual(seen["ctype"], "image/jpeg")
        self.assertEqual(seen["timeout"], shim.UPLOAD_TIMEOUT)
        self.assertGreaterEqual(shim.UPLOAD_TIMEOUT, 300)
        self.assertEqual(shim.UPLOAD_CACHE.get(hashlib.sha256(prepared).hexdigest()), name)

    def test_upload_retries_once_on_timeout(self):
        calls = []

        def flaky(payload, name, ctype, timeout=None):
            calls.append(name)
            if len(calls) == 1:
                raise TimeoutError("timed out")
            return name

        self._patched(exists=False, post=flaky)
        name = shim.upload_image("static/a.png", 1024)
        self.assertEqual(len(calls), 2)
        self.assertEqual(name, calls[-1])

    def test_upload_reuses_server_file_written_after_timeout(self):
        posted = []

        def slow(payload, name, ctype, timeout=None):
            posted.append(name)
            raise TimeoutError("timed out")

        self._patched(exists=True, post=slow)
        name = shim.upload_image("static/a.png", 1024)
        self.assertEqual(len(posted), 1)
        self.assertEqual(name, posted[0])

    def test_prepare_image_leaves_small_or_non_image_untouched(self):
        small = b"x" * (100 * 1024)
        self.assertEqual(shim.prepare_image(small, "image/png", 1024), (small, "image/png", ".png"))
        text = b"x" * (1024 * 1024)
        self.assertEqual(shim.prepare_image(text, "text/plain", 1024), (text, "text/plain", ".png"))
        jpeg = b"x" * (100 * 1024)
        self.assertEqual(shim.prepare_image(jpeg, "image/jpeg", 1024), (jpeg, "image/jpeg", ".jpg"))

    def test_prepare_image_prefers_smaller_sips_output(self):
        raw = b"x" * (1024 * 1024)
        with mock.patch.object(shim, "_sips_convert", return_value=b"y" * 1000):
            data, ctype, ext = shim.prepare_image(raw, "image/png", 1024)
        self.assertEqual(data, b"y" * 1000)
        self.assertEqual((ctype, ext), ("image/jpeg", ".jpg"))

    def test_prepare_image_keeps_original_when_sips_fails(self):
        raw = b"x" * (1024 * 1024)
        with mock.patch.object(shim, "_sips_convert", return_value=None):
            data, ctype, ext = shim.prepare_image(raw, "image/png", 1024)
        self.assertEqual(data, raw)
        self.assertEqual((ctype, ext), ("image/png", ".png"))


if __name__ == "__main__":
    unittest.main()
