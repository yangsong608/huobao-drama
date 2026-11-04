#!/usr/bin/env bash
# 全链路健康检查：隧道 → ComfyUI → H3 节点/模型 → 两个桥接 → 火宝
set -u
ok=0; bad=0
chk() { # chk "名称" "命令"
  if eval "$2" >/dev/null 2>&1; then echo "  ✓ $1"; ok=$((ok+1)); else echo "  ✗ $1"; bad=$((bad+1)); fi
}

echo "== 本机 → 服务器"
chk "SSH 隧道 8188" "curl -s -m 5 http://127.0.0.1:8188/system_stats"

echo "== ComfyUI / H3"
chk "ComfyUI system_stats" "curl -s -m 5 http://127.0.0.1:8188/system_stats"
if curl -s -m 8 http://127.0.0.1:8188/object_info > /tmp/_oi.json 2>/dev/null; then
  for n in MiniMaxH3Director MiniMaxH3ImageToVideo MiniMaxH3ReferenceToVideo MiniMaxH3MotionContext; do
    if python3 -c "import json;o=json.load(open('/tmp/_oi.json'));exit(0 if '$n' in o else 1)"; then
      echo "  ✓ 节点 $n"; ok=$((ok+1))
    else echo "  ✗ 节点 $n"; bad=$((bad+1)); fi
  done
else
  echo "  ✗ object_info 拉取失败"; bad=$((bad+1))
fi

echo "== 桥接"
chk "视频桥 8190" "curl -s -m 3 http://127.0.0.1:8190/health"
chk "图片桥 8191" "curl -s -m 3 http://127.0.0.1:8191/health"
# 确认端口后面的进程确实加载了项目里的脚本，而不是旧目录的同名副本
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
for entry in "8190 shim.py" "8191 img_shim.py"; do
  set -- $entry
  running=$(curl -s -m 3 "http://127.0.0.1:$1/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("script",""))' 2>/dev/null || true)
  if [ -z "$running" ]; then
    echo "  ! 端口 $1 未返回 script 字段（旧版桥接，需重启）"; bad=$((bad+1))
  elif [ "$running" = "$SCRIPTS_DIR/$2" ]; then
    echo "  ✓ 脚本 $2"
    ok=$((ok+1))
  else
    echo "  ✗ 端口 $1 跑的是 $running（应为 $SCRIPTS_DIR/$2）"; bad=$((bad+1))
  fi
done

echo "== 火宝"
chk "后端 5679" "curl -s -m 3 http://127.0.0.1:5679/api/v1/health"
chk "前端 3013" "curl -s -m 3 http://127.0.0.1:3013/"

echo
echo "结果：$ok 项正常，$bad 项异常"
[ "$bad" -eq 0 ] && echo "全链路 OK" || echo "有异常项，见上"
