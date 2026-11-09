#!/usr/bin/env python3
"""TRON GEO local social collector (Weibo, Tieba, Bilibili, Xiaohongshu) for the always-on Mac.

Runs a plain headless Google Chrome with its own profile (logged in to Weibo and Xiaohongshu once
by QR scan; Bilibili and Tieba need no login),
searches each keyword for the newest posts and forwards those published in the last 48 hours to
the geo-agent-reach-pilot ingest worker, which runs them through the normal monitor pipeline
(dedup, relevance, AI analysis, alerts). Each run also posts a heartbeat that the cron worker
turns into an outage alert when a platform stays silent.

Commands:
  collector.py run              one collection run (launchd: 9/11/13/15/17/19/21/3 o'clock)
  collector.py login weibo      open a visible Chrome window and wait for a QR-code login
  collector.py login xiaohongshu
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
BILI_KEYWORDS = tuple(k for k in KEYWORDS if k != "TRON")  # on Bilibili "TRON" is mostly e-tron/M-Tron noise
XHS_KEYWORDS = ("孙宇晨", "波场", "孙哥", "孙割", "Justin Sun")  # fewer searches on the strictest site
WINDOW_MS = 48 * 3600_000
WEIBO_MAX_PAGES = 4  # newest-first pages per keyword; enough to cover the 21:00→03:00→09:00 gaps
BILI_MAX_PAGES = 2
STATE = ROOT / "state.json"
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


WEIBO_REALTIME = "https://s.weibo.com/realtime?q={}&rd=realtime&tw=realtime&Refer=weibo_realtime&page={}"
WEIBO_CARDS_JS = """() => Array.from(document.querySelectorAll('div.card-wrap[mid]')).map(card => {
  const from = card.querySelector('div.from a[href*="weibo.com/"]') || card.querySelector('div.from a');
  const full = card.querySelector('p.txt[node-type="feed_list_content_full"]');
  const txt = full || card.querySelector('p.txt[node-type="feed_list_content"]') || card.querySelector('p.txt');
  const quoted = card.querySelector('div.card-comment p.txt');
  return { mid: card.getAttribute('mid'), time: from ? from.textContent.trim() : '',
           user: (card.querySelector('a.name') || {}).textContent || '',
           text: txt ? txt.innerText.trim() : '', quoted: quoted ? quoted.innerText.trim() : '' };
})"""


def weibo_display_time(text, now=None):
    """Desktop search times: 刚刚 / 5秒前 / 34分钟前 / 今天21:06 / 11月08日 20:13 / 2025年11月08日 20:13."""
    now = now or dt.datetime.now(BJ)
    text = (text or "").strip()
    m = re.match(r"(\d+)\s*(秒|分钟)前", text)
    if text.startswith("刚刚"):
        return int(now.timestamp() * 1000)
    if m:
        delta = dt.timedelta(seconds=int(m.group(1))) if m.group(2) == "秒" else dt.timedelta(minutes=int(m.group(1)))
        return int((now - delta).timestamp() * 1000)
    m = re.match(r"今天\s*(\d{1,2}):(\d{2})", text)
    if m:
        return int(now.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0).timestamp() * 1000)
    m = re.match(r"(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})", text)
    if m:
        year = int(m.group(1) or now.year)
        stamp = dt.datetime(year, int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)), tzinfo=BJ)
        if not m.group(1) and stamp > now + dt.timedelta(days=1):
            stamp = stamp.replace(year=year - 1)  # "12月31日" seen in early January
        return int(stamp.timestamp() * 1000)
    return None


def weibo_cards_to_posts(cards, now=None):
    posts, seen = [], set()
    for card in cards:
        mid = str(card.get("mid") or "")
        if not mid.isdigit() or mid in seen:
            continue
        seen.add(mid)
        text = re.sub(r"\s*收起\s*d?$", "", (card.get("text") or "").replace("\u200b", "")).strip()
        if card.get("quoted"):
            text = f"{text}\n//转发：{card['quoted'].strip()}"
        user = (card.get("user") or "").strip()
        posts.append({
            # Same canonical form as earlier imports and the cloud worker, so dedup still works.
            "url": f"https://m.weibo.cn/detail/{mid}",
            "title": title_of(text) or f"{user} 的微博",
            "text": (f"@{user}：" if user else "") + text,
            "publishedAt": weibo_display_time(card.get("time"), now),
        })
    return posts


def mobile_first_page(page, context, keyword):
    # Visiting the mobile home page refreshes the short-lived m.weibo.cn visitor tokens first.
    page.goto("https://m.weibo.cn/", wait_until="domcontentloaded", timeout=45_000)
    page.wait_for_timeout(2500)
    return weibo_page(context, keyword, 1)


def search_weibo(page, context, keyword, since_ms):
    """Desktop real-time search (uses the weibo.com login), newest first, paging back until a page
    reaches `since_ms` (the last successful run). Falls back to the mobile API's first page."""
    posts = []
    for number in range(1, WEIBO_MAX_PAGES + 1):
        page.goto(WEIBO_REALTIME.format(urllib.parse.quote(keyword), number), wait_until="domcontentloaded", timeout=45_000)
        page.wait_for_timeout(2000)
        if "passport.weibo.com" in page.url or "login" in page.url:
            if number == 1:
                try:
                    return mobile_first_page(page, context, keyword)
                except NeedsUser:
                    raise NeedsUser("微博网页版要求登录，需要重新扫码登录")
            break
        batch = weibo_cards_to_posts(page.evaluate(WEIBO_CARDS_JS))
        posts.extend(batch)
        stamps = [p["publishedAt"] for p in batch if p["publishedAt"]]
        if not batch or not stamps or min(stamps) <= since_ms:
            break
        time.sleep(random.uniform(2, 4))
    if not posts:
        return mobile_first_page(page, context, keyword)
    return posts


