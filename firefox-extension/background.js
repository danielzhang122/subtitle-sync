// Coordinates the automatic flow for each tab:
//   a frame reports a main video -> gather page context from every frame -> identify the
//   content -> find subtitles (OpenSubtitles) -> validate (title,
//   season/episode, language, runtime) -> load into the video's frame -> keep timing/state.
import { contentKey, displayTitle, identify, normalizeTitle } from "./lib/identify.js";
import { rank, runtimeCheck } from "./lib/match.js";
import * as os from "./lib/opensubtitles.js";
import * as store from "./lib/store.js";

const tabs = new Map(); // tabId -> state
const MAX_TRIES = 3;

function tabState(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, {
      tabId, frameId: null, video: null, url: "", ident: null, key: null, candidates: [], rejected: [],
      chosen: -1, status: "idle", message: "", timing: null, barOpen: false, runId: 0,
    });
  }
  return tabs.get(tabId);
}

function setStatus(s, status, message = "") {
  s.status = status;
  s.message = message;
  const badge = { showing: "CC", "needs-confirm": "?", uncertain: "?", "not-found": "–", error: "!" }[status] || "";
  browser.action.setBadgeText({ tabId: s.tabId, text: badge }).catch(() => {});
  browser.action.setBadgeBackgroundColor({ tabId: s.tabId, color: status === "showing" ? "#2f7d3c" : "#8a6d1d" }).catch(() => {});
  pushBarState(s);
}

async function publicState(s) {
  const settings = await store.getSettings();
  const t = s.timing || {};
  return {
    status: s.status, message: s.message, ident: s.ident,
    candidates: s.candidates.map((c, i) => ({ i, provider: c.provider, release: c.release || c.fileName, language: c.language,
      downloads: c.downloads, hearingImpaired: c.hearingImpaired, chosen: i === s.chosen, score: c.score })),
    rejected: s.rejected,
    loaded: !!t.loaded, enabled: t.enabled !== false, offset: t.offset || 0, manual: t.manual || 0, sync: t.sync || null,
    scale: t.scale || 1, display: t.display || "track", tracking: t.tracking ?? settings.audioTrack, label: t.meta?.label || "", video: s.video, barOpen: s.barOpen,
    language: settings.language, fontSize: settings.fontSize, position: settings.position, barText: settings.barText !== false,
    autoSync: settings.audioSync, hasKey: !!settings.apiKey,
  };
}

async function pushBarState(s) {
  const state = await publicState(s);
  browser.tabs.sendMessage(s.tabId, { type: "bar-state", state }, { frameId: 0 }).catch(() => {});
}

const toFrame = (s, msg) => browser.tabs.sendMessage(s.tabId, msg, { frameId: s.frameId });

const CONTENT_SCRIPTS = browser.runtime.getManifest().content_scripts[0].js;

// Ask every frame for its main video and switch to the best one (playing first, then largest).
// Frames without our scripts (a page opened before the add-on was loaded or reloaded) get them
// injected. Returns true when a video was found.
async function relocateVideo(s) {
  const ask = async () => {
    const frames = (await browser.webNavigation.getAllFrames({ tabId: s.tabId }).catch(() => null)) || [];
    return Promise.all(frames.map((f) =>
      browser.tabs.sendMessage(s.tabId, { type: "video-info" }, { frameId: f.frameId })
        .then((i) => ({ frameId: f.frameId, i }), () => ({ frameId: f.frameId, i: null }))));
  };
  let answers = await ask();
  if (answers.some((a) => !a.i)) {
    await browser.scripting.executeScript({ target: { tabId: s.tabId, allFrames: true }, files: CONTENT_SCRIPTS }).catch(() => {});
    answers = await ask();
  }
  const best = answers.filter((a) => a.i?.hasVideo)
    .sort((a, b) => (b.i.playing - a.i.playing) || (a.i.muted - b.i.muted) || (b.i.area - a.i.area))[0];
  if (!best) return false;
  s.frameId = best.frameId;
  s.video = best.i;
  return true;
}

