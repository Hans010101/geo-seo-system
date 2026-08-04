# 部署与迁移手册

## 当前策略

Cloudflare 已部署完整版本，Cloud Run 暂时保持不动：

```text
用户 ──→ Cloudflare Pages + Functions ──→ Hyperdrive ──→ Cloud SQL MySQL

Cloudflare Cron Worker（Queue 分片主运行版本）
Cloud Run（保持原样，仅用于平行对比）
```

Cloudflare Cron 当前开启 `primary` 模式：

- 北京时间奇数小时 `:15` 运行新闻批次，`:40` 运行社交批次；
- Workers AI 为文章分析主路由，OpenRouter 只作故障降级和 GEO 平台采集；
- 币安广场通过 Browser/Serper 在 Cloudflare 内独立采集，不允许调用 Cloud Run 兜底；
- Browser Shadow 使用独立串行 Queue、每日 4 页和 8 分钟硬预算；
- 实时告警、负面简报和最终失败通知有独立开关与幂等键；
- 每日 GEO 是 24 单元的轮转抽样，每周 GEO 是 31 问题 × 全部 15 平台的完整矩阵；
- OpenRouter 每日先做低成本预检，402、鉴权失败或状态过期时只暂停 GEO，不影响舆情主链。

Cloud Run 不参与 Cloudflare 的运行时降级链，且在迁移验收完成前不得停止、修改或删除。

## Cloudflare 资源

- Pages 项目：`geo-seo-system`
- Pages 地址：`https://geo-seo-system.pages.dev`
- Cron Worker：`geo-seo-system-cron`
- Cron 地址：`https://geo-seo-system-cron.hans-pan007.workers.dev`
- Hyperdrive：`geo-seo-system-mysql`
- Hyperdrive ID：`cd45e0e89ac544eebd5eb7eb0ab3b8de`
- 数据库账号：独立的 `geo_cloudflare` 最小权限账号，强制 TLS

Cloudflare Pages Secret（只记录名称，不记录值）：

- `JWT_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `RESEND_API_KEY`

Cron Worker Secret：

- `OPENROUTER_API_KEY`
- `RESEND_API_KEY`

数据库连接信息由 Hyperdrive 保存，不应另设明文 `DATABASE_URL`。

## 标准 Cloudflare 部署

前置条件：

1. Node.js 22、pnpm 10；
2. `pnpm install --frozen-lockfile` 已完成；
3. Wrangler 已登录到正确的 Cloudflare 账号；
4. Hyperdrive、数据库网络规则和 Secrets 已配置。

一键部署：

```bash
bash scripts/deploy-cloudflare.sh
```

等价的手动流程：

```bash
pnpm run check
pnpm test
pnpm run cf:deploy:pages
pnpm run cf:deploy:cron
bash scripts/post-deploy-cloudflare-smoke.sh
```

部署只有在 smoke test 全部通过后才算完成。它会验证首页、数据库健康、启动错误、公开 tRPC、受保护路由，以及 Cron Worker 的并行模式。

## 日常验证

```bash
curl -fsS https://geo-seo-system.pages.dev/api/health
curl -fsS https://geo-seo-system-cron.hans-pan007.workers.dev
bash scripts/post-deploy-cloudflare-smoke.sh
```

健康结果必须包含：

```json
{"ok":true,"db":true,"bootErrors":[]}
```

只验证 Cloud Run 原环境：

```bash
bash scripts/post-deploy-smoke.sh \
  https://geo-system-kwm3xu534q-an.a.run.app
```

## 将来正式迁移顺序

正式切换应安排维护窗口并按顺序执行：

1. 先冻结会创建后台任务的管理操作，并确认 Cloud Run 当前任务已结束。
2. 确认 Cloudflare 金丝雀任务已有足够的成功运行记录。
3. 确认 OpenRouter 预检健康、每日 GEO 完成、每周 465 单元在窗口内完成。
4. 所有 Stage 5 模块至少观察 2–3 个自然周期，并完成真实 14 天平行窗口。
5. 将正式域名和全部用户流量切到 Cloudflare Pages。
6. 保留 Cloud Run 作为只读回退一段观察期。
7. 经确认后再删除 Cloud Run；删除前另行备份数据库与配置。

Cloud Run 的停止、流量切换和删除不属于当前部署，当前不要执行。

## 回滚

Pages 回滚：

1. 在 Cloudflare Dashboard 的 Pages 部署历史中选择上一健康部署并回滚；或
2. 检出已知健康 Git commit，再执行 `pnpm run cf:deploy:pages`。

Cron Worker 回滚：

```bash
pnpm exec wrangler versions list --config wrangler.cron.jsonc
pnpm exec wrangler rollback <VERSION_ID> --config wrangler.cron.jsonc
```

紧急停止 Cloudflare 后台任务时，把 `ENABLE_CLOUDFLARE_CRON` 设回 `"false"` 并重新部署 Cron Worker。不要删除 Hyperdrive 或数据库用户作为停机手段。

## Cloud Run 原部署

原 Cloud Run 自动部署仍由 `scripts/deploy.sh` 管理。除非明确要修改或回滚 Cloud Run，否则 Cloudflare 部署流程不会调用它，也不会更改 Cloud Run 服务、revision、流量或环境变量。
