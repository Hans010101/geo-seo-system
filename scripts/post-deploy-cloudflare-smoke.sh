#!/usr/bin/env bash
# Cloudflare Pages + Cron Worker 部署后验收。
# 用法: scripts/post-deploy-cloudflare-smoke.sh [PAGES_URL] [CRON_URL]
set -u

PAGES_URL="${1:-https://geo-seo-system.pages.dev}"
CRON_URL="${2:-https://geo-seo-system-cron.hans-pan007.workers.dev}"
FAIL=0

say() { printf '%s\n' "$*"; }
ok() { say "  ✅ $*"; }
bad() { say "  ❌ $*"; FAIL=1; }

http_code() {
  curl -sS -o /dev/null -w "%{http_code}" -m 30 "$1" || printf '000'
}

expect_code() {
  local label="$1"
  local url="$2"
  local expected="$3"
  local code
  code="$(http_code "$url")"
  if [ "$code" = "$expected" ]; then
    ok "${label} → ${code}"
  else
    bad "${label} → ${code}（期望 ${expected}）"
  fi
}

say "== Cloudflare smoke test =="
expect_code "GET /" "${PAGES_URL}/" "200"

HEALTH="$(curl -sS -m 30 "${PAGES_URL}/api/health" || true)"
HEALTH_CODE="$(http_code "${PAGES_URL}/api/health")"
if [ "$HEALTH_CODE" = "200" ] \
  && printf '%s' "$HEALTH" | grep -q '"ok":true' \
  && printf '%s' "$HEALTH" | grep -q '"db":true' \
  && printf '%s' "$HEALTH" | grep -q '"bootErrors":\[\]'; then
  ok "健康检查、数据库和启动状态正常"
else
  bad "健康检查失败：HTTP ${HEALTH_CODE} $(printf '%s' "$HEALTH" | head -c 300)"
fi

expect_code "auth.me" "${PAGES_URL}/api/trpc/auth.me" "200"
expect_code "monitor.listArticles（未登录）" \
  "${PAGES_URL}/api/trpc/monitor.listArticles?input=%7B%7D" "401"
expect_code "dashboard.summary（未登录）" \
  "${PAGES_URL}/api/trpc/dashboard.summary" "401"

CRON_BODY="$(curl -sS -m 30 "${CRON_URL}/" || true)"
CRON_CODE="$(http_code "${CRON_URL}/")"
if [ "$CRON_CODE" = "200" ] \
  && printf '%s' "$CRON_BODY" | grep -q '"standby":false' \
  && printf '%s' "$CRON_BODY" | grep -q '"mode":"canary"'; then
  ok "Cron Worker 可达且处于免费套餐金丝雀并行模式"
else
  bad "Cron Worker 状态异常：HTTP ${CRON_CODE} $(printf '%s' "$CRON_BODY" | head -c 300)"
fi

if [ "$FAIL" = "0" ]; then
  say "== ✅ CLOUDFLARE SMOKE PASS =="
  exit 0
fi

say "== ❌ CLOUDFLARE SMOKE FAIL =="
exit 1
