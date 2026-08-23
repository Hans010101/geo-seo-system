#!/usr/bin/env python3
import hmac
import io
import json
import os
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DATA = Path("/app/data")
DB = DATA / "db.db"
FILES = ("db.db", "wx.lic", ".secret_key")
STATE_TOKEN = os.environ["STATE_TOKEN"]
REFRESH_INTERVAL = max(3600, int(os.getenv("WECHAT_REFRESH_INTERVAL_SECONDS", "21600")))
stopping = threading.Event()
child = None
child_lock = threading.Lock()
bootstrap = None
STATUS = Path("/app/static/backup-status.json")


def backup_status(ok, message):
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    STATUS.write_text(json.dumps({
        "ok": ok,
        "message": message[:300],
        "checkedAt": int(time.time()),
    }), "utf-8")


def seed_weread_cookie():
    cookie = os.getenv("WECHAT_WEREAD_COOKIE", "").strip()
    lic = DATA / "wx.lic"
    if not cookie:
        return
    import yaml

    document = {}
    if lic.exists():
        try:
            document = yaml.safe_load(lic.read_text("utf-8")) or {}
        except Exception:
            document = {}
    weread = document.get("weread_data") or {}
    if isinstance(weread, str):
        import json

        try:
            weread = json.loads(weread)
        except Exception:
            weread = {}
    if weread.get("cookie"):
        return

    vid = next(
        (item.split("=", 1)[1].strip() for item in cookie.split(";") if item.strip().startswith("wr_vid=")),
        "",
    )
    document["weread_data"] = {"cookie": cookie, "vid": vid, "name": ""}
    lic.write_text(
        yaml.safe_dump(document, allow_unicode=True),
        "utf-8",
    )
    print("wechat-state: seeded WeRead login", flush=True)


def archive_state():
    if not DB.exists():
        raise FileNotFoundError("database not found")
    output = io.BytesIO()
    with tempfile.TemporaryDirectory() as temp:
        snapshot = Path(temp) / "db.db"
        with sqlite3.connect(DB) as source, sqlite3.connect(snapshot) as target:
            source.backup(target)
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(snapshot, "db.db")
            for name in FILES[1:]:
                path = DATA / name
                if path.exists():
                    zf.write(path, name)
    backup_status(True, "snapshot ready")
    return output.getvalue()


def restore_state(body):
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        if not set(zf.namelist()).issubset(FILES) or "db.db" not in zf.namelist():
            raise ValueError("invalid state archive")
        for name in FILES:
            if name in zf.namelist():
                restored = DATA / f"{name}.restore"
                with zf.open(name) as src, open(restored, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                restored.replace(DATA / name)
    backup_status(True, "restored")


def start_upstream():
    global bootstrap, child
    with child_lock:
        if child and child.poll() is None:
            return
        if bootstrap:
            bootstrap.shutdown()
            bootstrap.server_close()
            bootstrap = None
        child = subprocess.Popen(["/app/start.sh"])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError(f"upstream exited with code {child.returncode}")
            try:
                with socket.create_connection(("127.0.0.1", 8001), timeout=0.25):
                    return
            except OSError:
                time.sleep(0.25)
        raise TimeoutError("upstream did not start")


class BootstrapHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, _format, *_args):
        pass


class StateHandler(BaseHTTPRequestHandler):
    def authorized(self):
        supplied = self.headers.get("Authorization", "").removeprefix("Bearer ")
        return hmac.compare_digest(supplied, STATE_TOKEN)

    def reply(self, status, body=b"", content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/state" or not self.authorized():
            return self.reply(404)
        try:
            self.reply(200, archive_state(), "application/zip")
        except Exception as error:
            backup_status(False, str(error))
            self.reply(500)

    def do_PUT(self):
        if self.path != "/state" or not self.authorized():
            return self.reply(404)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 25 * 1024 * 1024:
                return self.reply(413)
            restore_state(self.rfile.read(length))
            start_upstream()
            self.reply(200, b'{"ok":true}')
        except Exception as error:
            backup_status(False, str(error))
            self.reply(400)

    def do_POST(self):
        if self.path != "/start" or not self.authorized():
            return self.reply(404)
        try:
            start_upstream()
            self.reply(200, b'{"ok":true}')
        except Exception as error:
            backup_status(False, str(error))
            self.reply(500)

    def log_message(self, _format, *_args):
        pass


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
                backup_status(True, "cookie refreshed")
        except Exception as error:
            print(f"wechat-state: refresh failed: {error}", flush=True)


def stop(signum, _frame):
    stopping.set()
    if child and child.poll() is None:
        child.send_signal(signum)


DATA.mkdir(parents=True, exist_ok=True)
seed_weread_cookie()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
threading.Thread(target=refresh_loop, daemon=True).start()
bootstrap = ThreadingHTTPServer(("0.0.0.0", 8001), BootstrapHandler)
threading.Thread(target=bootstrap.serve_forever, daemon=True).start()
threading.Thread(
    target=ThreadingHTTPServer(("0.0.0.0", 8787), StateHandler).serve_forever,
    daemon=True,
).start()
while child is None and not stopping.wait(0.1):
    pass
raise SystemExit(child.wait() if child else 0)
