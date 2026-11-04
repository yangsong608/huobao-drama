#!/usr/bin/env bash
# 全链路健康检查：隧道 → ComfyUI → H3 节点/模型 → 两个桥接 → 火宝
set -u
ok=0; bad=0
chk() { # chk "名称" "命令"
  if eval "$2" >/dev/null 2>&1; then echo "  ✓ $1"; ok=$((ok+1)); else echo "  ✗ $1"; bad=$((bad+1)); fi
}

echo "== 本机 → 服务器（8188 隧道）"
if lsof -nP -iTCP:8188 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  ✓ 8188 本机监听"; ok=$((ok+1))
else
  echo "  ✗ 8188 无监听（隧道断开；出片会在上传参考图时 Broken pipe）"; bad=$((bad+1))
fi
if curl -sf -m 5 http://127.0.0.1:8188/system_stats > /tmp/_stats.json 2>/dev/null \
  && python3 -c "import json;o=json.load(open('/tmp/_stats.json'));exit(0 if o.get('system',{}).get('comfyui_version') else 1)" 2>/dev/null; then
  echo "  ✓ ComfyUI system_stats（含 comfyui_version）"; ok=$((ok+1))
else
  echo "  ✗ ComfyUI system_stats 不通（先重建 8188 隧道，见 local-h3/docs/隧道与访问.md）"; bad=$((bad+1))
fi

echo "== ComfyUI / H3"
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
chk "视频桥 8190" "curl -sf -m 3 http://127.0.0.1:8190/health"
chk "图片桥 8191" "curl -sf -m 3 http://127.0.0.1:8191/health"
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
chk "后端 5679" "curl -sf -m 3 http://127.0.0.1:5679/api/v1/health"
chk "前端 3013" "curl -sf -m 3 http://127.0.0.1:3013/"

echo
echo "结果：$ok 项正常，$bad 项异常"
if [ "$bad" -eq 0 ]; then
  echo "全链路 OK"
else
  echo "有异常项，见上"
  echo "提示：8188 隧道断开时桥接 /health 仍可能是绿的；本地 H3 任务会以 Connection refused / Broken pipe 失败且不可续跑，修复后需重新提交。"
fi
