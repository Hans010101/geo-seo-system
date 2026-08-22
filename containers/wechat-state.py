#!/usr/bin/env python3
import os
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

DATA = Path("/app/data")
DB = DATA / "db.db"
FILES = ("db.db", "wx.lic", ".secret_key")
STATE_URL = os.environ["STATE_URL"]
STATE_TOKEN = os.environ["STATE_TOKEN"]
INTERVAL = max(60, int(os.getenv("STATE_UPLOAD_INTERVAL_SECONDS", "600")))
REFRESH_INTERVAL = max(3600, int(os.getenv("WECHAT_REFRESH_INTERVAL_SECONDS", "21600")))
stopping = threading.Event()
child = None


def request(method, data=None):
    req = urllib.request.Request(
        STATE_URL,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {STATE_TOKEN}"},
    )
    return urllib.request.urlopen(req, timeout=60)


def restore():
    DATA.mkdir(parents=True, exist_ok=True)
    try:
        with request("GET") as response, tempfile.NamedTemporaryFile() as archive:
            shutil.copyfileobj(response, archive)
            archive.flush()
            with zipfile.ZipFile(archive.name) as zf:
                for name in FILES:
                    if name in zf.namelist():
                        with zf.open(name) as src, open(DATA / name, "wb") as dst:
                            shutil.copyfileobj(src, dst)
        print("wechat-state: restored", flush=True)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            print(f"wechat-state: restore HTTP {error.code}", flush=True)
    except Exception as error:
        print(f"wechat-state: restore failed: {error}", flush=True)


def backup():
    if not DB.exists():
        return
    try:
        with tempfile.TemporaryDirectory() as temp:
            snapshot = Path(temp) / "db.db"
            with sqlite3.connect(DB) as source, sqlite3.connect(snapshot) as target:
                source.backup(target)
            archive = Path(temp) / "state.zip"
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.write(snapshot, "db.db")
                for name in FILES[1:]:
                    path = DATA / name
                    if path.exists():
                        zf.write(path, name)
            with request("PUT", archive.read_bytes()):
                pass
        print("wechat-state: saved", flush=True)
    except Exception as error:
        print(f"wechat-state: save failed: {error}", flush=True)


def loop():
    while not stopping.wait(INTERVAL):
        backup()


def refresh_loop():
    while not stopping.wait(REFRESH_INTERVAL):
        try:
            import yaml
            from core.weread_cookie_refresh import refresh_weread_cookie

            lic = DATA / "wx.lic"
            document = yaml.safe_load(lic.read_text("utf-8")) or {}
            weread = document.get("weread_data") or {}
            if isinstance(weread, str):
                import json
                weread = json.loads(weread)
            weread.setdefault("cookie_refresh_url", "https://weread.qq.com/")
            document["weread_data"] = weread
            lic.write_text(yaml.safe_dump(document, allow_unicode=True, sort_keys=False), "utf-8")
            if refresh_weread_cookie(
                verbose=True,
                headless_only=True,
                force_bundled=True,
                cooldown_hours=0,
            ):
                backup()
        except Exception as error:
            print(f"wechat-state: refresh failed: {error}", flush=True)


def stop(signum, _frame):
    stopping.set()
    backup()
    if child and child.poll() is None:
        child.send_signal(signum)


restore()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
threading.Thread(target=loop, daemon=True).start()
threading.Thread(target=refresh_loop, daemon=True).start()
child = subprocess.Popen(["/app/start.sh"])
raise SystemExit(child.wait())
