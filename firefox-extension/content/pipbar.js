// Top-level page only: a small "CC bar" button, and the always-on-top subtitle bar it opens
// (Document Picture-in-Picture). The bar shows the current subtitle line, so subtitles stay
// visible even where Firefox's own PiP window shows the site's captions instead, and holds
// collapsible controls: on/off, timing, size, position, language, other subtitle versions.
// Firefox only allows opening it from a click in this top-level page (not from inside an
// embedded player), hence the button. Styles are set through element.style so a site's
// Content-Security-Policy can't block them.
(() => {
  if (window !== window.top || window.__subsyncBarLoaded) return;
  window.__subsyncBarLoaded = true;

  const ACCENT = "#e5484d";
  let state = null;          // tab state from the background script
  let cueText = "";
  let bar = null;            // {win, text, panel, ...} while the bar is open
  let pill = null, pillTimer = null;

  const css = (el, styles) => { Object.assign(el.style, styles); return el; };
  const send = (action, extra = {}) => browser.runtime.sendMessage({ type: "action", action, ...extra }).catch(() => {});
  const fmt = (ms) => `${ms < 0 ? "−" : "+"}${(Math.abs(ms || 0) / 1000).toFixed(2)} s`;

  function button(doc, label, title, onClick) {
    const b = css(doc.createElement("button"), {
      font: "12px system-ui, sans-serif", color: "#e6e6e6", background: "#24262b", border: "1px solid #3a3d44",
      borderRadius: "5px", padding: "2px 7px", cursor: "pointer", margin: "0",
    });
    b.textContent = label;
    b.title = title;
    b.addEventListener("mouseenter", () => css(b, { color: ACCENT, borderColor: ACCENT }));
    b.addEventListener("mouseleave", () => css(b, { color: "#e6e6e6", borderColor: "#3a3d44" }));
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  // ---- the page button ------------------------------------------------------------------

  function showPill() {
    if (!state?.loaded || bar) return hidePill();
    if (!pill) {
      pill = css(document.createElement("div"), {
        position: "fixed", right: "14px", bottom: "14px", zIndex: "2147483647", transition: "opacity .3s",
      });
      const b = button(document, "CC ⧉ subtitle bar", "Open an always-on-top subtitle bar with controls (works alongside picture-in-picture)", openBar);
      css(b, { font: "13px system-ui, sans-serif", padding: "5px 10px", background: "rgba(20,21,24,.9)" });
      pill.append(b);
      (document.body || document.documentElement).append(pill);
    }
    css(pill, { opacity: "1", pointerEvents: "auto" });
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => pill && css(pill, { opacity: "0", pointerEvents: "none" }), 3500);
  }

  function hidePill() {
    if (pill) { pill.remove(); pill = null; }
  }

  document.addEventListener("mousemove", () => { if (state?.loaded && !bar) showPill(); }, { passive: true });
  document.addEventListener("fullscreenchange", () => { if (document.fullscreenElement) hidePill(); });

  // ---- the bar ----------------------------------------------------------------------------

  async function openBar() {
    if (bar) return;
    if (!("documentPictureInPicture" in window)) {
      return alert("This browser can't open an always-on-top window. Use the browser's picture-in-picture: the subtitles are drawn on the video there.");
    }
    let win;
    try {
      win = await documentPictureInPicture.requestWindow({ width: 680, height: 120 });
    } catch (err) {
      return alert(`subtitle-sync couldn't open the subtitle bar: ${err.message}`);
    }
    hidePill();
    const doc = win.document;
    css(doc.body, { margin: "0", background: "#000", color: "#fff", overflow: "hidden", font: "14px system-ui, sans-serif", height: "100vh", display: "flex", flexDirection: "column" });
    const text = css(doc.createElement("div"), {
      flex: "1 1 0", minHeight: "0", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
      textAlign: "center", padding: "6px 14px", whiteSpace: "pre-line", lineHeight: "1.25", textShadow: "0 1px 2px #000",
    });
    const panel = css(doc.createElement("div"), {
      order: "-1", display: "none", flex: "0 0 auto", flexWrap: "wrap", gap: "4px",
      alignItems: "center", padding: "4px 6px", background: "rgb(26,27,30)",
    });
    const status = css(doc.createElement("span"), { color: "#8b8f98", fontSize: "11px", marginLeft: "4px" });
    const lang = css(doc.createElement("select"), { font: "12px system-ui", background: "#24262b", color: "#e6e6e6", border: "1px solid #3a3d44", borderRadius: "5px" });
    for (const [code, name] of LANGS) {
      const o = doc.createElement("option");
      o.value = code; o.textContent = name;
      lang.append(o);
    }
    lang.addEventListener("change", () => send("language", { language: lang.value }));
    const onoff = button(doc, "On", "Show / hide subtitles", () => send("enable", { enabled: !state?.enabled }));
    const textToggle = button(doc, "Text here", "Show the subtitle text in this bar (turn off if the video's PiP already shows it)", () => send("bar-text", { on: !state?.barText }));
    panel.append(
      onoff,
      button(doc, "−0.5", "Subtitles 0.5 s earlier", () => send("nudge", { ms: -500 })),
      button(doc, "−0.1", "Subtitles 0.1 s earlier", () => send("nudge", { ms: -100 })),
      button(doc, "+0.1", "Subtitles 0.1 s later", () => send("nudge", { ms: 100 })),
      button(doc, "+0.5", "Subtitles 0.5 s later", () => send("nudge", { ms: 500 })),
      button(doc, "Auto", "Let audio sync set the timing again", () => send("resume-auto")),
      button(doc, "Reset", "Undo all timing changes: back to the subtitle file's own timing", () => send("reset")),
      button(doc, "A−", "Smaller text", () => send("font", { delta: -10 })),
      button(doc, "A+", "Larger text", () => send("font", { delta: 10 })),
      button(doc, "▲", "Move subtitles up (on the video)", () => send("position", { delta: -5 })),
      button(doc, "▼", "Move subtitles down (on the video)", () => send("position", { delta: 5 })),
      textToggle,
      lang,
      button(doc, "Other version ▸", "Try the next best matching subtitle file", () => send("next-candidate")),
      status,
    );
    doc.body.append(text, panel);

    // controls appear while the pointer is over the bar, then collapse. They take their own space, above
    // the line, which shrinks to fit what's left (see fitText).
    let hideTimer = null;
    const reveal = () => {
      if (panel.style.display === "none") { css(panel, { display: "flex" }); fitText(); }
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { css(panel, { display: "none" }); fitText(); }, 2500);
    };
    win.addEventListener("resize", fitText);
    doc.addEventListener("mousemove", reveal);
    doc.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (k === "g") send("nudge", { ms: e.shiftKey ? -1000 : -100 });
      if (k === "h") send("nudge", { ms: e.shiftKey ? 1000 : 100 });
    });

    bar = { win, doc, text, panel, status, onoff, textToggle, lang };
    win.addEventListener("pagehide", () => { bar = null; send("bar-closed"); });
    send("bar-opened");
    render();
  }

  // The chosen text size, or smaller if the line wouldn't fit in the space it has now.
  function fitText() {
    if (!bar) return;
    let size = Math.round(22 * (state?.fontSize || 100) / 100);
    css(bar.text, { fontSize: `${size}px` });
    while (size > 12 && bar.text.scrollHeight > bar.text.clientHeight) {
      size -= 2;
      css(bar.text, { fontSize: `${size}px` });
    }
  }

  function render() {
    if (!bar) return;
    const s = state || {};
    bar.text.textContent = s.barText === false ? "" : (s.enabled === false ? "" : cueText);
    if (s.barText === false) bar.text.textContent = "";
    bar.onoff.textContent = s.enabled === false ? "Off" : "On";
    bar.textToggle.textContent = s.barText === false ? "Text: off" : "Text: on";
    if (s.language) bar.lang.value = s.language;
    const sync = s.sync || {};
    const syncText = { locked: s.tracking ? "synced to audio, tracking" : "synced to audio", listening: `listening to audio…${sync.heard ? ` (${sync.heard} s heard)` : ""}`, manual: "manual timing", unavailable: "no audio sync", unsure: "audio didn't match", off: "auto-sync off" }[sync.state] || "";
    fitText();
    bar.status.textContent = s.loaded ? `${s.label || ""} · ${fmt(s.offset)} · ${syncText}` : (s.message || "no subtitles loaded");
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "bar-state") {
      state = msg.state;
      if (!state?.loaded) { hidePill(); cueText = ""; }
      render();
    } else if (msg.type === "bar-cue") {
      cueText = msg.text || "";
      render();
    } else if (msg.type === "bar-open-status") {
      return Promise.resolve({ open: !!bar });
    }
  });

  const LANGS = [["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
    ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["tr", "Turkish"], ["ar", "Arabic"], ["he", "Hebrew"], ["zh", "Chinese"],
    ["ja", "Japanese"], ["ko", "Korean"], ["sv", "Swedish"], ["no", "Norwegian"], ["da", "Danish"], ["fi", "Finnish"], ["el", "Greek"],
    ["cs", "Czech"], ["hu", "Hungarian"], ["ro", "Romanian"], ["vi", "Vietnamese"], ["id", "Indonesian"], ["hi", "Hindi"]];
  globalThis.__subsync = globalThis.__subsync || {};
  globalThis.__subsync.LANGS = LANGS;
})();
