# Cloudflare 独立运行迁移底账

更新日期：2026-07-30
适用仓库：`Hans010101/geo-seo-system`

## 边界

- Cloud Run 保持 generation 96、revision `geo-system-00096-jds`、100% 流量，不暂停、不删改。
- Cloudflare 必须能够在 Cloud Run 应用关闭后独立运行；Cloud Run 只作结果对照，不得成为 Cloudflare 的运行时兜底。
- 当前 Cloudflare 和 Cloud Run 共用 MySQL 数据库。关闭 Cloud Run 应用不会影响 Cloudflare，但如果未来连 GCP 数据库也要退出，需要单独执行数据库迁移。
- 新采集引擎先 Shadow、后候选队列、再正式写入。扩量、付费或影响生产数据前单独报告。

## 功能对齐矩阵

| 功能 | Cloud Run | Cloudflare | 2026-07-30 验收结论 | 独立开关 / 后续验收 |
|---|---|---|---|---|
| Web 新闻发现 | Serper，监控周期内运行 | Queue 分片，奇数小时 `:15` | 已运行，需持续对比新增率 | `CLOUDFLARE_MONITOR_NEWS_ENABLED` |
| RSS 新闻 | 6 个 RSS feed | Queue 按 feed 分片 | 已运行 | 同新闻开关；阶段 6 对比覆盖 |
| Gate 广场 | Firecrawl 抓取 2 个 topic | Queue 按 URL 分片 | 已运行 | `CLOUDFLARE_MONITOR_SOCIAL_ENABLED` |
| Telegram | 5 个公开频道 | Queue 按频道分片 | 已运行 | 同社交开关 |
| X/Twitter | twitterapi.io，月预算控制 | Queue 独立发现任务，沿用预算 | 已运行 | 同社交开关；核对用量 |
| 币安广场 | Cookie/WAF 方式 | 私有 Browser Worker；403 时由 Cloudflare 内部 Serper 回退 | 已进入写入阶段，7 天验收未完成 | `CLOUDFLARE_BINANCE_*`；阶段 3/4 |
| 正文抓取 | self → Firecrawl → snippet | 复用同一抓取路由 | 功能已有，缺逐次尝试可观测性 | `CLOUDFLARE_FETCH_OBSERVABILITY_ENABLED`；阶段 1 |
| Browser 正文兜底 | 无 Cloudflare Browser | 独立私有 Browser Worker，snippet 后进入串行专用 Queue | 已部署影子链路，不写生产正文；预算 token 日内幂等校验 | `CLOUDFLARE_BROWSER_FULLTEXT_SHADOW_ENABLED`；阶段 2 |
| AI 舆情分析 | OpenRouter | Workers AI 优先，失败时 OpenRouter | 已运行；当天无新增时不会产生 AI 调用 | `CLOUDFLARE_OPENROUTER_FALLBACK_ENABLED` |
| 高威胁实时预警 | pipeline 内建，按配置推送 | Queue 候选链已接入，生产开关关闭 | 代码就绪，未启用 | `CLOUDFLARE_REALTIME_ALERTS_ENABLED`；阶段 5 |
| 每轮舆情简报 | pipeline 周期结束后生成/推送 | Coordinator 收集素材，幂等 Post-cycle Queue 已接入 | 代码就绪，未启用 | `CLOUDFLARE_BRIEFING_ENABLED`；阶段 5 |
| 舆情周报 | 周一 08:30（北京） | 周一 03:40 Queue | 已运行；共享库 upsert 幂等，推送需防双发 | `CLOUDFLARE_WEEKLY_REPORT_ENABLED` |
| 舆情月报 | 每月 1 日 08:40（北京） | 每月 1 日 03:40 Queue | 已运行；共享库 upsert 幂等，推送需防双发 | `CLOUDFLARE_MONTHLY_REPORT_ENABLED` |
| 35 天正文清理 | 每日 04:30（北京） | 每日 03:40 Queue | 已运行；操作幂等 | `CLOUDFLARE_CLEANUP_ENABLED` |
| GEO 日常采集 | DB 动态 Cron，全部启用问题 × 平台 | 已接入幂等 Queue 分片，默认 4 cells/片、并发 2 | 代码与调度就绪，生产开关关闭 | `CLOUDFLARE_GEO_DAILY_ENABLED`；阶段 5 |
| GEO 每周 15 平台覆盖 | Cloud Run 可运行完整批次 | 已接入幂等 Queue 分片，默认 6 cells/片、并发 3 | 代码与调度就绪，待 OpenRouter 余额恢复后启用 | `CLOUDFLARE_GEO_WEEKLY_ENABLED`；阶段 5 |
| Queue 重试 | 进程内任务错误处理 | 最多 4 次，30 秒退避，终态写 Coordinator | 技术重试已有 | Queue 配置 |
| 最终失败通知 | 日志/现有通知模块 | partial_failure 终态 Post-cycle Queue 已接入 | 代码就绪，未启用 | `CLOUDFLARE_FAILURE_NOTIFICATIONS_ENABLED`；阶段 5 |
| 迁移验收历史 | 无独立迁移台账 | Durable Object 保存 35 天精简运行指标 | 已接入；等待自然样本累计 | `status.migrationAcceptance` |
| Google 登录 | Cloud Run OAuth 配置 | Pages Functions OAuth 配置 | 已配置；持续抽测回调域名 | Pages secrets |
| 邮箱登录/邮件 | Resend | Pages Functions 与 Cron Worker 均直连 Resend HTTP API | 已配置并完成测试投递 | Pages/Cron 各自的 `RESEND_API_KEY` Secret / `RESEND_FROM` |
| Telegram Webhook/通知跳转 | Cloud Run URL | Cloudflare Pages URL | 默认地址已完全解除 Cloud Run 引用 | `https://geo-seo-system.pages.dev` |

