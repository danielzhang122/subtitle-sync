// Per-frame controller: finds the frame's main video, shows subtitles on it as a WebVTT
// text track (drawn by Firefox on the page, in fullscreen and in its PiP window), keeps the
// timing (manual nudges + audio sync), and reports to the background script.
(() => {
  if (window.__subsyncVideoLoaded) return;
  window.__subsyncVideoLoaded = true;
  const ns = globalThis.__subsync;

  const st = {
    cues: [],             // [{start, end, text}] as downloaded (ms)
    meta: null,           // {label, contentKey, subId, ...}
    enabled: true,
    scale: 1,
    segments: [{ from: 0, offset: 0 }], // offset by subtitle time: from (ms) -> offset (ms)
    manual: 0,            // user's nudge on top of the automatic timing
    autoSync: true,
    tracking: true,       // keep following the audio after the first match
    position: 90,
    video: null,
    track: null,
    otherTracks: [],
    lastCueText: null,
    sync: { state: "off", reason: "", offset: 0, score: null, verified: false },
  };
  let notice = null, noticeTimer = null, filled = 0, rendered = [];

  // ---- finding the video ---------------------------------------------------------------

  const area = (v) => { const r = v.getBoundingClientRect(); return Math.max(0, r.width) * Math.max(0, r.height); };
  const visible = (v) => area(v) > 0 && v.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

  // Players can keep their video inside shadow DOM, even a closed one. Finding those means looking at
  // every element, so that's done now and then: at least 3 s apart, and at most 2% of the time.
  let shadowRoots = [], nextScan = 0, scanMs = 0;
  const listening = new WeakSet();
  function scanShadowRoots() {
    const t0 = performance.now();
    const found = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        const inner = el.openOrClosedShadowRoot;
        if (inner) { found.push(inner); walk(inner); }
      }
    };
    walk(document);
    for (const root of found) {
      if (listening.has(root)) continue;
      listening.add(root);
      // these events don't cross out of a shadow root
      root.addEventListener("play", () => setTimeout(check, 200), true);
      root.addEventListener("loadedmetadata", () => setTimeout(check, 200), true);
    }
    shadowRoots = found;
    scanMs = performance.now() - t0;
    nextScan = performance.now() + Math.max(3000, scanMs * 50);
  }
  function allVideos() {
    if (performance.now() >= nextScan) scanShadowRoots();
    return [...document.querySelectorAll("video"), ...shadowRoots.flatMap((root) => [...root.querySelectorAll("video")])];
  }
  ns.allVideos = allVideos;

  // Playing first, then with sound, then largest.
  function bestVideo() {
    return allVideos().filter((v) => v.isConnected && visible(v))
      .sort((a, b) => (a.paused - b.paused) || (a.muted - b.muted) || (area(b) - area(a)))[0] || null;
  }

  // Has another video taken over from the one showing our subtitles? A playing video isn't enough: a
  // small preview can play while the movie is paused.
  function takesOver(best, cur = st.video) {
    if (!best || best === cur) return false;
    if (!cur || !cur.isConnected || !visible(cur)) return true;
    if (best.paused) return false;
    if (cur.paused) return area(best) >= area(cur) * 0.5;
    if (best.muted !== cur.muted) return !best.muted && area(best) >= area(cur) * 0.5;
    return area(best) > area(cur) * 1.2;
  }

  function info(v = st.video && st.video.isConnected ? st.video : bestVideo()) {
    if (!v) return { hasVideo: false };
    return {
      hasVideo: true,
      playing: !v.paused,
      muted: v.muted,
      played: v.played.length > 0,
      duration: Number.isFinite(v.duration) ? v.duration : null,
      area: area(v),
      size: `${v.videoWidth}×${v.videoHeight}`,
      url: location.href,
      top: window === window.top,
    };
  }

  // Report the main video when it appears, starts playing, or changes to something else (next
  // episode in the same player, SPA navigation). A change drops the old subtitles at once, so the
  // previous episode's lines never show over the new one; the background then loads the right ones.
  // The same address and length under a new source is the player changing quality or server, unless
  // it restarted from the beginning and stayed there (players put the position back a moment later).
  let last = null; // {href, src, dur, time} of the media last reported
  let restartedAt = null;
  function check() {
    const best = bestVideo();
    const v = st.cues.length && st.video?.isConnected && !takesOver(best) ? st.video : best;
    if (!v || (v.paused && v.played.length === 0)) return;
    const i = info(v);
    const cur = { href: location.href, src: v.currentSrc, dur: i.duration, time: v.currentTime };
    if (last && cur.dur == null) return; // a new video is only compared once its length is known
    const sameLength = cur.dur == null || last?.dur == null || Math.abs(cur.dur - last.dur) <= 2;
    if (last && cur.href === last.href && sameLength) {
      if (cur.src === last.src) {
        if (last.dur == null && cur.dur != null) { last.dur = cur.dur; send(i, false); } // length just became known
        last.time = cur.time;
        restartedAt = null;
        return;
      }
      const restarted = cur.time < 5 && last.time > 30;
      if (!restarted) { last = cur; restartedAt = null; return; }
      restartedAt ??= Date.now();
      if (Date.now() - restartedAt < 2500) return;
    }
    restartedAt = null;
    const changed = last !== null;
    last = cur;
    if (changed && st.cues.length) dropCues();
    send(i, changed);
  }
  const send = (i, mediaChanged) => browser.runtime.sendMessage({ type: "video", info: i, mediaChanged }).catch(() => {});
  setInterval(check, 1500);
  // Firefox stops an idle background page and forgets what it knew: keep it awake, and tell it again
  // what is showing here if it did forget.
  setInterval(() => {
    if (st.cues.length) report();
    else if (last) browser.runtime.sendMessage({ type: "ping" }).catch(() => {});
  }, 15000);
  document.addEventListener("play", () => setTimeout(check, 200), true);
  document.addEventListener("loadedmetadata", () => setTimeout(check, 200), true);

  // ---- rendering ----------------------------------------------------------------------

  // ms on the video's clock for a subtitle time
  function mediaTime(t) {
    let off = st.segments[0].offset;
    for (const s of st.segments) if (s.from <= t) off = s.offset;
    return t * st.scale + off + st.manual;
  }

  function attach() {
    const v = bestVideo();
    if (!v) return false;
    if (v !== st.video || !st.track) {
      if (st.track) st.track.mode = "disabled";
      overlayOff();
      st.video = v;
      st.track = [...v.textTracks].find((t) => t.label === "subtitle-sync") || v.addTextTrack("subtitles", "subtitle-sync", "und");
      st.track.oncuechange = forwardCue;
      v.addEventListener("seeked", () => sync.onSeek(), true);
    }
    st.otherTracks = [...st.video.textTracks].filter((t) => t !== st.track && t.mode === "showing");
    for (const t of st.otherTracks) t.mode = "disabled";
    st.track.mode = st.enabled && !trackBlocked ? "showing" : "disabled";
    fill();
    if (!overlay.on) overlayOn();
    return true;
  }

  // seconds on the video's clock for a subtitle; null if it would end before the video starts
  function cueTimes(c) {
    const a = mediaTime(c.start) / 1000, b = mediaTime(c.end) / 1000;
    return b <= 0 || b <= a ? null : [Math.max(0, a), b];
  }

  function fill() {
    if (!st.track) return;
    for (const [cue] of rendered) { try { st.track.removeCue(cue); } catch {} } // cues reads as null while the track is off
    for (const c of [...(st.track.cues || [])]) st.track.removeCue(c);
    notice = null;
    rendered = [];
    for (const c of st.cues) {
      const at = cueTimes(c);
      if (!at) continue;
      const cue = new VTTCue(at[0], at[1], c.text);
      cue.snapToLines = false;
      cue.line = st.position;
      cue.lineAlign = "end";
      st.track.addCue(cue);
      rendered.push([cue, c]);
    }
    filled = rendered.length;
    st.lastCueText = null;
    forwardCue();
  }

  // Timing changed: move the lines where they are. Taking them off and putting them back could
  // blink the line on screen and the subtitle bar's text.
  function retime() {
    if (!st.track) return;
    const times = rendered.map(([, c]) => cueTimes(c));
    if (times.includes(null) || st.cues.some((c) => cueTimes(c)) && rendered.length !== st.cues.filter((c) => cueTimes(c)).length) return fill();
    rendered.forEach(([cue], i) => {
      if (Math.abs(cue.startTime - times[i][0]) > 0.0005) cue.startTime = times[i][0];
      if (Math.abs(cue.endTime - times[i][1]) > 0.0005) cue.endTime = times[i][1];
    });
    forwardCue();
  }

  // On the page we draw the lines ourselves, over the video: a site can hide what Firefox draws for a
  // track (its own styles, a clipped player, or text too large to fit, which Firefox then doesn't show at
  // all), and nothing tells us it did. The track stays on, invisible on the page (content/cue.css), because
  // Firefox's picture-in-picture shows the track, and for fullscreen of the bare video, where nothing of
  // ours can appear above it.
  // Some players also switch off, the moment it's on, any track they didn't add. After a few tries we
  // leave it off; picture-in-picture then shows no lines, but the page and the subtitle bar still do.
  const overlay = { on: false, el: null, line: null, note: null, timer: null };
  let instantOffs = 0, trackBlocked = false, hiddenOn = null;

  function restoreTrack() {
    st.track.mode = "showing";
    forwardCue();
    setTimeout(() => {
      if (!st.cues.length || !st.enabled || trackBlocked || !st.track) return;
      if (st.track.mode === "showing") { instantOffs = 0; return; }
      if (++instantOffs >= 3) { trackBlocked = true; report(); }
      else restoreTrack();
    }, 300);
  }

  function overlayOn() {
    overlay.on = true;
    const el = overlay.el = document.createElement("div");
    el.dataset.subsyncOverlay = "";
    Object.assign(el.style, { position: "fixed", zIndex: "2147483647", pointerEvents: "none", overflow: "hidden", margin: "0", padding: "0" });
    const line = overlay.line = document.createElement("div");
    Object.assign(line.style, { position: "absolute", left: "5%", right: "5%", textAlign: "center", transform: "translateY(-100%)", font: "16px system-ui, sans-serif", color: "#fff", whiteSpace: "pre-line", textShadow: "0 0 2px #000, 0 0 4px #000, 0 1px 3px #000" });
    const note = overlay.note = document.createElement("div");
    Object.assign(note.style, { position: "absolute", left: "5%", right: "5%", top: "4%", textAlign: "center", font: "14px system-ui, sans-serif", color: "#fff", textShadow: "0 0 3px #000" });
    el.append(line, note);
    overlay.timer = setInterval(drawOverlay, 100);
    drawOverlay();
    report();
  }

  function overlayOff() {
    clearInterval(overlay.timer);
    overlay.el?.remove();
    Object.assign(overlay, { on: false, el: null, line: null, note: null, timer: null });
    instantOffs = 0;
    trackBlocked = false;
    hideTrackOnPage(null);
  }

  // Make the track invisible on the page. content/cue.css does it for the page itself; its styles don't
  // reach inside a player's shadow DOM, so one goes in there too.
  function hideTrackOnPage(v) {
    if (hiddenOn === v) return;
    hiddenOn?.removeAttribute("data-subsync-hide-cue");
    hiddenOn = v;
    if (!v) return;
    v.setAttribute("data-subsync-hide-cue", "");
    const root = v.getRootNode();
    if (root !== document && root.querySelector && !root.querySelector("style[data-subsync]")) {
      const style = document.createElement("style");
      style.dataset.subsync = "";
      style.textContent = "video[data-subsync-hide-cue]::cue { color: transparent !important; background: transparent !important; text-shadow: none !important; outline: none !important; }";
      root.append(style);
    }
  }

  // The part of the video that can be seen: players often clip a video larger than their frame.
  function visibleRect(v) {
    const r = v.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    left = Math.max(left, 0); top = Math.max(top, 0);
    right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
    const parent = (el) => el.parentElement || el.getRootNode().host || null;
    for (let el = parent(v), n = 0; el && el !== document.documentElement && n < 30; el = parent(el), n++) {
      const s = getComputedStyle(el);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const c = el.getBoundingClientRect();
      if (s.overflowX !== "visible") { left = Math.max(left, c.left); right = Math.min(right, c.right); }
      if (s.overflowY !== "visible") { top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); }
    }
    return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : r;
  }

  const activeLines = () => {
    const t = st.video ? st.video.currentTime : -1;
    return rendered.filter(([cue]) => cue.startTime <= t && t < cue.endTime).map(([cue]) => cue.text).join("\n");
  };

  function drawOverlay() {
    const v = st.video;
    if (!overlay.on || !v) return;
    // inside the fullscreen element if there is one: nothing else shows above it
    const fs = document.fullscreenElement;
    const parent = fs ? fs.openOrClosedShadowRoot || fs : document.documentElement;
    if (overlay.el.parentNode !== parent) parent.append(overlay.el);
    // the bare video in fullscreen: nothing can show above it, so the track shows the lines there
    const bare = v.getRootNode().fullscreenElement === v;
    hideTrackOnPage(bare || trackBlocked ? null : v);
    const r = visibleRect(v);
    Object.assign(overlay.el.style, { display: st.enabled && !bare ? "block" : "none", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    Object.assign(overlay.line.style, { top: `${st.position}%`, fontSize: `${Math.max(12, r.height * 0.05) * (st.fontSize || 100) / 100}px` });
    overlay.line.textContent = st.enabled ? activeLines().replace(/<[^>]+>/g, "") : "";
    forwardCue();
  }

  function forwardCue() {
    if (!st.track) return;
    const text = st.enabled ? activeLines() : "";
    if (text === st.lastCueText) return;
    st.lastCueText = text;
    browser.runtime.sendMessage({ type: "cue", text }).catch(() => {});
  }

  function showNotice(text) {
    if (!st.track || !st.video || !st.enabled) return;
    if (notice) { try { st.track.removeCue(notice); } catch {} }
    const t = st.video.currentTime;
    notice = new VTTCue(t, t + 1.8, text);
    notice.line = 0;
    st.track.addCue(notice);
    if (overlay.note) overlay.note.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      if (overlay.note) overlay.note.textContent = "";
      if (notice) { try { st.track.removeCue(notice); } catch {} notice = null; }
    }, 1800);
  }

  const fmt = (ms) => `${ms < 0 ? "−" : "+"}${(Math.abs(ms) / 1000).toFixed(2)} s`;
  const videoMs = () => (st.video ? st.video.currentTime * 1000 : 0);
  // The automatic offset that applies now (without your shift): media = subtitle*scale + offset.
  const offsetNow = () => {
    const t = videoMs();
    return ns.offsetNow ? ns.offsetNow(st, t) : mediaTime(t) - t * st.scale - st.manual;
  };
  // How far the line due now is really moved from the file's time, speed change and your shift included.
  const shiftNow = () => {
    const t = videoMs();
    return Math.round(t - (t - offsetNow()) / st.scale + st.manual);
  };

  function state() {
    return {
      ...info(),
      loaded: st.cues.length > 0,
      enabled: st.enabled,
      meta: st.meta,
      manual: st.manual,
      manualMode: !!st.manualMode,
      offset: shiftNow(),
      scale: st.scale,
      segments: st.segments,
      sync: st.sync,
      autoSync: st.autoSync,
      tracking: st.tracking,
      display: trackBlocked ? "overlay" : "track",
      scanMs: Math.round(scanMs),
    };
  }

  function report() {
    browser.runtime.sendMessage({ type: "timing", state: state() }).catch(() => {});
  }

  // ---- automatic sync --------------------------------------------------------------------

  const sync = (() => {
    const est = new ns.SyncEstimator();
    let tapStop = null, timer = null, points = [], policy = new ns.SyncPolicy(false), firstTry = Date.now();
    let startId = 0, retryWhenSafe = false, clickArmed = false;

    function setSync(patch) {
      Object.assign(st.sync, patch);
      report();
    }

    // keepAudio: the audio already heard still describes this video (reset, back to automatic)
    async function start({ keepAudio = false } = {}) {
      stop();
      const id = startId;
      if (!keepAudio) est.reset();
      est.setCues(st.cues, (t) => /^\s*(?:(?:\[[^\]]*\]|\([^)]*\)|[♪♫#*\-\s]|<\/?[ib]>)+)\s*$/.test(t));
      points = []; policy = new ns.SyncPolicy(st.sync.verified, { track: st.tracking }); firstTry = Date.now();
      retryWhenSafe = false;
      if (!st.autoSync) return setSync({ state: "off", reason: "automatic sync is turned off" });
      const res = await ns.tapAudio(st.video, (t0, t1, db) => est.addAudio(t0, t1, db));
      if (id !== startId) { if (res.ok) res.stop(); return; } // stopped or restarted meanwhile
      if (!res.ok) {
        if (res.needsClick) armClick();
        // no source yet, or one we may not listen to: the watchdog tries again when that changes
        retryWhenSafe = !ns.audioSafety(st.video).ok;
        return setSync({ state: "unavailable", reason: res.reason });
      }
      tapStop = res.stop;
      setSync({ state: policy.locked ? "locked" : "listening", reason: policy.locked ? "" : "listening to the audio", heard: 0 });
      timer = setInterval(step, 5000);
    }

    // allowed after the next click or key press in this frame, or when the video next starts playing
    function armClick() {
      if (clickArmed) return;
      clickArmed = true;
      const go = () => {
        if (!clickArmed) return;
        clickArmed = false;
        for (const e of ["pointerdown", "keydown", "play"]) document.removeEventListener(e, go, true);
        if (st.cues.length && !tapStop && st.autoSync && !st.manualMode) start({ keepAudio: true });
      };
      for (const e of ["pointerdown", "keydown", "play"]) document.addEventListener(e, go, true);
    }

    function stop() {
      startId++;
      if (tapStop) tapStop();
      tapStop = null;
      clearInterval(timer);
      timer = null;
    }

    function onSeek() {
      if (policy.onSeek) policy.onSeek(videoMs());
      else policy.pending = null;
    }

    function apply(action, nowMs) {
      // action.offset: media = subtitle*scale + offset around now (manual excluded)
      const offsetTotal = action.offset;
      ns.applySync(st, action, nowMs);
      fill();
      points.push({ t: nowMs, offset: offsetTotal });
      const ratio = st.scale === 1 ? ns.detectScale(points) : null;
      if (ratio) {
        const subNow = (nowMs - offsetTotal);
        st.scale = ratio;
        st.segments = [{ from: 0, offset: subNow + offsetTotal - subNow * ratio }];
        points = [];
        fill();
        showNotice("Subtitles: frame-rate fixed");
      }
    }

    function step() {
      const v = st.video;
      if (!v || v.paused || !st.cues.length || st.manualMode) return;
      const now = v.currentTime * 1000;
      const current = Math.round(offsetNow());
      const { r, action } = policy.step(est, now, current, st.scale);
      st.sync.heard = Math.round((r.heardMs || 0) / 1000);
      st.sync.last = r.ok ? { score: +r.score.toFixed(2), margin: +r.margin.toFixed(2), lines: r.cues, offset: r.offset, at: Math.round(now / 1000) } : { reason: r.reason, at: Math.round(now / 1000) };
      st.sync.drift = policy.drift;
      if (!action) {
        // keeps listening either way; after 8 minutes say it isn't working out (yet)
        if (!policy.locked && st.sync.state === "listening" && Date.now() - firstTry > 8 * 60000) {
          return setSync({ state: "unsure", reason: r.ok ? "the audio doesn't clearly match these subtitles yet" : `couldn't match the audio yet (${r.reason})` });
        }
        return report();
      }
      st.sync.lastFix = Date.now();
      if (action.kind === "lock") {
        st.manual = 0; // this match replaces any shift made by hand while waiting for it
        apply(action, now);
        setSync({ state: "locked", verified: true, reason: "", offset: action.offset, score: r.score });
        showNotice(`Subtitles synced to the audio (${fmt(action.offset)})`);
      } else if (action.kind === "fine") {
        // more audio gives a more precise answer: adjust the current stretch quietly
        ns.applySync(st, action, now);
        points.push({ t: now, offset: action.offset });
        retime();
        setSync({ offset: action.offset, score: r.score });
      } else if (action.kind === "track" || action.kind === "rescale") {
        // following the audio: small enough not to mention
        if (action.kind === "rescale") points = [];
        ns.applySync(st, action, now);
        retime();
        setSync({ offset: action.offset, score: r.score });
      } else {
        apply(action, now); // a jump: ad break or a different cut
        setSync({ state: "locked", offset: action.offset, score: r.score });
        showNotice(`Subtitles re-synced (${fmt(action.offset)})`);
      }
    }

    function setTracking(on) { policy.rules.track = on; policy.points = []; policy.drift = 0; st.sync.drift = 0; }

    // Called by the watchdog: bring back what the browser or the site stopped.
    function keepAlive() {
      const ctx = st.video?.__subsyncTap?.ctx;
      if (ctx?.state === "suspended") ctx.resume().catch(() => {});
      // the source changed under a video we listen to: stop, and say so (start reports the reason)
      if (tapStop && st.video && !ns.audioSafety(st.video).ok) return start({ keepAudio: true });
      if (retryWhenSafe && !tapStop && st.autoSync && !st.manualMode && ns.audioSafety(st.video).ok) start({ keepAudio: true });
    }

    return { start, stop, onSeek, setTracking, keepAlive, running: () => !!tapStop };
  })();

  function dropCues() {
    sync.stop();
    overlayOff();
    st.cues = [];
    st.meta = null;
    st.sync = { state: "off", reason: "", offset: 0, score: null, verified: false };
    fill();
    if (st.track) st.track.mode = "disabled";
    for (const t of st.otherTracks) t.mode = "showing";
    st.otherTracks = [];
    forwardCue();
    report();
  }

  // ---- messages ----------------------------------------------------------------------------

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "probe":
        return Promise.resolve(state());
      case "video-info":
        return Promise.resolve(info());
      case "load": {
        st.cues = msg.cues;
        st.meta = msg.meta;
        st.enabled = true;
        st.scale = msg.timing?.scale || 1;
        st.segments = msg.timing?.segments?.length ? msg.timing.segments : [{ from: 0, offset: 0 }];
        st.manual = msg.timing?.manual || 0;
        st.autoSync = msg.autoSync !== false;
        st.tracking = msg.tracking !== false;
        st.manualMode = !!msg.timing?.manualMode && !st.tracking; // tracking keeps a saved shift on top
        st.position = msg.style?.position ?? st.position;
        st.fontSize = msg.style?.fontSize ?? st.fontSize;
        st.sync = { state: "off", reason: "", offset: 0, score: null, verified: !!msg.timing?.verified };
        if (!attach()) { st.cues = []; return Promise.resolve({ ...state(), error: "no video in this frame" }); }
        showNotice(`subtitle-sync: ${msg.meta?.label || ""}`);
        if (!st.manualMode) sync.start();
        else st.sync = { state: "manual", reason: "you set the timing by hand", verified: false };
        report();
        return Promise.resolve(state());
      }
      case "nudge": // user adjustment: from now on, the user's timing wins over auto-sync
        if (!st.cues.length) return;
        st.manual += msg.ms;
        // with tracking on, the audio keeps being followed and your shift stays on top of it
        if (!(st.tracking && sync.running())) {
          st.manualMode = true;
          sync.stop();
          st.sync = { ...st.sync, state: "manual", reason: "you set the timing by hand" };
        }
        retime();
        showNotice(`Subtitles ${fmt(shiftNow())}`);
        report();
        return Promise.resolve(state());
      case "resume-auto":
        if (!st.cues.length) return;
        st.manual = 0;
        st.manualMode = false;
        st.autoSync = true;
        fill();
        sync.start({ keepAudio: true });
        return Promise.resolve(state());
      case "reset": // back to the file's own timing; audio sync (if on) starts over from there
        if (!st.cues.length) return;
        st.manual = 0;
        st.manualMode = false;
        st.scale = 1;
        st.segments = [{ from: 0, offset: 0 }];
        st.sync = { state: "off", reason: "", offset: 0, score: null, verified: false };
        fill();
        showNotice("Subtitles: timing reset");
        if (st.autoSync) sync.start({ keepAudio: true });
        else { st.sync.reason = "automatic sync is turned off"; report(); }
        return Promise.resolve(state());
      case "auto-sync":
        st.autoSync = msg.enabled;
        if (st.cues.length) { if (msg.enabled && !st.manualMode) sync.start(); else { sync.stop(); st.sync = { ...st.sync, state: "off", reason: "automatic sync is turned off" }; report(); } }
        return Promise.resolve(state());
      case "tracking":
        st.tracking = msg.enabled;
        sync.setTracking(msg.enabled);
        if (msg.enabled && st.cues.length && st.autoSync && (st.manualMode || !sync.running())) {
          st.manualMode = false; // your shift stays on top
          sync.start({ keepAudio: true });
        }
        report();
        return Promise.resolve(state());
      case "style":
        st.fontSize = msg.fontSize ?? st.fontSize;
        if (msg.position != null && msg.position !== st.position) { st.position = msg.position; fill(); }
        drawOverlay();
        return Promise.resolve(state());
      case "enable":
        if (!st.cues.length) return;
        st.enabled = msg.enabled;
        if (st.track) st.track.mode = st.enabled && !trackBlocked ? "showing" : "disabled";
        drawOverlay();
        for (const t of st.otherTracks) t.mode = st.enabled ? "disabled" : "showing";
        forwardCue();
        report();
        return Promise.resolve(state());
      case "unload":
        if (!st.cues.length) return;
        dropCues();
        return Promise.resolve(state());
    }
  });

  // Watchdog: while subtitles are loaded, keep them on. Players switch off tracks they didn't add and
  // clear cues, and sites replace the <video> element (ads, quality switch).
  setInterval(() => {
    if (!st.cues.length) return;
    const cur = st.video, best = bestVideo();
    if (takesOver(best)) { attach(); sync.start(); return; }
    if (!cur || !cur.isConnected || !st.track) return;
    if (trackBlocked) {
      // left off: the player would only switch it off again
    } else if (st.enabled) {
      for (const t of cur.textTracks) {
        if (t === st.track || t.mode !== "showing") continue;
        t.mode = "disabled";
        if (!st.otherTracks.includes(t)) st.otherTracks.push(t);
      }
      if (st.track.mode !== "showing") restoreTrack();
      else if ((st.track.cues?.length || 0) < filled) fill();
    } else if (st.track.mode === "showing") {
      st.track.mode = "disabled";
    }
    sync.keepAlive();
  }, 2000);
})();
