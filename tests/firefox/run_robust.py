"""How the extension copes with the way real players behave, and with long sessions. Slow (about 15 minutes).

    python tests/firefox/run_robust.py <media dir> <work dir> [case ...]

<media dir> holds movie.mp4 and true.srt/good.srt (see make_media.py). <work dir> holds the test-only extras:
hls.min.js (hls.js, downloaded separately), ad.mp4 (ffmpeg -i movie.mp4 -t 20 -c copy ad.mp4), and hls/master.m3u8
with hi/ and lo/ variants of movie.mp4. Firefox is muted by the harness. Local pages only.
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
from selenium.webdriver.common.by import By

from harness import EXT_DIR, Results, ext_storage_set, launch, open_ext

HERE = Path(__file__).resolve().parent
MEDIA, WORK = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
ONLY = set(sys.argv[3:])
SITE, API = 8780, 8781
TRUTH = [(e.start, e.text.replace("\\N", "\n")) for e in pysubs2.load(str(MEDIA / "true.srt"))]
BEHIND = 2.3  # good.srt shows every line this many seconds late


class Limited:
    def __init__(self, f, n):
        self.f, self.n = f, n

    def read(self, k=-1):
        data = self.f.read(min(self.n, 65536 if k < 0 else k)) if self.n > 0 else b""
        self.n -= len(data)
        return data

    def close(self):
        self.f.close()


class Static(SimpleHTTPRequestHandler):
    roots = [HERE / "site_robust", WORK, MEDIA, EXT_DIR]

    def log_message(self, *a):
        pass

    def translate_path(self, path):
        name = path.split("?")[0].lstrip("/")
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
        return Limited(f, end - start + 1)


class Quiet(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass


def wait(fn, timeout=30, every=1.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(every)
    return None


threading.Thread(target=Quiet(("127.0.0.1", SITE), Static).serve_forever, daemon=True).start()
mock = subprocess.Popen([sys.executable, str(HERE / "mock_opensubtitles.py"), str(API), str(MEDIA)])
time.sleep(1)
r = Results()
d = launch()
SETTINGS = {"apiKey": "test-key", "apiBase": f"http://127.0.0.1:{API}/api/v1", "language": "en", "audioSync": True, "autoLoad": True}
TRACK = "const v = window.V(); const t = v && [...v.textTracks].find(t => t.label === 'subtitle-sync');"
OVERLAY = """const o = document.querySelector('[data-subsync-overlay]');
  if (!o) return null;
  const l = o.firstElementChild, r = o.getBoundingClientRect();
  return {shown: getComputedStyle(o).display !== 'none', text: l.textContent, rect: [r.left, r.top, r.width, r.height], lineTop: parseFloat(l.style.top)};"""
INFO = TRACK + "return {has: !!t, mode: t ? t.mode : null, cues: t && t.cues ? [...t.cues].filter(c => c.line !== 0).length : 0, playing: v ? !v.paused : false, time: v ? v.currentTime : 0};"


def popup(target):
    back = d.current_window_handle
    open_ext(d, f"popup.html?target={target}")
    time.sleep(1.2)
    out = d.execute_script("""const t = id => document.getElementById(id);
      return {status: t('status-text').textContent, ident: t('ident').textContent, message: t('message').hidden ? '' : t('message').textContent,
              offset: t('offset').textContent, sync: t('sync-text').textContent, controls: !t('controls').hidden,
              candidates: document.querySelectorAll('#candidates li').length}""")
    d.close()
    d.switch_to.window(back)
    return out


def popup_read(target, expr):
    back = d.current_window_handle
    open_ext(d, f"popup.html?target={target}")
    time.sleep(1.2)
    out = d.execute_script(f"return {expr}")
    d.close()
    d.switch_to.window(back)
    return out


def popup_click(target, js):
    back = d.current_window_handle
    open_ext(d, f"popup.html?target={target}")
    time.sleep(1.2)
    d.execute_script(js)
    time.sleep(1)
    d.close()
    d.switch_to.window(back)


def forget():
    back = d.current_window_handle
    open_ext(d, "tests/unit.html")
    d.execute_async_script("""const done = arguments[0];
      browser.storage.local.get().then(all => browser.storage.local.remove(Object.keys(all).filter(k => k !== 'settings'))).then(done);""")
    d.close()
    d.switch_to.window(back)


def downloads():
    return httpx.get(f"http://127.0.0.1:{API}/stats").json()["downloads"]


def open_case(name, extra=""):
    forget()
    d.get(f"http://127.0.0.1:{SITE}/player.html?case={name}{extra}")
    time.sleep(1)


def play(rate=1):
    d.execute_script(f"const v = window.V(); v.playbackRate = {rate}; v.play();")


def showing(name, timeout=30):
    return wait(lambda: (lambda s: s if s["status"] == "showing subtitles" else None)(popup(f"case={name}")), timeout, 1)


def sample(seconds, every=0.5):
    """How much of the time the main video's track is really showing lines."""
    n = on = 0
    gap = longest = 0.0
    end = time.time() + seconds
    while time.time() < end:
        i = d.execute_script(INFO)
        n += 1
        drawn = d.execute_script(OVERLAY)
        if (i["mode"] == "showing" and i["cues"] > 0) or (drawn and drawn["shown"]):
            on += 1
            gap = 0.0
        else:
            gap += every
            longest = max(longest, gap)
        time.sleep(every)
    return on / max(n, 1), longest


