#!/usr/bin/env python3
"""预下载 UVR 分离模型，避免首次分离时静默等待。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

DEFAULT_MODEL = "UVR-MDX-NET-Inst_HQ_3"
DEFAULT_MODEL_DIR = os.path.expanduser("~/.cache/huobao-audio-engine/models")


def main() -> int:
    model_dir = Path(os.environ.get("AUDIO_ENGINE_MODEL_DIR", DEFAULT_MODEL_DIR)).expanduser()
    model_dir.mkdir(parents=True, exist_ok=True)
    work_dir = model_dir / ".download"
    work_dir.mkdir(exist_ok=True)

    from audio_separator.separator import Separator

    separator = Separator(model_file_dir=str(model_dir), output_dir=str(work_dir), output_format="WAV")
    separator.load_model(model_filename=f"{DEFAULT_MODEL}.onnx")
    print(f"模型就绪：{model_dir / (DEFAULT_MODEL + '.onnx')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
