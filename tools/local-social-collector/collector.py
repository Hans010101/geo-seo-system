#!/usr/bin/env python3
"""TRON GEO local social collector (Weibo + Tieba) for the always-on Mac.

Runs a plain headless Google Chrome with its own profile (logged in to Weibo once by QR scan),
searches each keyword for the newest posts and forwards those published in the last 48 hours to
the geo-agent-reach-pilot ingest worker, which runs them through the normal monitor pipeline
(dedup, relevance, AI analysis, alerts). Each run also posts a heartbeat that the cron worker
turns into an outage alert when a platform stays silent.

Commands:
  collector.py run              one collection run (launchd calls this hourly)
  collector.py login weibo      open a visible Chrome window and wait for a QR-code login
  collector.py status           show the last run and the Weibo login state

It never solves CAPTCHAs or security checks: when a platform shows one, the run records the
error for that platform and moves on.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import html
import json
import random
import re
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import certifi
from playwright.sync_api import sync_playwright

ROOT = Path.home() / "Library/Application Support/TronGeo/local-social-collector"
PROFILE = ROOT / "chrome-profile"
KEYWORDS = ("孙宇晨", "波场", "TRON", "Justin Sun", "孙哥", "孙割", "孙宇晨 火币", "孙宇晨 HTX")
TIEBA_KEYWORDS = ("孙宇晨", "波场", "孙割", "孙宇晨 HTX")
WINDOW_MS = 48 * 3600_000
BJ = dt.timezone(dt.timedelta(hours=8))
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
WEIBO_LOGIN_URL = "https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog&url=https%3A%2F%2Fweibo.com%2F"


class NeedsUser(Exception):
    """The platform wants a login or a human check; record it and skip the platform."""


def now_ms():
    return int(time.time() * 1000)


def log(event, **fields):
    line = json.dumps({"at": dt.datetime.now(BJ).isoformat(timespec="seconds"), "event": event, **fields}, ensure_ascii=False)
    print(line, flush=True)


def config():
    data = json.loads((ROOT / "config.json").read_text())
    if not data.get("endpoint") or not data.get("token"):
        raise SystemExit("config.json needs endpoint and token")
    return data


def strip_html(text):
    text = re.sub(r"<br\s*/?>", "\n", text or "", flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"[ \t ]+", " ", html.unescape(text)).strip()


def title_of(text, limit=60):
    first = next((line.strip() for line in text.splitlines() if line.strip()), text.strip())
    return first[:limit] + ("…" if len(first) > limit else "")


# ---------------------------------------------------------------- Weibo
def weibo_time(value):
    """m.weibo.cn created_at, e.g. 'Sat Nov 08 20:13:00 +0800 2026'."""
    try:
        return int(dt.datetime.strptime(value, "%a %b %d %H:%M:%S %z %Y").timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def weibo_posts(payload):
    if not isinstance(payload, dict) or payload.get("ok") != 1:
        raise NeedsUser(f"微博接口未返回数据（ok={payload.get('ok') if isinstance(payload, dict) else '?'}），可能需要重新登录")
    cards = []
    for card in (payload.get("data") or {}).get("cards") or []:
        cards.append(card)
        cards.extend(card.get("card_group") or [])
    posts = []
    for card in cards:
        mblog = card.get("mblog") if isinstance(card, dict) else None
        if not mblog or not mblog.get("id"):
            continue
        text = strip_html(mblog.get("text"))
        retweet = mblog.get("retweeted_status") or {}
        if retweet.get("text"):
            text = f"{text}\n//转发：{strip_html(retweet.get('text'))}"
        user = (mblog.get("user") or {}).get("screen_name") or ""
        posts.append({
            "url": f"https://m.weibo.cn/detail/{mblog['id']}",
            "title": title_of(text) or f"{user} 的微博",
            "text": (f"@{user}：" if user else "") + text,
            "publishedAt": weibo_time(mblog.get("created_at")),
        })
    return posts


def search_weibo(context, keyword):
    containerid = f"100103type=61&q={keyword}&t="  # type=61 = 实时（newest first）
    url = "https://m.weibo.cn/api/container/getIndex?" + urllib.parse.urlencode(
        {"containerid": containerid, "page_type": "searchall"})
    response = context.request.get(url, headers={"Referer": "https://m.weibo.cn/", "Accept": "application/json"}, timeout=30_000)
    if response.status in (401, 403, 418, 432):
        raise NeedsUser(f"微博返回 HTTP {response.status}，需要重新扫码登录")
    try:
        payload = response.json()
    except Exception:
        raise NeedsUser("微博返回了非数据页面（多半是登录页），需要重新扫码登录")
    return weibo_posts(payload)


# ---------------------------------------------------------------- Tieba
TIEBA_SEARCH_PAGE = "https://tieba.baidu.com/f/search/res?ie=utf-8&qw={}&rn=20&sm=1"
TIEBA_API = ("https://tieba.baidu.com/mo/q/search/multsearch?rn=20&st=1&word={}&needbrand=1&sug_type=2"
             "&pn=1&come_from=search&subapp_type=pc&_client_type=20")


def tieba_posts(payload):
    if not isinstance(payload, dict) or payload.get("no") not in (0, "0"):
        raise NeedsUser(f"贴吧搜索返回异常：{str((payload or {}).get('error') if isinstance(payload, dict) else payload)[:80]}")
    posts = []
    for card in (payload.get("data") or {}).get("card_list") or []:
        data = card.get("data") if isinstance(card, dict) else None
        if not isinstance(data, dict) or not str(data.get("tid") or "").isdigit():
            continue
        stamp = data.get("create_time") or data.get("time")
        stamp = int(stamp) * 1000 if str(stamp or "").isdigit() else None
        title = strip_html(data.get("title"))
        content = strip_html(data.get("content"))
        forum = data.get("forum_name") or ""
        posts.append({
            "url": f"https://tieba.baidu.com/p/{data['tid']}",
            "title": title or title_of(content),
            "text": (f"【{forum}吧】" if forum else "") + (f"{title}\n{content}" if content else title),
            "publishedAt": stamp,
        })
    return posts


def search_tieba(page, keyword):
    page.goto(TIEBA_SEARCH_PAGE.format(urllib.parse.quote(keyword)), wait_until="domcontentloaded", timeout=40_000)
    page.wait_for_timeout(1500)
    if "安全验证" in page.title():
        raise NeedsUser("百度安全验证拦截，稍后再试")
    payload = page.evaluate(
        "u => fetch(u, {credentials: 'include'}).then(r => r.json()).catch(e => ({no: -1, error: String(e)}))",
        TIEBA_API.format(urllib.parse.quote(keyword)))
    return tieba_posts(payload)


# ---------------------------------------------------------------- delivery
def outbox():
    db = sqlite3.connect(ROOT / "outbox.sqlite3")
    db.execute("CREATE TABLE IF NOT EXISTS sent (urlHash TEXT PRIMARY KEY, platform TEXT, url TEXT, status TEXT, at INTEGER)")
    return db


def post_json(cfg, path, body):
    request = urllib.request.Request(
        cfg["endpoint"].rstrip("/") + path, data=json.dumps(body, ensure_ascii=False).encode(), method="POST",
        headers={"Authorization": "Bearer " + cfg["token"], "Content-Type": "application/json",
                 "User-Agent": "trongeo-local-collector/1"})
    try:
        with urllib.request.urlopen(request, timeout=90, context=SSL_CONTEXT) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read() or b"{}")
        except ValueError:
            return error.code, {}


def deliver(cfg, db, platform, posts, stats):
    for post in posts:
        key = hashlib.sha256(post["url"].encode()).hexdigest()
        if db.execute("SELECT 1 FROM sent WHERE urlHash = ?", (key,)).fetchone():
            continue
        status, body = post_json(cfg, "/ingest", {
            "channel": platform, "url": post["url"], "title": post["title"][:500], "text": post["text"][:12_000],
            "publishedAt": post["publishedAt"], "access": "public", "completenessVerified": False,
        })
        if status == 429:
            stats["capped"] = True
            return
        if status >= 500:
            stats["errors"].append(f"ingest HTTP {status}")
            continue
        outcome = body.get("status") or ("rejected" if status == 400 else str(status))
        db.execute("INSERT OR REPLACE INTO sent VALUES (?, ?, ?, ?, ?)", (key, platform, post["url"], outcome, now_ms()))
        db.commit()
        stats["sent"] += 1
        stats["outcomes"][outcome] = stats["outcomes"].get(outcome, 0) + 1


# ---------------------------------------------------------------- commands
def browser(playwright, headless=True):
    PROFILE.mkdir(parents=True, exist_ok=True)
    return playwright.chromium.launch_persistent_context(
        str(PROFILE), channel="chrome", headless=headless, locale="zh-CN", timezone_id="Asia/Shanghai",
        viewport={"width": 1280, "height": 900})


def run(args):
    cfg = None if args.dry_run else config()
    lock = open(ROOT / "run.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("skip", reason="another run is active")
        return 0
    db = outbox()
    started = now_ms()
    report = {}
    with sync_playwright() as playwright:
        context = browser(playwright)
        page = context.new_page()
        for platform, keywords in (("weibo", KEYWORDS), ("tieba", TIEBA_KEYWORDS)):
            stats = {"found": 0, "fresh": 0, "sent": 0, "outcomes": {}, "errors": [], "capped": False}
            for keyword in keywords:
                try:
                    posts = search_weibo(context, keyword) if platform == "weibo" else search_tieba(page, keyword)
                except NeedsUser as reason:
                    stats["errors"].append(str(reason))
                    break  # same cause for every keyword; don't hammer the site
                except Exception as error:  # network hiccup on one keyword
                    stats["errors"].append(f"{keyword}: {str(error)[:160]}")
                    continue
                stats["found"] += len(posts)
                fresh = [p for p in posts if p["publishedAt"] and started - WINDOW_MS <= p["publishedAt"] <= started + 3600_000]
                stats["fresh"] += len(fresh)
                if args.dry_run:
                    stats.setdefault("samples", []).extend(
                        f"{dt.datetime.fromtimestamp(p['publishedAt'] / 1000, BJ):%m-%d %H:%M} {p['title'][:30]}" for p in fresh[:2])
                elif not stats["capped"]:
                    deliver(cfg, db, platform, fresh, stats)
                time.sleep(random.uniform(3, 7))
            report[platform] = {"discovered": stats["found"], **({"error": stats["errors"][0]} if stats["errors"] else {})}
            log("platform", platform=platform, **stats)
        context.close()
    if args.dry_run:
        log("dry-run done", report=report)
        return 0
    status, body = post_json(cfg, "/report", {"platforms": report})
    summary = {"started": started, "finished": now_ms(), "report": report, "heartbeat": status}
    (ROOT / "last-run.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    with open(ROOT / "runs.jsonl", "a") as runs:
        runs.write(json.dumps(summary, ensure_ascii=False) + "\n")
    log("done", heartbeat=status)
    return 0


def weibo_logged_in(context):
    return any(c["name"] == "SUB" and c["value"] and "weibo" in c["domain"] for c in context.cookies())


def login(args):
    if args.platform != "weibo":
        raise SystemExit("only weibo needs a login")
    with sync_playwright() as playwright:
        context = browser(playwright, headless=False)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(WEIBO_LOGIN_URL, wait_until="domcontentloaded", timeout=60_000)
        print("请在弹出的 Chrome 窗口里用微博 App 扫码登录（最多等 5 分钟）……", flush=True)
        deadline = time.time() + 300
        while time.time() < deadline and not weibo_logged_in(context):
            page.wait_for_timeout(2000)
        if not weibo_logged_in(context):
            context.close()
            raise SystemExit("没有检测到登录，请重试")
        # Let the SSO hop set m.weibo.cn cookies too, then verify the search API.
        page.goto("https://m.weibo.cn/", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(4000)
        try:
            posts = search_weibo(context, KEYWORDS[0])
            print(f"登录成功，测试搜索拿到 {len(posts)} 条微博。", flush=True)
        except NeedsUser as reason:
            print(f"已登录，但搜索接口还不通：{reason}", flush=True)
        context.close()
    return 0


def status(_args):
    last = ROOT / "last-run.json"
    print(last.read_text() if last.exists() else "还没有运行记录")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--dry-run", action="store_true", help="search only; send nothing")
    run_parser.set_defaults(func=run)
    login_parser = sub.add_parser("login")
    login_parser.add_argument("platform", choices=["weibo"])
    login_parser.set_defaults(func=login)
    sub.add_parser("status").set_defaults(func=status)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