// ---- the pipeline ---------------------------------------------------------------------------

async function gatherContexts(tabId) {
  const frames = (await browser.webNavigation.getAllFrames({ tabId })) || [];
  const all = await Promise.all(frames.map((f) =>
    browser.tabs.sendMessage(tabId, { type: "context" }, { frameId: f.frameId }).catch(() => null)));
  return all.filter(Boolean);
}

async function run(tabId, { force = false, recheck = false } = {}) {
  const s = tabState(tabId);
  // A recheck only looks; it takes over (cancelling any run in progress) once it finds something new.
  let runId = recheck ? s.runId : ++s.runId;
  const stale = () => runId !== s.runId;
  const settings = await store.getSettings();
  const lang = settings.language;
  try {
    if (!recheck) setStatus(s, "identifying", "Working out what's playing…");
    const contexts = await gatherContexts(tabId);
    const topUrl = contexts.find((c) => c)?.url || s.url;
    const override = await store.get(`page:${s.url || topUrl}`);
    const ident = override?.ident ? { ...override.ident, confidence: "high", evidence: ["you confirmed it"] } : identify(contexts);
    if (stale()) return;
    const key = ident.kind && (ident.title || ident.tmdbId != null || ident.imdbId != null) ? contentKey(ident, lang) : null;
    // the address or title changed, but it still names what we already have (or nothing usable):
    // leave whatever is running or showing alone
    if (recheck && (!key || key === s.key || key === s.loadedKey)) return;
    if (recheck) { runId = ++s.runId; setStatus(s, "identifying", "Working out what's playing…"); }
    s.ident = ident;
    if (!key) return setStatus(s, "needs-confirm", "Couldn't tell what's playing. Enter the title below.");
    s.key = key;
    if (!ident.title) ident.resolvedTitle = (await store.get(`match:${key}`))?.resolvedTitle || "";
    if (stale()) return;
    // A new full-length video started, but the page still names the episode that was showing,
    // and it isn't that episode reloading (the length differs). Its subtitles would most likely
    // be wrong, so ask instead; for a show, suggest the next episode.
    const prev = s.previous;
    s.previous = null;
    if (!force && prev && prev.key === key) {
      const a = prev.duration, b = s.video?.duration;
      if (a >= 300 && b >= 300 && Math.abs(a - b) > 2) {
        if (ident.kind === "episode") s.ident = { ...ident, episode: ident.episode + 1, confidence: "low" };
        s.candidates = [];
        s.chosen = -1;
        const guess = ident.kind === "episode" ? `Is this ${describe(s.ident)}? ` : "";
        return setStatus(s, "needs-confirm", `A new video started, but the page still says ${describe(ident)}. ${guess}Confirm or correct it below.`);
      }
    }

    // candidates: cached ranking, else search
    let match = force ? null : await store.get(`match:${s.key}`);
    if (!match) {
      setStatus(s, "searching", "Looking for subtitles…");
      let fromOs = [];
      let osError = null;
      try { fromOs = await os.search(ident, lang); } catch (err) { osError = err; }
      if (stale()) return;
      if (!ident.title) ident.resolvedTitle = resolveName(ident, fromOs);
      const ranked = rank(ident, fromOs, { language: lang, release: ident.release, preferHearingImpaired: settings.preferHearingImpaired });
      ranked.sort((a, b) => b.score - a.score);
      if (!ranked.length && ident.confidence === "low" && !osError) {
        s.candidates = [];
        return setStatus(s, "needs-confirm", `Couldn't tell what's playing (best guess: "${ident.title}"). Enter the title below.`);
      }
      if (!ranked.length) {
        return setStatus(s, osError ? "error" : "not-found", osError ? osError.message
          : `No ${lang} subtitles found for ${describe(ident)}.`);
      }
      match = { candidates: ranked.slice(0, 8), chosen: 0, resolvedTitle: ident.resolvedTitle || "" };
      await store.put(`match:${s.key}`, match);
    }
    if (!ident.title && !ident.resolvedTitle) ident.resolvedTitle = match.resolvedTitle || "";
    s.candidates = match.candidates;
    s.rejected = [];
    if (ident.confidence === "low") {
      s.chosen = -1;
      return setStatus(s, "needs-confirm", `Is this ${describe(ident)}? Confirm or correct it below before subtitles load.`);
    }
    if (!settings.autoLoad && !force) {
      s.chosen = -1;
      return setStatus(s, "ready", `Found subtitles for ${describe(ident)}. Pick one to load.`);
    }
    await tryCandidates(s, match.chosen || 0, stale);
  } catch (err) {
    if (!stale()) setStatus(s, "error", err.message);
  }
}

