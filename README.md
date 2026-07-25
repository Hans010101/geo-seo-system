# GEO + SEO System

GEO/SEO 内容采集、监控、分析与报告系统。项目同时支持 Node.js/Cloud Run 和 Cloudflare Workers 两套运行时；当前正在从 Cloud Run 平滑迁移到 Cloudflare。

## 当前生产拓扑

| 组件 | 地址 | 状态 |
|---|---|---|
| Cloudflare Pages 全栈应用 | [geo-seo-system.pages.dev](https://geo-seo-system.pages.dev) | 已上线，可完整访问 |
| Cloudflare Pages 健康检查 | [geo-seo-system.pages.dev/api/health](https://geo-seo-system.pages.dev/api/health) | 应返回 `ok:true`、`db:true` |
| Cloudflare Cron Worker | [geo-seo-system-cron.hans-pan007.workers.dev](https://geo-seo-system-cron.hans-pan007.workers.dev) | 已部署，待命模式 |
| Cloud Run 原生产环境 | [geo-system-kwm3xu534q-an.a.run.app](https://geo-system-kwm3xu534q-an.a.run.app) | 保持运行，尚未下线 |

Cloudflare Pages Functions 通过 Hyperdrive 访问现有 Cloud SQL MySQL。Cloudflare 使用独立的最小权限数据库账号；用户、业务数据和现有 Cloud Run 共用同一个数据库，所以迁移期间无需搬运数据。

Cloudflare Cron 每分钟收到一次触发，再按数据库中的动态表达式调度采集、监控、维护和报告任务。目前 `ENABLE_CLOUDFLARE_CRON=false`，Cloud Run 仍负责后台任务，以免两边重复执行。

## 技术结构

- 前端：React 19、Vite、Tailwind CSS
- API：tRPC；Cloud Run 使用 Express，Cloudflare 使用 Hono/Fetch
- 数据库：MySQL、Drizzle ORM
- Cloudflare 数据链路：Pages Functions / Cron Worker → Hyperdrive → Cloud SQL
- 登录：邮箱密码、Google OAuth、JWT Cookie
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
- `wrangler.cron.jsonc`：独立 Cron Worker、触发频率和待命开关。
- `JWT_SECRET`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 只保存在 Cloudflare Secret 中，不进入 Git。
- OpenRouter 等模型提供商 Key 由系统管理页面写入数据库，不写入仓库。
- 不要在 Cloud Run 仍运行后台任务时开启 Cloudflare Cron。

## 仓库

[Hans010101/geo-seo-system](https://github.com/Hans010101/geo-seo-system)
