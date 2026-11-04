#!/usr/bin/env bash
# 停止两个桥接（视频 8190 / 图片 8191）
set -u

stop_one() { # stop_one 名称 端口 脚本名
  local name="$1" port="$2" script="$3"
  local health pid running pids
  health=$(curl -s -m 2 "http://127.0.0.1:$port/health" || true)
  if [ -n "$health" ]; then
    pid=$(printf '%s' "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("pid",""))' 2>/dev/null || true)
    running=$(printf '%s' "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("script",""))' 2>/dev/null || true)
    if [ -n "$pid" ]; then
      echo "kill ${name}: ${pid} (${running:-旧版无 script 字段})"
      kill "$pid" 2>/dev/null || true
      return
    fi
  fi
  # 旧版 /health 没有 pid：只杀监听该端口的进程，避免误杀 img_shim.py 或包装 shell
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "kill ${name}: ${pids}"
    echo "$pids" | xargs -r kill 2>/dev/null || true
  else
    echo "${name} 未在运行（${script}）"
  fi
}

stop_one "视频桥 8190" 8190 shim.py
stop_one "图片桥 8191" 8191 img_shim.py
sleep 1
echo "--- 剩余监听"
lsof -nP -iTCP:8190 -sTCP:LISTEN 2>/dev/null || echo "8190 已停止"
lsof -nP -iTCP:8191 -sTCP:LISTEN 2>/dev/null || echo "8191 已停止"