def lines_on_main(timeout=30, frame=None):
    """Waits until the main video itself has lines showing (a status can be left over from an ad)."""
    def look():
        if frame:
            d.switch_to.frame(d.find_element(By.ID, frame))
        i = d.execute_script(INFO)
        d.switch_to.default_content()
        return i if i["mode"] == "showing" and i["cues"] > 0 else None
    return wait(look, timeout, 1)


def line_at(sec):
    return d.execute_async_script(TRACK + """const done = arguments[arguments.length - 1];
      v.addEventListener('seeked', () => setTimeout(() => done([...t.activeCues].filter(c => c.line !== 0).map(c => c.text).join('|')), 250), {once: true});
      v.currentTime = arguments[0];""", sec)


def locks(name, rate=2, timeout=170):
    return wait(lambda: (lambda s: s if "Synced" in s["sync"] else None)(popup(f"case={name}")), timeout, 5)


def offset_of(s):
    return float(s["offset"].replace("−", "-").replace(" s", "").replace("+", ""))


# ---- cases ---------------------------------------------------------------------------------------------

def state_of(target):
    """What the main frame's content script reports about itself."""
    back = d.current_window_handle
    open_ext(d, "tests/unit.html")
    out = d.execute_async_script("""const done = arguments[1];
      browser.tabs.query({}).then(ts => browser.tabs.sendMessage(ts.find(t => t.url.includes(arguments[0])).id, {type: 'probe'}, {frameId: 0})).then(done);""", target)
    d.close()
    d.switch_to.window(back)
    return out


def drawn_on_page(name):
    """Lines must be readable on the page whatever the site does to the track, and the track stays on for PiP."""
    open_case(name)
    play()
    s = showing(name, 25)
    lines = [(e.start, e.end, e.text.replace("\\N", "\n")) for e in pysubs2.load(str(MEDIA / "good.srt"))]
    a, b, text = lines[30]
    d.execute_script("const v = window.V(); v.pause(); v.currentTime = arguments[0]", (a + b) / 2000)
    time.sleep(1)
    drawn = d.execute_script(OVERLAY)
    i = d.execute_script(INFO)
    r.check(bool(s) and bool(drawn) and drawn["shown"] and drawn["text"] == text and i["mode"] == "showing",
            f"{name}: the right line is drawn on the page, track still on for PiP (want {text!r}; drawn {drawn}; track {i})")
    if name == "clipped":
        frame = d.execute_script("const r = window.V().parentElement.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]")
        r.check(abs(drawn["rect"][3] - frame[3]) < 2, f"{name}: the line stays inside the part you can see (drawn {drawn['rect']}; frame {frame})")