function describe(id) {
  const name = displayTitle(id);
  return id.kind === "episode" ? `${name} S${String(id.season).padStart(2, "0")}E${String(id.episode).padStart(2, "0")}` : `${name}${id.year ? ` (${id.year})` : ""}`;
}

// The show/movie name for an id the page gave without a name: the title OpenSubtitles files the
// results of the id search under. Results filed under another id are about something else and
// are left out; at least 80% of the rest must agree on the name, or it's "" (not settled).
function resolveName(ident, results) {
  const counts = new Map();
  let n = 0;
  for (const r of results) {
    const f = r.feature || {};
    const other = (ident.tmdbId != null && f.tmdbId != null && Number(f.tmdbId) !== Number(ident.tmdbId)) ||
      (ident.imdbId != null && f.imdbId != null && Number(f.imdbId) !== Number(ident.imdbId));
    if (other) continue;
    n++;
    if (!f.title) continue;
    const k = normalizeTitle(f.title);
    counts.set(k, { title: f.title, n: (counts.get(k)?.n || 0) + 1 });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best && best.n >= n * 0.8 ? best.title : "";
}

async function getCues(c) {
  const key = `sub:${c.provider}:${c.id}`;
  const cached = await store.get(key);
  if (cached?.cues?.length) return cached.cues;
  const res = await os.download(c);
  await store.put(key, { cues: res.cues, release: c.release, language: c.language });
  return res.cues;
}

// Try candidates from `start`, skipping any whose length doesn't fit the video.
async function tryCandidates(s, start, stale = () => false) {
  const n = s.candidates.length;
  for (let k = 0; k < Math.min(n, MAX_TRIES); k++) {
    const i = (start + k) % n;
    const c = s.candidates[i];
    setStatus(s, "downloading", `Loading subtitles (${c.release || c.fileName || c.provider})…`);
    let cues;
    try {
      cues = await getCues(c);
    } catch (err) {
      if (err.quota) return setStatus(s, "error", err.message);
      s.rejected.push({ i, reason: err.message });
      continue;
    }
    if (stale()) return;
    const check = runtimeCheck(cues, s.video?.duration);
    if (check.waiting) {
      // an ad, most likely. When the real video starts, the media-change path comes back here.
      if (s.timing?.loaded) await toFrame(s, { type: "unload" }).catch(() => {});
      s.chosen = -1;
      return setStatus(s, "waiting-main", `This looks like an ad: ${check.reason}. They'll load when the main video starts, or pick one below to load it now.`);
    }
    if (!check.ok) { s.rejected.push({ i, reason: check.reason }); continue; }
    await load(s, i, cues);
    return;
  }
  s.chosen = -1;
  setStatus(s, "uncertain", `None of the subtitles fit this video well enough to load automatically (${s.rejected.map((r) => r.reason).join("; ")}). Pick one below to try anyway.`);
}

async function load(s, i, cues) {
  const c = s.candidates[i];
  const settings = await store.getSettings();
  const timing = await store.get(`sync:${s.key}:${c.provider}:${c.id}`);
  const source = c.provider === "file" ? "file" : "OpenSubtitles";
  const label = `${s.ident?.kind ? `${describe(s.ident)} · ` : ""}${source}${c.release ? ` · ${c.release}` : ""}`;
  const msg = {
    type: "load", cues,
    meta: { label, key: s.key, provider: c.provider, id: c.id, ident: s.ident },
    timing: timing || null,
    autoSync: settings.audioSync,
    tracking: settings.audioTrack,
    style: { position: settings.position },
  };
  let res = await toFrame(s, msg).catch((err) => ({ error: err.message }));
  // The frame that reported the video can be gone by now (sites swap an ad or placeholder
  // player for the real one): find where the video is now and try once more.
  if (res?.error && await relocateVideo(s)) res = await toFrame(s, msg).catch((err) => ({ error: err.message }));
  if (res?.error) {
    s.timing = null;
    return setStatus(s, "error", `Couldn't attach subtitles to the video (${res.error}). Start the video playing, then click a subtitle file below.`);
  }
  s.chosen = i;
  s.loadedKey = s.key;
  s.frameReloaded = false; // whatever reloaded, these subtitles are for what is there now
  await store.put(`match:${s.key}`, { candidates: s.candidates, chosen: i, resolvedTitle: s.ident?.resolvedTitle || "" });
  await applyFont(s, settings.fontSize);
  setStatus(s, "showing", "");
}

let cssByFrame = new Map();
async function applyFont(s, size) {
  const key = `${s.tabId}:${s.frameId}`;
  const old = cssByFrame.get(key);
  const css = `::cue { font-size: ${size}% !important; }`;
  toFrame(s, { type: "style", fontSize: size }).catch(() => {}); // for lines we draw ourselves
  try {
    if (old) await browser.scripting.removeCSS({ target: { tabId: s.tabId, frameIds: [s.frameId] }, css: old });
    await browser.scripting.insertCSS({ target: { tabId: s.tabId, frameIds: [s.frameId] }, css, origin: "USER" });
    cssByFrame.set(key, css);
  } catch {}
}

// ---- messages ---------------------------------------------------------------------------------

// A pending run per tab. A full run wins over a "recheck" (look again after the address or
// title changed; reloads nothing if it's still the same episode).
const runTimers = new Map();
function scheduleRun(tabId, delay = 700, { recheck = false } = {}) {
  const pending = runTimers.get(tabId);
  if (pending) clearTimeout(pending.timer);
  const opts = { recheck: recheck && (!pending || pending.opts.recheck) };
  const timer = setTimeout(() => { runTimers.delete(tabId); if (tabs.has(tabId)) run(tabId, opts); }, delay);
  runTimers.set(tabId, { timer, opts });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = msg.tabId ?? sender.tab?.id;
  if (tabId == null) return;
  const s = tabState(tabId);
  switch (msg.type) {
    case "video":
      onVideo(s, msg, sender);
      return;
    case "ping": // only here to keep this page from being stopped while a video is open
      return;
    case "timing":
      if (s.frameId === null && msg.state?.loaded) return adopt(s, msg.state, sender.frameId, sender.tab.url);
      if (sender.frameId !== s.frameId) return;
      s.timing = msg.state;
      persistTiming(s);
      pushBarState(s);
      return;
    case "cue":
      if (sender.frameId !== s.frameId) return;
      browser.tabs.sendMessage(tabId, { type: "bar-cue", text: msg.text }, { frameId: 0 }).catch(() => {});
      return;
    case "get-state":
      return (s.frameId === null ? findLoaded(s) : Promise.resolve()).then(() => publicState(s));
    case "action":
      return action(s, msg).then(() => publicState(s));
  }
});

