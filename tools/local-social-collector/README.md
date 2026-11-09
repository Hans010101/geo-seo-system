# 本机采集器（微博、贴吧、B站、小红书 + 百分点、智推时代）

在常开的 Mac 上，用独立的 Chrome 配置（微博、小红书各扫码登录一次；B站、贴吧免登录）按关键词搜最新内容，把 48 小时内的帖子
送到 `geo-agent-reach-pilot` 入库 Worker，走系统现有的去重、相关性判断、AI 分析和预警流程，
入库后 `sourcePlatform` 为 `weibo` / `tieba` / `bilibili` / `xiaohongshu`，显示为“本机浏览器采集”，在后台和报告里与其他信源一样展示。

- 运行目录：`~/Library/Application Support/TronGeo/local-social-collector/`
  （`config.json` 放 endpoint 与 token，权限 600；`chrome-profile/` 是登录态；`runs.jsonl` 是运行记录）
- 计划任务：launchd `com.trongeo.local-social-collector`，新加坡/北京时间 9、11、13、15、17、19、21、3 点的 :05（白天每 2 小时，夜间只在 21、3、9 点）；Mac 睡眠时错过的会在唤醒后补跑一次。
- B站按“最新发布”取前 2 页；小红书在搜索页选“最新”。云端已不再采这四个平台。
- 微博按“实时”逐页往回翻，直到接上一次成功运行的时间（最多 4 页、48 小时），夜间 6 小时的空档也不漏；每条帖子当场送入库，入库后立即出现在舆情平台。断网时未送出的帖子下一轮自动重送。
- 每次运行向 `/report` 发心跳；云端定时任务据此判断，任一平台 48 小时没有搜到内容
  （包括 Mac 一直没开机）就推 Telegram「信源断流提醒 · 微博（本机采集）」。
- 遇到登录页、验证码或安全验证只记录错误，不做任何绕过。小红书建议用小号登录。

## 外部服务商系统

同一个 Chrome 配置里还登录了两个服务商后台（由用户本人登录，脚本不保存账号、密码或令牌，只复用页面自己发出的查询）：

- **百分点 Mediaforce**（mf.percent.cn，方案“波场TRON”）：每轮取上次成功以来的“敏感”信息（百分点合并相似后的列表），
  逐条走 `/ingest`（channel `percent`，按原平台记 `sourcePlatform`，引擎显示“百分点舆情导入”，日上限 500，
  中威胁只进预警中心、高威胁才推送）。另把当天和前一天的总量、敏感量、敏感平台分布写入 D1 `externalDailyStats`。
- **智推时代 GenOptima 星枢监测**（app.zhituishidai.com，项目“波场TRON”）：每轮按时间倒序翻 AI 问答记录，
  把上次之后的新回答（6 个国内 AI 平台，约 780 条/天）原样写入 D1 `externalGeoAnswers`（`/external-geo`），
  情感用服务商判定，不额外跑 AI。后台“外部监测”页展示两者。
- 两张表的建表语句在 `scripts/external-sources.sql`。登录失效时断流提醒显示“百分点舆情（本机采集）”或
  “智推时代 GEO（本机采集）”，运行对应的 `login` 命令重新登录即可。

## 常用命令

```bash
ROOT="$HOME/Library/Application Support/TronGeo/local-social-collector"
"$ROOT/venv/bin/python" "$ROOT/collector.py" login weibo        # 弹出 Chrome，用微博 App 扫码
"$ROOT/venv/bin/python" "$ROOT/collector.py" login xiaohongshu  # 用小红书 App 扫码
"$ROOT/venv/bin/python" "$ROOT/collector.py" login percent      # 百分点：微信扫码或手机验证码
"$ROOT/venv/bin/python" "$ROOT/collector.py" login genoptima    # 智推时代：手机验证码
"$ROOT/venv/bin/python" "$ROOT/collector.py" run --dry-run [--platforms bilibili]  # 只搜不发
"$ROOT/venv/bin/python" "$ROOT/collector.py" status          # 最近一次运行
```

修改 `collector.py` 后运行 `tools/local-social-collector/install.sh` 同步到运行目录并重载计划任务。
入库上限：微博 150、贴吧 40、B站 80、小红书 80、百分点 500 条/天（`workers/agent-reach-ingest.ts` 的 `PLATFORM_DAILY_CAPS`）。
