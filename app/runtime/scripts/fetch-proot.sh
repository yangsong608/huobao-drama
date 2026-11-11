#!/usr/bin/env bash
# 取固定版本的 Termux proot 及其依赖，产出 proot/ 运行时目录（在 linux/arm64 构建容器内执行）。
# A1 真机结论：loader 与 loader32 必须随包携带，仅 bin/proot 会导致所有 exec 返回 EACCES。
set -euo pipefail

BASE="${TERMUX_APT_BASE:-https://packages.termux.dev/apt/termux-main}"
CACHE_DIR="${CACHE_DIR:-/cache/proot}"
OUT_DIR="${1:-/build/context/proot}"

PROOT_VERSION="5.1.107.102"
TALLOC_VERSION="2.5.0"
SHMEM_VERSION="0.7"

PROOT_SHA256="10a394b585c2fc2b2c8502544f4e5f1be581dc8bfff79e8ba62f16207423e030"
TALLOC_SHA256="556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7"
SHMEM_SHA256="0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6"

mkdir -p "$CACHE_DIR" "$OUT_DIR/bin" "$OUT_DIR/lib" "$OUT_DIR/libexec/proot" "$OUT_DIR/licenses"
index="$CACHE_DIR/Packages"
if [ ! -s "$index" ]; then
    curl -fsSL "$BASE/dists/stable/main/binary-aarch64/Packages" -o "$index.part"
    mv "$index.part" "$index"
fi

find_entry() {
    local pkg="$1" want="$2"
    awk -v pkg="$pkg" -v want="$want" '
        BEGIN { RS=""; FS="\n" }
        {
            name = ""; ver = ""; file = ""
            for (i = 1; i <= NF; i++) {
                if ($i ~ /^Package: /) name = substr($i, 10)
                if ($i ~ /^Version: /) ver = substr($i, 10)
                if ($i ~ /^Filename: /) file = substr($i, 11)
            }
            if (name == pkg && ver == want && file != "") { print file; exit }
        }
    ' "$index"
}

fetch_pkg() {
    local pkg="$1" version="$2" sha="$3"
    local filename deb
    filename="$(find_entry "$pkg" "$version")"
    if [ -z "$filename" ]; then
        echo "Termux 包索引中找不到 $pkg $version" >&2
        exit 1
    fi
    deb="$CACHE_DIR/$(basename "$filename")"
    if [ ! -f "$deb" ]; then
        curl -fsSL "$BASE/$filename" -o "$deb.part"
        mv "$deb.part" "$deb"
    fi
    echo "$sha  $deb" | sha256sum -c - >&2
    printf '%s\n' "$deb"
}

extract_deb() {
    local deb="$1" dest="$2"
    rm -rf "$dest"
    mkdir -p "$dest"
    dpkg-deb -x "$deb" "$dest"
}

proot_deb="$(fetch_pkg proot "$PROOT_VERSION" "$PROOT_SHA256")"
talloc_deb="$(fetch_pkg libtalloc "$TALLOC_VERSION" "$TALLOC_SHA256")"
shmem_deb="$(fetch_pkg libandroid-shmem "$SHMEM_VERSION" "$SHMEM_SHA256")"

# 在容器本地临时目录解包：macOS 绑定挂载对 dpkg-deb 的目录重命名不兼容
work="$(mktemp -d /tmp/proot-extract.XXXXXX)"
trap 'rm -rf "$work"' EXIT
extract_deb "$proot_deb" "$work/proot"
extract_deb "$talloc_deb" "$work/libtalloc"
extract_deb "$shmem_deb" "$work/libandroid-shmem"

usr=./data/data/com.termux/files/usr
install -m 755 "$work/proot/$usr/bin/proot" "$OUT_DIR/bin/proot"

for f in loader loader32; do
    src="$work/proot/$usr/libexec/proot/$f"
    if [ ! -s "$src" ]; then
        echo "proot 缺少 $f（A1 约束：缺失会导致全部 exec EACCES）" >&2
        exit 1
    fi
    install -m 755 "$src" "$OUT_DIR/libexec/proot/$f"
done

for so in libtalloc.so libtalloc.so.2 libtalloc.so."$TALLOC_VERSION"; do
    src="$work/libtalloc/$usr/lib/$so"
    if [ -L "$src" ]; then
        cp -aL "$src" "$OUT_DIR/lib/$so.tmp"
    else
        install -m 644 "$src" "$OUT_DIR/lib/$so.tmp"
    fi
    mv "$OUT_DIR/lib/$so.tmp" "$OUT_DIR/lib/$so"
done
install -m 644 "$work/libandroid-shmem/$usr/lib/libandroid-shmem.so" "$OUT_DIR/lib/libandroid-shmem.so"

copyright="$work/libandroid-shmem/$usr/share/doc/libandroid-shmem/copyright"
if [ -f "$copyright" ]; then
    install -m 644 "$copyright" "$OUT_DIR/licenses/libandroid-shmem.copyright"
fi

{
    echo "proot=$PROOT_VERSION"
    echo "libtalloc=$TALLOC_VERSION"
    echo "libandroid-shmem=$SHMEM_VERSION"
} > "$OUT_DIR/VERSION"

echo "proot $PROOT_VERSION 就绪：$OUT_DIR"
find "$OUT_DIR" -type f -printf '%m %p\n' | sort