def overlay_case():
    """wipe-instant has just run: lines are drawn over the video. Are they the right ones, and do the controls work?"""
    name = "wipe-instant"
    s = popup(f"case={name}")
    note = popup_read(f"case={name}", "document.getElementById('display-note').hidden ? '' : document.getElementById('display-note').textContent")
    r.check(s["status"] == "showing subtitles" and "picture-in-picture won't show" in note and "subtitle bar" in note, f"{name}: popup says plainly how the lines are shown ({note[:90]!r})")
    lines = [(e.start, e.end, e.text.replace("\\N", "\n")) for e in pysubs2.load(str(MEDIA / "good.srt"))]
    a, b, text = lines[30]
    d.execute_script("const v = window.V(); v.pause(); v.currentTime = arguments[0]", (a + b) / 2000)
    time.sleep(1)
    drawn = d.execute_script(OVERLAY)
    box = d.execute_script("const r = window.V().getBoundingClientRect(); return [r.left, r.top, r.width, r.height]")
    r.check(bool(drawn) and drawn["text"] == text and drawn["shown"] and abs(drawn["rect"][2] - box[2]) < 2 and abs(drawn["rect"][1] - box[1]) < 2,
            f"{name}: the right line is drawn over the video (want {text!r}; drawn {drawn}; video {box})")
    pos = drawn["lineTop"]
    popup_click(f"case={name}", "document.getElementById('btn-pos-up').click()")
    time.sleep(0.5)
    moved = d.execute_script(OVERLAY)
    r.check(moved["lineTop"] < pos, f"{name}: position control moves the drawn line ({pos} to {moved['lineTop']})")
    popup_click(f"case={name}", "document.getElementById('btn-pos-down').click()")
    popup_click(f"case={name}", "document.getElementById('btn-onoff').click()")
    time.sleep(0.5)
    off = d.execute_script(OVERLAY)
    r.check(not off["shown"] and not off["text"], f"{name}: Off hides the drawn line ({off})")
    popup_click(f"case={name}", "document.getElementById('btn-onoff').click()")
    time.sleep(0.5)
    on = d.execute_script(OVERLAY)
    r.check(on["shown"] and on["text"] == text, f"{name}: On brings it back ({on})")


def shadow_late():
    open_case("shadow-late")
    time.sleep(4)
    d.execute_script("window.V().play()")
    s = showing("shadow-late", 25)
    i = d.execute_script(INFO)
    r.check(bool(s) and i["mode"] == "showing" and i["cues"] > 0, f"shadow-late: player added to a closed shadow root 4 s after the page loaded gets subtitles (track {i})")


def huge():
    open_case("huge")
    play()
    s = showing("huge", 40)
    i = d.execute_script(INFO)
    info = state_of("case=huge")
    interval = max(3000, info["scanMs"] * 50)
    r.check(bool(s) and i["cues"] > 0 and info["scanMs"] <= 1000, f"huge page (200,000 elements): player found; one shadow-DOM scan takes {info['scanMs']} ms, every {interval / 1000:.1f} s ({info['scanMs'] / interval:.1%} of the time)")


def shadow(name):
    open_case(name)
    play()
    s = showing(name, 25)
    i = d.execute_script(INFO)
    last = popup(f"case={name}")
    r.check(bool(s) and i["mode"] == "showing" and i["cues"] > 0, f"{name}: video inside shadow DOM gets subtitles (status {last['status']!r}, {last['message']!r}, track {i})")


def hls():
    if not (WORK / "hls.min.js").exists():
        return r.check(False, "hls: hls.min.js missing from the work dir")
    open_case("hls")
    wait(lambda: d.execute_script("return !!window.hlsReady"), 15)
    time.sleep(3)
    src = d.execute_script("return window.V().currentSrc")
    d.find_element(By.TAG_NAME, "video").click()
    play(2)
    s = showing("hls", 40)
    i = d.execute_script(INFO)
    r.check(bool(s) and i["cues"] > 0, f"hls: stream through a blob: source ({src[:12]}...) gets subtitles ({s and s['status']}, {i})")
    if not s:
        return
    s = locks("hls")
    last = popup("case=hls")
    ok = bool(s) and abs(offset_of(s) + BEHIND) <= 0.3
    r.check(ok, f"hls: audio sync finds the 2.3 s delay ({last['sync']!r}, offset {last['offset']})")
    d.execute_script("window.hls.currentLevel = 0")
    time.sleep(10)
    level = d.execute_script("return window.hls.currentLevel")
    i = d.execute_script(INFO)
    s = popup("case=hls")
    r.check(i["mode"] == "showing" and i["cues"] > 0 and "Synced" in s["sync"], f"hls: quality switch (level {level}) keeps the lines and the sync ({i}, {s['sync']!r}, offset {s['offset']})")
    before = d.execute_script("return [window.V().currentSrc, window.V().currentTime]")
    d.execute_script("const at = window.V().currentTime; window.startHls(); window.V().addEventListener('loadedmetadata', () => { window.V().currentTime = at; window.V().play(); }, {once: true});")
    time.sleep(12)
    after = d.execute_script("return [window.V().currentSrc, window.V().currentTime]")
    i = d.execute_script(INFO)
    s = popup("case=hls")
    r.check(after[0] != before[0] and i["mode"] == "showing" and i["cues"] > 0 and s["status"] == "showing subtitles" and "Synced" in s["sync"],
            f"hls: player rebuilds its stream at the same place (new blob address {after[0] != before[0]}): lines kept ({i}, {s['status']!r}, {s['sync']!r}, offset {s['offset']})")


