#!/usr/bin/env bash
# 安装/升级 H3 网关；Token 只在本机生成，不回显、不出现在命令行参数里。
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
APP=/opt/huobao-h3-gateway
DATA=/var/lib/huobao-h3-gateway
ENV_FILE=/etc/huobao-h3-gateway.env
UNIT=/etc/systemd/system/huobao-h3-gateway.service
UNIT_ADMIN=/etc/systemd/system/huobao-h3-admin.service

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh 需要 root 权限" >&2
  exit 1
fi
if [ ! -f "$SRC/h3_gateway.py" ] || [ ! -d "$SRC/workflows" ] || [ ! -d "$SRC/admin" ] || [ ! -d "$SRC/seed" ]; then
  echo "源码目录不完整: $SRC" >&2
  exit 1
fi

id -u huobao-h3 >/dev/null 2>&1 || \
  useradd --system --no-create-home --home-dir "$DATA" --shell /usr/sbin/nologin huobao-h3

install -d -m 0755 "$APP" "$APP/workflows" "$APP/deploy" "$APP/seed"
install -d -m 0755 "$DATA" "$DATA/files"
install -m 0644 "$SRC/h3_gateway.py" "$APP/h3_gateway.py"
for file in "$SRC"/workflows/*.json; do
  install -m 0644 "$file" "$APP/workflows/$(basename "$file")"
done
for file in "$SRC"/seed/*.json; do
  install -m 0644 "$file" "$APP/seed/$(basename "$file")"
done
install -m 0644 "$SRC/deploy/h3-gateway.service" "$UNIT"
install -m 0644 "$SRC/deploy/huobao-h3-admin.service" "$UNIT_ADMIN"
install -m 0644 "$SRC/requirements-admin.txt" "$APP/requirements-admin.txt"
install -d -m 0755 "$APP/admin"
cp -R "$SRC/admin/." "$APP/admin/"
find "$APP/admin" -type d -name '__pycache__' -prune -exec rm -rf {} +
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

if ! grep -q '^H3_DB_PATH=' "$ENV_FILE"; then
  printf 'H3_DB_PATH=%s\n' "$DATA/gateway.db" >> "$ENV_FILE"
fi
if ! grep -q '^H3_ADMIN_SECRET=' "$ENV_FILE"; then
  umask 077
  printf 'H3_ADMIN_SECRET=%s\n' \
    "$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" >> "$ENV_FILE"
  echo "已生成管理台会话密钥（不回显）"
fi
chmod 0600 "$ENV_FILE"
chown root:root "$ENV_FILE"
umask 022  # 生成密钥用的 077 不能延续到 venv，否则服务用户无法进入目录

# 管理台依赖独立 venv，避免影响系统 Python 上的网关
if [ ! -x "$APP/.venv-admin/bin/python" ]; then
  python3 -m venv "$APP/.venv-admin"
fi
"$APP/.venv-admin/bin/pip" install --quiet --disable-pip-version-check \
  -r "$APP/requirements-admin.txt"
chown -R root:root "$APP/.venv-admin"
chmod -R a+rX "$APP/.venv-admin"

# 首次安装写入内置工作流；已存在的 slug 不覆盖，避免冲掉管理端改过的参数
runuser -u huobao-h3 -- env PYTHONPATH="$APP" H3_DB_PATH="$DATA/gateway.db" \
  "$APP/.venv-admin/bin/python" -m admin.cli seed-workflows --dir "$APP/seed" \
  || echo "种子工作流导入失败，可在管理台手动新建或从 ComfyUI 导入" >&2

systemctl daemon-reload
systemctl enable huobao-h3-gateway.service >/dev/null
systemctl restart huobao-h3-gateway.service
systemctl enable huobao-h3-admin.service >/dev/null
systemctl restart huobao-h3-admin.service
sleep 1
systemctl --no-pager --full status huobao-h3-gateway.service | sed -n '1,12p'
systemctl --no-pager --full status huobao-h3-admin.service | sed -n '1,12p'

ADMIN_USERS="$("$APP/.venv-admin/bin/python" -c \
  "import sys; sys.path.insert(0, '$APP'); from admin import db; print(len(db.list_admin_users('$DATA/gateway.db')))" \
  2>/dev/null || echo 0)"
if [ "$ADMIN_USERS" = "0" ]; then
  echo
  echo "尚未创建管理台账号，请执行（会提示输入密码）："
  echo "  sudo -u huobao-h3 env H3_DB_PATH=$DATA/gateway.db \\"
  echo "    $APP/.venv-admin/bin/python -m admin.cli create-admin --username admin"
fi
echo
echo "管理台仅监听 127.0.0.1:8193；通过 SSH 隧道访问："
echo "  ssh -L 8193:127.0.0.1:8193 <用户>@<服务器>"
echo "  浏览器打开 http://127.0.0.1:8193"
