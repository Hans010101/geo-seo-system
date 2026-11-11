#!/usr/bin/env python3
"""TRON GEO local collector for the always-on Mac: Weibo, Tieba, Bilibili and Xiaohongshu searches,
plus two vendor systems the team subscribes to (百分点 Mediaforce sentiment, 智推时代 GenOptima GEO).

Runs a plain headless Google Chrome with its own profile (logged in to Weibo and Xiaohongshu once
by QR scan; Bilibili and Tieba need no login),
searches each keyword for the newest posts and forwards those published in the last 48 hours to
the geo-agent-reach-pilot ingest worker, which runs them through the normal monitor pipeline
(dedup, relevance, AI analysis, alerts). Each run also posts a heartbeat that the cron worker
turns into an outage alert when a platform stays silent.

百分点 sensitive posts go through the same /ingest pipeline (plus a daily totals snapshot);
GenOptima AI answers are mirrored as-is to /external-geo. Both are read with the user's own login,
through the requests their web pages already make; no credential is stored by this script.

Commands:
  collector.py run              one collection run (launchd: 9/11/13/15/17/19/21/3 o'clock)
  collector.py login weibo      open a visible Chrome window and wait for a QR-code login
  collector.py login xiaohongshu
  collector.py login percent    百分点 Mediaforce (WeChat QR / SMS code, entered by the user)
  collector.py login genoptima  智推时代 GenOptima (SMS code, entered by the user)
  collector.py login-browser    plain Chrome with all login pages (GenOptima's slider rejects automated windows)
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
import industry  # noqa: E402  (lives next to this file)
WEIBO_LOGIN_URL = "https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog&url=https%3A%2F%2Fweibo.com%2F"


VENDORS = ("percent", "genoptima")


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


# ---------------------------------------------------------------- 百分点 Mediaforce
PERCENT_LOGIN = "https://mf.percent.cn/user/login"
PERCENT_MONITOR = "https://mf.percent.cn/monitor"
PERCENT_MAX_PAGES = 4  # 500 folded items per page; a day has ~400 sensitive ones
PERCENT_PLATFORM_NAMES = {
    "抖音": "douyin", "快手": "kuaishou", "知乎": "zhihu", "小红书": "xiaohongshu", "微博": "weibo",
    "微信": "wechat", "哔哩哔哩": "bilibili", "B站": "bilibili", "bilibili": "bilibili", "百度贴吧": "tieba", "贴吧": "tieba",
}
PERCENT_DOC_TYPES = {"weibo": "weibo", "weixin": "wechat", "tieba": "tieba"}
# Replays the page's own list query (its body carries the session's short-lived signature).
PERCENT_QUERY_JS = """async body => { try {
  const r = await fetch('/server/api/monitor/query', { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Accept': 'application/json' }, body: JSON.stringify(body) });
  return await r.json(); } catch (e) { return { code: -1, desc: String(e) }; } }"""


def percent_platform(item):
    for name in (item.get("platform"), item.get("source"), item.get("siteName"), item.get("realSource")):
        if name and name.strip() in PERCENT_PLATFORM_NAMES:
            return PERCENT_PLATFORM_NAMES[name.strip()]
    return PERCENT_DOC_TYPES.get(item.get("docType"), "web")


def percent_posts(items):
    posts, seen = [], set()
    for item in items:
        url = str(item.get("url") or "").strip()
        if url.startswith("http://"):
            url = "https://" + url[len("http://"):]
        if not url.startswith("https://") or url in seen or not str(item.get("pubTime") or "").isdigit():
            continue
        seen.add(url)
        content = strip_html(item.get("content") or item.get("contentAbstract"))
        title = strip_html(item.get("titleAll") or item.get("title")) or title_of(content)
        forward = strip_html(item.get("forwardContent"))
        label = (item.get("platform") or item.get("source") or item.get("siteName") or "").strip()
        author = (item.get("author") or item.get("promulgator") or "").strip()
        text = (f"【{label}】" if label else "") + (f"@{author}：" if author else "") + (content or title)
        if forward:
            text += f"\n//转发：{forward}"
        posts.append({
            "url": url, "title": title or f"{author} 的内容", "text": text,
            "publishedAt": int(item["pubTime"]), "platform": percent_platform(item), "label": label or "其他",
        })
    return posts


def percent_session(page):
    """Open the 舆情 list and keep the query body the page sends with the user's session."""
    captured = []

    def on_request(request):
        if request.method == "POST" and "/server/api/monitor/query" in request.url and request.post_data:
            captured.append(request.post_data)
    page.on("request", on_request)
    try:
        page.goto(PERCENT_MONITOR, wait_until="domcontentloaded", timeout=60_000)
        for _ in range(20):
            if captured or "/user/login" in page.url:
                break
            page.wait_for_timeout(1000)
    finally:
        page.remove_listener("request", on_request)
    if "/user/login" in page.url:
        raise NeedsUser("百分点登录已失效，需要运行 collector.py login percent 重新登录")
    if not captured:
        raise NeedsUser("百分点舆情页没有发出查询，可能需要重新登录")
    return json.loads(captured[-1])


def percent_query(page, base, start_ms, end_ms, sensitive, offset=0, limit=500):
    body = json.loads(json.dumps(base))
    body["timeRange"] = {"startTime": int(start_ms), "endTime": int(end_ms)}
    body["page"] = {"start": offset, "limit": limit}
    condition = body.setdefault("condition", {})
    condition["emotion"] = ["negative"] if sensitive else []
    condition["sortFlag"] = "timeDesc"
    payload = page.evaluate(PERCENT_QUERY_JS, body) or {}
    if payload.get("code") != 0:
        desc = str(payload.get("desc") or payload.get("msg") or payload.get("code"))[:80]
        if payload.get("code") in (301, 401, 403) or "Token" in desc or "登录" in desc:
            raise NeedsUser(f"百分点会话失效（{desc}），需要运行 collector.py login percent")
        raise RuntimeError(f"百分点查询失败：{desc}")
    return payload.get("data") or {}


def percent_list(page, base, start_ms, end_ms):
    items = []
    for number in range(PERCENT_MAX_PAGES):
        data = percent_query(page, base, start_ms, end_ms, True, offset=number * 500)
        batch = data.get("monitorLists") or []
        items.extend(batch)
        if len(batch) < 500:
            break
        time.sleep(random.uniform(1, 2))
    return items


def percent_day_stats(page, base, day_start_ms, end_ms):
    everything = percent_query(page, base, day_start_ms, end_ms, False, limit=1)
    sensitive = percent_list(page, base, day_start_ms, end_ms)
    platforms = {}
    for item in percent_posts(sensitive):
        platforms[item["label"]] = platforms.get(item["label"], 0) + 1
    sensitive_totals = percent_query(page, base, day_start_ms, end_ms, True, limit=1)
    return {
        "total": everything.get("allDocNumber"), "totalFolded": everything.get("afterFoldNumber"),
        "sensitive": sensitive_totals.get("allDocNumber"), "sensitiveFolded": sensitive_totals.get("afterFoldNumber"),
        "sensitiveByPlatform": platforms, "complete": end_ms >= day_start_ms + 86400_000,
    }


def bj_day_start(ms):
    day = dt.datetime.fromtimestamp(ms / 1000, BJ).replace(hour=0, minute=0, second=0, microsecond=0)
    return int(day.timestamp() * 1000)


def collect_percent(page, cfg, db, state, started, dry_run):
    stats = {"found": 0, "fresh": 0, "sent": 0, "outcomes": {}, "errors": [], "capped": False}
    base = percent_session(page)
    # Overlap the previous run by an hour; the ingest worker only takes the last 48h.
    since = max(started - WINDOW_MS + 3600_000, int(state.get("percentSuccessAt") or 0) - 3600_000)
    posts = percent_posts(percent_list(page, base, since, started))
    stats["found"] = stats["fresh"] = len(posts)
    if dry_run:
        stats["samples"] = [f"{p['label']} {p['title'][:30]}" for p in posts[:3]]
    else:
        deliver(cfg, db, "percent", posts, stats)
    today = bj_day_start(started)
    days = [(today, started)]
    if state.get("percentStatsFinal") != dt.datetime.fromtimestamp((today - 1) / 1000, BJ).strftime("%Y-%m-%d"):
        days.append((today - 86400_000, today))  # finish yesterday's numbers once
    for start, end in days:
        day = dt.datetime.fromtimestamp(start / 1000, BJ).strftime("%Y-%m-%d")
        snapshot = percent_day_stats(page, base, start, end)
        if dry_run:
            stats.setdefault("days", {})[day] = {k: v for k, v in snapshot.items() if k != "sensitiveByPlatform"}
            continue
        status, body = post_json(cfg, "/external-stats", {"source": "percent", "day": day, "stats": snapshot})
        if status != 200:
            stats["errors"].append(f"日汇总 {day} 上传失败：HTTP {status} {body.get('error', '')}")
        elif snapshot["complete"]:
            state["percentStatsFinal"] = day
    return stats


# ---------------------------------------------------------------- 智推时代 GenOptima
GENO_LOGIN = "https://app.zhituishidai.com/login"
GENO_PROJECT = ("https://app.zhituishidai.com/xingshu/ai-qa?project_id=e8f58902-545e-4550-84e4-109ce46240a7"
                "&project_name=%E6%B3%A2%E5%9C%BATRON")
GENO_RECORDS = "https://xingshu-api.zhituishidai.com/api/v1/xingshu/ai-qa/records"
GENO_PAGE = 500
GENO_MAX_PAGES = 20
GENO_BATCH = 50
GENO_JS = """async ([url, body, auth]) => { try {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'zh-CN', 'Authorization': auth } });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data }; } catch (e) { return { status: 0, data: { message: String(e) } }; } }"""


def geno_time(text):
    try:
        return int(dt.datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=BJ).timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def geno_records(raw_records):
    records = []
    for raw in raw_records:
        if not isinstance(raw, dict):
            continue
        platform = re.sub(r"\.\w+$", "", str(raw.get("platform") or "").rsplit("/", 1)[-1])
        stamp = geno_time(raw.get("queryTime"))
        if not raw.get("id") or not stamp or not raw.get("question"):
            continue
        refs = [r.get("code") for r in raw.get("referenceSources") or [] if isinstance(r, dict) and r.get("code")]
        competitors = [c.get("name") if isinstance(c, dict) else c for c in raw.get("competitors") or []]
        records.append({
            "id": str(raw["id"]), "platform": platform, "question": raw["question"], "answer": raw.get("content") or "",
            "sentiment": raw.get("brandSentiment"), "brandMentioned": raw.get("brandMentioned"),
            "brandRank": raw.get("brandRank"), "intentType": raw.get("intentType"),
            "references": refs, "referenceCount": raw.get("referenceSourceCount") or len(refs),
            "competitors": [c for c in competitors if isinstance(c, str)], "queryTime": stamp,
        })
    return records


def geno_session(page):
    """Open the AI 问答记录 page and keep the query body and session header it sends (memory only)."""
    captured = []

    def on_request(request):
        if request.method == "POST" and "/ai-qa/records" in request.url and request.post_data:
            captured.append((request.post_data, request.headers.get("authorization")))
    page.on("request", on_request)
    try:
        page.goto(GENO_PROJECT, wait_until="domcontentloaded", timeout=60_000)
        for _ in range(25):
            if captured or page.url.rstrip("/").endswith("/login"):
                break
            page.wait_for_timeout(1000)
    finally:
        page.remove_listener("request", on_request)
    if page.url.rstrip("/").endswith("/login") or "/login?" in page.url:
        raise NeedsUser("智推时代登录已失效，需要运行 collector.py login genoptima 重新登录")
    if not captured or not captured[-1][1]:
        raise NeedsUser("智推时代问答记录页没有发出查询，可能需要重新登录")
    body, auth = captured[-1]
    return json.loads(body), auth


def collect_genoptima(page, cfg, state, dry_run):
    stats = {"found": 0, "new": 0, "inserted": 0, "errors": []}
    base, auth = geno_session(page)
    latest = int(state.get("genoptimaLatest") or 0)
    stop_at = latest - 3600_000 if latest else 0
    fresh = []
    for number in range(GENO_MAX_PAGES):
        body = {**base, "time_range": "7d", "limit": GENO_PAGE, "offset": number * GENO_PAGE}
        result = page.evaluate(GENO_JS, [GENO_RECORDS, body, auth]) or {}
        if result.get("status") in (401, 403):
            raise NeedsUser("智推时代会话失效，需要运行 collector.py login genoptima")
        data = (result.get("data") or {}).get("data") if isinstance(result.get("data"), dict) else None
        if result.get("status") != 200 or not isinstance(data, dict):
            raise RuntimeError(f"智推时代查询失败：HTTP {result.get('status')}")
        batch = geno_records(data.get("records") or [])
        stats["found"] += len(batch)
        fresh.extend(r for r in batch if r["queryTime"] > stop_at)
        if len(data.get("records") or []) < GENO_PAGE or (batch and min(r["queryTime"] for r in batch) <= stop_at):
            break
        time.sleep(random.uniform(1, 2))
    stats["new"] = sum(1 for r in fresh if r["queryTime"] > latest)
    if dry_run:
        stats["samples"] = [f"{r['platform']} {r['sentiment']} {r['question'][:24]}" for r in fresh[:3]]
        return stats
    for index in range(0, len(fresh), GENO_BATCH):
        status, body = post_json(cfg, "/external-geo", {"source": "genoptima", "records": fresh[index:index + GENO_BATCH]})
        if status != 200:
            stats["errors"].append(f"上传失败：HTTP {status} {body.get('error', '')}")
            return stats  # keep genoptimaLatest so the next run retries the rest
        stats["inserted"] += body.get("inserted", 0)
    if fresh:
        state["genoptimaLatest"] = max(latest, max(r["queryTime"] for r in fresh))
    return stats


# ---------------------------------------------------------------- 币价（币价联动）
# Binance and CoinGecko refuse Cloudflare's egress IPs, so the Mac fetches hourly prices and posts
# them to /market-prices; the cron worker only evaluates alerts on what is stored.
MARKET_TOKENS = (  # symbol, CoinGecko id, Binance USDT pair (None → CoinGecko hourly chart)
    ("TRX", "tron", "TRXUSDT"), ("USDD", "usdd", None), ("BTT", "bittorrent", None), ("NFT", "apenft", None),
    ("JST", "just", "JSTUSDT"), ("WIN", "wink", "WINUSDT"), ("BTC", "bitcoin", "BTCUSDT"),
    ("ETH", "ethereum", "ETHUSDT"), ("BNB", "binancecoin", "BNBUSDT"), ("SOL", "solana", "SOLUSDT"),
    ("XRP", "ripple", "XRPUSDT"), ("HYPE", "hyperliquid", "HYPEUSDT"),
)
BINANCE_KLINES = "https://data-api.binance.vision/api/v3/klines?symbol={}&interval=1h&startTime={}&limit=1000"
COINGECKO = "https://api.coingecko.com/api/v3"
COINGECKO_SPACING_S = 15  # the keyless tier allows only a few calls a minute
HOUR_MS = 3600_000
MARKET_BACKFILL_DAYS = 90


def get_json(url, timeout=30):
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "trongeo-local-collector/1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        return error.code, None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        return 0, str(error)[:120]


def kline_rows(symbol, klines):
    """Binance 1h klines → the kline's open hour with its close price (last price in that hour)."""
    rows = []
    for k in klines if isinstance(klines, list) else []:
        try:
            ts, price = int(k[0]), float(k[4])
        except (TypeError, ValueError, IndexError):
            continue
        if price > 0:
            rows.append({"symbol": symbol, "ts": ts // HOUR_MS * HOUR_MS, "price": price})
    return rows


def chart_rows(symbol, chart):
    """CoinGecko market_chart → one row per whole hour, the last sample inside it wins."""
    buckets = {}
    for name in ("prices", "market_caps", "total_volumes"):
        for point in (chart or {}).get(name) or [] if isinstance(chart, dict) else []:
            try:
                ts, value = int(point[0]) // HOUR_MS * HOUR_MS, float(point[1])
            except (TypeError, ValueError, IndexError):
                continue
            buckets.setdefault(ts, {})[name] = value
    return [{"symbol": symbol, "ts": ts, "price": v["prices"], "marketCap": v.get("market_caps"), "volume": v.get("total_volumes")}
            for ts, v in sorted(buckets.items()) if v.get("prices", 0) > 0]


def snapshot_rows(markets):
    """CoinGecko /coins/markets → every token's price, market cap and 24h volume at its update hour."""
    by_id = {cg: symbol for symbol, cg, _ in MARKET_TOKENS}
    rows = []
    for m in markets if isinstance(markets, list) else []:
        symbol = by_id.get((m or {}).get("id"))
        try:
            ts = int(dt.datetime.fromisoformat(m["last_updated"].replace("Z", "+00:00")).timestamp() * 1000)
            price = float(m["current_price"])
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if symbol and price > 0:
            rows.append({"symbol": symbol, "ts": ts // HOUR_MS * HOUR_MS, "price": price,
                         "marketCap": m.get("market_cap"), "volume": m.get("total_volume")})
    return rows


def coingecko(path, calls):
    if calls[0] > 0:
        time.sleep(COINGECKO_SPACING_S)
    calls[0] += 1
    status, payload = get_json(COINGECKO + path)
    if status == 429:
        time.sleep(60)
        status, payload = get_json(COINGECKO + path)
    if status != 200:
        raise RuntimeError(f"CoinGecko {path.split('?')[0]} HTTP {status}")
    return payload


def collect_market(cfg, state, dry_run):
    stats = {"found": 0, "errors": []}
    backfilled = set(state.get("marketBackfilled") or [])
    now = now_ms()
    rows, fresh_backfill, via_gecko, calls = [], [], [], [0]
    for symbol, cg_id, pair in MARKET_TOKENS:
        days = 2 if symbol in backfilled else MARKET_BACKFILL_DAYS
        if not pair:
            via_gecko.append((symbol, cg_id, days))
            continue
        start, got = now - days * 86400_000, []
        try:
            for _ in range(4):  # 1000 hours per page; 90 days needs three
                status, batch = get_json(BINANCE_KLINES.format(pair, start))
                if status != 200 or not isinstance(batch, list):
                    raise RuntimeError(f"Binance {pair} HTTP {status}")
                got.extend(kline_rows(symbol, batch))
                if len(batch) < 1000:
                    break
                start = int(batch[-1][0]) + HOUR_MS
            rows.extend(got)
            if days == MARKET_BACKFILL_DAYS:
                fresh_backfill.append(symbol)
        except RuntimeError as error:
            stats["errors"].append(str(error))
            via_gecko.append((symbol, cg_id, days))  # keep the basket complete
    for symbol, cg_id, days in via_gecko:
        try:
            rows.extend(chart_rows(symbol, coingecko(f"/coins/{cg_id}/market_chart?vs_currency=usd&days={days}", calls)))
            if days == MARKET_BACKFILL_DAYS:
                fresh_backfill.append(symbol)
        except RuntimeError as error:
            stats["errors"].append(str(error))
    try:
        ids = ",".join(cg for _, cg, _ in MARKET_TOKENS)
        rows.extend(snapshot_rows(coingecko(f"/coins/markets?vs_currency=usd&ids={ids}", calls)))
    except RuntimeError as error:
        stats["errors"].append(str(error))
    stats["found"] = len(rows)
    if dry_run:
        stats["symbols"] = sorted({r["symbol"] for r in rows})
        return stats
    for index in range(0, len(rows), 2000):
        status, body = post_json(cfg, "/market-prices", {"rows": rows[index:index + 2000]})
        if status != 200:
            stats["errors"].append(f"上传失败：HTTP {status} {body.get('error', '')}")
            return stats  # backfill flags stay unset so the next run retries
    state["marketBackfilled"] = sorted(backfilled | set(fresh_backfill))
    return stats


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
            "collector": "local_browser", **({"platform": post["platform"]} if post.get("platform") else {}),
        })
        if status == 429:
            stats["capped"] = True
            return
        if status == 0:
            # One slow pipeline run (AI + D1) can exceed the read timeout; only a run of
            # failures means the Mac is offline. Unsent posts retry next run either way.
            stats["timeouts"] = stats.get("timeouts", 0) + 1
            if "timed out" in str(body.get("error", "")) and stats["timeouts"] < 3:
                continue
            stats["errors"].append(f"无法连接入库服务：{body.get('error', '')}")
            stats["offline"] = True
            return
        if status >= 500:
            stats["errors"].append(f"ingest HTTP {status}")
            continue
        outcome = body.get("status") or ("rejected" if status == 400 else str(status))
        if status == 400 and len(stats.setdefault("rejects", [])) < 5:
            stats["rejects"].append(f"{post['url'][-24:]}：{body.get('error', '')}")  # data issue, not an outage
        db.execute("INSERT OR REPLACE INTO sent VALUES (?, ?, ?, ?, ?)", (key, platform, post["url"], outcome, now_ms()))
        db.commit()
        stats["sent"] += 1
        stats["outcomes"][outcome] = stats["outcomes"].get(outcome, 0) + 1


# ---------------------------------------------------------------- commands
def browser(playwright, headless=True):
    PROFILE.mkdir(parents=True, exist_ok=True)
    # Use the macOS keychain like normal Chrome does, so cookies saved by a plain Chrome window
    # (login-browser) and by this collector stay readable to both instead of being discarded.
    return playwright.chromium.launch_persistent_context(
        str(PROFILE), channel="chrome", headless=headless, locale="zh-CN", timezone_id="Asia/Shanghai",
        viewport={"width": 1280, "height": 900}, ignore_default_args=["--use-mock-keychain"])


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
        if not selected or "market" in selected:
            # Prices first: the cron worker evaluates market alerts at :15, ten minutes after this run starts.
            try:
                stats = collect_market(cfg, state, args.dry_run)
            except Exception as error:
                stats = {"found": 0, "errors": [f"{type(error).__name__}: {str(error)[:160]}"]}
            report["market"] = {"discovered": stats["found"], **({"error": stats["errors"][0]} if stats["errors"] else {})}
            log("platform", platform="market", **stats)
        if not selected or "industry" in selected:
            # 行业动态 feeds, macro prices and daily competitor numbers (industry.py); all public, keyless.
            try:
                stats = industry.collect(cfg, state, args.dry_run, post_json, SSL_CONTEXT)
            except Exception as error:
                stats = {"found": 0, "errors": [f"{type(error).__name__}: {str(error)[:160]}"]}
            # One flaky feed is normal; only a failed upload or no items at all count as an error.
            fatal = next((e for e in stats["errors"] if "上传失败" in e), None) or (stats["errors"][0] if stats["errors"] and not stats["found"] else None)
            report["industry"] = {"discovered": stats["found"], **({"error": fatal[:200]} if fatal else {})}
            log("platform", platform="industry", **stats)
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
        for name, collect in (
            ("percent", lambda: collect_percent(page, cfg, db, state, started, args.dry_run)),
            ("genoptima", lambda: collect_genoptima(page, cfg, state, args.dry_run)),
        ):
            if selected and name not in selected:
                continue
            try:
                stats = collect()
            except NeedsUser as reason:
                stats = {"found": 0, "errors": [str(reason)]}
            except Exception as error:
                stats = {"found": 0, "errors": [f"{type(error).__name__}: {str(error)[:160]}"]}
            # GenOptima answers arrive in a couple of daily batches; count only answers newer than before.
            discovered = stats.get("new", stats["found"]) if name == "genoptima" else stats["found"]
            report[name] = {"discovered": discovered, **({"error": stats["errors"][0]} if stats["errors"] else {})}
            # A capped run left posts unsent: keep the old start so the next run picks them up.
            if name == "percent" and not stats["errors"] and not stats.get("capped") and not args.dry_run:
                state["percentSuccessAt"] = started
            log("platform", platform=name, **stats)
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


def login_vendor(name):
    """The user signs in themselves in a visible window; we only wait until the site lets them in."""
    login_url, prompt, done = {
        "percent": (PERCENT_LOGIN, "请在弹出的 Chrome 窗口里登录百分点（微信扫码或手机验证码）",
                    lambda url: "mf.percent.cn" in url and "/user/login" not in url),
        "genoptima": (GENO_LOGIN, "请在弹出的 Chrome 窗口里登录智推时代 GenOptima（手机验证码）",
                      lambda url: "zhituishidai.com" in url and not url.rstrip("/").endswith("/login") and "/login?" not in url),
    }[name]
    with sync_playwright() as playwright:
        context = browser(playwright, headless=False)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(login_url, wait_until="domcontentloaded", timeout=60_000)
        print(prompt + "（最多等 5 分钟）……", flush=True)
        deadline = time.time() + 300
        while time.time() < deadline and not done(page.url):
            page.wait_for_timeout(2000)
        if not done(page.url):
            context.close()
            raise SystemExit("没有检测到登录，请重试")
        page.wait_for_timeout(3000)
        try:
            if name == "percent":
                base = percent_session(page)
                data = percent_query(page, base, now_ms() - 86400_000, now_ms(), True, limit=1)
                print(f"登录成功，近 24 小时敏感信息 {data.get('allDocNumber')} 条。", flush=True)
            else:
                base, auth = geno_session(page)
                result = page.evaluate(GENO_JS, [GENO_RECORDS, {**base, "time_range": "1d", "limit": 1, "offset": 0}, auth])
                total = ((result.get("data") or {}).get("data") or {}).get("total")
                print(f"登录成功，近 1 天 AI 问答 {total} 条。", flush=True)
        except (NeedsUser, RuntimeError) as reason:
            print(f"已登录，但读取数据还不通：{reason}", flush=True)
        session_only = [c["name"] for c in context.cookies() if c.get("expires", -1) in (-1, 0)
                        and any(d in c["domain"] for d in ("percent.cn", "zhituishidai.com"))]
        if session_only:
            print(f"提示：有 {len(session_only)} 个会话级 Cookie，关闭浏览器后可能失效，下一轮采集会验证。", flush=True)
        context.close()
    return 0


def login(args):
    if args.platform == "xiaohongshu":
        return login_xhs()
    if args.platform in VENDORS:
        return login_vendor(args.platform)
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


CHROME_APP = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
LOGIN_PAGES = {
    "weibo": WEIBO_LOGIN_URL, "xiaohongshu": XHS_HOME, "percent": PERCENT_LOGIN, "genoptima": GENO_LOGIN,
}


def login_browser(args):
    """Open a plain (not automated) Chrome on the collector profile with the chosen login pages;
    the user signs in there and quits Chrome (⌘Q), then each site is checked headlessly."""
    import subprocess
    names = args.sites.split(",") if args.sites else list(LOGIN_PAGES)
    urls = [LOGIN_PAGES[name] for name in names]
    print("已打开普通 Chrome：请在各标签页登录（" + "、".join(names) + "），全部完成后按 ⌘Q 退出这个 Chrome。", flush=True)
    subprocess.run([CHROME_APP, f"--user-data-dir={PROFILE}", "--no-first-run", "--new-window", *urls], check=False)
    with sync_playwright() as playwright:
        context = browser(playwright)
        page = context.new_page()
        for name in names:
            try:
                if name == "weibo":
                    ok = weibo_logged_in(context)
                    print(f"微博：{'已登录' if ok else '未检测到登录'}", flush=True)
                elif name == "xiaohongshu":
                    me, stop = capture_json(page, "/user/me")
                    page.goto(XHS_HOME, wait_until="domcontentloaded", timeout=45_000)
                    page.wait_for_timeout(4000)
                    stop()
                    print(f"小红书：{'已登录' if xhs_guest_flag(me) is False else '未检测到登录'}", flush=True)
                elif name == "percent":
                    base = percent_session(page)
                    data = percent_query(page, base, now_ms() - 86400_000, now_ms(), True, limit=1)
                    print(f"百分点：已登录，近 24 小时敏感信息 {data.get('allDocNumber')} 条", flush=True)
                elif name == "genoptima":
                    base, auth = geno_session(page)
                    result = page.evaluate(GENO_JS, [GENO_RECORDS, {**base, "time_range": "1d", "limit": 1, "offset": 0}, auth])
                    total = ((result.get("data") or {}).get("data") or {}).get("total")
                    print(f"智推时代：已登录，近 1 天 AI 问答 {total} 条", flush=True)
            except (NeedsUser, RuntimeError) as reason:
                print(f"{name}：{reason}", flush=True)
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
    login_parser.add_argument("platform", choices=["weibo", "xiaohongshu", "percent", "genoptima"])
    login_parser.set_defaults(func=login)
    plain = sub.add_parser("login-browser", help="sign in with a plain Chrome window (for sites that reject automated windows)")
    plain.add_argument("--sites", help="comma-separated: weibo,xiaohongshu,percent,genoptima (default all)")
    plain.set_defaults(func=login_browser)
    sub.add_parser("status").set_defaults(func=status)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