// Firefox stops this page when it's idle and everything in `tabs` is lost, while the frames keep
// showing their subtitles. Pick up from what a frame says it's showing; nothing is downloaded.
async function adopt(s, state, frameId, url) {
  const m = state.meta;
  s.frameId = frameId;
  s.url = url;
  s.video = { hasVideo: true, playing: state.playing, played: state.played, duration: state.duration, area: state.area, size: state.size, url: state.url, top: state.top };
  s.timing = state;
  s.key = s.loadedKey = m?.key ?? null;
  s.ident = m?.ident ?? s.ident;
  setStatus(s, "showing", "");
  const match = m?.key ? await store.get(`match:${m.key}`) : null;
  if (match?.candidates?.length) { s.candidates = match.candidates; s.chosen = match.chosen; }
  pushBarState(s);
}

// The popup opened before any frame reported in: ask them.
async function findLoaded(s) {
  const frames = await browser.webNavigation.getAllFrames({ tabId: s.tabId }).catch(() => null);
  for (const f of frames || []) {
    const state = await browser.tabs.sendMessage(s.tabId, { type: "probe" }, { frameId: f.frameId }).catch(() => null);
    if (s.frameId !== null) return;
    if (state?.loaded) return adopt(s, state, f.frameId, (await browser.tabs.get(s.tabId)).url);
  }
}

