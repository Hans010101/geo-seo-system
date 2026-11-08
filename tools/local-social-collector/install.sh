#!/bin/bash
# Install or update the local Weibo/Tieba collector on this Mac.
# Usage: tools/local-social-collector/install.sh   (re-run after editing collector.py)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HOME/Library/Application Support/TronGeo/local-social-collector"
LABEL="com.trongeo.local-social-collector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$ROOT"
[ -x "$ROOT/venv/bin/python" ] || python3 -m venv "$ROOT/venv"
"$ROOT/venv/bin/pip" install -q --disable-pip-version-check playwright certifi
cp "$HERE/collector.py" "$ROOT/collector.py"
if [ ! -f "$ROOT/config.json" ]; then
  echo "缺少 $ROOT/config.json（需要 endpoint 与 token，见 README）" >&2
  exit 1
fi
chmod 600 "$ROOT/config.json"
sed "s#__ROOT__#$ROOT#g" "$HERE/$LABEL.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已安装：每小时 :05 运行。首次请执行："
echo "  \"$ROOT/venv/bin/python\" \"$ROOT/collector.py\" login weibo"
