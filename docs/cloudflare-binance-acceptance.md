# Cloudflare 币安广场独立采集验收

阶段 3 观察窗口：2026-07-30 10:12（北京时间）起，至少连续 7 个自然日。
阶段 4 当前状态：Cloudflare 小流量写入开关已开启，依靠 URL 唯一键去重；在阶段 3 通过前不扩量、不启用重复通知。

## 验收门槛

- Cloudflare 独立采集成功率不低于 90%。
- 样本 URL 必须属于 `binance.com/.../square/post/...`，内容质量与 Cloud Run 可比。
- Cloudflare 运行时不调用 Cloud Run；Browser 失败时仅允许 Cloudflare 内部 Serper 回退。
- 无重复写入，候选队列最终失败数可解释。
- Browser Run、Workers、Queues、数据库与 Serper 用量保持在当前免费/既定预算范围。
- 满 7 天前不宣告通过；任一核心门槛不达标则延长观察并修复。

## 起始样本

2026-07-30 10:12（北京时间）的独立探针：

- 状态：`partial`
- Browser：2 个查询未观察到 Binance Square payload
- Cloudflare 内部回退：Serper 成功 1 个查询
- 结果：10 个原始帖子、10 个匹配帖子
- 样本 URL：均为 `https://www.binance.com/zh-CN/square/post/...`
- Cloud Run 依赖：无

每日自动监控继续累积成功/失败、provider、样本、写入、AI、重复率和资源风险。正式结论最早不早于 2026-08-06 同一时刻。