// A frame reports its main video. Switch to it if it's the one we follow, or if it's a better
// main video than the one we follow now, judged by asking that frame afresh: a site that swaps
// in a new player for the next episode leaves the old one gone or stopped.
async function onVideo(s, msg, sender) {
  const i = msg.info;
  let better = s.frameId === null || s.frameId === sender.frameId || !s.video;
  if (!better) {
    const cur = await browser.tabs.sendMessage(s.tabId, { type: "video-info" }, { frameId: s.frameId }).catch(() => null);
    const area = i.area || 0, curArea = cur?.area || 0;
    if (!cur?.hasVideo) better = true;
    else if (!i.playing) better = !cur.playing && area > curArea * 1.2;
    else if (!cur.playing) better = area >= curArea * 0.5;
    else if (!i.muted !== !cur.muted) better = !i.muted && area >= curArea * 0.5;
    else better = area > curArea * 1.2;
  }
  if (!better) return;
  const newFrame = s.frameId !== null && s.frameId !== sender.frameId;
  const fresh = msg.mediaChanged || newFrame || s.frameReloaded;
  const changed = fresh || s.url !== sender.tab.url || Math.abs((s.video?.duration || 0) - (i.duration || 0)) > 2;
  // something new started where subtitles were showing: remember what that was, so a run that
  // finds the page still naming the same episode can tell (see run)
  if (fresh && s.loadedKey) s.previous = { key: s.loadedKey, duration: s.video?.duration ?? null };
  s.frameReloaded = false;
  s.frameId = sender.frameId;
  s.video = i;
  s.url = sender.tab.url;
  // a new video in the same place: give the site a moment to update its address and title first
  if (changed || s.status === "idle") scheduleRun(s.tabId, fresh ? 2500 : 700);
}

async function persistTiming(s) {
  const t = s.timing;
  if (!t?.meta || !s.key) return;
  if (t.sync?.state === "locked" || t.manualMode || t.manual) {
    const saved = { segments: t.segments, scale: t.scale, verified: t.sync?.verified || false, manual: t.manual, manualMode: !!t.manual };
    const key = `sync:${t.meta.key}:${t.meta.provider}:${t.meta.id}`, text = JSON.stringify([key, saved]);
    if (text === s.lastSaved) return; // frames report often; only a change is worth writing
    s.lastSaved = text;
    await store.put(key, saved);
  }
}

