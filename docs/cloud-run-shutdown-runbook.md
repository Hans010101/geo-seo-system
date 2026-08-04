# Cloud Run 停运与回滚手册

本手册用于在 Cloudflare 迁移验收通过后停止 Cloud Run 的实际运行，同时保留可回滚能力。执行前必须获得项目所有者的明确停运指令。

## 当前基线

- Google Cloud project：`gen-lang-client-0869327408`
- Region：`asia-northeast1`
- Service：`geo-system`
- 保留修订版：`geo-system-00096-jds`
- 当前 generation：`96`
- 当前流量：`100%`
- 当前最小实例数：`1`

## 已完成的停运前条件

- Cloudflare Pages 健康检查通过。
- Cloudflare Cron Worker 为主运行模式。
- 日常 GEO 本周期已完成。
- 周度 GEO 31 个问题 × 15 个平台，共 465 个唯一单元已完成。
- 迁移验收账本 `blockingReasons` 为空，Stage 6 为 `pass`。
- Cloud Run 仍保持 generation 96 / revision `geo-system-00096-jds`，迁移期间未修改。

## 建议停运方式

第一阶段只停运，不删除服务：

1. 导出 Cloud Run 服务配置和 revision 信息，作为回滚快照。
2. 将 `geo-system` 的最小实例数从 1 调整为 0。
3. 关闭公网入口，防止健康检查或外部请求再次唤醒实例。
4. 保留 revision `geo-system-00096-jds`、Cloud SQL 和相关密钥，不删除数据。
5. 停运后只检查 Cloudflare 主链，不再以 Cloud Run 作为运行时兜底。

这样可以停止 Cloud Run 的常驻实例与内部定时器，同时保留快速回滚路径。不要只把最小实例数改为 0 而继续开放公网入口，否则外部请求仍可能唤醒实例。

## 回滚原则

如 Cloudflare 主链出现无法快速恢复的生产故障：

1. 恢复 Cloud Run 公网入口。
2. 将最小实例数恢复为 1。
3. 确认 100% 流量仍指向 `geo-system-00096-jds`。
4. 验证 `/api/health` 后再决定是否恢复旧定时任务。

## 明确不在停运步骤中执行

- 不删除 Cloud Run 服务或 revision。
- 不删除 Cloud SQL、数据库表、对象存储或密钥。
- 不修改 Cloudflare 的主运行配置。
- 不让 Cloudflare 在运行时调用 Cloud Run 兜底。

