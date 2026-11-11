"""行业动态 collection for the TRON GEO system (imported by collector.py, runs at every :05 run).

- Feeds: Chinese newsflash RSS (ChainCatcher, TechFlow, Odaily, 吴说), English media (The Block,
  Cointelegraph, Decrypt), Binance announcements and Tether's news feed → /industry-news.
  The cron queue de-duplicates and classifies them with an LLM.
- Macro: hourly Yahoo Finance closes for NASDAQ / S&P 500 / DXY / US10Y / gold → /market-prices.
- Daily numbers (DefiLlama stablecoins / TVL / fees, Binance reserves, Fear & Greed) → /industry-metrics,
  Polymarket Fed-decision odds → /industry-snapshot.
Everything here is public, keyless data.
"""
import email.utils
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HOUR_MS = 3600_000
DAY_MS = 24 * HOUR_MS
UA = "Mozilla/5.0"  # Yahoo answers 429 to a full browser UA without its cookies; the plain one works everywhere

FEEDS = (
    ("chaincatcher", "https://www.chaincatcher.com/rss/clist"),
    ("techflow", "https://www.techflowpost.com/rss.aspx"),
    ("odaily", "https://rss.odaily.news/rss/newsflash"),
    ("wublock", "https://wublock123.com/rss"),
    ("theblock", "https://www.theblock.co/rss.xml"),
    ("cointelegraph", "https://cointelegraph.com/rss"),
    ("decrypt", "https://decrypt.co/feed"),
    ("tether", "https://tether.io/feed/"),
)
BINANCE_CATALOGS = {48: "上币", 49: "公告", 161: "下架"}
BINANCE_URL = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20"

MACRO = (("NASDAQ", "^IXIC"), ("SPX", "^GSPC"), ("DXY", "DX-Y.NYB"), ("US10Y", "^TNX"), ("GOLD", "GC=F"))
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/{}?range={}&interval=1h"

# DefiLlama chain names → our keys (server/industry-metrics.ts CHAINS).
CHAINS = {"Tron": "tron", "Ethereum": "ethereum", "Solana": "solana", "BSC": "bsc", "Plasma": "plasma", "Stable": "stable", "Arc": "arc"}
TVL_CHAINS = {"Tron": "tron", "Ethereum": "ethereum", "Solana": "solana", "BSC": "bsc", "Plasma": "plasma"}
METRIC_BACKFILL_DAYS = 95


