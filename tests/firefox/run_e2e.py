"""End-to-end test of the Firefox extension in real (headless) Firefox.

    python tests/firefox/run_e2e.py <media dir>

<media dir> holds movie.mp4 (speech at known times), true.srt (correct timing), good.srt (same
lines 2.3 s late) and long.srt (far too long for the video). make_media.py builds them.
Starts: two test sites on 8766/8767 (the second is a different origin, like an embedded player)
and a stand-in OpenSubtitles API on 8768. Screenshots go to <media dir>/shots/.
"""
import re
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pysubs2
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By

from harness import Results, ext_storage_set, launch, open_ext

HERE = Path(__file__).resolve().parent
MEDIA = Path(sys.argv[1]).resolve()
SHOTS = MEDIA / "shots"
SHOTS.mkdir(exist_ok=True)
TRUTH = [(e.start, e.text.replace("\\N", "\n")) for e in pysubs2.load(str(MEDIA / "true.srt"))]
if not (MEDIA / "movie2.mp4").exists():  # a shorter video standing in for a different episode
    import shutil
    ffmpeg = shutil.which("ffmpeg") or str(Path.home() / "AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe")
    subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(MEDIA / "movie.mp4"), "-t", "420", "-c", "copy", str(MEDIA / "movie2.mp4")], check=True)
r = Results()


class Static(SimpleHTTPRequestHandler):
    """Serves the site folder, then the media folder; supports Range requests (video seeking)."""
    def __init__(self, *a, roots, **k):
        self.roots = roots
        super().__init__(*a, directory=str(roots[0]), **k)

    def log_message(self, *a):
        pass

    def translate_path(self, path):
        name = path.split("?")[0].lstrip("/") or "index.html"
        if re.fullmatch(r"embed/tv/\d+/\d+/\d+", name):
            name = "player-xo.html"  # an embedded player addressed by TMDB id, season, episode
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
        start = int(m.group(1) or 0)
        end = int(m.group(2)) if m.group(2) else size - 1
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return _Limited(f, end - start + 1)


class _Limited:
    def __init__(self, f, n):
        self.f, self.n = f, n

    def read(self, k=-1):
        if self.n <= 0:
            return b""
        data = self.f.read(min(self.n, 65536 if k < 0 else k))
        self.n -= len(data)
        return data

    def close(self):
        self.f.close()


class QuietServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass  # the browser cancels video downloads when it seeks; that's normal


def serve(port, roots):
    srv = QuietServer(("127.0.0.1", port), partial(Static, roots=roots))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def wait(fn, timeout=30, every=0.5):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(every)
    return None


serve(8766, [HERE / "site" / "outer", MEDIA])
serve(8767, [HERE / "site" / "inner", MEDIA])
mock = subprocess.Popen([sys.executable, str(HERE / "mock_opensubtitles.py"), "8768", str(MEDIA)])

