// Toolbar popup: shows what the background found for this tab, and sends user actions.
import * as store from "./lib/store.js";
import { displayTitle } from "./lib/identify.js";
import { decodeSubtitleBytes, parseSubtitles } from "./lib/subparse.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const fmt = (ms) => `${ms < 0 ? "−" : "+"}${(Math.abs(ms || 0) / 1000).toFixed(2)} s`;
const LANGS = [["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
  ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["tr", "Turkish"], ["ar", "Arabic"], ["he", "Hebrew"], ["zh", "Chinese"],
  ["ja", "Japanese"], ["ko", "Korean"], ["sv", "Swedish"], ["no", "Norwegian"], ["da", "Danish"], ["fi", "Finnish"], ["el", "Greek"],
  ["cs", "Czech"], ["hu", "Hungarian"], ["ro", "Romanian"], ["vi", "Vietnamese"], ["id", "Indonesian"], ["hi", "Hindi"]];
const SETTINGS = ["apiKey", "username", "password", "autoLoad", "audioSync", "audioTrack", "preferHearingImpaired", "apiBase"];

let tabId = null;
let state = null;

async function findTab() {
  if (params.get("tab")) return browser.tabs.get(Number(params.get("tab")));
  if (params.get("target")) return (await browser.tabs.query({})).find((t) => t.url.includes(params.get("target")));
  return (await browser.tabs.query({ active: true, currentWindow: true }))[0];
}

const ask = (msg) => browser.runtime.sendMessage({ tabId, ...msg });
const act = async (action, extra = {}) => { state = await ask({ type: "action", action, ...extra }); render(); };

function describe(id) {
  const name = displayTitle(id);
  if (!id?.kind || !name) return "Nothing identified yet";
  return id.kind === "episode" ? `${name} · S${String(id.season).padStart(2, "0")}E${String(id.episode).padStart(2, "0")}` : `${name}${id.year ? ` (${id.year})` : ""}`;
}

function render() {
  const s = state || {};
  const busy = ["identifying", "searching", "downloading", "waiting-main"].includes(s.status);
  $("status-dot").className = s.status === "showing" ? "ok" : ["error", "not-found"].includes(s.status) ? "bad" : busy ? "busy" : "";
  $("status-text").textContent = {
    idle: "waiting for a video", identifying: "identifying…", searching: "searching…", downloading: "downloading…",
    showing: "showing subtitles", "needs-confirm": "needs your confirmation", uncertain: "needs your choice",
    "waiting-main": "waiting for the main video", "not-found": "no subtitles found", error: "problem", ready: "ready",
  }[s.status] || "";

  $("ident").textContent = describe(s.ident);
  $("evidence").textContent = s.ident?.evidence?.length ? `from ${[...new Set(s.ident.evidence)].join(", ")}${s.ident.confidence ? ` · ${s.ident.confidence} confidence` : ""}` : "";
  if (s.status === "needs-confirm" && $("ident-form").hidden) openForm();

  $("message").hidden = !s.message;
  $("message").textContent = s.message || "";
  if (!s.hasKey && s.status !== "showing") {
    $("message").hidden = false;
    $("message").textContent = `${s.message ? `${s.message} ` : ""}To download subtitles automatically, add your free OpenSubtitles API key in Settings below.`;
  }

  $("controls").hidden = !s.loaded;
  $("btn-onoff").textContent = s.enabled ? "On" : "Off";
  $("offset").textContent = fmt(s.offset);
  const secs = (Math.abs(s.offset || 0) / 1000).toFixed(2);
  $("offset-words").textContent = `${Math.abs(s.offset || 0) < 5 ? "Subtitles at the file's own timing"
    : `Subtitles shown ${secs} s ${s.offset > 0 ? "later" : "earlier"} than the file says`} · − = earlier, + = later`;
  const sync = s.sync || {};
  const heard = sync.heard ? ` ${sync.heard >= 60 ? `${Math.floor(sync.heard / 60)} min ${sync.heard % 60} s` : `${sync.heard} s`} heard so far;` : "";
  $("sync-text").textContent = {
    locked: `✓ Synced to the audio${tracked(s, sync)}`,
    listening: `Listening to the audio to sync…${heard} usually needs 1–4 minutes of talking`,
    manual: "Manual timing",
    unavailable: `No audio sync: ${sync.reason}`,
    unsure: `Audio sync unsure: ${sync.reason}. Still listening; or set it by hand with − / +.`,
    off: "Audio sync off",
  }[sync.state] || "";
  $("tracking").checked = !!s.tracking;
  $("display-note").hidden = s.display !== "overlay";
  $("btn-auto").hidden = !(sync.state === "manual" || sync.state === "off");
  $("font").textContent = `${s.fontSize || 100}%`;

  $("subs").hidden = !(s.candidates || []).length;
  $("language").value = s.language || "en";
  const rejected = new Map((s.rejected || []).map((r) => [r.i, r.reason]));
  $("candidates").replaceChildren(...(s.candidates || []).map((c) => {
    const li = document.createElement("li");
    li.className = c.chosen ? "chosen" : "";
    const name = document.createElement("div");
    name.textContent = `${c.chosen ? "● " : ""}${c.release || "(unnamed release)"}`;
    const detail = document.createElement("div");
    detail.className = "muted small";
    detail.textContent = ["OpenSubtitles", c.downloads ? `${c.downloads} downloads` : "",
      c.hearingImpaired ? "SDH" : "", rejected.has(c.i) ? `skipped: ${rejected.get(c.i)}` : ""].filter(Boolean).join(" · ");
    li.append(name, detail);
    li.onclick = () => act("choose", { index: c.i });
    return li;
  }));
}

// "tracking · slipping +0.12 s/min · last fix 20 s ago · your shift +0.50 s"
function tracked(s, sync) {
  const parts = [];
  if (s.tracking) {
    parts.push("tracking");
    const perMin = (sync.drift || 0) * 60;
    if (Math.abs(perMin) >= 0.01) parts.push(`slipping ${perMin > 0 ? "+" : "−"}${Math.abs(perMin).toFixed(2)} s/min`);
    if (sync.lastFix) parts.push(`last fix ${Math.max(0, Math.round((Date.now() - sync.lastFix) / 1000))} s ago`);
  }
  if (s.manual) parts.push(`your shift ${fmt(s.manual)}`);
  return parts.length ? `, ${parts.join(" · ")}` : "";
}

function openForm() {
  const id = state?.ident || {};
  $("ident-form").hidden = false;
  $("f-kind").value = id.kind || "episode";
  $("f-title").value = id.title || id.resolvedTitle || "";
  $("f-season").value = id.season ?? "";
  $("f-episode").value = id.episode ?? "";
  $("f-year").value = id.year ?? "";
  toggleKind();
}

function toggleKind() {
  const ep = $("f-kind").value === "episode";
  for (const el of document.querySelectorAll(".ep")) el.hidden = !ep;
  for (const el of document.querySelectorAll(".mv")) el.hidden = ep;
  $("f-season").required = $("f-episode").required = ep;
}

async function init() {
  const tab = await findTab();
  tabId = tab?.id;
  $("language").replaceChildren(...LANGS.map(([v, l]) => Object.assign(document.createElement("option"), { value: v, textContent: l })));
  const settings = await store.getSettings();
  for (const k of SETTINGS) {
    const el = $(`s-${k}`);
    if (el.type === "checkbox") el.checked = !!settings[k]; else el.value = settings[k] ?? "";
  }
  if (!settings.apiKey && !params.get("file")) $("settings").open = true;
  if (params.get("file")) { // the small file-picking window: only the picker
    for (const el of document.querySelectorAll("section, details")) el.hidden = el.id !== "file-row" && el.id !== "message";
  }
  if (tabId == null) return;
  state = await ask({ type: "get-state" });
  render();
  setInterval(async () => { state = await ask({ type: "get-state" }); render(); }, 1000);
}

$("btn-edit").onclick = () => ($("ident-form").hidden ? openForm() : ($("ident-form").hidden = true));
$("f-kind").onchange = toggleKind;
$("ident-form").onsubmit = (e) => {
  e.preventDefault();
  const kind = $("f-kind").value;
  const ident = { kind, title: $("f-title").value.trim() };
  if (kind === "episode") Object.assign(ident, { season: Number($("f-season").value), episode: Number($("f-episode").value) });
  else ident.year = $("f-year").value ? Number($("f-year").value) : null;
  $("ident-form").hidden = true;
  act("confirm", { ident });
};
for (const b of document.querySelectorAll("[data-nudge]")) b.onclick = () => act("nudge", { ms: Number(b.dataset.nudge) });
$("btn-onoff").onclick = () => act("enable", { enabled: !state?.enabled });
$("btn-auto").onclick = () => act("resume-auto");
$("btn-reset").onclick = () => act("reset");
$("tracking").onchange = () => { $("s-audioTrack").checked = $("tracking").checked; act("tracking", { enabled: $("tracking").checked }); };
$("btn-font-down").onclick = () => act("font", { delta: -10 });
$("btn-font-up").onclick = () => act("font", { delta: 10 });
$("btn-pos-up").onclick = () => act("position", { delta: -5 });
$("btn-pos-down").onclick = () => act("position", { delta: 5 });
$("language").onchange = () => act("language", { language: $("language").value });

// Firefox closes a toolbar popup when a file picker opens, so pick files in a small window.
$("btn-file").onclick = async () => {
  if (params.get("file")) return $("file").click();
  await browser.windows.create({ url: `popup.html?tab=${tabId}&file=1`, type: "popup", width: 420, height: 220 });
  window.close();
};
$("file").onchange = async () => {
  const f = $("file").files[0];
  if (!f) return;
  const cues = parseSubtitles(decodeSubtitleBytes(await f.arrayBuffer()), f.name);
  if (!cues.length) { $("message").hidden = false; $("message").textContent = "That file has no readable subtitle lines."; return; }
  await act("load-file", { name: f.name, cues });
  if (params.get("file")) window.close();
};

$("btn-save-settings").onclick = async () => {
  const patch = {};
  for (const k of SETTINGS) {
    const el = $(`s-${k}`);
    patch[k] = el.type === "checkbox" ? el.checked : el.value.trim().replace(/\/+$/, "");
  }
  const before = await store.getSettings();
  await store.setSettings(patch);
  if (patch.username !== before.username || patch.password !== before.password) await store.remove("os-token");
  $("settings").open = false;
  if (tabId != null) act("retry");
};

init();
