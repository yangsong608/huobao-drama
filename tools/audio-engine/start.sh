#!/usr/bin/env bash
# 启动本地 UVR 分离服务（默认 127.0.0.1:8199）。
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x .venv/bin/python ]]; then
  echo "缺少 .venv，请先运行 ./setup.sh" >&2
  exit 1
fi

# 默认只允许仓库 data 目录；数据在别处时显式传 AUDIO_ENGINE_ALLOWED_ROOTS。
export AUDIO_ENGINE_ALLOWED_ROOTS="${AUDIO_ENGINE_ALLOWED_ROOTS:-$(cd ../.. && pwd)/data}"
exec .venv/bin/python server.py "$@"