def weibo_page(context, keyword, page):
    containerid = f"100103type=61&q={keyword}&t="  # type=61 = 实时（newest first）
    query = {"containerid": containerid, "page_type": "searchall"}
    if page > 1:
        query["page"] = page
    url = "https://m.weibo.cn/api/container/getIndex?" + urllib.parse.urlencode(query)
    response = context.request.get(url, headers={"Referer": "https://m.weibo.cn/", "Accept": "application/json"}, timeout=30_000)
    if response.status in (401, 403, 418, 432):
        raise NeedsUser(f"微博返回 HTTP {response.status}，需要重新扫码登录")
    try:
        payload = response.json()
    except Exception:
        raise NeedsUser("微博返回了非数据页面（多半是登录页），需要重新扫码登录")
    return weibo_posts(payload)


# ---------------------------------------------------------------- Bilibili
BILI_SEARCH = "https://search.bilibili.com/video?keyword={}&order=pubdate&page={}"
# The search page is server-rendered into its Pinia store; collect every video object in it.
BILI_VIDEOS_JS = """() => { const found = []; const seen = new Set();
  const walk = (o, d) => { if (!o || d > 9) return;
    if (Array.isArray(o)) { o.forEach(x => walk(x, d + 1)); return; }
    if (typeof o !== 'object') return;
    if (typeof o.bvid === 'string' && typeof o.pubdate === 'number') {
      if (!seen.has(o.bvid)) { seen.add(o.bvid); found.push({ bvid: o.bvid, pubdate: o.pubdate, title: o.title || '',
        author: o.author || '', description: o.description || '' }); }
      return; }
    Object.values(o).forEach(x => walk(x, d + 1)); };
  walk(window.__pinia, 0); return found; }"""


def bili_posts(videos):
    posts = []
    for video in videos:
        bvid = str(video.get("bvid") or "")
        if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid) or not video.get("pubdate"):
            continue
        title = strip_html(video.get("title"))
        desc = strip_html(video.get("description"))
        desc = "" if desc in ("-", title) else desc
        author = (video.get("author") or "").strip()
        posts.append({
            "url": f"https://www.bilibili.com/video/{bvid}",
            "title": title or f"{author} 的视频",
            "text": (f"UP主 {author}：" if author else "") + title + (f"\n{desc}" if desc else ""),
            "publishedAt": int(video["pubdate"]) * 1000,
        })
    return posts


