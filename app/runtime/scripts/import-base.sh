#!/usr/bin/env bash
# 导入固定的 Debian bookworm arm64 根文件系统，作为构建镜像与运行时镜像的共同基底。
set -euo pipefail

BASE_IMAGE="${BASE_IMAGE:-huobao-debian-base:arm64}"
BASE_URL="${BASE_URL:-https://images.linuxcontainers.org/images/debian/bookworm/arm64/default/20261110_05:24/rootfs.tar.xz}"
BASE_SHA256="${BASE_SHA256:-68ce225782c47e500c42ef90cf4c8a4d19ed2dc1b77004010405cc7c643820ee}"
CACHE_DIR="${CACHE_DIR:-$(cd "$(dirname "$0")/.." && pwd)/.build/cache}"

if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
    echo "base image exists: $BASE_IMAGE"
    exit 0
fi

mkdir -p "$CACHE_DIR"
archive="$CACHE_DIR/debian-bookworm-arm64-rootfs.tar.xz"
if [ ! -f "$archive" ]; then
    echo "downloading $BASE_URL"
    curl -fL --retry 3 --connect-timeout 30 -o "$archive.part" "$BASE_URL"
    mv "$archive.part" "$archive"
fi

if command -v sha256sum >/dev/null 2>&1; then
    echo "$BASE_SHA256  $archive" | sha256sum -c -
else
    echo "$BASE_SHA256  $archive" | shasum -a 256 -c -
fi
docker import --platform linux/arm64 "$archive" "$BASE_IMAGE"
rm -f "$archive"
echo "imported $BASE_IMAGE"
