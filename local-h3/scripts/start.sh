#!/usr/bin/env bash
# 启动两个桥接（视频 8190 / 图片 8191）
# 用法：bash start.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE" || exit 1
# 服务器地址不入库，按本机环境提供
H3_HOST="${H3_HOST:-YOUR_H3_SERVER_IP}"

echo "[1/3] 检查 ComfyUI 隧道（本机 8188）..."
code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:8188/system_stats || true)
if [ "$code" != "200" ]; then
  echo "  ✗ 本机 8188 不通（HTTP=$code）"
  echo "  请先建隧道："
  echo "    DSH: ssh_tunnel start  alias=$H3_HOST localPort=8188 remotePort=8188 remoteHost=127.0.0.1"
  echo "    或:  ssh -f -N -L 8188:127.0.0.1:8188 -o ExitOnForwardFailure=yes root@$H3_HOST"
  exit 1
fi
echo "  ✓ ComfyUI 可达"

# 端口已有进程时先确认它跑的是不是项目里的这份脚本：
# 旧副本（如 mm-shim/shim.py）会让人误以为新代码已生效，必须重启替换。
start_bridge() { # start_bridge 端口 脚本 日志
  local port="$1" script="$2" log="$3"
  local expected="$HERE/$script"
  local health running pid
  health=$(curl -s -m 2 "http://127.0.0.1:$port/health" || true)
  if [ -n "$health" ]; then
    running=$(printf '%s' "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("script",""))' 2>/dev/null || true)
    if [ "$running" = "$expected" ]; then
      echo "  已在运行：$running"
      return
    fi
    pid=$(printf '%s' "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("pid",""))' 2>/dev/null || true)
    echo "  ! 端口 $port 运行的是 ${running:-未知脚本（旧版无 script 字段）}"
    echo "    与项目脚本不一致，重启为 $expected"
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    else
      # 路径边界匹配：换 shim.py 时不能误杀 img_shim.py
      ps -eo pid,command | grep -E "[p]ython3? (.*/)?${script}( |$)" | awk '{print $1}' | xargs -r kill 2>/dev/null || true
    fi
    sleep 1
  fi
  (nohup python3 "$expected" > "$log" 2>&1 &)
  sleep 3
}

echo "[2/3] 启动视频桥 8190..."
start_bridge 8190 shim.py /tmp/mm_shim.log

echo "[3/3] 启动图片桥 8191..."
start_bridge 8191 img_shim.py /tmp/img_shim.log

echo "--- 结果"
curl -s -m 3 http://127.0.0.1:8190/health; echo
curl -s -m 3 http://127.0.0.1:8191/health; echo
