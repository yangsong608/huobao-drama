#!/usr/bin/env bash
# 构建上下文准备（在 huobao-runtime-builder 内执行）：proot + 原生依赖清单 + 后端 bundle + 前端产物 + 工作区模板。
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/work}"
BUILD_DIR="${BUILD_DIR:-/build}"
CACHE_DIR="${CACHE_DIR:-/cache}"
RUNTIME_DIR="$REPO_ROOT/app/runtime"
CTX="$BUILD_DIR/context"
SKIP_WEB="${SKIP_WEB:-0}"
NODE_EXPECTED="${NODE_EXPECTED:-22.16.0}"

node_version="$(node -p 'process.versions.node')"
if [ "$node_version" != "$NODE_EXPECTED" ]; then
    echo "构建容器 Node 版本不符：$node_version != $NODE_EXPECTED" >&2
    exit 1
fi

rm -rf "$CTX"
mkdir -p "$CTX"

bash "$RUNTIME_DIR/scripts/fetch-proot.sh" "$CTX/proot"

install -m 644 "$RUNTIME_DIR/package/package.json" "$CTX/package.json"
install -m 644 "$RUNTIME_DIR/package/package-lock.json" "$CTX/package-lock.json"

# bundle 解析依赖：按 backend 锁文件在容器内安装一份，仅用于 esbuild 解析；
# 原生模块不执行安装脚本，最终运行时另用 package/ 的精确版本。
DEPS_DIR="$BUILD_DIR/deps"
lock_sha="$(sha256sum "$REPO_ROOT/backend/package-lock.json" | awk '{print $1}')"
if [ ! -d "$DEPS_DIR/node_modules" ] || [ ! -f "$DEPS_DIR/lock.sha256" ] || [ "$(cat "$DEPS_DIR/lock.sha256")" != "$lock_sha" ]; then
    echo "安装 bundle 解析依赖（锁文件 $lock_sha）"
    rm -rf "$DEPS_DIR"
    mkdir -p "$DEPS_DIR"
    cp "$REPO_ROOT/backend/package.json" "$REPO_ROOT/backend/package-lock.json" "$DEPS_DIR/"
    (cd "$DEPS_DIR" && npm ci --ignore-scripts --omit=dev --no-audit --no-fund --cache "$CACHE_DIR/npm")
    printf '%s\n' "$lock_sha" > "$DEPS_DIR/lock.sha256"
else
    echo "复用 bundle 解析依赖缓存"
fi

REPO_ROOT="$REPO_ROOT" OUT_DIR="$CTX" NODE_PATHS="$DEPS_DIR/node_modules" \
    node "$RUNTIME_DIR/scripts/build-backend.cjs"

web_included=false
if [ "$SKIP_WEB" = "1" ]; then
    mkdir -p "$CTX/web"
    echo "SKIP_WEB=1：本次构建不含前端产物（仅用于运行时流水线自测）"
else
    web_src="${WEB_SOURCE:-$REPO_ROOT/frontend/.output/public}"
    if [ ! -f "$web_src/index.html" ]; then
        echo "缺少前端产物：$web_src/index.html；请先执行 frontend 的 npm run generate，或显式 SKIP_WEB=1" >&2
        exit 1
    fi
    cp -a "$web_src" "$CTX/web"
    web_included=true
fi

cp -a "$REPO_ROOT/backend/workspace" "$CTX/workspace"

schema_sha="$(node - "$REPO_ROOT" <<'NODE'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const repo = process.argv[2]
const files = ['backend/src/db/schema.ts', 'backend/src/db/sqlite-schema.ts']
const h = crypto.createHash('sha256')
for (const rel of files.slice().sort()) {
  h.update(rel + '\0')
  h.update(fs.readFileSync(path.join(repo, rel)))
}
process.stdout.write(h.digest('hex'))
NODE
)"

proot_version="$(sed -n 's/^proot=//p' "$CTX/proot/VERSION")"
META_PATH="$BUILD_DIR/meta.json" \
PROOT_VERSION="$proot_version" \
SCHEMA_SHA="$schema_sha" \
WEB_INCLUDED="$web_included" \
NODE_EXPECTED="$NODE_EXPECTED" \
CTX="$CTX" \
node -e '
const fs = require("fs")
const lock = require(process.env.CTX + "/package-lock.json")
const meta = {
  runtimeVersion: process.env.RUNTIME_VERSION || "",
  appVersion: process.env.APP_VERSION || "",
  backendVersion: process.env.BACKEND_VERSION || "",
  nodeVersion: process.env.NODE_EXPECTED || "22.16.0",
  prootVersion: process.env.PROOT_VERSION || "",
  schemaSha256: process.env.SCHEMA_SHA,
  webIncluded: process.env.WEB_INCLUDED === "true",
  sourceRevision: process.env.GIT_COMMIT || "",
  sourceDateEpoch: Number(process.env.SOURCE_DATE_EPOCH || 946684800),
  bundledBetterSqlite3: lock.packages["node_modules/better-sqlite3"].version,
  bundledSharp: lock.packages["node_modules/sharp"].version,
}
fs.writeFileSync(process.env.META_PATH, JSON.stringify(meta, null, 2) + "\n")
'

du -sh "$CTX"/*
echo "构建上下文就绪：$CTX"
