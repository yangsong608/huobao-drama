#!/usr/bin/env bash
# 安装/升级 H3 网关；Token 只在本机生成，不回显、不出现在命令行参数里。
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
APP=/opt/huobao-h3-gateway
DATA=/var/lib/huobao-h3-gateway
ENV_FILE=/etc/huobao-h3-gateway.env
UNIT=/etc/systemd/system/huobao-h3-gateway.service

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh 需要 root 权限" >&2
  exit 1
fi
if [ ! -f "$SRC/h3_gateway.py" ] || [ ! -d "$SRC/workflows" ]; then
  echo "源码目录不完整: $SRC" >&2
  exit 1
fi

id -u huobao-h3 >/dev/null 2>&1 || \
  useradd --system --no-create-home --home-dir "$DATA" --shell /usr/sbin/nologin huobao-h3

install -d -m 0755 "$APP" "$APP/workflows" "$APP/deploy"
install -d -m 0755 "$DATA" "$DATA/files"
install -m 0644 "$SRC/h3_gateway.py" "$APP/h3_gateway.py"
for file in "$SRC"/workflows/*.json; do
  install -m 0644 "$file" "$APP/workflows/$(basename "$file")"
done
install -m 0644 "$SRC/deploy/h3-gateway.service" "$UNIT"
chown -R root:root "$APP"
chown -R huobao-h3:huobao-h3 "$DATA"

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  sign_key="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  cat > "$ENV_FILE" <<EOF
H3_GATEWAY_TOKEN=$token
H3_GATEWAY_SIGN_KEY=$sign_key
H3_GATEWAY_HOST=0.0.0.0
H3_GATEWAY_PORT=8192
H3_COMFY_URL=http://127.0.0.1:8188
H3_DATA_DIR=$DATA
H3_WORKERS=1
H3_QUEUE_LIMIT=32
H3_RETENTION_DAYS=7
EOF
  chmod 0600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  echo "已生成 Token 与签名密钥（不回显）"
else
  echo "复用现有 $ENV_FILE"
fi

systemctl daemon-reload
systemctl enable huobao-h3-gateway.service >/dev/null
systemctl restart huobao-h3-gateway.service
sleep 1
systemctl --no-pager --full status huobao-h3-gateway.service | sed -n '1,12p'
