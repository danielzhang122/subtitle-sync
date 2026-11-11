"""Shared helpers for driving the Firefox extension with Selenium (pip install -r requirements-dev.txt)."""
import json
import os
import re
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ["MOZ_REMOTE_ALLOW_SYSTEM_ACCESS"] = "1"  # lets tests open extension pages / Firefox's PiP

import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

EXT_DIR = Path(__file__).resolve().parents[2] / "firefox-extension"
EXT_ID = "subtitle-sync@danielzhang122"
UUID = "6a1f6f51-0d6c-4c3e-9a55-5ab5c0a1e001"  # fixed so tests know the moz-extension:// address


def launch(headless=True):
    opts = Options()
    if headless:
        opts.add_argument("-headless")
    opts.set_preference("extensions.webextensions.uuids", json.dumps({EXT_ID: UUID}))
    opts.set_preference("media.autoplay.default", 0)          # allow test videos to play
    opts.set_preference("media.autoplay.blocking_policy", 0)
    opts.set_preference("media.volume_scale", "0.0")          # silent speakers; pages still analyse the sound normally
    d = webdriver.Firefox(options=opts)
    d.install_addon(str(EXT_DIR), temporary=True)
    return d


def open_ext(d, path):
    """Open an extension page in a new tab (WebDriver can't navigate to moz-extension:// directly)."""
    before = set(d.window_handles)
    d.set_context("chrome")
    d.execute_script(
        "gBrowser.selectedTab = gBrowser.addTab(arguments[0], "
        "{triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});",
        f"moz-extension://{UUID}/{path}")
    d.set_context("content")
    want = f"moz-extension://{UUID}/{path.split('?')[0]}"
    for _ in range(50):
        for h in set(d.window_handles) - before:
            d.switch_to.window(h)
            if d.current_url.startswith(want):
                return h
        time.sleep(0.1)
    raise RuntimeError(f"extension page {path} did not open")


def ext_storage_set(d, values):
    """Write browser.storage.local from an extension page (opens and closes one)."""
    back = d.current_window_handle
    open_ext(d, "tests/unit.html")
    d.execute_async_script("browser.storage.local.set(arguments[0]).then(arguments[1])", values)
    d.close()
    d.switch_to.window(back)


class Results:
    def __init__(self):
        self.lines = []

    def check(self, ok, msg):
        self.lines.append(f"{'PASS' if ok else 'FAIL'} {msg}")
        print(self.lines[-1], flush=True)
        return ok

    @property
    def failed(self):
        return sum(line.startswith("FAIL") for line in self.lines)


class _Limited:
    """A file that stops after n bytes: the body of a Range response."""
    def __init__(self, f, n):
        self.f, self.n = f, n

    def read(self, k=-1):
        data = self.f.read(min(self.n, 65536 if k < 0 else k)) if self.n > 0 else b""
        self.n -= len(data)
        return data

    def close(self):
        self.f.close()


class _Static(SimpleHTTPRequestHandler):
    """Serves a file from the first root that has it; supports Range requests (video seeking)."""
    def __init__(self, *a, roots, alias, **k):
        self.roots, self.alias = roots, alias
        super().__init__(*a, directory=str(roots[0]), **k)

    def log_message(self, *a):
        pass

    def translate_path(self, path):
        name = self.alias(path.split("?")[0].lstrip("/"))
        for root in self.roots:
            if (root / name).is_file():
                return str(root / name)
        return str(self.roots[0] / name)

    def send_head(self):
        path = Path(self.translate_path(self.path))
        rng = self.headers.get("Range")
        if not rng or not path.is_file():
            return super().send_head()
        size = path.stat().st_size
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        start, end = int(m.group(1) or 0), int(m.group(2)) if m.group(2) else size - 1
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        return _Limited(f, end - start + 1)


class _QuietServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass  # the browser cancels video downloads when it seeks; that's normal


def serve(port, roots, alias=lambda name: name):
    """Start a local test site on `port` in the background. `alias` maps a requested name to the file to serve."""
    srv = _QuietServer(("127.0.0.1", port), partial(_Static, roots=roots, alias=alias))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def wait(fn, timeout=30, every=1.0):
    """Call fn every `every` seconds until it returns something truthy; None if `timeout` seconds pass first."""
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(every)
    return None