def search_bilibili(page, keyword, since_ms):
    posts = []
    for number in range(1, BILI_MAX_PAGES + 1):
        page.goto(BILI_SEARCH.format(urllib.parse.quote(keyword), number), wait_until="domcontentloaded", timeout=45_000)
        page.wait_for_timeout(2500)
        if "验证" in page.title() or "risk" in page.url:
            raise NeedsUser("B站要求安全验证，稍后再试")
        batch = bili_posts(page.evaluate(BILI_VIDEOS_JS))
        posts.extend(batch)
        stamps = [p["publishedAt"] for p in batch]
        if not stamps or min(stamps) <= since_ms:
            break
        time.sleep(random.uniform(2, 4))
    return posts


# ---------------------------------------------------------------- Xiaohongshu
XHS_HOME = "https://www.xiaohongshu.com/explore"
XHS_SEARCH = "https://www.xiaohongshu.com/search_result?keyword={}&source=web_search_result_notes"


def xhs_time(text, now=None):
    """Note card times: 刚刚 / 5分钟前 / 3小时前 / 昨天 21:05 / 2天前 / 11-05 / 2025-11-05 (may carry a place)."""
    now = now or dt.datetime.now(BJ)
    text = (text or "").strip()
    if text.startswith("刚刚"):
        return int(now.timestamp() * 1000)
    m = re.match(r"(\d+)\s*(分钟|小时|天)前", text)
    if m:
        unit = {"分钟": "minutes", "小时": "hours", "天": "days"}[m.group(2)]
        delta = dt.timedelta(**{unit: int(m.group(1))})
        if unit == "days":
            delta += dt.timedelta(minutes=1)  # "2天前" is at least 48h old: keep it outside the window
        return int((now - delta).timestamp() * 1000)
    m = re.match(r"(今天|昨天)\s*(\d{1,2}):(\d{2})", text)
    if m:
        day = now - dt.timedelta(days=1 if m.group(1) == "昨天" else 0)
        return int(day.replace(hour=int(m.group(2)), minute=int(m.group(3)), second=0, microsecond=0).timestamp() * 1000)
    m = re.match(r"(?:(\d{4})-)?(\d{1,2})-(\d{1,2})", text)
    if m:
        stamp = dt.datetime(int(m.group(1) or now.year), int(m.group(2)), int(m.group(3)), 12, tzinfo=BJ)
        return int(stamp.timestamp() * 1000)
    return None


def xhs_posts(payloads, now=None):
    posts, seen = [], set()
    for payload in payloads:
        items = ((payload or {}).get("data") or {}).get("items") or [] if isinstance(payload, dict) else []
        for item in items:
            card = item.get("note_card") if isinstance(item, dict) else None
            note_id = str(item.get("id") or "") if card else ""
            if not re.fullmatch(r"[0-9a-f]{24}", note_id) or note_id in seen:
                continue
            seen.add(note_id)
            corner = next((c.get("text") for c in card.get("corner_tag_info") or []
                           if isinstance(c, dict) and c.get("type") == "publish_time"), None)
            title = strip_html(card.get("display_title") or card.get("title"))
            desc = strip_html(card.get("desc"))
            user = ((card.get("user") or {}).get("nickname") or (card.get("user") or {}).get("nick_name") or "").strip()
            posts.append({
                # No xsec_token: it changes per search and would break URL dedup.
                "url": f"https://www.xiaohongshu.com/explore/{note_id}",
                "title": title or title_of(desc) or f"{user} 的笔记",
                "text": (f"@{user}：" if user else "") + (title or "") + (f"\n{desc}" if desc and desc != title else ""),
                "publishedAt": xhs_time(corner, now) if corner else (int(card["time"]) if str(card.get("time") or "").isdigit() else None),
            })
    return posts


def xhs_guest_flag(payloads):
    """True/False from the page's own /user/me response; None when it was not seen."""
    for payload in payloads:
        data = (payload or {}).get("data") if isinstance(payload, dict) else None
        if isinstance(data, dict) and "guest" in data:
            return bool(data["guest"])
    return None


def capture_json(page, needle):
    store = []

    def on_response(response):
        if needle in response.url and "json" in (response.headers.get("content-type") or ""):
            try:
                store.append(response.json())
            except Exception:
                pass
    page.on("response", on_response)
    return store, lambda: page.remove_listener("response", on_response)


