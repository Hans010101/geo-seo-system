# GEO + SEO System

GEO/SEO 内容采集、监控、分析与报告系统。当前生产运行在 Cloudflare 002 账号的 Pages、Workers 和 D1；仓库仍保留历史 Node.js/Cloud Run 路径，不是当前生产依赖。

## 当前生产拓扑

| 组件 | 地址 | 状态 |
|---|---|---|
| Cloudflare Pages 全栈应用 | [geo-seo-system-faq.pages.dev](https://geo-seo-system-faq.pages.dev) | 002 现行入口；Pages 项目名仍为 `geo-seo-system` |
| Cloudflare Pages 健康检查 | [geo-seo-system-faq.pages.dev/api/health](https://geo-seo-system-faq.pages.dev/api/health) | 应返回 `ok:true`、`db:true` |
| Cloudflare Cron Worker | [geo-seo-system-cron.bitman001.workers.dev](https://geo-seo-system-cron.bitman001.workers.dev) | 002 Queue 分片主运行版本；详细状态需要授权 |
| Cloudflare D1 | `geo-seo-system-db` | 002 生产数据库，绑定名沿用 `HYPERDRIVE` |

生产账号为 `a828bebda1f352216c7d7da425bad17a`，D1 ID 为 `c5389b9d-218e-4e11-bb64-6659233d812f`。Pages Functions 与 Cron Worker 直接通过 D1 绑定访问数据库；`HYPERDRIVE` 只是保留的绑定名称，不代表需要创建 Hyperdrive 或连接 Cloud SQL。

截至 2026-10-10，002 Cron 在北京时间奇数小时 `:15` 执行新闻批次、`:40` 执行社交批次，通过 Queue 分片完成采集、分析和写入。新闻与社媒开启；每日/每周 GEO 定时任务、微信采集及 OpenRouter 自动预检关闭，发布时不得自动恢复。浏览器服务、Queue、R2 和 Durable Objects 均使用 002 资源。

历史 Cloud Run／Cloud SQL／Hyperdrive 方案本轮未验证，不用于新的 002 发布或运行时兜底；不要沿用旧 007 入口。

## 技术结构

- 前端：React 19、Vite、Tailwind CSS
- API：tRPC，Cloudflare 使用 Hono/Fetch；Express 属于历史 Node.js 路径
- 生产数据库：Cloudflare D1（SQLite），Drizzle ORM
- Cloudflare 数据链路：Pages Functions / Cron Worker → 002 D1
- 登录：邮箱密码、Resend 邮箱验证码、Google OAuth、JWT Cookie
- 运行时：Node.js 22、Cloudflare Workers `nodejs_compat`

## 本地开发

需要 Node.js 22 和 pnpm 10。

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run dev
```

Node 容器构建（历史路径，本轮未验证，不用于 002 发布）：

```bash
pnpm run build
```

Cloudflare 构建验证：

```bash
pnpm run cf:build
```

## Cloudflare 部署

先按 [DEPLOY.md](DEPLOY.md) 核对 002 账号、资源和待发布差异，只在干净、已批准的发布检出中运行以下脚本。当前工作区包含大量未发布改动，不能直接全量部署。

```bash
bash scripts/deploy-cloudflare.sh
```

该脚本会执行检查、测试、Pages、币安浏览器和 Cron 发布及线上 smoke test，不是只读验证。涉及其他浏览器服务时还需单独核对其发布版本和 Service Binding。本轮只更新文档，不部署。

## 配置原则

- `wrangler.jsonc`：002 Pages 项目、D1（绑定名 `HYPERDRIVE`）和服务绑定。
- `wrangler.cron.jsonc`：002 Cron Worker、D1、Queue、Workers AI、R2、Durable Objects 和运行开关。
- JWT、Google OAuth、Resend、模型与采集服务凭据沿用 002 现有 Secrets／加密存储；密钥原值不进入 Git。
- 保留线上 Secrets 与现有开关；不要为发布重新登录、覆盖共享 Wrangler 凭据或启用已暂停的 GEO／微信任务。
- `CLOUDFLARE_CRON_MODE=primary`；新发布与回滚只能使用 002 资源和已验证版本，不回退到 007 或历史 Cloud Run／Hyperdrive 流程。

## 仓库

[Hans010101/geo-seo-system](https://github.com/Hans010101/geo-seo-system)
