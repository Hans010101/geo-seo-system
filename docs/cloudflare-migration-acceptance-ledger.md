# Cloudflare 迁移验收台账

`MigrationAcceptanceLedger` 是 Cloudflare Cron Worker 内的独立 Durable Object。它只保存精简指标，不保存文章正文、AI 提示词、密钥或用户身份数据。

## 用途

- 阶段 3：累计币安广场每次运行的 provider、状态、查询成功数、有效样本、错误和成功率。
- 阶段 4：累计写入批次、候选数、实际插入数和被唯一键/哈希检查拦截的重复候选。
- Browser Shadow：跨日累计可用率、Browser 毫秒和正文增益。
- AI：累计 Workers AI / OpenRouter provider 分布、neurons、fallback 和成本。
- 阶段 5：记录简报与最终失败通知的尝试和结果。
- 阶段 6：在前置功能通过后建立独立的 14 天并行窗口。

## 数据边界

- 记录保留 35 天，每 6 小时最多执行一次过期清理。
- 每个批次以 `cycleId` 幂等覆盖，币安和 Browser 事件以运行时间及哈希幂等保存。
- 任何台账写入失败只记录结构化警告，不会使正常采集任务失败。
- 状态从 Cron Worker 的 `status.migrationAcceptance` 读取。

## 阶段 3 判定

- 时间门槛：从 `2026-07-30 10:12:35`（北京时间）起满 7 个自然日。
- 运行成功：至少一个查询成功，且运行未整体失败。
- 内容证据：至少存在有效的 `binance.com/.../square/post/...` 样本。
- 通过门槛：时间门槛已满足、运行成功率不低于 90%、存在内容证据、无无效样本 URL。
- 满 7 天之前始终返回 `observing`，不会提前判定为通过。

## 阶段 5 门控

实时告警、周期简报和最终失败通知代码已进入 Queue 主链，但生产变量保持：

```text
CLOUDFLARE_REALTIME_ALERTS_ENABLED=false
CLOUDFLARE_BRIEFING_ENABLED=false
CLOUDFLARE_FAILURE_NOTIFICATIONS_ENABLED=false
```

因此当前不会新增告警行、发送简报或发送失败通知。通过前置验收后按既定顺序一次只开启一项，并观察 2–3 个自然周期。
