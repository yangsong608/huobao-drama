#!/usr/bin/env bash
# 运行时打包入口（宿主机执行，要求 Docker Desktop 与 linux/arm64 原生能力）。
# 阶段：基础镜像 → 构建容器 → 上下文 → rootfs 镜像 → 导出 → 裁剪打包 → 冒烟 → 校验 → 归档。
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$RUNTIME_DIR/../.." && pwd)"
BUILD_DIR="$RUNTIME_DIR/.build"
CACHE_DIR="$BUILD_DIR/cache"
OUT_DIR="$BUILD_DIR/out"
CONTEXT_DIR="$BUILD_DIR/context"
EXPORT_TAR="$BUILD_DIR/export.tar"

BASE_IMAGE="${BASE_IMAGE:-huobao-debian-base:arm64}"
BUILDER_IMAGE="${BUILDER_IMAGE:-huobao-runtime-builder:local}"
ROOTFS_IMAGE="${ROOTFS_IMAGE:-huobao-runtime:local}"

APP_VERSION="${APP_VERSION:-$(node -p "require('$REPO_ROOT/desktop/package.json').version")}"
BACKEND_VERSION="${BACKEND_VERSION:-$(node -p "require('$REPO_ROOT/backend/package.json').version")}"
RUNTIME_VERSION="${RUNTIME_VERSION:-$APP_VERSION-runtime1}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-946684800}"
VOLUME_SIZE="${VOLUME_SIZE:-200M}"
ZSTD_LEVEL="${ZSTD_LEVEL:-19}"
SKIP_WEB="${SKIP_WEB:-0}"
SKIP_SMOKE="${SKIP_SMOKE:-0}"
FORCE_REBUILD="${FORCE_REBUILD:-0}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$RUNTIME_DIR/out/$RUNTIME_VERSION}"

GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
if [ -n "$GIT_COMMIT" ] && [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)" ]; then
    GIT_COMMIT="$GIT_COMMIT+dirty"
fi

if ! docker info >/dev/null 2>&1; then
    echo "Docker 不可用" >&2
    exit 1
fi
docker_arch="$(docker info --format '{{.Architecture}}' 2>/dev/null || true)"
if [ "$docker_arch" != "aarch64" ] && [ "$docker_arch" != "arm64" ]; then
    echo "要求 linux/arm64 原生构建环境，当前 Docker 架构：$docker_arch" >&2
    exit 1
fi

mkdir -p "$BUILD_DIR" "$CACHE_DIR"

echo "==> 基础镜像 $BASE_IMAGE"
BASE_IMAGE="$BASE_IMAGE" CACHE_DIR="$CACHE_DIR" bash "$RUNTIME_DIR/scripts/import-base.sh"

echo "==> 构建容器 $BUILDER_IMAGE"
builder_args=(--platform linux/arm64 -t "$BUILDER_IMAGE" -f "$RUNTIME_DIR/container/Dockerfile.builder")
if [ "$FORCE_REBUILD" = "1" ]; then builder_args+=(--no-cache); fi
docker build "${builder_args[@]}" "$RUNTIME_DIR/container"

echo "==> 准备构建上下文"
web_mount_args=()
web_source_container=/work/frontend/.output/public
if [ "$SKIP_WEB" != "1" ]; then
    web_source_host="${WEB_SOURCE:-$REPO_ROOT/frontend/.output/public}"
    if [ ! -f "$web_source_host/index.html" ]; then
        echo "缺少前端产物：$web_source_host/index.html；请先执行前端 generate，或通过 WEB_SOURCE 指定，或 SKIP_WEB=1" >&2
        exit 1
    fi
    web_mount_args=(-v "$web_source_host:/web:ro")
    web_source_container=/web
fi
docker run --rm --platform linux/arm64 \
    -v "$REPO_ROOT:/work:ro" \
    -v "$BUILD_DIR:/build" \
    -v "$CACHE_DIR:/cache" \
    ${web_mount_args[@]+"${web_mount_args[@]}"} \
    -e REPO_ROOT=/work \
    -e BUILD_DIR=/build \
    -e CACHE_DIR=/cache \
    -e SKIP_WEB="$SKIP_WEB" \
    -e WEB_SOURCE="$web_source_container" \
    -e RUNTIME_VERSION="$RUNTIME_VERSION" \
    -e APP_VERSION="$APP_VERSION" \
    -e BACKEND_VERSION="$BACKEND_VERSION" \
    -e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
    -e GIT_COMMIT="$GIT_COMMIT" \
    "$BUILDER_IMAGE" bash /work/app/runtime/scripts/inner-bundle.sh

echo "==> rootfs 镜像 $ROOTFS_IMAGE"
docker build --platform linux/arm64 -f "$RUNTIME_DIR/rootfs/Dockerfile" -t "$ROOTFS_IMAGE" "$CONTEXT_DIR"