def sort_xhs_newest(page):
    """Hover 筛选 and pick 排序依据 → 最新 so results are newest first; best effort."""
    try:
        page.locator("div.filter").first.hover(timeout=5000)
        page.wait_for_timeout(1200)
        page.get_by_text("最新", exact=True).filter(visible=True).first.click(timeout=5000)
        page.wait_for_timeout(3500)
        return True
    except Exception:
        return False


# The search page keeps its results in the Vue store (camelCase); read it after sorting.
XHS_FEEDS_JS = """() => { const s = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.search;
  const f = s && s.feeds; const arr = f && (f._value || f.value || f._rawValue || f);
  if (!Array.isArray(arr)) return [];
  return arr.map(x => { const n = x.noteCard || x.note_card || {}; const u = n.user || {};
    return { id: x.id, note_card: { display_title: n.displayTitle || n.display_title || '', desc: n.desc || '',
      user: { nickname: u.nickname || u.nickName || u.nick_name || '' },
      corner_tag_info: n.cornerTagInfo || n.corner_tag_info || [] } }; }); }"""


def search_xhs(page, keyword):
    me, stop_me = capture_json(page, "/user/me")
    try:
        page.goto(XHS_SEARCH.format(urllib.parse.quote(keyword)), wait_until="domcontentloaded", timeout=45_000)
        page.wait_for_timeout(4000)
        if "website-login/captcha" in page.url or "验证" in page.title():
            raise NeedsUser("小红书要求安全验证，稍后再试或手动打开一次")
        if xhs_guest_flag(me) is True or "login" in page.url:
            raise NeedsUser("小红书未登录，需要运行 collector.py login xiaohongshu 扫码")
        sort_xhs_newest(page)
        return xhs_posts([{"data": {"items": page.evaluate(XHS_FEEDS_JS)}}])
    finally:
        stop_me()


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


def mentions(keyword, text):
    """Every part of the keyword appears in the post (search engines also match names/hidden text)."""
    lowered = (text or "").lower()
    return all(part.lower() in lowered for part in keyword.split())


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
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        # Offline (e.g. just woke from sleep): unsent posts stay out of the outbox and retry next run.
        return 0, {"error": str(error)[:160]}


