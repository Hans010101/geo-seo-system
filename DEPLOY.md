# 002 现行发布说明

截至 2026-10-10，现用项目已在 Cloudflare 002 运行。本文是当前发布约束，不再沿用旧 Cloud Run／Hyperdrive 迁移的强制流程。

## 已验证的生产资源

- 账号：`a828bebda1f352216c7d7da425bad17a`（002）。
- Pages 项目：`geo-seo-system`；入口：[geo-seo-system-faq.pages.dev](https://geo-seo-system-faq.pages.dev)。
- Cron Worker：`geo-seo-system-cron`；入口：[geo-seo-system-cron.bitman001.workers.dev](https://geo-seo-system-cron.bitman001.workers.dev)。
- D1：`geo-seo-system-db`，ID `c5389b9d-218e-4e11-bb64-6659233d812f`。
- D1 绑定名沿用 `HYPERDRIVE`，但资源类型是 `d1_databases`，不是 Hyperdrive；不需要旧 MySQL 账号、Cloud SQL 网络规则或 `DATABASE_URL`。
- Queue：`geo-seo-monitor`、`geo-seo-browser-shadow`，消费者均为 002 的 `geo-seo-system-cron`，当前未暂停。
- R2：`geo-seo-system-state`；浏览器服务和 Durable Objects 也属于 002，保留现行 Service Binding 与状态。

```text
用户 → 002 Pages + Functions → 002 D1
002 Cron → 002 Queue / 浏览器服务 / Workers AI → 002 D1
         → 002 R2 / Durable Objects
```

新闻与社媒开启，Cron 为 `primary` 模式：北京时间奇数小时 `:15` 运行新闻批次，`:40` 运行社交批次。每日 GEO、每周 GEO、微信采集和 OpenRouter 自动预检均关闭，发布不能自动恢复这些任务。

## 发布前置条件

1. 使用 Node.js 22、pnpm 10 和项目锁文件安装依赖。
2. 核对 Wrangler 默认账号和所有待发布配置的 `account_id` 均为上述 002；不重新登录、不覆盖共享凭据。
3. 核对 Pages／Cron 的 D1 ID、Queue、R2、Service Binding、Durable Objects 和生产 URL 都指向 002，保留现有 Secrets 与运行开关。不要复制旧 007 配置。
4. 只发布干净、已批准的检出或已核验产物。当前工作区有大量未发布改动，**不能直接从这里执行全量部署**；文档提交不代表这些改动获准发布。
5. 若涉及浏览器服务，先核对并发布对应已批准服务版本，再发布调用它的应用／Cron；现有一键脚本不覆盖所有浏览器服务。

在满足以上条件的发布检出中，先执行检查与构建：

```bash
pnpm run check
pnpm run check:workers
pnpm test
pnpm run cf:build
```

现有 `scripts/deploy-cloudflare.sh` 会实际部署 Pages、币安浏览器服务和 Cron，并执行线上 smoke test；不是只读检查。只有发布内容和 002 配置均通过审核后才运行：

```bash
bash scripts/deploy-cloudflare.sh
```

密钥和认证凭据沿用现有 002 云端 Secrets、加密存储与受限本地认证文件，不写入文档、Git、日志或命令行。保留现有 JWT、Google OAuth、Resend、模型与采集服务配置；不要用一份不完整的 Secret 清单覆盖线上绑定。

## 只读验收

```bash
curl -fsS https://geo-seo-system-faq.pages.dev/api/health
```

健康结果应包含 `ok:true`、`db:true`，且 `bootErrors` 为空。Cron 详细状态通过已登录的 002 后台或现有授权读取；未授权请求返回 401 不能视为采集故障，也不应为验证导出密钥。

还需核对两条 Queue 有消费者且未暂停、四个迁移状态可读、既有定时批次在 002 D1 有新入库，及 GEO／微信开关仍关闭。首页或健康检查成功不等于所有平台覆盖正常；微博／小红书缺登录态、X 空结果和正文降级应单独记录。

## 回滚与停机边界

只在 002 项目的部署历史中选择已经验证健康的 Pages 部署／Cron 版本回滚，并确认 D1 绑定、Service Binding、Secrets 和任务开关仍保持 002 配置。不要回滚到旧 007 入口或恢复历史 Hyperdrive 连接。

停止后台任务使用现有 Cron 运行开关；不要删除 D1、R2、Queue 或 Durable Objects 作为停机手段。回滚、停机和资源删除均是独立线上操作，本轮只更新文档，没有执行。

## 历史方案（本轮未验证，禁止当作现行发布步骤）

仓库曾采用 Cloud Run／Express → Cloud SQL MySQL，以及 Cloudflare → Hyperdrive → Cloud SQL 的方案。历史 `scripts/deploy.sh`、`scripts/post-deploy-smoke.sh` 和旧迁移门槛只用于理解原实现，不是 002 的前置条件或运行时兜底。

本轮没有验证、部署、恢复或删除旧 Cloud Run、Hyperdrive、MySQL 账号或 007 资源；未来处理这些历史资源需要另行授权与核验。不要依据历史文档创建旧数据库连接、恢复每日／每周 GEO 自动采集，或支付、重启 007 服务。