async function action(s, msg) {
  const settings = await store.getSettings();
  switch (msg.action) {
    case "nudge": return toFrame(s, { type: "nudge", ms: msg.ms }).catch(() => {});
    case "resume-auto": // also forgets the saved timing for this subtitle: the frame first, so
    case "reset": {     // nothing it reports on the old timing can write it back afterwards
      const m = s.timing?.meta;
      const res = await toFrame(s, { type: msg.action }).catch(() => {});
      if (m) await store.remove(`sync:${m.key}:${m.provider}:${m.id}`);
      s.lastSaved = null;
      return res;
    }
    case "enable": return toFrame(s, { type: "enable", enabled: msg.enabled }).catch(() => {});
    case "font": {
      const fontSize = Math.min(250, Math.max(50, (msg.size ?? settings.fontSize + (msg.delta || 0))));
      await store.setSettings({ fontSize });
      await applyFont(s, fontSize);
      return pushBarState(s);
    }
    case "position": {
      const position = Math.min(95, Math.max(5, (msg.value ?? settings.position + (msg.delta || 0))));
      await store.setSettings({ position });
      await toFrame(s, { type: "style", position }).catch(() => {});
      return pushBarState(s);
    }
    case "bar-text": await store.setSettings({ barText: msg.on }); return pushBarState(s);
    case "bar-opened": s.barOpen = true; return pushBarState(s);
    case "bar-closed": s.barOpen = false; return;
    case "tracking":
      await store.setSettings({ audioTrack: msg.enabled });
      return toFrame(s, { type: "tracking", enabled: msg.enabled }).catch(() => {});
    case "auto-sync":
      await store.setSettings({ audioSync: msg.enabled });
      return toFrame(s, { type: "auto-sync", enabled: msg.enabled }).catch(() => {});
    case "language":
      await store.setSettings({ language: msg.language });
      return run(s.tabId);
    case "next-candidate":
      if (!s.candidates.length) return;
      s.rejected = [];
      return tryCandidates(s, (s.chosen + 1) % s.candidates.length);
    case "choose": {
      s.rejected = [];
      const c = s.candidates[msg.index];
      if (!c) return;
      try { const cues = await getCues(c); await load(s, msg.index, cues); }
      catch (err) { setStatus(s, "error", err.message); }
      return;
    }
    case "confirm": { // user confirmed or corrected the identification
      const ident = { ...msg.ident, confidence: "high" };
      await store.put(`page:${s.url}`, { ident });
      return run(s.tabId, { force: true });
    }
    case "retry": return run(s.tabId, { force: true });
    case "load-file": { // a subtitle file the user picked from disk: loaded as-is (their choice)
      const c = { provider: "file", id: `f${Date.now()}`, release: msg.name, fileName: msg.name, language: settings.language,
        downloads: 0, files: 1, hearingImpaired: false, machine: false, trusted: true, feature: {} };
      await store.put(`sub:file:${c.id}`, { cues: msg.cues });
      s.candidates = [c, ...s.candidates.filter((x) => x.provider !== "file")];
      s.key = s.key || `file:${msg.name}`;
      s.rejected = [];
      return load(s, 0, msg.cues);
    }
    case "unload":
      await toFrame(s, { type: "unload" }).catch(() => {});
      s.chosen = -1;
      s.loadedKey = null;
      return setStatus(s, "ready", "Subtitles removed.");
  }
}

browser.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
browser.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) {
    const s = tabs.get(d.tabId);
    if (s) { s.runId++; tabs.delete(d.tabId); browser.action.setBadgeText({ tabId: d.tabId, text: "" }).catch(() => {}); }
  } else {
    // the player frame loaded a new page: its subtitles are gone, so load again when it reports a video
    const s = tabs.get(d.tabId);
    if (s && s.frameId === d.frameId) { s.frameReloaded = true; s.timing = null; }
  }
});

// Sites that switch episodes without loading a new page change the address (history API or
// #fragment) or the title: look again. A recheck reloads nothing if it's still the same episode.
const lookAgain = (d) => { if (tabs.get(d.tabId)?.video) scheduleRun(d.tabId, 1500, { recheck: true }); };
browser.webNavigation.onHistoryStateUpdated.addListener(lookAgain);
browser.webNavigation.onReferenceFragmentUpdated.addListener(lookAgain);
browser.tabs.onUpdated.addListener((tabId) => lookAgain({ tabId }), { properties: ["title"] });

// keyboard shortcuts (Alt+Shift+G / Alt+Shift+H)
browser.commands.onCommand.addListener(async (command) => {
  const ms = { earlier: -100, later: 100 }[command];
  if (!ms) return;
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  const s = tab && tabs.get(tab.id);
  if (s?.frameId != null) toFrame(s, { type: "nudge", ms }).catch(() => {});
});
