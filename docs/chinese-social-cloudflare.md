# Cloudflare 中文社媒采集

本模块借鉴 MediaCrawler 的“平台适配器 + 关键词搜索 + 帖子详情 + 评论/作者扩展”分层设计，
但不直接运行其 Python/CDP 代码。生产运行环境保持为 Cloudflare Workers、Queues、Durable
Objects、Browser Run 和现有数据库。

## 当前生产层（已实现）

- 平台：小红书、抖音、快手、B 站、微博、百度贴吧、知乎。
- 发现：Cloudflare Browser 优先、Serper 安全降级，每 2 小时覆盖 `孙宇晨`、`波场`、
  `TRON`、`Justin Sun`、`孙割` 5 个关键词。
- 原始来源：只接收各平台的规范帖子/视频/问答 URL；搜索页、账号页和搜索中转页直接丢弃。
- 新鲜度：搜索结果必须回到原站验证发布时间，并通过严格 7 天窗口；不可验证、未来时间、
  旧内容全部拒绝。
- 去重：先按规范 URL 去重，再按正文指纹去重；数据库唯一 URL 约束处理并发重复。
- 下游：复用现有抓取、Workers AI/OpenRouter、告警、100 天保留和报告链路。
- 调度：北京时间奇数小时的 `:40` 随社交批次运行；可由受保护的
  `POST /operator/chinese-social` 手动触发。

## Browser Run 原生发现层（已实现）

Cloudflare Worker `geo-seo-system-chinese-social-browser` 通过 Browser Run Binding
直接渲染七个平台的搜索页：

- 每轮最多 35 次 Browser 调用，每个平台 5 个关键词；北京时间每 2 小时运行。
- 使用 `/scrape` 抓取真实 DOM 中的原帖链接和标题，不额外消耗 Browser JSON 的 Workers AI。
- 严格的平台 URL 规则在 Browser Worker 和主 Queue 两侧共同生效。
- Browser 返回空结果、登录墙、验证码、429 或结构异常时，单个平台自动降级 Serper。
- `sourceDiagnostics` 记录 provider、browserMs、fallbacks、发现/入队数和错误。
- Browser 发现的结果仍必须回原站验证发布时间并通过 7 天窗口。

## 登录态、评论与创作者增强层（下一层）

仍只使用 Cloudflare：

1. Browser Run 复用每个平台的加密登录 Cookie，在真实浏览器中打开搜索/详情页。
2. Queue 按平台串行执行，Durable Object 负责每日页面数、浏览器毫秒数、冷却和断点游标。
3. 原帖详情可验证后才进入正式写入；评论和创作者数据使用独立表及独立游标，不阻塞主舆情链。
4. Cookie 失效、验证码、429 或页面结构改变时停止该平台并记录诊断，不回退到旧内容补量。
5. 先接入较稳定的 B 站、微博、贴吧、知乎，再接入需要更强登录态的
   小红书、抖音、快手。

## 资源护栏

- 免费期继续使用现有 Browser Shadow 上限，不因中文社媒扩大浏览器调用。
- 付费期初始总预算建议不超过 8 小时/月，预留 2 小时给全文和故障重试。
- 所有 Browser Run 响应记录 `X-Browser-Ms-Used`；达到日/月阈值时停止新增任务。
- 评论默认只取命中帖子的一层 Top 评论，二级评论和创作者主页默认关闭，按平台逐项开启。

## MediaCrawler 许可边界

MediaCrawler 使用非商业学习许可证。本项目仅借鉴其适配器和任务分层思想；若未来复制或修改其
具体实现，必须保留其版权与许可证声明，并继续限于内部非商业学习/研究和非大规模采集。
