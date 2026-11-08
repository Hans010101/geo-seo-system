# 本机社媒采集器（微博 + 贴吧）

在常开的 Mac 上，用独立的 Chrome 配置（登录一次微博）按关键词搜最新内容，把 48 小时内的帖子
送到 `geo-agent-reach-pilot` 入库 Worker，走系统现有的去重、相关性判断、AI 分析和预警流程，
入库后 `sourcePlatform` 为 `weibo` / `tieba`，在后台和报告里与其他信源一样展示。

- 运行目录：`~/Library/Application Support/TronGeo/local-social-collector/`
  （`config.json` 放 endpoint 与 token，权限 600；`chrome-profile/` 是登录态；`runs.jsonl` 是运行记录）
- 计划任务：launchd `com.trongeo.local-social-collector`，每小时 :05；Mac 睡眠时错过的会在唤醒后补跑一次。
- 每次运行向 `/report` 发心跳；云端定时任务据此判断，微博或贴吧 48 小时没有搜到内容
  （包括 Mac 一直没开机）就推 Telegram「信源断流提醒 · 微博（本机采集）」。
- 遇到登录页或百度安全验证只记录错误，不做任何绕过。

## 常用命令

```bash
ROOT="$HOME/Library/Application Support/TronGeo/local-social-collector"
"$ROOT/venv/bin/python" "$ROOT/collector.py" login weibo     # 弹出 Chrome，用微博 App 扫码
"$ROOT/venv/bin/python" "$ROOT/collector.py" run --dry-run   # 只搜不发，检查效果
"$ROOT/venv/bin/python" "$ROOT/collector.py" status          # 最近一次运行
```

修改 `collector.py` 后运行 `tools/local-social-collector/install.sh` 同步到运行目录并重载计划任务。
入库上限：微博 150 条/天、贴吧 40 条/天（`workers/agent-reach-ingest.ts` 的 `PLATFORM_DAILY_CAPS`）。
