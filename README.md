# GEO + SEO System

GEO/SEO 内容采集、监控、分析与报告系统。项目同时支持 Node.js/Cloud Run 和 Cloudflare Workers 两套运行时；当前正在从 Cloud Run 平滑迁移到 Cloudflare。

## 当前生产拓扑

| 组件 | 地址 | 状态 |
|---|---|---|
| Cloudflare Pages 全栈应用 | [geo-seo-system.pages.dev](https://geo-seo-system.pages.dev) | 已上线，可完整访问 |
| Cloudflare Pages 健康检查 | [geo-seo-system.pages.dev/api/health](https://geo-seo-system.pages.dev/api/health) | 应返回 `ok:true`、`db:true` |
| Cloudflare Cron Worker | [geo-seo-system-cron.hans-pan007.workers.dev](https://geo-seo-system-cron.hans-pan007.workers.dev) | Queue 分片主运行版本，与 Cloud Run 平行验收 |
| Cloud Run 原生产环境 | [geo-system-kwm3xu534q-an.a.run.app](https://geo-system-kwm3xu534q-an.a.run.app) | 保持运行，尚未下线 |

Cloudflare Pages Functions 通过 Hyperdrive 访问现有 Cloud SQL MySQL。Cloudflare 使用独立的最小权限数据库账号；用户、业务数据和现有 Cloud Run 共用同一个数据库，所以迁移期间无需搬运数据。

Cloudflare Cron 在北京时间奇数小时 `:15` 执行新闻批次、`:40` 执行社交批次，所有数据库、抓取、AI 和写入工作通过 Queue 分片完成。文章分析优先使用 Workers AI，额度、限流或服务异常时才降级 OpenRouter。币安广场、Browser Shadow、通知、每日抽样 GEO 和每周全量 GEO 都在 Cloudflare 内部独立运行；Cloud Run 仅保留为平行效果对比，不是 Cloudflare 的运行时兜底。

## 技术结构

- 前端：React 19、Vite、Tailwind CSS
- API：tRPC；Cloud Run 使用 Express，Cloudflare 使用 Hono/Fetch
- 数据库：MySQL、Drizzle ORM
- Cloudflare 数据链路：Pages Functions / Cron Worker → Hyperdrive → Cloud SQL
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

Node 容器构建：

```bash
pnpm run build
```

Cloudflare 构建验证：

```bash
pnpm run cf:build
```

## Cloudflare 部署

```bash
bash scripts/deploy-cloudflare.sh
```

该脚本依次执行类型检查、测试、Pages 部署、Cron Worker 部署和线上 smoke test。详细配置、Secret 清单、切换与回滚流程见 [DEPLOY.md](DEPLOY.md)。

## 配置原则

- `wrangler.jsonc`：Pages 项目及 Hyperdrive 绑定。
- `wrangler.cron.jsonc`：独立 Cron Worker、Queue、Workers AI、Hyperdrive 和分阶段迁移门槛。
- `JWT_SECRET`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`RESEND_API_KEY`、`OPENROUTER_API_KEY` 只保存在 Cloudflare Secret 中，不进入 Git。
- OpenRouter 启用付费 GEO 任务前会执行一次一 token 预检；HTTP 402、鉴权失败或预检过期时，周度/每日 GEO 自动暂停，舆情主链不受影响。
- Cloud Run 与 Cloudflare 平行期间保持 `CLOUDFLARE_CRON_MODE=primary`；只有迁移验收账本全部过门槛后才能关闭 Cloud Run。

## 仓库

[Hans010101/geo-seo-system](https://github.com/Hans010101/geo-seo-system)
