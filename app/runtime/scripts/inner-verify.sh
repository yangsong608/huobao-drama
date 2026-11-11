#!/usr/bin/env bash
# 运行时包校验（在 huobao-runtime-builder 内执行）：分卷哈希、解压、逐文件哈希、禁用项。
set -euo pipefail

BUILD_DIR="${BUILD_DIR:-/build}"
OUT_DIR="${OUT_DIR:-$BUILD_DIR/out}"
VERIFY_DIR="${VERIFY_DIR:-$BUILD_DIR/verify}"
RUNTIME_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$OUT_DIR/manifest.json"

if [ ! -f "$MANIFEST" ]; then
    echo "缺少清单：$MANIFEST" >&2
    exit 1
fi

rm -rf "$VERIFY_DIR"
mkdir -p "$VERIFY_DIR/stage"

echo "[1/5] 校验分卷哈希"
node - "$MANIFEST" "$OUT_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const [manifestPath, outDir] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
for (const vol of manifest.archive.volumes) {
  const abs = path.join(outDir, vol.name)
  const buf = fs.readFileSync(abs)
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  if (buf.length !== vol.size || sha !== vol.sha256) {
    console.error(`分卷校验失败: ${vol.name}`)
    process.exit(1)
  }
}
console.log(`  ${manifest.archive.volumes.length} 个分卷哈希一致`)
NODE

echo "[2/6] 合并解压（记录首解压耗时）"
start_ms="$(date +%s%3N)"
cat "$OUT_DIR"/runtime.tar.zst.part-* | zstd -d -T1 -q > "$VERIFY_DIR/runtime.tar"
end_ms="$(date +%s%3N)"
echo "  解压耗时 $((end_ms - start_ms)) ms"

echo "[3/6] 检查硬链接条目"
if tar -tvf "$VERIFY_DIR/runtime.tar" | awk '$1 ~ /^h/ { print "发现硬链接条目：" $0; bad = 1 } END { exit bad ? 1 : 0 }'; then
    echo "  无硬链接条目"
else
    exit 1
fi
tar -xf "$VERIFY_DIR/runtime.tar" -C "$VERIFY_DIR/stage"
rm -f "$VERIFY_DIR/runtime.tar"

echo "[4/6] 逐文件哈希比对"
STAGE_DIR="$VERIFY_DIR/stage" OUT_FILE="$VERIFY_DIR/manifest.verify.json" META_FILE="$VERIFY_DIR/stage/runtime-meta.json" \
    node "$RUNTIME_DIR/scripts/make-manifest.mjs" files
node "$RUNTIME_DIR/scripts/compare-manifests.mjs" --files-only "$MANIFEST" "$VERIFY_DIR/manifest.verify.json"

echo "[5/6] 禁用项扫描"
STAGE_DIR="$VERIFY_DIR/stage" node "$RUNTIME_DIR/scripts/scan-forbidden.mjs"

echo "[6/6] 必需文件与执行位"
required=(
    runtime-meta.json
    rootfs/opt/huobao/backend.mjs
    rootfs/opt/huobao/web/index.html
    rootfs/opt/huobao/workspace/skills
    rootfs/usr/local/bin/node
    proot/bin/proot
    proot/libexec/proot/loader
    proot/libexec/proot/loader32
    proot/lib/libandroid-shmem.so
    licenses/THIRD-PARTY.md
)
for rel in "${required[@]}"; do
    if [ "$rel" = "rootfs/opt/huobao/web/index.html" ] && [ "${SKIP_WEB:-0}" = "1" ]; then
        continue
    fi
    if [ ! -e "$VERIFY_DIR/stage/$rel" ]; then
        echo "缺少必需文件：$rel" >&2
        exit 1
    fi
done
for rel in proot/bin/proot proot/libexec/proot/loader proot/libexec/proot/loader32 rootfs/usr/local/bin/node; do
    if [ ! -x "$VERIFY_DIR/stage/$rel" ]; then
        echo "缺少执行位：$rel" >&2
        exit 1
    fi
done
echo "  必需文件与执行位通过"

echo "校验通过：$MANIFEST"
