#!/usr/bin/env bash
# 运行时打包（在 huobao-runtime-builder 内执行）：导出根目录裁剪、proot/许可证合入、
# 确定性 tar、zstd 分卷、逐文件清单。
set -euo pipefail
umask 022

BUILD_DIR="${BUILD_DIR:-/build}"
CTX="$BUILD_DIR/context"
EXPORT_TAR="${EXPORT_TAR:-$BUILD_DIR/export.tar}"
STAGE="${STAGE_DIR:-$BUILD_DIR/stage}"
OUT_DIR="${OUT_DIR:-$BUILD_DIR/out}"
META_FILE="${META_FILE:-$BUILD_DIR/meta.json}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-946684800}"
VOLUME_SIZE="${VOLUME_SIZE:-200M}"
VOLUME_PREFIX="runtime.tar.zst.part-"
ARCHIVE_NAME="runtime.tar.zst"
ZSTD_LEVEL="${ZSTD_LEVEL:-19}"
RUNTIME_DIR="$(cd "$(dirname "$0")/.." && pwd)"

for f in "$EXPORT_TAR" "$META_FILE" "$CTX/backend.mjs" "$CTX/proot/bin/proot"; do
    if [ ! -e "$f" ]; then
        echo "缺少输入：$f" >&2
        exit 1
    fi
done

rm -rf "$STAGE" "$OUT_DIR"
mkdir -p "$STAGE/rootfs" "$OUT_DIR"

echo "[1/6] 解包 docker export"
tar -xf "$EXPORT_TAR" -C "$STAGE/rootfs"
rm -f "$STAGE/rootfs/.dockerenv"

echo "[2/6] 生成许可证清单"
STAGE_DIR="$STAGE/rootfs" LICENSES_DIR="$STAGE/licenses" PROOT_DIR="$CTX/proot" META_FILE="$META_FILE" \
    node "$RUNTIME_DIR/scripts/make-licenses.mjs"

echo "[3/6] 合入 proot 并裁剪 rootfs"
cp -a "$CTX/proot" "$STAGE/proot"
rm -rf "$STAGE/proot/licenses"
install -m 644 "$META_FILE" "$STAGE/runtime-meta.json"

cd "$STAGE/rootfs"
rm -rf var/lib/apt var/lib/dpkg var/cache/apt var/cache/debconf var/lib/systemd var/log
rm -rf usr/share/doc usr/share/man usr/share/info usr/share/lintian usr/share/bug usr/share/common-licenses
rm -rf usr/local/share/doc usr/local/share/man usr/local/share/systemtap
rm -rf etc/apt etc/init.d etc/systemd etc/rc0.d etc/rc1.d etc/rc2.d etc/rc3.d etc/rc4.d etc/rc5.d etc/rc6.d
rm -rf lib/systemd usr/lib/systemd
rm -f etc/hostname etc/hosts etc/machine-id
find tmp var/tmp -mindepth 1 -delete 2>/dev/null || true
mkdir -p etc
: > etc/resolv.conf
cd "$STAGE"

STAGE_DIR="$STAGE" node "$RUNTIME_DIR/scripts/scan-forbidden.mjs"

echo "[4/6] 生成文件清单"
STAGE_DIR="$STAGE" OUT_FILE="$OUT_DIR/manifest.files.json" META_FILE="$META_FILE" \
    node "$RUNTIME_DIR/scripts/make-manifest.mjs" files

echo "[5/6] 确定性 tar + zstd -$ZSTD_LEVEL"
# Android 16 的应用私有目录禁止 link()，归档不能依赖硬链接还原
tar --sort=name \
    --mtime="@$SOURCE_DATE_EPOCH" \
    --owner=0 --group=0 --numeric-owner \
    --format=gnu \
    --hard-dereference \
    -C "$STAGE" -cf "$OUT_DIR/runtime.tar" .

zstd "-$ZSTD_LEVEL" -T1 --no-progress -q -o "$OUT_DIR/$ARCHIVE_NAME" "$OUT_DIR/runtime.tar"
rm -f "$OUT_DIR/runtime.tar"
archive_size="$(stat -c %s "$OUT_DIR/$ARCHIVE_NAME")"
archive_sha="$(sha256sum "$OUT_DIR/$ARCHIVE_NAME" | awk '{print $1}')"

echo "[6/6] 分卷 $VOLUME_SIZE"
split -b "$VOLUME_SIZE" -d -a 3 "$OUT_DIR/$ARCHIVE_NAME" "$OUT_DIR/$VOLUME_PREFIX"
rm -f "$OUT_DIR/$ARCHIVE_NAME"

FILES_MANIFEST="$OUT_DIR/manifest.files.json" \
OUT_FILE="$OUT_DIR/manifest.json" \
ARCHIVE_DIR="$OUT_DIR" \
VOLUME_PREFIX="$VOLUME_PREFIX" \
ARCHIVE_NAME="$ARCHIVE_NAME" \
ARCHIVE_SIZE="$archive_size" \
ARCHIVE_SHA256="$archive_sha" \
VOLUME_SIZE="$VOLUME_SIZE" \
ZSTD_LEVEL="$ZSTD_LEVEL" \
    node "$RUNTIME_DIR/scripts/make-manifest.mjs" finalize
rm -f "$OUT_DIR/manifest.files.json"

du -sh "$OUT_DIR"
ls -l "$OUT_DIR"