echo "==> 导出 rootfs"
cid="$(docker create --platform linux/arm64 "$ROOTFS_IMAGE")"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker export "$cid" -o "$EXPORT_TAR"
docker rm -f "$cid" >/dev/null
trap - EXIT

echo "==> 裁剪、压缩分卷、清单"
docker run --rm --platform linux/arm64 \
    -v "$REPO_ROOT:/work:ro" \
    -v "$BUILD_DIR:/build" \
    -e BUILD_DIR=/build \
    -e EXPORT_TAR=/build/export.tar \
    -e STAGE_DIR=/tmp/stage \
    -e OUT_DIR=/build/out \
    -e META_FILE=/build/meta.json \
    -e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
    -e VOLUME_SIZE="$VOLUME_SIZE" \
    -e ZSTD_LEVEL="$ZSTD_LEVEL" \
    "$BUILDER_IMAGE" bash /work/app/runtime/scripts/inner-package.sh
rm -f "$EXPORT_TAR"

if [ "$SKIP_SMOKE" != "1" ]; then
    echo "==> 容器冒烟测试"
    name="huobao-runtime-smoke-$$"
    docker rm -f "$name" >/dev/null 2>&1 || true
    trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
    docker run -d --name "$name" --platform linux/arm64 \
        --tmpfs /data:rw,size=512m \
        -e HOST=127.0.0.1 \
        -e PORT=5679 \
        -e HUOBAO_DATA_DIR=/data \
        -e SQLITE_PATH=/data/huobao.sqlite3 \
        -e STORAGE_PATH=/data/static \
        -e WORKSPACE_PATH=/opt/huobao/workspace \
        -e FRONTEND_DIST=/opt/huobao/web \
        -e HUOBAO_VERSION="$APP_VERSION" \
        "$ROOTFS_IMAGE" >/dev/null

    healthy=0
    for _ in $(seq 1 120); do
        if docker exec "$name" /usr/local/bin/node -e \
            "fetch('http://127.0.0.1:5679/api/v1/health').then(r=>r.json()).then(j=>{if(j.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))" \
            >/dev/null 2>&1; then
            healthy=1
            break
        fi
        sleep 1
    done
    if [ "$healthy" != "1" ]; then
        echo "后端健康检查超时，日志尾部：" >&2
        docker logs --tail 200 "$name" >&2 || true
        exit 1
    fi

    docker cp "$RUNTIME_DIR/scripts/smoke.mjs" "$name":/tmp/smoke.mjs
    docker exec \
        -e SMOKE_HEALTH_URL=http://127.0.0.1:5679/api/v1/health \
        -e SMOKE_SQLITE_PATH=/data/huobao.sqlite3 \
        "$name" /usr/local/bin/node /tmp/smoke.mjs | tee "$BUILD_DIR/smoke.json"
    docker rm -f "$name" >/dev/null
    trap - EXIT
else
    echo "==> 跳过冒烟测试（SKIP_SMOKE=1）"
fi

echo "==> 解压校验"
SKIP_WEB="$SKIP_WEB" docker run --rm --platform linux/arm64 \
    -v "$REPO_ROOT:/work:ro" \
    -v "$BUILD_DIR:/build" \
    -e BUILD_DIR=/build \
    -e OUT_DIR=/build/out \
    -e VERIFY_DIR=/tmp/verify \
    -e SKIP_WEB="$SKIP_WEB" \
    "$BUILDER_IMAGE" bash /work/app/runtime/scripts/inner-verify.sh | tee "$BUILD_DIR/verify.log"

echo "==> 归档 $ARTIFACT_DIR"
rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"
cp "$OUT_DIR/manifest.json" "$ARTIFACT_DIR/"
cp "$OUT_DIR"/runtime.tar.zst.part-* "$ARTIFACT_DIR/"
if [ -f "$BUILD_DIR/smoke.json" ]; then cp "$BUILD_DIR/smoke.json" "$ARTIFACT_DIR/"; fi
if [ -f "$BUILD_DIR/verify.log" ]; then cp "$BUILD_DIR/verify.log" "$ARTIFACT_DIR/"; fi

total="$(du -sk "$ARTIFACT_DIR" | awk '{print $1}')"
echo
echo "构建完成：$RUNTIME_VERSION"
echo "  分卷总数：$(ls "$ARTIFACT_DIR"/runtime.tar.zst.part-* | wc -l | tr -d ' ')"
echo "  压缩总体积：$((total / 1024)) MB"
node -e '
const m = require(process.argv[1])
console.log("  解压后文件：" + m.totals.fileCount + "，原始体积：" + (m.totals.totalBytes / 1024 / 1024).toFixed(1) + " MB")
console.log("  压缩包 SHA-256：" + m.archive.whole.sha256)
' "$ARTIFACT_DIR/manifest.json"
