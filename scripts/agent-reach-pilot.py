#!/usr/bin/env python3
"""Seven-day public-only supplementary collector. No browser/cookies or paid fallback."""
import argparse
import datetime as dt
import email.utils
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import certifi

ROOT = Path.home() / "Library/Application Support/Dianjinshou/agent-reach-pilot"
CHANNELS = ("web", "reddit", "youtube", "xiaohongshu")
QUERIES = (
    'Justin Sun TRON',
    '孙宇晨 波场',
    'Justin Sun HTX',
    'Justin Sun TRON 孙宇晨',
)


def publication_ms(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        date = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        try:
            date = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            return None
    if date.tzinfo is None:
        date = date.replace(tzinfo=dt.timezone.utc)
    return int(date.timestamp() * 1000)


def canonical(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or parts.username or parts.password or parts.port:
        raise ValueError("public HTTPS URL required")
    host = (parts.hostname or "").lower().removeprefix("www.")
    if "." not in host or host.endswith((".local", ".internal", ".test")):
        raise ValueError("public host required")
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query) if not k.startswith("utm_") and k not in ("fbclid", "gclid")]
    return urllib.parse.urlunsplit(("https", host, parts.path, urllib.parse.urlencode(sorted(query)), ""))


def reach(channel, action, target):
    # Explicit public backends bypass setup/login and cannot fall back to site browsers.
    command_channel = "web" if channel == "youtube" and action == "search" else channel
    if channel == "youtube" and action == "search":
        target += " site:youtube.com/watch"
    backend = ("exa" if action == "search" else "jina") if command_channel == "web" else ("yt-dlp" if channel == "youtube" else "public-web")
    args = [str(ROOT / "venv/bin/agent-reach"), command_channel, action, target, "--backend", backend, "--timeout", "35"]
    if action == "search":
        args += ["--limit", "2"]
    env = {"HOME": str(ROOT / "public-home"), "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", "LANG": "en_US.UTF-8", "SSL_CERT_FILE": certifi.where()}
    result = subprocess.run(args, capture_output=True, text=True, timeout=45, env=env)
    data = json.loads(result.stdout)
    if data.get("schema_version") != 1 or not data.get("ok"):
        error = data.get("error") or {}
        raise RuntimeError(str(error.get("code", "INVALID_RESPONSE")) + ": " + str(error.get("message", ""))[:200])
    return data.get("items", [])


def make_post(channel, found, read_items, now):
    # Search snippets are still useful if page access fails; never label either as full text.
    item = read_items[0] if read_items else found
    url = canonical(found.get("url", ""))
    stamp = publication_ms(item.get("published_at")) or publication_ms(found.get("published_at"))
    if stamp is None or not now - 48 * 3600_000 <= stamp <= now + 3600_000:
        return None
    text = (item.get("text") or found.get("text") or "").strip()[:12_000]
    title = (found.get("title") or item.get("title") or "").strip()[:512]
    if len(text) < 40 or not title:
        return None
    return dict(channel=channel, url=url, title=title, text=text, publishedAt=stamp,
                access="public", completenessVerified=False)


