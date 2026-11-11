#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
PKG="com.huobao.a1probe"

serial="$("$ADB" devices | awk 'NR>1 && $2=="device"{print $1; exit}')"
if [ -z "$serial" ]; then
    echo "no adb device" >&2
    exit 1
fi

"$ADB" -s "$serial" shell am force-stop "$PKG"
"$ADB" -s "$serial" shell am start -n "$PKG/.MainActivity" --ez autorun true

for _ in $(seq 1 90); do
    sleep 2
    log="$("$ADB" -s "$serial" shell "run-as $PKG cat files/a1.log 2>/dev/null" || true)"
    if printf '%s' "$log" | grep -q '^exit='; then
        printf '%s\n' "$log"
        break
    fi
done
