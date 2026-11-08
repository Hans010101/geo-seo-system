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


if __name__ == "__main__":
    test_mentions()
    test_display_times()
    test_cards_to_posts()
    print("ok")
