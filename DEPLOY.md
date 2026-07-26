# 部署与迁移手册

## 当前策略

Cloudflare 已部署完整版本，Cloud Run 暂时保持不动：

```text
用户 ──→ Cloudflare Pages + Functions ──→ Hyperdrive ──→ Cloud SQL MySQL

Cloudflare Cron Worker（免费套餐金丝雀并行模式）
Cloud Run（继续运行，并继续执行原有后台任务）
```

Cloudflare Cron 当前开启 `canary` 模式：

- 每天 11:35（Asia/Shanghai）使用最高优先级的 1 个关键词和 Serper 单一来源执行真实监控链路；
- 每轮最多处理 2 篇新文章，不发送实时提醒或简报，也不覆盖 Cloud Run 的生产调度时间；
- 清理、周报、月报比 Cloud Run 错峰 15 分钟运行，相关写入均为幂等操作；
- 只占用 1 个每 5 分钟触发的 Cron，由代码内部按时间分发任务，兼容免费账户的触发器配额；
- Cloud Run 的完整生产调度保持不变。

这个模式用于在 Workers 免费套餐下获得真实运行数据，同时控制 CPU、子请求和第三方 API
消耗。要运行完整任务，必须先基于金丝雀指标确认资源上限，再把
`CLOUDFLARE_CRON_MODE` 切为 `"full"`。

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

Cron Worker 当前业务密钥均从共享数据库的全局配置读取，不额外复制登录密钥。
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
3. 停止 Cloud Run 的后台调度能力后，将 `CLOUDFLARE_CRON_MODE` 从 `"canary"` 改为 `"full"`。
4. 观察至少一个完整采集/监控周期，确认没有重复任务、失败积压或异常写入。
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