def wipe(name, need):
    open_case(name)
    play()
    s = showing(name, 25)
    frac, gap = sample(18)
    r.check(bool(s) and frac >= need, f"{name}: lines available {frac:.0%} of 18 s (need {need:.0%}), longest gap {gap:.1f} s, status {s and s['status']}")


def reload_player():
    open_case("reload")
    play()
    showing("reload", 25)
    d.execute_script("window.V().currentTime = 200")
    time.sleep(2)
    d.execute_script("window.reloadPlayer()")
    time.sleep(8)
    i = d.execute_script(INFO)
    s = popup("case=reload")
    r.check(i["mode"] == "showing" and i["cues"] > 0 and i["playing"] and s["status"] == "showing subtitles", f"reload: player calls video.load() and returns: lines kept ({i}, {s['status']!r})")


def ad(name):
    open_case(name)
    play()
    time.sleep(3)
    during = popup(f"case={name}")
    on_ad = d.execute_script(INFO)
    r.check(on_ad["cues"] == 0 or on_ad["mode"] != "showing", f"{name}: the show's lines aren't put over the 20 s ad ({on_ad}, {during['status']!r})")
    # wait for the 20 s ad to end and the show to start
    wait(lambda: d.execute_script("return window.V() && window.V().duration > 100 && !window.V().paused"), 40, 1)
    lines_on_main(40)
    i = d.execute_script(INFO)
    last = popup(f"case={name}")
    r.check(last["status"] == "showing subtitles" and i["mode"] == "showing" and i["cues"] > 0, f"{name}: show after a preroll ad gets subtitles (during the ad {during['status']!r}; after {last['status']!r} {last['message'][:120]!r}; track {i})")


def decoy_hidden():
    open_case("decoy-hidden")
    play()
    s = lines_on_main(25)
    i = d.execute_script(INFO)
    where = d.execute_script("return [...document.querySelectorAll('video')].map(v => [v.style.cssText.slice(0, 22), v.muted, [...v.textTracks].some(t => t.label === 'subtitle-sync' && t.mode === 'showing')])")
    r.check(bool(s), f"decoy-hidden: lines go on the visible main video, not hidden ones ({i}; [style, muted, has lines]: {where})")


def decoy_small():
    open_case("decoy-small")
    time.sleep(6)
    idle = popup("case=decoy-small")
    d.execute_script("window.V().play()")
    s = lines_on_main(30)
    i = d.execute_script(INFO)
    last = popup("case=decoy-small")
    r.check(bool(s) and i["mode"] == "showing" and i["cues"] > 0, f"decoy-small: small looping preview doesn't take over (before play {idle['status']!r} {idle['message'][:100]!r}; after {last['status']!r} {last['message'][:100]!r}; track {i})")


def iframes():
    open_case("iframes")
    time.sleep(2)
    d.switch_to.frame(d.find_element(By.ID, "small"))
    d.execute_script("window.V().muted = true; window.V().loop = true; window.V().play()")
    d.switch_to.default_content()
    time.sleep(6)
    d.switch_to.frame(d.find_element(By.ID, "big"))
    d.execute_script("window.V().play()")
    d.switch_to.default_content()
    s = lines_on_main(30, "big")
    d.switch_to.frame(d.find_element(By.ID, "big"))
    i = d.execute_script(INFO)
    d.switch_to.default_content()
    d.switch_to.frame(d.find_element(By.ID, "small"))
    small = d.execute_script(INFO)
    d.switch_to.default_content()
    last = popup("case=iframes")
    print("   small-frame track", small, "popup", last, flush=True)
    r.check(bool(s) and i["mode"] == "showing" and i["cues"] > 0, f"iframes: big player frame wins over a small trailer frame that started first ({last['status']!r} {last['message'][:100]!r}; big-frame track {i})")


