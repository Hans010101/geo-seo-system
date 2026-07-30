# Cloudflare Browser 全文影子链路

阶段 2 的目标是验证 Cloudflare Browser Run 能否替代普通抓取失败后的正文兜底，但不改变现有生产内容和 AI 分析。

## 运行链路

1. 正常候选任务仍使用来源全文或 snippet 完成原有分析和写入。
2. 只有退化为 snippet 且 `CLOUDFLARE_BROWSER_FULLTEXT_SHADOW_ENABLED=true` 时，才追加一个独立 `browser_shadow` Queue 消息。
3. Queue 先向 `BrowserShadowBudget` Durable Object 申请当天额度。
4. 私有 Worker `geo-seo-system-fulltext-browser` 通过 Browser Run `markdown` Quick Action 抓取正文。
5. 仅记录域名、原始/Browser 字符数、耗时、Browser 毫秒、增益比和错误；全文不进入数据库，也不重新运行 AI。

这条链路不调用 Cloud Run，不需要 Cloud Run 作为运行时兜底。

## 免费额度保护

- Worker 不公开 `workers.dev` 地址，只能通过 Service Binding 调用。
- UTC 每日最多 4 页。
- UTC 每日 Browser 运行软上限 480,000 ms（8 分钟）。
- 单页导航和动作上限 22 秒。
- 图片、媒体和字体资源默认拦截。
- 每次 Queue 消费串行处理一个 URL；影子失败不会重试生产候选或影响其完成状态。
- 只接受公开 HTTP(S) URL，拒绝 localhost、私网 IPv4、链路本地地址和本地域名。

## 状态与验收

Cron Worker 状态新增 `status.browserFulltext`，包含：

- `reserved` / `completed` / `successes` / `failed`
- `browserMs`
- `lastResult.originalChars` / `browserChars` / `gainRatio` / `usable`
- `lastResult.domain` / `sourcePlatform` / `status` / `error`

`usable=true` 的门槛是正文不少于 500 字符，且至少为原 snippet 的 1.25 倍。阶段 2 只验证技术可行性；是否用 Browser 正文替换生产 snippet，必须在样本质量评估后另行开启。

2026-07-30 上线探针：对公开页面执行一次无数据库写入的远程 Browser Run，HTTP 200，提取 19,340 字符，Browser 用时约 2,766 ms，端到端约 5,061 ms。生产影子队列的首个自然 snippet 样本仍由每日监控确认。
