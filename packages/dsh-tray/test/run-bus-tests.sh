#!/usr/bin/env bash
# 起独立 dbus-daemon(不碰桌面总线),跑全部测试后清理。
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOCK=/tmp/dsh-tray-test-$$.sock
ADDR_FILE=/tmp/dsh-tray-addr-$$.txt
rm -f "$SOCK" "$ADDR_FILE"
dbus-daemon --session --address="unix:path=$SOCK" --print-address=1 > "$ADDR_FILE" 2>/dev/null &
DAEMON=$!
cleanup() {
  kill "$DAEMON" 2>/dev/null || true
  rm -f "$SOCK" "$ADDR_FILE"
}
trap cleanup EXIT
for _ in 1 2 3 4 5 6 7 8; do
  [ -s "$ADDR_FILE" ] && break
  sleep 0.2
done
ADDR="$(cat "$ADDR_FILE")"
[ -n "$ADDR" ] || { echo "dbus-daemon 启动失败" >&2; exit 2; }
export DBUS_SESSION_BUS_ADDRESS="$ADDR"
cd "$DIR"
node --test test/*.test.mjs