def bj_day(ms):
    return (datetime.fromtimestamp(ms / 1000, timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")


def fetch(url, ssl_context, timeout=30, accept="*/*"):
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(request, timeout=timeout, context=ssl_context) as response:
        return response.read()


def fetch_json(url, ssl_context, timeout=40):
    return json.loads(fetch(url, ssl_context, timeout, "application/json"))


# ---------------------------------------------------------------- feeds
def _text(block, tag):
    m = re.search(rf"<{tag}(?:\s[^>]*)?>(.*?)</{tag}>", block, re.S)
    if not m:
        return ""
    value = m.group(1).strip()
    cdata = re.fullmatch(r"<!\[CDATA\[(.*?)\]\]>", value, re.S)
    if cdata:
        value = cdata.group(1)
    value = re.sub(r"<[^>]+>", " ", html.unescape(value))
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def parse_feed(source, xml):
    """RSS 2.0 items → {source, url, title, excerpt, publishedAt}; undated or broken items are dropped."""
    items = []
    for block in re.findall(r"<item[\s>](.*?)</item>", xml, re.S):
        url = _text(block, "link") or _text(block, "guid")
        title = _text(block, "title")
        date = _text(block, "pubDate") or _text(block, "dc:date")
        if not url.startswith("http") or not title or not date:
            continue
        try:
            published = email.utils.parsedate_to_datetime(date)
        except (TypeError, ValueError):
            try:
                published = datetime.fromisoformat(date.replace("Z", "+00:00"))
            except ValueError:
                continue
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone(timedelta(hours=8)))
        excerpt = _text(block, "description")[:600]
        items.append({"source": source, "url": url, "title": title[:300], "excerpt": excerpt,
                      "publishedAt": int(published.timestamp() * 1000)})
    return items


def binance_items(payload):
    items = []
    for catalog in (payload or {}).get("data", {}).get("catalogs", []):
        tag = BINANCE_CATALOGS.get(catalog.get("catalogId"))
        if not tag:
            continue
        for article in catalog.get("articles", []):
            code, title, released = article.get("code"), article.get("title"), article.get("releaseDate")
            if not code or not title or not released:
                continue
            items.append({"source": "binance", "url": f"https://www.binance.com/zh-CN/support/announcement/detail/{code}",
                          "title": f"[币安{tag}] {title}"[:300], "excerpt": "", "publishedAt": int(released)})
    return items


def collect_feeds(state, ssl_context):
    """Every feed; only items newer than the previous high-water mark (minus 2h) are sent again."""
    now = int(time.time() * 1000)
    marks = state.get("industryMarks") or {}
    items, per_source = [], {}
    sources = list(FEEDS) + [("binance", BINANCE_URL)]
    for source, url in sources:
        try:
            if source == "binance":
                got = binance_items(fetch_json(url, ssl_context))
            else:
                got = parse_feed(source, fetch(url, ssl_context).decode("utf-8", "replace"))
            floor = max(now - 3 * DAY_MS, int(marks.get(source) or 0) - 2 * HOUR_MS)
            fresh = [i for i in got if floor <= i["publishedAt"] <= now + HOUR_MS]
            items.extend(fresh)
            per_source[source] = {"ok": True, "found": len(got), "fresh": len(fresh)}
        except Exception as error:  # one broken feed must not stop the others
            per_source[source] = {"ok": False, "error": f"{type(error).__name__}: {str(error)[:80]}"}
    return items, per_source


# ---------------------------------------------------------------- macro prices
def yahoo_rows(symbol, payload):
    """Hourly closes → rows on whole hours (US cash sessions open at :30; the bar's hour is used)."""
    result = ((payload or {}).get("chart") or {}).get("result") or []
    if not result:
        return []
    stamps = result[0].get("timestamp") or []
    closes = (((result[0].get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
    rows = {}
    for ts, close in zip(stamps, closes):
        if close is None or close <= 0:
            continue
        hour = int(ts) * 1000 // HOUR_MS * HOUR_MS
        rows[hour] = {"symbol": symbol, "ts": hour, "price": round(float(close), 6), "marketCap": None, "volume": None}
    return list(rows.values())


def collect_macro_prices(state, ssl_context):
    backfilled = set(state.get("macroBackfilled") or [])
    rows, fresh, errors = [], [], []
    for symbol, ticker in MACRO:
        span = "5d" if symbol in backfilled else "3mo"
        try:
            got = yahoo_rows(symbol, fetch_json(YAHOO.format(urllib.parse.quote(ticker), span), ssl_context))
            if not got:
                raise RuntimeError("empty chart")
            rows.extend(got)
            if span == "3mo":
                fresh.append(symbol)
        except Exception as error:
            errors.append(f"{symbol}: {type(error).__name__} {str(error)[:60]}")
    return rows, fresh, errors


# ---------------------------------------------------------------- daily metrics
def _usd(value):
    if isinstance(value, dict):
        value = value.get("peggedUSD")
    return float(value) if isinstance(value, (int, float)) else None


def stablecoin_history(payload, entity, metric, since_day):
    rows = []
    for point in payload or []:
        value = _usd(point.get("totalCirculatingUSD"))
        if value is None:
            continue
        day = datetime.fromtimestamp(int(point["date"]), timezone.utc).strftime("%Y-%m-%d")
        if day >= since_day:
            rows.append({"day": day, "entity": entity, "metric": metric, "value": round(value, 2)})
    return rows


def collect_metrics(state, ssl_context, now=None):
    """DefiLlama + Fear & Greed. Full 95-day history the first time, the latest day after that."""
    now = now or int(time.time() * 1000)
    today = bj_day(now)
    backfill = not state.get("industryMetricsBackfilled")
    since = bj_day(now - (METRIC_BACKFILL_DAYS if backfill else 3) * DAY_MS)
    rows, errors = [], []

    def attempt(label, fn):
        try:
            fn()
        except Exception as error:
            errors.append(f"{label}: {type(error).__name__} {str(error)[:60]}")

    def chains_now():
        for chain in fetch_json("https://stablecoins.llama.fi/stablecoinchains", ssl_context):
            key = CHAINS.get(chain.get("name"))
            value = _usd(chain.get("totalCirculatingUSD"))
            if key and value is not None:
                rows.append({"day": today, "entity": key, "metric": "stablecoins", "value": round(value, 2)})

    def issuers_now():
        assets = fetch_json("https://stablecoins.llama.fi/stablecoins?includePrices=false", ssl_context).get("peggedAssets", [])
        total = 0.0
        for asset in assets:
            total += _usd(asset.get("circulating")) or 0
            symbol = asset.get("symbol")
            if symbol not in ("USDT", "USDC"):
                continue
            entity, metric = ("tether", "usdt") if symbol == "USDT" else ("circle", "usdc")
            rows.append({"day": today, "entity": entity, "metric": "supply", "value": round(_usd(asset.get("circulating")) or 0, 2)})
            for name, data in (asset.get("chainCirculating") or {}).items():
                key = CHAINS.get(name)
                value = _usd((data or {}).get("current"))
                if key and value is not None:
                    rows.append({"day": today, "entity": key, "metric": metric, "value": round(value, 2)})
        rows.append({"day": today, "entity": "all", "metric": "stablecoins", "value": round(total, 2)})

    def tvl_now():
        for chain in fetch_json("https://api.llama.fi/v2/chains", ssl_context):
            key = TVL_CHAINS.get(chain.get("name"))
            if key and isinstance(chain.get("tvl"), (int, float)):
                rows.append({"day": today, "entity": key, "metric": "tvl", "value": round(chain["tvl"], 2)})

    def fees_now():
        for name, key in TVL_CHAINS.items():
            data = fetch_json(f"https://api.llama.fi/overview/fees/{name}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true", ssl_context)
            for field, metric in (("total24h", "fees24h"), ("total30d", "fees30d")):
                if isinstance(data.get(field), (int, float)):
                    rows.append({"day": today, "entity": key, "metric": metric, "value": round(data[field], 2)})
            time.sleep(1)

    def binance_now():
        value = fetch_json("https://api.llama.fi/tvl/binance-cex", ssl_context)
        if isinstance(value, (int, float)):
            rows.append({"day": today, "entity": "binance", "metric": "reserves", "value": round(value, 2)})

    def fng():
        data = fetch_json(f"https://api.alternative.me/fng/?limit={METRIC_BACKFILL_DAYS if backfill else 3}", ssl_context).get("data", [])
        for point in data:
            day = bj_day(int(point["timestamp"]) * 1000)
            if day >= since:
                rows.append({"day": day, "entity": "macro", "metric": "fng", "value": float(point["value"])})

    base = "https://stablecoins.llama.fi/stablecoincharts/"
    # History, one call each: a chain without e.g. USDT (Arc) returns an empty body, which is fine.
    history = [(base + "all", "all", "stablecoins"), (base + "all?stablecoin=1", "tether", "supply"),
               (base + "all?stablecoin=2", "circle", "supply")]
    for name, key in CHAINS.items():
        history += [(base + urllib.parse.quote(name), key, "stablecoins"), (base + urllib.parse.quote(name) + "?stablecoin=1", key, "usdt")]
    history_errors = []

    def history_point(url, entity, metric):
        try:
            rows.extend(stablecoin_history(fetch_json(url, ssl_context), entity, metric, since))
        except Exception as error:
            history_errors.append(f"{entity}/{metric}: {type(error).__name__}")

    def tvl_history(name, key):
        try:
            for point in fetch_json("https://api.llama.fi/v2/historicalChainTvl/" + urllib.parse.quote(name), ssl_context):
                day = datetime.fromtimestamp(int(point["date"]), timezone.utc).strftime("%Y-%m-%d")
                if day >= since and isinstance(point.get("tvl"), (int, float)):
                    rows.append({"day": day, "entity": key, "metric": "tvl", "value": round(point["tvl"], 2)})
        except Exception as error:
            history_errors.append(f"{key}/tvl: {type(error).__name__}")

    if backfill:
        for url, entity, metric in history:
            history_point(url, entity, metric)
            time.sleep(0.5)
        for name, key in TVL_CHAINS.items():
            tvl_history(name, key)
        # Only the totals decide whether the backfill must be retried; a missing small chain is not worth it.
        if any(e.startswith(("all/", "tether/", "circle/", "tron/")) for e in history_errors):
            errors.append("history: " + ", ".join(history_errors)[:120])
    for label, fn in (("chains", chains_now), ("issuers", issuers_now), ("tvl", tvl_now), ("fees", fees_now),
                      ("binance", binance_now), ("fng", fng)):
        attempt(label, fn)
    # Later rows win (today's snapshot overrides the history point for the same day).
    merged = {}
    for row in rows:
        merged[(row["day"], row["entity"], row["metric"])] = row
    return list(merged.values()), errors, backfill


def fed_snapshot(ssl_context, now=None):
    """Open Polymarket Fed-decision markets → [{title, endDate, url, outcomes:[{label, prob}]}], soonest first."""
    now = now or int(time.time() * 1000)
    events = fetch_json("https://gamma-api.polymarket.com/events?closed=false&limit=50&tag_slug=fed-rates&order=endDate&ascending=true", ssl_context)
    out = []
    for event in events or []:
        title = event.get("title") or ""
        if not re.search(r"\bFed\b.*\bdecision\b|interest rates?", title, re.I):
            continue
        outcomes = []
        for market in event.get("markets") or []:
            if market.get("closed"):
                continue
            try:
                prob = float(json.loads(market.get("outcomePrices") or "[]")[0]) * 100
            except (ValueError, IndexError, TypeError):
                continue
            label = market.get("groupItemTitle") or market.get("question") or ""
            outcomes.append({"label": label[:60], "prob": round(prob, 1)})
        if outcomes:
            outcomes.sort(key=lambda o: -o["prob"])
            out.append({"title": title[:120], "endDate": event.get("endDate") or "", "url": f"https://polymarket.com/event/{event.get('slug')}",
                        "outcomes": outcomes[:6]})
    return {"at": now, "events": out[:3]}


# ---------------------------------------------------------------- entry point
def collect(cfg, state, dry_run, post_json, ssl_context):
    stats = {"found": 0, "errors": []}
    # 1) Feeds (every run).
    items, per_source = collect_feeds(state, ssl_context)
    stats["found"] = len(items)
    stats["sources"] = {k: v.get("fresh", v.get("error")) for k, v in per_source.items()}
    stats["errors"].extend(f"{k}: {v['error']}" for k, v in per_source.items() if not v["ok"])
    if not dry_run:
        for index in range(0, max(1, len(items)), 1000):
            status, body = post_json(cfg, "/industry-news", {"items": items[index:index + 1000], "sources": per_source})
            if status != 200:
                stats["errors"].insert(0, f"上传失败：HTTP {status} {(body or {}).get('error', '')}")
                return stats
        marks = state.get("industryMarks") or {}
        for item in items:
            marks[item["source"]] = max(int(marks.get(item["source"]) or 0), item["publishedAt"])
        state["industryMarks"] = marks
    # 2) Macro prices (every run).
    rows, fresh, errors = collect_macro_prices(state, ssl_context)
    stats["errors"].extend(errors)
    stats["macroRows"] = len(rows)
    if rows and not dry_run:
        status, body = post_json(cfg, "/market-prices", {"rows": rows})
        if status == 200:
            state["macroBackfilled"] = sorted(set(state.get("macroBackfilled") or []) | set(fresh))
        else:
            stats["errors"].append(f"宏观上传失败：HTTP {status} {(body or {}).get('error', '')}")
    # 3) Daily numbers: once every 6 hours is plenty (DefiLlama updates daily).
    now = int(time.time() * 1000)
    if dry_run or now - int(state.get("industryMetricsAt") or 0) >= 6 * HOUR_MS:
        metric_rows, metric_errors, backfill = collect_metrics(state, ssl_context, now)
        stats["errors"].extend(metric_errors)
        stats["metricRows"] = len(metric_rows)
        try:
            fed = fed_snapshot(ssl_context, now)
            stats["fedEvents"] = len(fed["events"])
        except Exception as error:
            fed = None
            stats["errors"].append(f"polymarket: {type(error).__name__} {str(error)[:60]}")
        if not dry_run:
            ok = True
            for index in range(0, len(metric_rows), 2000):
                status, body = post_json(cfg, "/industry-metrics", {"rows": metric_rows[index:index + 2000]})
                if status != 200:
                    ok = False
                    stats["errors"].append(f"指标上传失败：HTTP {status} {(body or {}).get('error', '')}")
                    break
            if fed and fed["events"]:
                post_json(cfg, "/industry-snapshot", {"kind": "fed", "data": fed})
            if ok and metric_rows:
                state["industryMetricsAt"] = now
                if backfill and not metric_errors:
                    state["industryMetricsBackfilled"] = True
    return stats