d = launch()
try:
    ext_storage_set(d, {"settings": {"apiKey": "test-key", "apiBase": "http://127.0.0.1:8768/api/v1", "language": "en", "audioSync": True, "autoLoad": True}})

    def popup_state(target):
        """Open the popup for the tab whose URL contains `target`, return its visible text bits."""
        back = d.current_window_handle
        open_ext(d, f"popup.html?target={target}")
        time.sleep(1.2)
        out = d.execute_script("""const t = id => document.getElementById(id);
          return {status: t('status-text').textContent, ident: t('ident').textContent, message: t('message').hidden ? '' : t('message').textContent,
                  offset: t('offset').textContent, offsetWords: t('offset-words').textContent, sync: t('sync-text').textContent, controls: !t('controls').hidden,
                  candidates: [...document.querySelectorAll('#candidates li')].map(li => li.textContent)}""")
        d.close()
        d.switch_to.window(back)
        return out

    def popup_click(target, js):
        back = d.current_window_handle
        open_ext(d, f"popup.html?target={target}")
        time.sleep(1.2)
        d.execute_script(js)
        time.sleep(1.5)
        d.close()
        d.switch_to.window(back)

    def in_frame(js, *args, frame="player"):
        d.switch_to.default_content()
        if frame:
            d.switch_to.frame(d.find_element(By.ID, frame))
        out = d.execute_script(js, *args)
        d.switch_to.default_content()
        return out

    TRACK = "const v = document.getElementById('v'); const t = [...v.textTracks].find(t => t.label === 'subtitle-sync');"

    # ---- 0. browser fact check: does volume/mute still work after routing audio through Web Audio?
    d.get("http://127.0.0.1:8767/volume.html")
    time.sleep(1)
    vol = d.execute_async_script("window.measure().then(arguments[0], e => arguments[0]({error: String(e)}))")
    r.check(vol.get("ctxState") == "running", f"audio analysis runs in this Firefox ({vol})")
    if "full" in vol:
        r.check(vol["full"] - vol["tenth"] > 12 and vol["muted"] < vol["full"] - 40,
                f"volume and mute still apply to routed audio: full {vol['full']:.1f} dB, volume 0.1 {vol['tenth']:.1f} dB, muted {vol['muted']:.1f} dB")

    # ---- 1. streaming-style page, cross-origin embedded player ---------------------------------
    d.get("http://127.0.0.1:8766/show.html")
    site = d.current_window_handle
    time.sleep(1)
    in_frame("document.getElementById('v').play()")
    st = wait(lambda: (lambda s: s if s["status"] == "showing subtitles" or "problem" in s["status"] else None)(popup_state("8766/show")), 40, 2)
    st = st or popup_state("8766/show")
    r.check(st["status"] == "showing subtitles", f"automatic: identified, found and loaded with no clicks (status: {st['status']} {st['message']})")
    r.check("Test Show · S01E02" in st["ident"], f"identified from the page title: {st['ident']!r}")
    r.check(len(st["candidates"]) == 2 and "S01E03" not in " ".join(st["candidates"]), f"wrong-episode result filtered out: {st['candidates']}")
    r.check(any("skipped: subtitles run to" in c for c in st["candidates"]) and any(c.startswith("● Test.Show.S01E02.WEB") for c in st["candidates"]),
            "too-long subtitle rejected by the runtime check; the fitting one was chosen")
    stats = httpx.get("http://127.0.0.1:8768/stats").json()
    r.check(stats["problems"] == [], f"API requests: key, user agent and sorted parameters OK ({stats['problems']})")
    r.check(stats["downloads"] == {"102": 1, "103": 1}, f"downloads: {stats['downloads']}")
    r.check("another site" in st["sync"], f"audio sync refused for cross-origin media, and says why: {st['sync']!r}")

    info = in_frame(TRACK + "return {mode: t && t.mode, n: t ? [...t.cues].filter(c => c.line !== 0).length : 0};")
    r.check(info["mode"] == "showing" and info["n"] == len(TRUTH), f"subtitle track on the embedded player's video: {info}")

    def _active(sec, frame):
        d.switch_to.default_content()
        if frame:
            d.switch_to.frame(d.find_element(By.ID, frame))
        out = d.execute_async_script(TRACK + """const done = arguments[arguments.length - 1];
          v.addEventListener('seeked', () => setTimeout(() => done([...t.activeCues].filter(c => c.line !== 0).map(c => c.text).join('|')), 200), {once: true});
          v.currentTime = arguments[0];""", sec)
        d.switch_to.default_content()
        return out

    k = 20
    shown = _active(TRUTH[k][0] / 1000 + 2.3 + 0.3, "player")
    r.check(shown == TRUTH[k][1], f"seeking: the right line shows ({shown!r})")
    in_frame("document.getElementById('v').pause()")
    shown = _active(TRUTH[k + 5][0] / 1000 + 2.3 + 0.3, "player")
    r.check(shown == TRUTH[k + 5][1], "seeking while paused updates the line")
    d.switch_to.frame(d.find_element(By.ID, "player"))
    rate = d.execute_async_script("""const v = document.getElementById('v'); const done = arguments[arguments.length - 1];
      v.playbackRate = 2; const t0 = v.currentTime; v.play();
      setTimeout(() => { const t = [...v.textTracks].find(t => t.label === 'subtitle-sync');
        done({advanced: v.currentTime - t0, now: v.currentTime, active: [...t.activeCues].filter(c => c.line !== 0).map(c => [c.startTime, c.endTime])}); }, 1500);""")
    d.execute_script("document.getElementById('v').playbackRate = 1")
    d.switch_to.default_content()
    ok = rate["advanced"] > 2.2 and all(a <= rate["now"] < b for a, b in rate["active"])
    r.check(ok, f"2x speed: video advanced {rate['advanced']:.1f} s in 1.5 s and the showing line matches the position ({rate['active']})")

    # manual controls from the popup
    popup_click("8766/show", "document.querySelector('[data-nudge=\"500\"]').click()")
    st = popup_state("8766/show")
    r.check(st["offset"] == "+0.50 s" and "Manual" in st["sync"], f"popup +0.5: offset {st['offset']}, {st['sync']!r}")
    shown = _active(TRUTH[k][0] / 1000 + 2.3 + 0.5 + 0.3, "player")
    r.check(shown == TRUTH[k][1], "nudged timing applied to the lines")
    in_frame(TRACK + "window.__keep = [...t.cues].filter(c => c.line !== 0);")
    popup_click("8766/show", "document.querySelector('[data-nudge=\"-100\"]').click()")
    same = in_frame(TRACK + "const now = [...t.cues].filter(c => c.line !== 0); return now.length === window.__keep.length && now.every((c, i) => c === window.__keep[i]);")
    popup_click("8766/show", "document.querySelector('[data-nudge=\"100\"]').click()")
    r.check(same, "a timing change moves the lines in place, so the one on screen can't blink")
    popup_click("8766/show", "document.getElementById('btn-pos-up').click()")
    line = in_frame(TRACK + "return [...t.cues].find(c => c.line !== 0).line;")
    r.check(line == 85, f"position ▲ moves the lines up (line {line}%)")

    # Firefox's own picture-in-picture window: paused in the middle of line 31, so a line must show
    mid = (TRUTH[30][0] / 1000 + 2.3 + 0.5) + 0.8
    in_frame("document.getElementById('v').pause()")
    _active(mid, "player")
    want_pip = in_frame(TRACK + "return [...t.activeCues].filter(c => c.line !== 0).map(c => c.text).join(' ');")
    d.set_context("chrome")
    d.execute_script("""for (const c of gBrowser.selectedBrowser.browsingContext.getAllBrowsingContextsInSubtree()) {
        try { c.currentWindowGlobal?.getActor("PictureInPictureLauncher").sendAsyncMessage("PictureInPicture:KeyToggle"); } catch (e) {} }""")
    time.sleep(6)  # let Firefox's PiP controls fade out
    for h in d.window_handles:
        d.switch_to.window(h)
        if "PictureInPicture" in (d.execute_script("return document.documentElement.getAttribute('windowtype')") or ""):
            d.get_screenshot_as_file(str(SHOTS / "native-pip.png"))
            r.check(True, f"native PiP window opened while {want_pip!r} is showing; screenshot {SHOTS / 'native-pip.png'} (check it shows that line)")
            d.execute_script("window.close()")
    d.set_context("content")
    d.switch_to.window(site)
    in_frame("document.getElementById('v').play()")

    # always-on-top subtitle bar (Document PiP), opened from the page button
    ActionChains(d).move_by_offset(200, 200).move_by_offset(10, 10).perform()
    pill = wait(lambda: d.execute_script("return [...document.querySelectorAll('button')].find(b => b.textContent.includes('subtitle bar'))"), 5, 0.3)
    r.check(bool(pill), "page shows the 'CC ⧉ subtitle bar' button")
    if pill:
        in_frame("document.getElementById('v').pause()")
        _active(TRUTH[40][0] / 1000 + 2.3 + 0.5 + 0.8, "player")  # middle of line 41
        pill.click()
        time.sleep(2)
        bar = d.execute_script("return documentPictureInPicture.window ? documentPictureInPicture.window.document.body.innerText : null")
        r.check(bar is not None, "subtitle bar window opened")
        want = in_frame(TRACK + "return [...t.activeCues].filter(c => c.line !== 0).map(c => c.text).join('\\n');")
        bar_text = d.execute_script("const b = documentPictureInPicture.window.document.body; return b.firstChild.textContent")
        r.check(bar_text == want and bar_text, f"bar shows the current line: {bar_text!r}")
        in_frame("document.getElementById('v').play()")
        later = wait(lambda: (lambda t: t if t != bar_text else None)(d.execute_script("return documentPictureInPicture.window.document.body.firstChild.textContent")), 12, 0.5)
        r.check(bool(later), f"bar follows playback: next {later!r}")
        n = d.execute_script("return documentPictureInPicture.window.document.querySelectorAll('button').length")
        r.check(n >= 12, f"bar has its control strip ({n} buttons)")
        d.execute_script("documentPictureInPicture.window.close()")

    # fullscreen
    d.switch_to.frame(d.find_element(By.ID, "player"))
    d.find_element(By.ID, "fs").click()
    time.sleep(1.5)
    fs = d.execute_script(TRACK + "return {fs: !!document.fullscreenElement, mode: t.mode, active: [...t.activeCues].length}")
    d.get_screenshot_as_file(str(SHOTS / "fullscreen.png"))
    d.execute_script("document.exitFullscreen()")
    d.switch_to.default_content()
    r.check(fs["fs"] and fs["mode"] == "showing", f"fullscreen keeps the track showing ({fs}); screenshot {SHOTS / 'fullscreen.png'}")

    # cache: reload -> same subtitles, no new download
    d.refresh()
    time.sleep(1)
    in_frame("document.getElementById('v').play()")
    st = wait(lambda: (lambda s: s if s["status"] == "showing subtitles" else None)(popup_state("8766/show")), 30, 2)
    stats = httpx.get("http://127.0.0.1:8768/stats").json()
    r.check(bool(st) and stats["downloads"] == {"102": 1, "103": 1}, f"after reload: loaded from cache, no new downloads ({stats['downloads']})")
    r.check(bool(st) and st["offset"] == "+0.50 s", f"your timing for this subtitle was remembered ({st and st['offset']})")
    r.check(bool(st) and "0.50 s later than the file" in st["offsetWords"], f"popup says which way: {st and st['offsetWords']!r}")
    # Reset: back to the file's own timing, and the saved timing is forgotten
    popup_click("8766/show", "document.getElementById('btn-reset').click()")
    st = popup_state("8766/show")
    shown = _active(TRUTH[k][0] / 1000 + 2.3 + 0.3, "player")
    r.check(st["offset"] == "+0.00 s" and "file's own timing" in st["offsetWords"] and "Manual" not in st["sync"] and shown == TRUTH[k][1],
            f"Reset: back to the file's timing ({st['offset']}, {st['offsetWords']!r}, {st['sync']!r}, line {shown!r})")
    d.refresh()
    time.sleep(1)
    in_frame("document.getElementById('v').play()")
    st = wait(lambda: (lambda s: s if s["status"] == "showing subtitles" else None)(popup_state("8766/show")), 30, 2)
    r.check(bool(st) and st["offset"] == "+0.00 s", f"after Reset and a reload, the old timing stays forgotten ({st and st['offset']})")

    # ---- 2. same-site video: automatic audio sync ------------------------------------------------
    d.get("http://127.0.0.1:8767/sync.html")
    time.sleep(1)
    d.find_element(By.ID, "v").click()
    d.execute_script("const v = document.getElementById('v'); v.currentTime = 20; v.playbackRate = 2; v.play()")
    st = wait(lambda: (lambda s: s if "Synced" in s["sync"] or "No audio" in s["sync"] else None)(popup_state("8767/sync")), 150, 5)
    st = st or popup_state("8767/sync")
    r.check("Synced" in st["sync"], f"audio sync locked on (playing at 2x): {st['sync']!r}, offset {st['offset']}")
    off = float(st["offset"].replace("−", "-").replace(" s", ""))
    r.check(abs(off + 2.3) <= 0.15, f"found the 2.3 s delay: offset {st['offset']} (true −2.30 s)")
    d.execute_script("document.getElementById('v').playbackRate = 1")
    shown = _active(TRUTH[60][0] / 1000 + 0.3, None)
    r.check(shown == TRUTH[60][1], f"after sync, line 61 shows when it's spoken ({shown!r})")
    r.check("tracking" in st["sync"], f"tracking is on by default: {st['sync']!r}")
    # a shift by hand doesn't switch tracking off, and stays on top of it
    popup_click("8767/sync", "document.querySelector('[data-nudge=\"500\"]').click()")
    st = popup_state("8767/sync")
    r.check("Synced" in st["sync"] and "your shift +0.50 s" in st["sync"], f"shift by hand with tracking on: still synced ({st['sync']!r}, {st['offset']})")
    popup_click("8767/sync", "document.getElementById('btn-reset').click()")

    # a video we listen to switches to a source from another site: the popup says what that means
    d.execute_script("""const v = document.getElementById('v'); const at = v.currentTime;
      v.addEventListener('loadedmetadata', () => { v.currentTime = at; v.play(); }, {once: true});
      v.src = 'http://127.0.0.1:8766/movie.mp4';""")
    st = wait(lambda: (lambda s: s if "reload" in s["sync"] else None)(popup_state("8767/sync")), 15, 2)
    r.check(bool(st), f"listened-to video switches to another site's source: popup says so ({st and st['sync']!r})")

    # two starts at once on a video not yet listened to: only one may set up the listening
    d.get("http://127.0.0.1:8767/sync.html")
    time.sleep(1)
    res = None
    back = d.current_window_handle
    open_ext(d, "tests/unit.html")
    res = d.execute_async_script("""const done = arguments[0];
      (async () => {
        const tab = (await browser.tabs.query({})).find(t => t.url.includes('8767/sync'));
        const load = {type: 'load', cues: [{start: 5000, end: 7000, text: 'one'}], meta: {label: 'x', key: 'two-starts', provider: 'file', id: 'x'}, timing: null, autoSync: true, tracking: true, style: {}};
        const frame = {frameId: 0};
        await Promise.all([browser.tabs.sendMessage(tab.id, load, frame), browser.tabs.sendMessage(tab.id, load, frame)]);
        await new Promise(r => setTimeout(r, 3000));
        done((await browser.tabs.sendMessage(tab.id, {type: 'probe'}, frame)).sync);
      })();""")
    d.close()
    d.switch_to.window(back)
    r.check(res["state"] != "unavailable", f"two starts within 1.5 s don't leave audio sync unavailable ({res['state']}: {res.get('reason')!r})")

    # ---- 3. page that doesn't say what it is: never guess ----------------------------------------
    d.get("http://127.0.0.1:8766/vague.html")
    time.sleep(1)
    d.execute_script("document.getElementById('v').play()")
    st = wait(lambda: (lambda s: s if s["status"] not in ("waiting for a video", "identifying…", "searching…", "") else None)(popup_state("8766/vague")), 30, 2)
    has = d.execute_script("return [...document.getElementById('v').textTracks].some(t => t.label === 'subtitle-sync' && t.mode === 'showing')")
    r.check(st and st["status"] == "needs your confirmation" and not has, f"unclear page: nothing loaded, asks to confirm ({st and st['status']}: {st and st['message']!r})")
    popup_click("8766/vague", """document.getElementById('f-kind').value = 'episode'; document.getElementById('f-kind').dispatchEvent(new Event('change'));
      document.getElementById('f-title').value = 'Test Show'; document.getElementById('f-season').value = '1'; document.getElementById('f-episode').value = '2';
      document.getElementById('btn-confirm').click();""")
    st = wait(lambda: (lambda s: s if s["status"] == "showing subtitles" else None)(popup_state("8766/vague")), 30, 2)
    r.check(bool(st), f"after confirming the title in the popup, subtitles load ({st and st['ident']})")

    # ---- 5. a subtitle file from disk ------------------------------------------------------------
    d.get("http://127.0.0.1:8766/vague.html")
    time.sleep(1)
    d.execute_script("document.getElementById('v').play()")
    time.sleep(3)
    tab_id = None
    back = d.current_window_handle
    open_ext(d, "tests/unit.html")
    tab_id = d.execute_async_script("browser.tabs.query({}).then(ts => arguments[0](ts.find(t => t.url.includes('8766/vague')).id))")
    d.close()
    d.switch_to.window(back)
    open_ext(d, f"popup.html?tab={tab_id}&file=1")
    time.sleep(1)
    fi = d.find_element(By.ID, "file")
    d.execute_script("arguments[0].hidden = false", fi)
    fi.send_keys(str(MEDIA / "true.srt"))
    time.sleep(2)
    d.switch_to.window(back)
    n = d.execute_script("const t = [...document.getElementById('v').textTracks].find(t => t.label === 'subtitle-sync'); return t && t.mode === 'showing' ? [...t.cues].filter(c => c.line !== 0).length : 0")
    r.check(n == len(TRUTH), f"file from disk loaded onto the video ({n} lines)")

    # ---- 6. the player frame is swapped for a new one before the subtitles arrive ----------------
    d.get("http://127.0.0.1:8766/swap.html")
    time.sleep(1)
    in_frame("document.getElementById('v').play()")
    st = wait(lambda: (lambda s: s if s["status"] == "showing subtitles" or "problem" in s["status"] else None)(popup_state("8766/swap")), 30, 2)
    swapped = d.execute_script("return !!document.getElementById('player').dataset.swapped")
    n = in_frame(TRACK + "return t && t.mode === 'showing' ? [...t.cues].filter(c => c.line !== 0).length : 0")
    r.check(swapped and st and st["status"] == "showing subtitles" and n == len(TRUTH),
            f"player frame replaced mid-load: found the new player and loaded there (swapped {swapped}, status {st and st['status']} {st and st['message']!r}, {n} lines)")

    # ---- 7. player addressed by TMDB id, page shows no name (like /embed/tv/1396/1/1) ------------
    d.get("http://127.0.0.1:8766/idshow.html")
    time.sleep(1)
    in_frame("document.getElementById('v').play()")
    st = wait(lambda: (lambda s: s if s["status"] in ("showing subtitles", "problem", "no subtitles found", "needs your confirmation", "needs your choice") else None)(popup_state("8766/idshow")), 30, 2)
    stats = httpx.get("http://127.0.0.1:8768/stats").json()
    n = in_frame(TRACK + "return t && t.mode === 'showing' ? [...t.cues].filter(c => c.line !== 0).length : 0")
    r.check(bool(st) and st["status"] == "showing subtitles" and n == len(TRUTH),
            f"TMDB id in the player address: subtitles found and loaded ({st and st['status']} {st and st['message']!r}, {n} lines)")
    r.check(bool(st) and st["ident"] == "Id Show · S01E01", f"show name taken from the subtitle search, not the site name: {st and st['ident']!r}")
    r.check(bool(st) and not any("Other Show" in c for c in st["candidates"]) and stats["downloads"].get("106") is None and stats["downloads"].get("105") == 1,
            f"result filed under another TMDB id rejected, never downloaded ({st and st['candidates']}, downloads {stats['downloads']})")

    # ---- 8. next episode -------------------------------------------------------------------------
    # (a) the site points its player at the next episode and updates its own address (no page load)
    d.execute_script("""history.pushState({}, '', '/idshow.html?next=1');
      document.getElementById('player').src = 'http://127.0.0.1:8767/embed/tv/5550/1/2';""")
    time.sleep(2)
    in_frame("document.getElementById('v').play()")
    st = wait(lambda: (lambda s: s if s["status"] == "showing subtitles" and "S01E02" in s["ident"] else None)(popup_state("8766/idshow")), 30, 2)
    stats = httpx.get("http://127.0.0.1:8768/stats").json()
    n = in_frame(TRACK + "return t && t.mode === 'showing' ? [...t.cues].filter(c => c.line !== 0).length : 0")
    r.check(bool(st) and n == len(TRUTH) and stats["downloads"].get("107") == 1,
            f"next episode in a new player address: S01E02 found and loaded ({st and st['ident']}, {n} lines, downloads {stats['downloads']})")
    # (b) the same player starts a different video, and nothing on the page says which: drop the old
    # subtitles at once and ask, suggesting the next episode
    in_frame("const v = document.getElementById('v'); v.src = 'http://127.0.0.1:8766/movie2.mp4'; v.play();")
    time.sleep(2.5)
    left = in_frame(TRACK + "return t && t.mode === 'showing' ? [...t.cues].filter(c => c.line !== 0).length : 0")
    st = wait(lambda: (lambda s: s if s["status"] == "needs your confirmation" else None)(popup_state("8766/idshow")), 20, 2)
    r.check(left == 0, f"new video in the same player: the previous episode's subtitles were removed at once ({left} lines left)")
    r.check(bool(st) and "Is this Id Show S01E03?" in st["message"],
            f"page still names the old episode: asks instead of guessing ({st and st['status']}: {st and st['message']!r})")
    # (c) the site removes the player and puts in a new one for the episode (a new frame); the
    # old frame was last seen playing, which must not keep the new one from being followed
    d.execute_script("""const f = document.createElement('iframe');
      Object.assign(f, {id: 'player', src: 'http://127.0.0.1:8767/embed/tv/5550/1/1', width: 800, height: 470});
      document.getElementById('player').replaceWith(f);""")
    time.sleep(2)
    in_frame("document.getElementById('v').play()")
    st = wait(lambda: (lambda s: s if s["status"] == "showing subtitles" and "S01E01" in s["ident"] else None)(popup_state("8766/idshow")), 30, 2)
    n = in_frame(TRACK + "return t && t.mode === 'showing' ? [...t.cues].filter(c => c.line !== 0).length : 0")
    r.check(bool(st) and n == len(TRUTH), f"player replaced by a new one for another episode: followed and loaded ({st and st['ident']}, {n} lines)")

    # ---- 9. stays on ---------------------------------------------------------------------------
    LINES = "return t && t.mode === 'showing' ? [...t.cues].filter(c => c.line !== 0).length : 0"
    # (a) the player switches our track off, or clears it: it comes back by itself
    in_frame(TRACK + "t.mode = 'disabled';")
    time.sleep(4)
    n = in_frame(TRACK + LINES)
    r.check(n == len(TRUTH), f"player switched the subtitle track off: back on within 4 s ({n} lines)")
    in_frame(TRACK + "for (const c of [...t.cues]) t.removeCue(c);")
    time.sleep(4)
    n = in_frame(TRACK + LINES)
    r.check(n == len(TRUTH), f"player cleared the lines: put back within 4 s ({n} lines)")
    # (b) your Off stays off
    popup_click("8766/idshow", "document.getElementById('btn-onoff').click()")
    time.sleep(5)
    mode = in_frame(TRACK + "return t.mode")
    r.check(mode == "disabled", f"subtitles turned Off by you stay off ({mode})")
    popup_click("8766/idshow", "document.getElementById('btn-onoff').click()")
    time.sleep(1)
    r.check(in_frame(TRACK + LINES) == len(TRUTH), "and On brings them back")
    # (c) same length from a new address (the player changed quality or server), carrying on where it was
    before = httpx.get("http://127.0.0.1:8768/stats").json()["downloads"]
    in_frame("""const v = document.getElementById('v'); const at = v.currentTime + 40;
      v.addEventListener('loadedmetadata', () => { v.currentTime = at; v.play(); }, {once: true});
      v.src = 'http://127.0.0.1:8766/movie.mp4?quality=2';""")
    time.sleep(6)
    n = in_frame(TRACK + LINES)
    st = popup_state("8766/idshow")
    stats = httpx.get("http://127.0.0.1:8768/stats").json()["downloads"]
    r.check(n == len(TRUTH) and st["status"] == "showing subtitles" and stats == before, f"quality/server switch: lines kept, nothing reloaded ({n} lines, {st['status']}, downloads {stats})")
    # a small muted preview plays while you've paused the movie: it isn't new media
    in_frame("""const p = document.createElement('video'); p.id = 'preview'; p.muted = true; p.loop = true; p.style.width = '120px';
      p.src = 'http://127.0.0.1:8766/movie2.mp4'; document.body.append(p); document.getElementById('v').pause(); p.play();""")
    time.sleep(6)
    n = in_frame(TRACK + LINES)
    st = popup_state("8766/idshow")
    stats = httpx.get("http://127.0.0.1:8768/stats").json()["downloads"]
    r.check(n == len(TRUTH) and st["status"] == "showing subtitles" and stats == before, f"small preview playing while the movie is paused: subtitles stay ({n} lines, {st['status']}, downloads {stats})")
    in_frame("document.getElementById('preview').remove(); document.getElementById('v').play();")
    time.sleep(1)
    # (d) another video element takes over in the same frame (ours stops, it plays)
    in_frame("""const o = document.getElementById('v'); const n = o.cloneNode(); n.id = 'v2'; o.after(n);
      n.addEventListener('loadedmetadata', () => { n.currentTime = o.currentTime; o.pause(); n.play(); }, {once: true});""")
    n = wait(lambda: in_frame("const t = [...document.getElementById('v2').textTracks].find(t => t.label === 'subtitle-sync'); " + LINES) or None, 15, 1)
    r.check(n == len(TRUTH), f"another video took over in the same frame: subtitles followed it ({n} lines)")
    # (e) Firefox stops the background page and it forgets everything: the popup still knows, no download
    in_frame("document.getElementById('v2').pause()")
    before = httpx.get("http://127.0.0.1:8768/stats").json()["downloads"]
    d.set_context("chrome")
    bg_state = "return WebExtensionPolicy.getByID('subtitle-sync-firefox@danielzhang122').extension.backgroundState"
    d.execute_script("WebExtensionPolicy.getByID('subtitle-sync-firefox@danielzhang122').extension.terminateBackground()")
    stopped = False
    for _ in range(50):
        if d.execute_script(bg_state) == "stopped":
            stopped = True
            break
        time.sleep(0.1)
    d.set_context("content")
    r.check(stopped, "(test setup) the background page really was stopped")
    st = popup_state("8766/idshow")
    stats = httpx.get("http://127.0.0.1:8768/stats").json()["downloads"]
    r.check(st["status"] == "showing subtitles" and "S01E01" in st["ident"] and st["controls"] and st["candidates"] and stats == before,
            f"after the background page was stopped: popup still shows subtitles, nothing downloaded ({st['status']}, {st['ident']}, {len(st['candidates'])} files, downloads {stats})")
    # (f) at Firefox's default idle time, the heartbeat keeps it running while the video sits paused...
    d.set_context("chrome")
    seen = set()
    for _ in range(70):
        seen.add(d.execute_script(bg_state))
        time.sleep(1)
    d.set_context("content")
    r.check(seen == {"running"}, f"paused for 70 s at Firefox's default idle time (30 s): background page kept running ({seen})")
    # ...and with no video open, nothing does: it stops, so the check above means something
    d.get("http://127.0.0.1:8766/true.srt")
    d.set_context("chrome")
    stopped_after = None
    t0 = time.time()
    while time.time() - t0 < 60:
        if d.execute_script(bg_state) in ("suspending", "stopped"):
            stopped_after = round(time.time() - t0)
            break
        time.sleep(1)
    d.set_context("content")
    r.check(stopped_after is not None, f"control: with no video open the background page does stop (after {stopped_after} s)")
finally:
    try:
        d.quit()
    finally:
        mock.terminate()

print(f"\n{len(r.lines) - r.failed} passed, {r.failed} failed")
sys.exit(1 if r.failed else 0)
