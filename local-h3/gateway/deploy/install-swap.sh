#!/usr/bin/env bash
# 安装/升级独立的换人网关：8194 -> 8189，管理端 8195 仅回环。
# 不触碰生产 /opt/huobao-h3-gateway、8192、8193、8188。
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
APP=/opt/huobao-h3-gateway-swap
DATA=/data/huobao-h3-gateway-swap
ENV_FILE=/etc/huobao-h3-gateway-swap.env
UNIT=/etc/systemd/system/huobao-h3-gateway-swap.service
UNIT_ADMIN=/etc/systemd/system/huobao-h3-admin-swap.service

if [ "$(id -u)" -ne 0 ]; then
  echo "install-swap.sh 需要 root 权限" >&2
  exit 1
fi
case "$DATA" in
  /data/*) ;;
  *) echo "换人网关数据目录必须在 /data 下，当前: $DATA" >&2; exit 1 ;;
esac
if [ ! -f "$SRC/h3_gateway.py" ] || [ ! -d "$SRC/admin" ] || [ ! -f "$SRC/requirements-admin.txt" ]; then
  echo "源码目录不完整: $SRC" >&2
  exit 1
fi

id -u huobao-h3 >/dev/null 2>&1 || \
  useradd --system --no-create-home --home-dir "$DATA" --shell /usr/sbin/nologin huobao-h3

install -d -m 0755 "$APP" "$APP/admin" "$APP/deploy"
install -d -m 0755 "$DATA" "$DATA/files"
install -m 0644 "$SRC/h3_gateway.py" "$APP/h3_gateway.py"
install -m 0644 "$SRC/requirements-admin.txt" "$APP/requirements-admin.txt"
install -m 0644 "$SRC/deploy/h3-gateway-swap.service" "$UNIT"
install -m 0644 "$SRC/deploy/huobao-h3-admin-swap.service" "$UNIT_ADMIN"
cp -R "$SRC/admin/." "$APP/admin/"
find "$APP/admin" -type d -name '__pycache__' -prune -exec rm -rf {} +
if [ -d "$SRC/seed/swap" ]; then
  install -d -m 0755 "$APP/seed-swap"
  cp -R "$SRC/seed/swap/." "$APP/seed-swap/"
  chown -R root:root "$APP/seed-swap"
fi
chown -R root:root "$APP"
chown -R huobao-h3:huobao-h3 "$DATA"

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  sign_key="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  admin_secret="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  cat > "$ENV_FILE" <<EOF
H3_GATEWAY_TOKEN=$token
H3_GATEWAY_SIGN_KEY=$sign_key
H3_GATEWAY_HOST=0.0.0.0
H3_GATEWAY_PORT=8194
H3_COMFY_URL=http://127.0.0.1:8189
H3_DATA_DIR=$DATA
H3_DB_PATH=$DATA/gateway.db
H3_WORKERS=1
H3_QUEUE_LIMIT=16
H3_RETENTION_DAYS=7
H3_MAX_BODY_BYTES=268435456
H3_MAX_VIDEO_BYTES=268435456
H3_UPSTREAM_TIMEOUT=3600
H3_UPLOAD_TIMEOUT=600
H3_ADMIN_SECRET=$admin_secret
EOF
  chmod 0600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  echo "已生成换人网关 Token/签名密钥/管理台密钥（不回显）"
else
  echo "复用现有 $ENV_FILE"
fi
for key in H3_DB_PATH H3_ADMIN_SECRET H3_MAX_BODY_BYTES H3_MAX_VIDEO_BYTES H3_UPSTREAM_TIMEOUT H3_UPLOAD_TIMEOUT; do
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    case "$key" in
      H3_DB_PATH) value="$DATA/gateway.db" ;;
      H3_ADMIN_SECRET) value="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" ;;
      H3_MAX_BODY_BYTES|H3_MAX_VIDEO_BYTES) value="268435456" ;;
      H3_UPSTREAM_TIMEOUT) value="3600" ;;
      H3_UPLOAD_TIMEOUT) value="600" ;;
    esac
    umask 077
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
done
chmod 0600 "$ENV_FILE"
chown root:root "$ENV_FILE"
umask 022

if [ ! -x "$APP/.venv-admin/bin/python" ]; then
  python3 -m venv "$APP/.venv-admin"
fi
"$APP/.venv-admin/bin/pip" install --quiet --disable-pip-version-check \
  -r "$APP/requirements-admin.txt"
chown -R root:root "$APP/.venv-admin"
chmod -R a+rX "$APP/.venv-admin"

if [ -d "$APP/seed-swap" ]; then
  runuser -u huobao-h3 -- "$APP/.venv-admin/bin/python" "$APP/admin/cli.py" \
    --db "$DATA/gateway.db" seed-workflows --dir "$APP/seed-swap"
fi

systemctl daemon-reload
systemctl enable huobao-h3-gateway-swap.service >/dev/null
systemctl restart huobao-h3-gateway-swap.service
systemctl enable huobao-h3-admin-swap.service >/dev/null
systemctl restart huobao-h3-admin-swap.service
sleep 1
systemctl --no-pager --full status huobao-h3-gateway-swap.service | sed -n '1,12p'
systemctl --no-pager --full status huobao-h3-admin-swap.service | sed -n '1,12p'

echo
echo "换人网关 8194 -> 8189；管理端 8195 仅监听 127.0.0.1。"
echo "管理端通过 SSH 隧道访问：ssh -L 8195:127.0.0.1:8195 <用户>@<服务器>"
echo "尚未创建管理账号；需要时执行："
echo "  sudo -u huobao-h3 env H3_DB_PATH=$DATA/gateway.db \\"
echo "    $APP/.venv-admin/bin/python -m admin.cli create-admin --username admin"
