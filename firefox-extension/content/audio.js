// Listen to a video's audio to measure loudness over media time, for automatic sync.
//
// Firefox only lets a page analyse a video's sound by routing it through Web Audio
// (createMediaElementSource). That routing can't be undone for that video, and if the
// media is protected (DRM) or comes from another site without permission, the routed
// sound is SILENCE, which would mute the video. So before touching anything this checks:
//   - no DRM (video.mediaKeys is null)
//   - the media is readable: same-site address, a blob: stream built by the page (MSE),
//     or fetched with CORS (crossOrigin set)
//   - the page isn't already using Web Audio on this video
//   - an AudioContext can actually run here (autoplay rules)
// The sound keeps playing through the same path; volume and mute still apply.
(() => {
  const ns = (globalThis.__subsync ??= {});

  function audioSafety(video) {
    if (video.mediaKeys) return { ok: false, reason: "protected video (DRM)" };
    const src = video.currentSrc || video.src || "";
    if (!src) return { ok: false, reason: "no video source yet" };
    let origin;
    try { origin = new URL(src, location.href); } catch { return { ok: false, reason: "unreadable video address" }; }
    const readable = origin.protocol === "blob:" || origin.origin === location.origin || (video.crossOrigin != null && video.crossOrigin !== "");
    // already routed: that can't be undone, so its sound may now be silent, and only a reload restores it
    if (!readable && video.__subsyncTap) return { ok: false, reason: "this video switched to a source from another site. Its sound can't be protected: if it goes silent, reload the page" };
    if (!readable) return { ok: false, reason: "video comes from another site without permission to analyse its sound" };
    return { ok: true };
  }

  // onLevel(mediaStartMs, mediaEndMs, db) is called for every ~21 ms of played audio.
  // A video's sound can only be routed once, and setting that up takes a moment: callers
  // arriving meanwhile share the one attempt.
  const settingUp = new WeakMap();
  async function tap(video, onLevel) {
    const safe = audioSafety(video);
    if (!safe.ok) return safe;
    if (!video.__subsyncTap) {
      if (!settingUp.has(video)) settingUp.set(video, setUp(video).finally(() => settingUp.delete(video)));
      const res = await settingUp.get(video);
      if (!res.ok) return res;
    }
    const { listeners } = video.__subsyncTap;
    listeners.add(onLevel);
    return { ok: true, stop: () => listeners.delete(onLevel) };
  }

  async function setUp(video) {
    let ctx;
    try {
      ctx = new AudioContext();
      // Firefox only starts audio analysis after a click in this page; until then resume()
      // never settles, so don't wait for it forever.
      if (ctx.state !== "running") await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
      if (ctx.state !== "running") { ctx.close(); return { ok: false, needsClick: true, reason: "click the video once to allow audio sync" }; }
    } catch (err) {
      return { ok: false, reason: `audio analysis unavailable (${err.message})` };
    }
    let source;
    try {
      source = ctx.createMediaElementSource(video);
    } catch (err) {
      ctx.close();
      return { ok: false, reason: "the site already processes this video's sound" };
    }
    source.connect(ctx.destination); // keep the sound playing exactly as before

    // analysis branch: voice band only, then measure loudness
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 250;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3500;
    const proc = ctx.createScriptProcessor(1024, 1, 1);
    const sink = ctx.createGain(); sink.gain.value = 0;
    source.connect(hp); hp.connect(lp); lp.connect(proc); proc.connect(sink); sink.connect(ctx.destination);

    const listeners = new Set();
    // Media-time clock for the audio blocks. video.currentTime only updates in coarse steps,
    // so stamping each 21 ms block with it piles blocks onto the same time. Instead advance by
    // each block's exact length and steer gently toward currentTime; jump only on a seek.
    let clock = null;
    proc.onaudioprocess = (ev) => {
      const playing = !video.paused && !video.seeking && video.readyState >= 3 && video.playbackRate > 0;
      const now = video.currentTime * 1000;
      if (!playing) { clock = null; return; }
      const data = ev.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const db = 10 * Math.log10(sum / data.length + 1e-12);
      const span = (data.length / ctx.sampleRate) * 1000 * video.playbackRate;
      if (clock === null || Math.abs(now - (clock + span)) > 300) {
        clock = now; // start, or a seek/stall: re-anchor and skip this block
        return;
      }
      clock += span;
      clock += (now - clock) * 0.02;
      for (const fn of listeners) fn(clock - span, clock, db);
    };
    video.__subsyncTap = { ctx, listeners };
    return { ok: true };
  }

  ns.audioSafety = audioSafety;
  ns.tapAudio = tap;
})();
