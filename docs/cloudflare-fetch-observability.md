# Cloudflare 抓取可观测性

阶段 1 不增加采集 URL、抓取次数或 AI 调用。每个抓取尝试写入两处：

- Worker 结构化日志：逐次记录引擎、结果、失败原因、耗时、字符数和成本。
- `MonitorCoordinator.fetchTelemetry`：按每个正常批次汇总总数、成功数、fallback 数、引擎分布、失败原因和域名成功率；可直接从 Cron Worker 状态读取。

Cloudflare 账号中已预建可选数据集 `geo_seo_fetch_attempts`。截至 2026-07-30，Cloudflare Worker Versions API 尚未接受该账号的 Analytics Engine binding（错误 10089），因此当前不把它绑定到生产 Worker，避免阻塞正常发布。代码里的 `FETCH_ANALYTICS` 是可选绑定；账户侧恢复后可无代码改动启用三个月时序留存。

## 逐次字段

| 字段 | 含义 |
|---|---|
| `engine` | `self`、`firecrawl`、`snippet` 或来源 API |
| `outcome` | `success`、`failed`、`skipped`、`fallback` |
| `reason` | 403、429、超时、短内容、JS 空壳、预算、缺 Key 等 |
| `sourcePlatform` / `domain` | 来源和域名 |
| `urlHash` | 规范化 URL 的 SHA-256；日志不保存原始 URL |
| `durationMs` / `contentChars` | 耗时和内容长度 |
| `costUsd` / `httpStatus` | 成本和 HTTP 状态 |

## 批次域名成功率

状态中的 `fetchTelemetry.domains` 结构：

```json
{
  "example.com": {
    "attempts": 3,
    "successes": 2,
    "fallbacks": 1
  }
}
```

域名成功率为 `successes / attempts`。`fetchTelemetry.failureReasons` 用于决定阶段 2 的 Browser Shadow 是否只覆盖 403、JS 空壳和短内容站点。

## Analytics Engine 可选字段

账户绑定恢复后，数据映射如下：`blob1..6 = engine/outcome/reason/sourcePlatform/domain/urlHash`，`double1..5 = count/durationMs/contentChars/costUsd/httpStatus`，`index1 = domain`。

域名成功率 SQL：

```sql
SELECT
  blob5 AS domain,
  SUM(_sample_interval) AS attempts,
  SUM(IF(blob2 = 'success', _sample_interval, 0)) AS successes,
  ROUND(
    100.0 * SUM(IF(blob2 = 'success', _sample_interval, 0))
    / SUM(_sample_interval),
    2
  ) AS success_rate_pct,
  AVG(double2) AS avg_duration_ms,
  SUM(double4 * _sample_interval) AS cost_usd
FROM geo_seo_fetch_attempts
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY domain
ORDER BY attempts DESC
LIMIT 100
```

失败原因分布：

```sql
SELECT
  blob1 AS engine,
  blob3 AS reason,
  SUM(_sample_interval) AS attempts
FROM geo_seo_fetch_attempts
WHERE timestamp > NOW() - INTERVAL '1' DAY
  AND blob2 <> 'success'
GROUP BY engine, reason
ORDER BY attempts DESC
```
