#!/usr/bin/env bash
# 安装隔离的 Python 环境并预下载 UVR 模型。
# 用法：./setup.sh [--no-model]
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
  echo "需要 uv：brew install uv（或把 uv 加入 PATH）" >&2
  exit 1
fi

uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -r requirements.txt

if [[ "${1:-}" != "--no-model" ]]; then
  .venv/bin/python download_model.py
fi

echo "完成。启动：./start.sh"
