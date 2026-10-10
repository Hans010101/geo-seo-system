# Cloudflare 币安广场采集

以下架构与配额说明属于历史方案，本轮未重新验证；002 当前入口、D1 拓扑与发布约束以 [DEPLOY.md](../DEPLOY.md) 为准。

## 历史方案架构

币安广场在 Cloudflare 版本中独立运行，不依赖 Cloud Run：

1. `geo-seo-system-cron` 在北京时间 03:40、09:40、15:40、21:40 将币安发现任务放入 `geo-seo-monitor` Queue。
2. Cron Worker 通过内部 Service Binding 调用 `geo-seo-system-binance-browser`。
3. Browser Worker 使用 Cloudflare Browser Run + Playwright 打开币安广场搜索页。
4. 如果币安允许 Cloudflare 浏览器出口，响应直接转为现有候选文章。
5. 如果币安返回 403，Cron Worker 使用 Serper 对 `binance.com/.../square/post/...` 做站内定向检索。
6. 结果经过域名/路径白名单、现有关键词匹配、URL 去重、文章上限和 AI 分析后写入 MySQL。

Cloud Run 只用于平行效果对比，不在这条链路中提供接口、Cookie、代理或运行时兜底。

## 资源控制

- Browser Run：每 6 小时最多一个浏览器会话、一个直接查询。
- Serper：仅在 Browser Run 失败且月度预算已成功预留时调用一次。
- 正式写入：每个币安批次最多 5 条候选，仍受全局文章上限和 URL 唯一键约束。
- Browser Worker 没有公开路由或 `workers.dev` 地址，只能通过 Service Binding 调用。

## 配置开关

配置位于 `wrangler.cron.jsonc`：

- `CLOUDFLARE_BINANCE_SHADOW_ENABLED`
- `CLOUDFLARE_BINANCE_WRITE_ENABLED`
- `CLOUDFLARE_BINANCE_MAX_QUERIES`
- `CLOUDFLARE_BINANCE_QUERY_TERMS`
- `CLOUDFLARE_BINANCE_INTERVAL_HOURS`

状态读取（002 受保护接口，需现有授权；401 不代表采集故障）：

```text
GET https://geo-seo-system-cron.bitman001.workers.dev
```

重点字段：

- `status.binance.configuredMode`
- `status.binance.provider`
- `status.binance.summary`
- `status.profiles.monitor_primary_social.sourceDiagnostics.binance_square`

## 部署与验证

```bash
pnpm run check
pnpm run check:workers
pnpm vitest run workers/binance-square-browser.test.ts
pnpm run cf:deploy:binance-browser
pnpm run cf:deploy:cron
```

部署顺序必须先 Browser Worker、后 Cron Worker，避免 Service Binding 指向尚未部署的服务。
