# -*- coding: utf-8 -*-
"""本地 H3 桥接纯函数回归测试：音频指令覆盖、帧网格、错误透传。"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))

import shim  # noqa: E402


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

    def test_native_keeps_existing_chinese_audio_line(self):
        prompt = "信息头\n音频：人声清晰靠前。\n[Shot 1] 雨夜破庙。"
        out = shim.with_audio_directive(prompt, "native")
        self.assertIn("音频：", out)
        self.assertEqual(out, prompt)

    def test_empty_prompt_returns_directive(self):
        self.assertEqual(shim.with_audio_directive("", "ambient"), shim.AMBIENT_DIRECTIVE)
        self.assertEqual(shim.with_audio_directive("", "silent"), shim.SILENT_DIRECTIVE)


class GridTest(unittest.TestCase):
    def test_frames_for_keeps_supported_grid(self):
        self.assertEqual(shim.frames_for(4), 124)
        self.assertEqual(shim.frames_for(10), 241)
        self.assertEqual(shim.frames_for(15), 362)

    def test_local_480p_canvas(self):
        self.assertEqual(shim.resolve_canvas("480p", "16:9"), (864, 480))
        self.assertEqual(shim.resolve_canvas("720p", "16:9"), (1376, 768))


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


if __name__ == "__main__":
    unittest.main()
