"""Shared helpers for driving the Firefox extension with Selenium (pip install -r requirements-dev.txt)."""
import json
import os
import time
from pathlib import Path

os.environ["MOZ_REMOTE_ALLOW_SYSTEM_ACCESS"] = "1"  # lets tests open extension pages / Firefox's PiP

import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

EXT_DIR = Path(__file__).resolve().parents[2] / "firefox-extension"
EXT_ID = "subtitle-sync-firefox@danielzhang122"
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
