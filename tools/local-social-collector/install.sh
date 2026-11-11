#!/bin/bash
# Install or update the local collector (Weibo/Tieba/Bilibili/Xiaohongshu + 百分点/智推时代) on this Mac.
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
cp "$HERE/industry.py" "$ROOT/industry.py"
if [ ! -f "$ROOT/config.json" ]; then
  echo "缺少 $ROOT/config.json（需要 endpoint 与 token，见 README）" >&2
  exit 1
fi
chmod 600 "$ROOT/config.json"
sed "s#__ROOT__#$ROOT#g" "$HERE/$LABEL.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
# 行业动态 agent (every 15 minutes, no browser).
AGENT_LABEL="com.trongeo.industry-agent"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
sed "s#__ROOT__#$ROOT#g" "$HERE/$AGENT_LABEL.plist" > "$AGENT_PLIST"
launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST"
echo "已安装：浏览器采集在新加坡时间 9、11、13、15、17、19、21、3 点的 :05 运行；行业动态 agent 每 15 分钟运行。首次请执行："
echo "  \"$ROOT/venv/bin/python\" \"$ROOT/collector.py\" login weibo"
echo "  \"$ROOT/venv/bin/python\" \"$ROOT/collector.py\" login xiaohongshu"
echo "  \"$ROOT/venv/bin/python\" \"$ROOT/collector.py\" login percent"
echo "  \"$ROOT/venv/bin/python\" \"$ROOT/collector.py\" login genoptima"