def deliver(db, config, report):
    for url, payload in db.execute("SELECT url, payload FROM outbox WHERE status='pending' ORDER BY rowid LIMIT 20").fetchall():
        request = urllib.request.Request(config["endpoint"] + "/ingest", data=payload.encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + config["token"],
                     "User-Agent": "Dianjinshou-AgentReach-Pilot/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=110, context=ssl.create_default_context(cafile=certifi.where())) as response:
                result = json.load(response)
            status = result.get("status", "unknown")
            db.execute("UPDATE outbox SET status=?, result=? WHERE url=?", (status, json.dumps(result), url))
            db.commit()
            report["delivery"][status] = report["delivery"].get(status, 0) + 1
        except urllib.error.HTTPError as error:
            report["delivery"][str(error.code)] = report["delivery"].get(str(error.code), 0) + 1
            if error.code == 400:
                db.execute("UPDATE outbox SET status='rejected' WHERE url=?", (url,))
                db.commit()
            # Auth, expired, cap, and ambiguous server failures wait for operator inspection/next run.
            break
        except (OSError, ValueError):
            report["delivery"]["network_error"] = 1
            break


def run():
    os.umask(0o077)
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / "public-home").mkdir(exist_ok=True)
    with (ROOT / "run.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "already_running"}
        config = json.loads((ROOT / "config.json").read_text())
        now = int(time.time() * 1000)
        if now >= publication_ms(config["expires"]):
            return {"status": "pilot_expired"}
        db = sqlite3.connect(ROOT / "outbox.sqlite3")
        db.execute("CREATE TABLE IF NOT EXISTS outbox (url TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT)")
        report = dict(started=dt.datetime.now(dt.timezone.utc).isoformat(), channels={}, delivery={}, paidCollectorCalls=0)
        query = QUERIES[(dt.datetime.now().hour // 4) % len(QUERIES)] + dt.datetime.now().strftime(" latest %B %d %Y")
        for channel in CHANNELS:
            status = dict(discovered=0, candidates=0, skipped=0, readErrors=[])
            report["channels"][channel] = status
            try:
                found_items = reach(channel, "search", query)
                status["discovered"] = len(found_items)
                for found in found_items[:2]:
                    try:
                        url = canonical(found.get("url", ""))
                    except ValueError:
                        status["skipped"] += 1
                        continue
                    if db.execute("SELECT 1 FROM outbox WHERE url=?", (url,)).fetchone():
                        status["skipped"] += 1
                        continue
                    read_items = []
                    try:
                        read_items = reach(channel, "read", url)
                    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
                        status["readErrors"].append(str(error)[:240])
                    post = make_post(channel, found, read_items, now)
                    if post is None:
                        status["skipped"] += 1
                        continue
                    db.execute("INSERT OR IGNORE INTO outbox VALUES (?, ?, 'pending', NULL)", (post["url"], json.dumps(post, ensure_ascii=False)))
                    db.commit()
                    status["candidates"] += 1
                status["status"] = "candidates_found" if status["candidates"] else "no_fresh_verified_candidates"
            except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as error:
                status.update(status="unavailable", error=str(error)[:240])
        deliver(db, config, report)
        db.close()
        report["finished"] = dt.datetime.now(dt.timezone.utc).isoformat()
        (ROOT / "last-run.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        with (ROOT / "runs.jsonl").open("a") as history:
            history.write(json.dumps(report, ensure_ascii=False) + "\n")
        return report


def install_schedule():
    import plistlib
    target = Path.home() / "Library/LaunchAgents/com.dianjinshou.agent-reach-pilot.plist"
    target.parent.mkdir(parents=True, exist_ok=True)
    collector = ROOT / "collector.py"
    collector.write_bytes(Path(__file__).read_bytes())
    collector.chmod(0o600)
    # macOS runs missed calendar jobs on wake; the collector lock prevents overlap.
    data = dict(Label="com.dianjinshou.agent-reach-pilot",
                ProgramArguments=[str(ROOT / "venv/bin/python"), str(collector), "--once"],
                StartCalendarInterval=[dict(Hour=hour, Minute=10) for hour in (9, 13, 17, 21)],
                StandardOutPath=str(ROOT / "launchd.log"), StandardErrorPath=str(ROOT / "launchd-error.log"),
                ProcessType="Background", EnvironmentVariables={"PYTHONUNBUFFERED": "1"})
    target.write_bytes(plistlib.dumps(data))
    domain = f"gui/{os.getuid()}"
    loaded = subprocess.run(["launchctl", "print", f"{domain}/{data['Label']}"], capture_output=True)
    if loaded.returncode:
        subprocess.run(["launchctl", "bootstrap", domain, str(target)], check=True)
    return {"installed": str(target), "hours": "09:10,13:10,17:10,21:10 Asia/Shanghai"}


def configure(endpoint):
    import secrets
    parts = urllib.parse.urlsplit(endpoint)
    if parts.scheme != "https" or not (parts.hostname or "").endswith(".workers.dev") or parts.path not in ("", "/"):
        raise ValueError("Expected deployed workers.dev endpoint")
    os.umask(0o077)
    ROOT.mkdir(parents=True, exist_ok=True)
    config_path = ROOT / "config.json"
    if config_path.exists():
        raise RuntimeError("Configuration exists; do not silently rotate the ingest secret")
    repo = Path(__file__).resolve().parent.parent
    worker_config = json.loads((repo / "wrangler.agent-reach.jsonc").read_text())
    if worker_config["account_id"] != "a828bebda1f352216c7d7da425bad17a":
        raise RuntimeError("Cloudflare account conflict")
    token = secrets.token_hex(32)
    result = subprocess.run(["npx", "wrangler", "secret", "put", "INGEST_TOKEN", "--config", "wrangler.agent-reach.jsonc"],
                            cwd=repo, input=token, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr[:500])
    config_path.write_text(json.dumps(dict(endpoint=endpoint.rstrip("/"), token=token, expires=worker_config["vars"]["PILOT_END"])))
    config_path.chmod(0o600)
    return {"configured": str(config_path), "secret": "stored privately, not logged"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--install-schedule", action="store_true")
    parser.add_argument("--configure", metavar="ENDPOINT")
    args = parser.parse_args()
    result = configure(args.configure) if args.configure else install_schedule() if args.install_schedule else run()
    print(json.dumps(result, ensure_ascii=False, indent=2))