def deliver(cfg, db, platform, posts, stats):
    for post in posts:
        key = hashlib.sha256(post["url"].encode()).hexdigest()
        if db.execute("SELECT 1 FROM sent WHERE urlHash = ?", (key,)).fetchone():
            continue
        status, body = post_json(cfg, "/ingest", {
            "channel": platform, "url": post["url"], "title": post["title"][:500], "text": post["text"][:12_000],
            "publishedAt": post["publishedAt"], "access": "public", "completenessVerified": False,
            "collector": "local_browser",
        })
        if status == 429:
            stats["capped"] = True
            return
        if status == 0:
            stats["errors"].append(f"无法连接入库服务：{body.get('error', '')}")
            stats["offline"] = True
            return
        if status >= 500:
            stats["errors"].append(f"ingest HTTP {status}")
            continue
        outcome = body.get("status") or ("rejected" if status == 400 else str(status))
        if status == 400 and len(stats["errors"]) < 5:
            stats["errors"].append(f"拒收 {post['url'][-24:]}：{body.get('error', '')}")
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
    try:
        state = json.loads(STATE.read_text())
    except (OSError, ValueError):
        state = {}
    # Page back to the previous successful run (capped at 48h) so overnight gaps are covered.
    since = {name: max(started - WINDOW_MS, int(state.get(f"{name}SuccessAt") or 0)) for name in ("weibo", "bilibili")}
    selected = set(args.platforms.split(",")) if getattr(args, "platforms", None) else None
    with sync_playwright() as playwright:
        context = browser(playwright)
        page = context.new_page()
        searches = (
            ("weibo", KEYWORDS, lambda kw: search_weibo(page, context, kw, since["weibo"])),
            ("tieba", TIEBA_KEYWORDS, lambda kw: search_tieba(page, kw)),
            ("bilibili", BILI_KEYWORDS, lambda kw: search_bilibili(page, kw, since["bilibili"])),
            ("xiaohongshu", XHS_KEYWORDS, lambda kw: search_xhs(page, kw)),
        )
        for platform, keywords, search in searches:
            if selected and platform not in selected:
                continue
            stats = {"found": 0, "fresh": 0, "sent": 0, "outcomes": {}, "errors": [], "capped": False}
            for keyword in keywords:
                try:
                    posts = search(keyword)
                except NeedsUser as reason:
                    stats["errors"].append(str(reason))
                    break  # same cause for every keyword; don't hammer the site
                except Exception as error:  # network hiccup on one keyword
                    stats["errors"].append(f"{keyword}: {str(error)[:160]}")
                    continue
                stats["found"] += len(posts)
                # 1h margin: the ingest worker re-checks the 48h window minutes later, at delivery.
                fresh = [p for p in posts if p["publishedAt"] and started - WINDOW_MS + 3600_000 <= p["publishedAt"] <= started + 3600_000
                         and mentions(keyword, p["title"] + " " + p["text"])]
                stats["fresh"] += len(fresh)
                if args.dry_run:
                    stats.setdefault("samples", []).extend(
                        f"{dt.datetime.fromtimestamp(p['publishedAt'] / 1000, BJ):%m-%d %H:%M} {p['title'][:30]}" for p in fresh[:2])
                elif not stats["capped"] and not stats.get("offline"):
                    deliver(cfg, db, platform, fresh, stats)
                time.sleep(random.uniform(3, 7))
            report[platform] = {"discovered": stats["found"], **({"error": stats["errors"][0]} if stats["errors"] else {})}
            if platform in since and stats["found"] > 0 and not stats.get("offline") and not args.dry_run:
                state[f"{platform}SuccessAt"] = started
            log("platform", platform=platform, **stats)
        context.close()
    if args.dry_run:
        log("dry-run done", report=report)
        return 0
    STATE.write_text(json.dumps(state))
    status, body = post_json(cfg, "/report", {"platforms": report})
    summary = {"started": started, "finished": now_ms(), "report": report, "heartbeat": status}
    (ROOT / "last-run.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    with open(ROOT / "runs.jsonl", "a") as runs:
        runs.write(json.dumps(summary, ensure_ascii=False) + "\n")
    log("done", heartbeat=status)
    return 0


def weibo_logged_in(context):
    return any(c["name"] == "SUB" and c["value"] and "weibo" in c["domain"] for c in context.cookies())


def login_xhs():
    with sync_playwright() as playwright:
        context = browser(playwright, headless=False)
        page = context.pages[0] if context.pages else context.new_page()
        me, _stop = capture_json(page, "/user/me")
        page.goto(XHS_HOME, wait_until="domcontentloaded", timeout=60_000)
        print("请在弹出的 Chrome 窗口里用小红书 App 扫码登录（最多等 5 分钟）……", flush=True)
        deadline = time.time() + 300
        # The page asks /user/me again once the QR login completes; wait for guest=false.
        while time.time() < deadline and xhs_guest_flag(me[-1:]) is not False:
            page.wait_for_timeout(3000)
        if xhs_guest_flag(me[-1:]) is not False:
            context.close()
            raise SystemExit("没有检测到小红书登录，请重试")
        page.wait_for_timeout(3000)
        try:
            posts = search_xhs(page, XHS_KEYWORDS[0])
            print(f"登录成功，测试搜索拿到 {len(posts)} 条笔记。", flush=True)
        except NeedsUser as reason:
            print(f"已登录，但搜索还不通：{reason}", flush=True)
        context.close()
    return 0


def login(args):
    if args.platform == "xiaohongshu":
        return login_xhs()
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
            posts = search_weibo(page, context, KEYWORDS[0], now_ms() - 3600_000)
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
    run_parser.add_argument("--platforms", help="comma-separated subset, e.g. bilibili,xiaohongshu")
    run_parser.set_defaults(func=run)
    login_parser = sub.add_parser("login")
    login_parser.add_argument("platform", choices=["weibo", "xiaohongshu"])
    login_parser.set_defaults(func=login)
    sub.add_parser("status").set_defaults(func=status)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