## 依赖清单

| 依赖 | Cloudflare 使用方式 | Cloud Run 关闭后的影响 | 完全退出 GCP 前的动作 |
|---|---|---|---|
| MySQL / Cloud SQL | Hyperdrive `HYPERDRIVE` | 仅关闭 Cloud Run 应用无影响 | 迁移数据库并更新 Hyperdrive origin |
| Serper | 数据库 API Key；新闻与币安回退 | 无 | 确认额度与告警 |
| Firecrawl | 数据库 API Key；Gate/正文兜底 | 无 | 保留月预算 |
| twitterapi.io | 数据库 API Key | 无 | 保留月预算 |
| Workers AI | `AI` binding | 无 | 每日 neurons 监控 |
| OpenRouter | Worker secret，Workers AI 失败兜底；周度 GEO 专用 | 无 | 余额恢复后才开启周度 GEO |
| Cloudflare Browser Rendering | 私有 Service Binding | 无 | 观察 Browser 分钟 |
| Resend / Google OAuth | Pages secrets；Cron 使用独立 Sending-only Resend key | 无 | 定期登录与投递抽测 |
| Telegram / 飞书 / Email 目标 | 数据库通知配置 | 无 | 数据库迁移时一并迁移 |

## 七阶段推进与闸门

1. **阶段 1：抓取可观测性。** 只记录尝试、状态、耗时、字符数、成本和域名成功率，不扩量。
2. **阶段 2：Browser 正文 Shadow。** 普通抓取失败后才触发；独立 Worker；每天软上限 8 分钟；先 4–6 页/天，不写生产正文。
3. **阶段 3：币安 7 天验收。** 成功率不低于 90%，内容质量可比，无重复写入，不依赖 Cloud Run，资源仍在免费范围。
4. **阶段 4：币安写入验收。** Cloudflare 候选队列写入，数据库唯一键去重，初期不触发重复通知；Cloud Run 不变。
5. **阶段 5：补齐调度任务。** 按“实时预警 → 简报 → 周月报 → 周度 GEO → 日常 GEO → 最终失败通知”逐项开启，每项观察 2–3 个周期。
6. **阶段 6：14 天并行验收。** 比较新增、写入、AI 成功率、来源覆盖、重复率、成本和资源限制；任一核心指标未通过则不进入阶段 7。
7. **阶段 7：Cloud Run 关停。** 只在用户再次明确授权后执行；本路线不会自动暂停、删除或改动 Cloud Run。

## 当前状态

- 阶段 0：本文件与独立 Feature Flag 已完成。
- 阶段 1：已上线；正常批次可读取逐次抓取与域名聚合统计。
- 阶段 2：已实现；Browser Shadow 已从主采集 Queue 拆到 `geo-seo-browser-shadow` 串行 Queue，预算预留/回写增加日内 token 校验，等待自然样本验证 429 是否消失。
- 阶段 3：自 2026-07-30 10:12（北京）起进行 7 天计时观察，最早 2026-08-06 验收，不能提前宣告通过。
- 阶段 4：已开启小流量写入；插入来源、候选去重和唯一冲突指标已进入验收台账，等待自然批次。
- 阶段 5：实时告警、简报、日常 GEO、周度 GEO 和最终失败通知的 Queue 链路均已准备；生产开关保持关闭，待阶段 3/4 通过后逐项启用。
- 通知底座：Telegram Webhook 已固定为 Pages 地址；Pages 邮件测试投递成功；Cron Worker 已配置独立的 Sending-only Resend Secret，可在阶段 5 开启通知功能时独立发送。
- 阶段 6：验收账本会列出实时告警、简报、失败通知、日/周 GEO 等前置阻塞项；全部解除后设置 `CLOUDFLARE_STAGE6_WINDOW_START` 才开始 14 天窗口，目前仍为 `0`。
- 阶段 7：锁定，必须获得新的明确授权。