def readd():
    open_case("readd")
    play()
    showing("readd", 25)
    d.execute_script("window.takeOut()")
    time.sleep(6)
    out = popup("case=readd")
    d.execute_script("window.putBack()")
    time.sleep(6)
    i = d.execute_script(INFO)
    s = popup("case=readd")
    r.check(i["mode"] == "showing" and i["cues"] > 0 and s["status"] == "showing subtitles", f"readd: element out of the page 6 s and back: lines kept (while out {out['status']!r}; after {s['status']!r}, {i})")


def rebuild():
    open_case("rebuild")
    play()
    showing("rebuild", 25)
    d.execute_script("window.V().currentTime = 100")
    time.sleep(2)
    d.execute_script("window.rebuild()")
    time.sleep(9)
    i = d.execute_script(INFO)
    s = popup("case=rebuild")
    r.check(i["has"] and i["mode"] == "showing" and i["cues"] > 0 and s["status"] == "showing subtitles", f"rebuild: new element at the same position gets the lines ({s['status']!r}, {i})")


def suspend():
    open_case("plain")
    play()
    showing("plain", 25)
    d.set_context("chrome")
    d.execute_script("Services.prefs.setIntPref('extensions.background.idle.timeout', 1000)")
    d.set_context("content")
    d.execute_script("window.V().pause()")
    dl0 = downloads()
    state = "return WebExtensionPolicy.getByID('subtitle-sync@danielzhang122').extension.backgroundState"
    stopped = 0
    end = time.time() + 75  # several heartbeats, far longer than the idle limit
    d.set_context("chrome")
    while time.time() < end:
        if d.execute_script(state) != "running":
            stopped += 1
        time.sleep(1)
    d.set_context("content")
    s = popup("case=plain")
    i = d.execute_script(INFO)
    r.check(s["status"] == "showing subtitles" and s["controls"] and i["cues"] > 0, f"suspend: 75 s paused, background stopped in {stopped} of 75 samples: popup still shows it ({s['status']!r}, controls {s['controls']}, {s['candidates']} subtitle files listed, track {i})")
    r.check(downloads() == dl0, f"suspend: no re-download after the background page came back ({dl0} then {downloads()})")
    r.check(s["candidates"] > 0, f"suspend: the list of subtitle files survives ({s['candidates']} listed)")
    popup_click("case=plain", "document.querySelector('[data-nudge=\"500\"]').click()")
    s2 = popup("case=plain")
    d.execute_script("window.V().play()")
    time.sleep(4)
    i = d.execute_script(INFO)
    r.check(s2["offset"] == "+0.50 s" and i["playing"] and i["mode"] == "showing", f"suspend: controls still work afterwards (offset {s2['offset']}, {i})")
    d.set_context("chrome")
    d.execute_script("Services.prefs.clearUserPref('extensions.background.idle.timeout')")
    d.set_context("content")


def autoplay_blocked():
    d.set_context("chrome")
    d.execute_script("Services.prefs.setIntPref('media.autoplay.default', 1)")
    d.set_context("content")
    open_case("plain")
    d.execute_script("const v = window.V(); v.muted = true; v.play();")
    showing("plain", 25)
    time.sleep(3)
    before = popup("case=plain")
    d.find_element(By.TAG_NAME, "video").click()
    d.execute_script("const v = window.V(); v.muted = false; if (v.paused) v.play();")
    s = wait(lambda: (lambda q: q if "Listening" in q["sync"] or "Synced" in q["sync"] else None)(popup("case=plain")), 15, 1)
    r.check(bool(s), f"autoplay-blocked: audio sync starts after the first click (before {before['sync']!r}; after {s and s['sync']!r})")
    d.set_context("chrome")
    d.execute_script("Services.prefs.clearUserPref('media.autoplay.default')")
    d.set_context("content")


