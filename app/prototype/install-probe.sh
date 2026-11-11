#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
PKG="com.huobao.a1probe"
APP="/data/user/0/$PKG/files"

serial="$("$ADB" devices | awk 'NR>1 && $2=="device"{print $1; exit}')"
if [ -z "$serial" ]; then
    echo "no adb device" >&2
    exit 1
fi

"$ADB" -s "$serial" install -r app/build/outputs/apk/debug/app-debug.apk
"$ADB" -s "$serial" shell "run-as $PKG mkdir -p $APP/a1/lib $APP/rootfs"

"$ADB" -s "$serial" push runtime/proot/bin/proot /data/local/tmp/a1-proot
"$ADB" -s "$serial" push runtime/proot/lib/libtalloc.so.2 /data/local/tmp/a1-libtalloc.so.2
"$ADB" -s "$serial" push runtime/proot/lib/libandroid-shmem.so /data/local/tmp/a1-libandroid-shmem.so
"$ADB" -s "$serial" push runtime/test.sh /data/local/tmp/a1-test.sh

"$ADB" -s "$serial" shell "run-as $PKG cp /data/local/tmp/a1-proot $APP/a1/proot"
"$ADB" -s "$serial" shell "run-as $PKG cp /data/local/tmp/a1-libtalloc.so.2 $APP/a1/lib/libtalloc.so.2"
"$ADB" -s "$serial" shell "run-as $PKG cp /data/local/tmp/a1-libandroid-shmem.so $APP/a1/lib/libandroid-shmem.so"
"$ADB" -s "$serial" shell "run-as $PKG cp /data/local/tmp/a1-test.sh $APP/a1/test.sh"
"$ADB" -s "$serial" shell "run-as $PKG chmod 755 $APP/a1/proot $APP/a1/test.sh"

"$ADB" -s "$serial" push runtime/rootfs.tar /data/local/tmp/a1-rootfs.tar
"$ADB" -s "$serial" shell "run-as $PKG tar xf /data/local/tmp/a1-rootfs.tar -C $APP/rootfs"
"$ADB" -s "$serial" shell "run-as $PKG rm -f $APP/rootfs/etc/resolv.conf"
"$ADB" -s "$serial" shell "run-as $PKG ls $APP/rootfs | head -5"
