#!/usr/bin/env bash
# 完整部署 Cloudflare Pages 与待命 Cron Worker，并执行线上验收。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  printf '需要 Node.js 22+，当前为 %s\n' "$(node --version)" >&2
  exit 1
fi

pnpm run check
pnpm test
pnpm run cf:deploy:pages
pnpm run cf:deploy:cron
bash scripts/post-deploy-cloudflare-smoke.sh