def seeks():
    open_case("plain")
    d.find_element(By.TAG_NAME, "video").click()
    d.execute_script("window.V().currentTime = 20")
    play(2)
    showing("plain", 25)
    s = locks("plain")
    r.check(bool(s), f"seek: locks on first ({s and s['sync']!r}, {s and s['offset']})")
    if not s:
        return
    results = []
    for at in (600, 100, 450, 30):
        k = min(range(len(TRUTH)), key=lambda j: abs(TRUTH[j][0] / 1000 - at))
        shown = line_at(TRUTH[k][0] / 1000 + 0.3)
        results.append((at, shown == TRUTH[k][1]))
    d.execute_script("window.V().play()")
    time.sleep(40)  # 80 s of video at 2x after all that jumping about
    last = popup("case=plain")
    r.check(all(ok for _, ok in results) and "Synced" in last["sync"] and abs(offset_of(last) + BEHIND) <= 0.25, f"seek: far forward and back keeps the right line and the timing ({results}, {last['sync']!r}, offset {last['offset']})")
    # storage writes while synced and playing at normal speed
    back = d.current_window_handle
    open_ext(d, "tests/unit.html")
    ext = d.current_window_handle
    d.execute_script("window.__w = []; browser.storage.onChanged.addListener(c => { for (const k in c) window.__w.push([k, JSON.stringify(c[k].newValue || '').length]); });")
    d.switch_to.window(back)
    d.execute_script("window.V().playbackRate = 1")
    time.sleep(60)
    d.switch_to.window(ext)
    writes = d.execute_script("return window.__w")
    d.close()
    d.switch_to.window(back)
    r.check(len(writes) <= 4, f"storage: {len(writes)} writes in 60 s of watching (want at most 4; largest {max([w[1] for w in writes], default=0)} bytes; keys {sorted({w[0][:30] for w in writes})})")


def soak():
    d.get(f"http://127.0.0.1:{SITE}/soak.html")
    res = wait(lambda: d.execute_script("return window.RESULT || null"), 500, 2)
    if not res:
        return r.check(False, "soak: no result in 500 s")
    for v in res["views"]:
        ok = v["stepMs"]["p99"] <= 40 and v["errMs"]["median"] <= 150
        r.check(ok, f"soak 3 h, slip {v['k']}: lock at {v['lockS']} s, actions {v['kinds']}, {v['segments']} segments ({v['segmentsJson']} bytes saved each report), audio {v['energyMB']} MB, step ms {v['stepMs']}, error ms {v['errMs']}, scale {v['scale']:.5f}")
    for f in res["fills"]:
        ok = f["fillMs"]["median"] <= 16 and f["noLineAfter100ms"] == 0
        r.check(ok, f"fill: redraw of {f['cues']} lines with {f['segments']} segments takes {f['fillMs']} ms; of {f['rounds']} redraws, no line on screen right after {f['noLineJustAfter']}, 100 ms after {f['noLineAfter100ms']}; {f['cuechangeEvents']} cue-change events")


CASES = {
    "shadow-open": lambda: shadow("shadow-open"), "shadow-nested": lambda: shadow("shadow-nested"), "shadow-closed": lambda: shadow("shadow-closed"), "shadow-late": shadow_late, "huge": huge,
    "cue-hidden": lambda: drawn_on_page("cue-hidden"), "clipped": lambda: drawn_on_page("clipped"),
    "wipe-periodic": lambda: wipe("wipe-periodic", 0.6), "wipe-instant": lambda: (wipe("wipe-instant", 0.6), overlay_case()), "wipe-cues": lambda: wipe("wipe-cues", 0.6),
    "reload": reload_player, "ad-same": lambda: ad("ad-same"), "ad-separate": lambda: ad("ad-separate"),
    "decoy-hidden": decoy_hidden, "decoy-small": decoy_small, "iframes": iframes, "readd": readd, "rebuild": rebuild,
    "suspend": suspend, "autoplay-blocked": autoplay_blocked, "soak": soak, "hls": hls, "seek": seeks,
}

try:
    ext_storage_set(d, {"settings": SETTINGS})
    d.get(f"http://127.0.0.1:{SITE}/player.html?case=plain")
    for name, fn in CASES.items():
        if ONLY and name not in ONLY:
            continue
        try:
            fn()
        except Exception as err:
            d.set_context("content")
            while len(d.window_handles) > 1:
                d.switch_to.window(d.window_handles[-1])
                d.close()
            d.switch_to.window(d.window_handles[0])
            d.switch_to.default_content()
            r.check(False, f"{name}: the test itself failed: {type(err).__name__}: {str(err)[:200]}")
finally:
    d.quit()
    mock.terminate()
print(f"\n{len(r.lines) - r.failed} passed, {r.failed} failed")
sys.exit(1 if r.failed else 0)
