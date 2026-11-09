"""Offline checks for the parsers: python3 -m pytest tools/local-social-collector (or run directly)."""
import datetime as dt
import importlib.util
import sys
import types
from pathlib import Path

# The parsers don't need Playwright/certifi; stub them so this runs with plain python3.
for name in ("playwright", "playwright.sync_api", "certifi"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["playwright.sync_api"].sync_playwright = None
sys.modules["certifi"].where = lambda: None
spec = importlib.util.spec_from_file_location("collector", Path(__file__).with_name("collector.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

NOW = dt.datetime(2026, 11, 8, 22, 0, tzinfo=c.BJ)
ms = lambda d: int(d.timestamp() * 1000)


def test_display_times():
    assert c.weibo_display_time("34分钟前", NOW) == ms(NOW - dt.timedelta(minutes=34))
    assert c.weibo_display_time("刚刚", NOW) == ms(NOW)
    assert c.weibo_display_time("今天21:06", NOW) == ms(NOW.replace(hour=21, minute=6))
    assert c.weibo_display_time("11月07日 20:13", NOW) == ms(dt.datetime(2026, 11, 7, 20, 13, tzinfo=c.BJ))
    assert c.weibo_display_time("2025年11月08日 20:13", NOW) == ms(dt.datetime(2025, 11, 8, 20, 13, tzinfo=c.BJ))
    jan = dt.datetime(2027, 1, 1, 8, 0, tzinfo=c.BJ)
    assert c.weibo_display_time("12月31日 23:50", jan) == ms(dt.datetime(2026, 12, 31, 23, 50, tzinfo=c.BJ))
    assert c.weibo_display_time("来自 iPhone", NOW) is None


def test_cards_to_posts():
    posts = c.weibo_cards_to_posts([
        {"mid": "5363087622539798", "time": "今天21:06", "user": "DeFi乔", "text": "孙宇晨亲自下场认领了一张床照 收起d", "quoted": ""},
        {"mid": "5363087622539798", "time": "今天21:06", "user": "dup", "text": "dup", "quoted": ""},
        {"mid": "x", "time": "今天21:06", "user": "bad", "text": "bad", "quoted": ""},
        {"mid": "5363075868003567", "time": "34分钟前", "user": "u", "text": "转发", "quoted": "原文 孙宇晨"},
    ], NOW)
    assert [p["url"] for p in posts] == ["https://m.weibo.cn/detail/5363087622539798", "https://m.weibo.cn/detail/5363075868003567"]
    assert posts[0]["text"] == "@DeFi乔：孙宇晨亲自下场认领了一张床照"
    assert posts[1]["text"].endswith("//转发：原文 孙宇晨")
    assert posts[0]["publishedAt"] == ms(NOW.replace(hour=21, minute=6))


def test_mentions():
    assert c.mentions("孙宇晨 HTX", "孙宇晨 回应 htx 传闻")
    assert not c.mentions("孙宇晨 HTX", "孙宇晨 回应传闻")
    assert c.mentions("Justin Sun", "justin sun said")


def test_bilibili_posts():
    posts = c.bili_posts([
        {"bvid": "BV1fnWn6QEh1", "pubdate": 1794135959, "title": '如何评价<em class="keyword">孙宇晨</em>', "author": "某UP", "description": "-"},
        {"bvid": "bad", "pubdate": 1, "title": "x"},
    ])
    assert posts == [{"url": "https://www.bilibili.com/video/BV1fnWn6QEh1", "title": "如何评价孙宇晨",
                      "text": "UP主 某UP：如何评价孙宇晨", "publishedAt": 1794135959000}]


def test_xhs_times_and_posts():
    assert c.xhs_time("3小时前", NOW) == ms(NOW - dt.timedelta(hours=3))
    assert c.xhs_time("昨天 21:05", NOW) == ms(dt.datetime(2026, 11, 7, 21, 5, tzinfo=c.BJ))
    assert c.xhs_time("2天前 上海", NOW) == ms(NOW - dt.timedelta(days=2, minutes=1))
    assert c.xhs_time("11-05", NOW) == ms(dt.datetime(2026, 11, 5, 12, tzinfo=c.BJ))
    payload = {"data": {"items": [
        {"id": "6720a1b2000000001b012345", "model_type": "note", "note_card": {
            "display_title": "孙宇晨又上热搜", "user": {"nickname": "小红"},
            "corner_tag_info": [{"type": "publish_time", "text": "5分钟前"}]}},
        {"id": "hot", "model_type": "hot_query"},
    ]}}
    posts = c.xhs_posts([payload], NOW)
    assert posts == [{"url": "https://www.xiaohongshu.com/explore/6720a1b2000000001b012345", "title": "孙宇晨又上热搜",
                      "text": "@小红：孙宇晨又上热搜", "publishedAt": ms(NOW - dt.timedelta(minutes=5))}]
    assert c.xhs_guest_flag([{"data": {"guest": False}}]) is False
    assert c.xhs_guest_flag([]) is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("ok")
