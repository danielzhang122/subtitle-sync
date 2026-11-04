// Audio-based timing estimator (no browser APIs: testable on its own).
//
// The audio tap reports loudness (dB) for stretches of *media time* while the video plays.
// Speech is told apart from music and effects by comparing each moment with its surroundings:
//   speech(t) = loudness at t minus the typical (median) loudness of the ~10 s around t
// (one fixed level for the whole window fails on real films: a loud music scene looks like
// talking all the way through). For every candidate shift d of the subtitles the score is the
// average of speech(t) over the time a line is on screen. The best d is trusted only if it stands
// out from every alternative more than 0.5 s away, measured in standard deviations of all the
// scores ("margin").
(() => {
  const ns = (globalThis.__subsync ??= {});

  const BIN = 20;     // ms per slice
  const LOCAL = 50;   // slices per second: local loudness is judged per second...
  const AROUND = 5;   // ...against the 5 s on each side
  const FAR = 25;     // slices (0.5 s): "a different answer"
  const PEAK = 10;    // slices (0.2 s): a peak is the highest score within this distance
  const EDGE = 15;    // slices (0.3 s) compared before and after each line's start...
  const EDGE_WEIGHT = 0.15; // ...and how much that counts next to the on-screen average (0.1-0.2 tested best;
                            // 0.3 drifted on a film whose subtitle times are rounded to 0.5 s)

  const PRESET_RATIOS = [25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25, 24 / 23.976, 23.976 / 24];

  const median = (arr) => {
    if (!arr.length) return NaN;
    const x = [...arr].sort((p, q) => p - q);
    return x[x.length >> 1];
  };

  class SyncEstimator {
    constructor() {
      this.energy = new Float32Array(0); // dB per slice of media time; NaN = not heard
      this.cues = [];
      this.edgeWeight = EDGE_WEIGHT;
    }

    // on-screen stretches, merged where lines overlap (so no time counts twice)
    setCues(cues, isSoundOnly) {
      const kept = cues.filter((c) => !isSoundOnly(c.text)).map((c) => [c.start, c.end]).sort((p, q) => p[0] - q[0]);
      this.cues = [];
      for (const [s, e] of kept) {
        const last = this.cues[this.cues.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], e);
        else this.cues.push([s, e]);
      }
    }

    reset() { this.energy = new Float32Array(0); }

    _grow(n) {
      if (n <= this.energy.length) return;
      const next = new Float32Array(Math.max(n, this.energy.length * 2, 30000)).fill(NaN);
      next.set(this.energy);
      this.energy = next;
    }

    // Loudness `db` heard over media time [t0, t1) ms.
    addAudio(t0, t1, db) {
      if (!(t1 > t0) || !Number.isFinite(db)) return;
      const a = Math.floor(t0 / BIN), b = Math.max(a + 1, Math.floor(t1 / BIN));
      this._grow(b + 1);
      for (let i = a; i < b; i++) this.energy[i] = Number.isNaN(this.energy[i]) ? db : Math.max(this.energy[i], db);
    }

    // Erase what was heard in [t0, t1) (e.g. after a seek mid-block).
    forget(t0, t1) {
      const a = Math.max(0, Math.floor(t0 / BIN)), b = Math.min(this.energy.length, Math.ceil(t1 / BIN));
      this.energy.fill(NaN, a, b);
    }

    observedMs(t0, t1) {
      let n = 0;
      const a = Math.max(0, Math.floor(t0 / BIN)), b = Math.min(this.energy.length, Math.ceil(t1 / BIN));
      for (let i = a; i < b; i++) if (!Number.isNaN(this.energy[i])) n++;
      return n * BIN;
    }

    // speech(t) for slices [a, b): loudness above the local median, clipped to [-10, +15] dB,
    // 0 where not heard; centred so heard slices average 0. null if nothing stands out.
    _speech(a, b) {
      const e = this.energy;
      const nBlocks = Math.ceil((b - a) / LOCAL);
      const blockMed = new Float32Array(nBlocks);
      for (let k = 0; k < nBlocks; k++) {
        const vals = [];
        for (let i = a + k * LOCAL; i < Math.min(b, a + (k + 1) * LOCAL); i++) if (!Number.isNaN(e[i])) vals.push(e[i]);
        blockMed[k] = median(vals);
      }
      const base = new Float32Array(nBlocks);
      for (let k = 0; k < nBlocks; k++) {
        const vals = [];
        for (let j = Math.max(0, k - AROUND); j <= Math.min(nBlocks - 1, k + AROUND); j++) if (!Number.isNaN(blockMed[j])) vals.push(blockMed[j]);
        base[k] = median(vals);
      }
      const n = b - a, f = new Float32Array(n), heard = new Uint8Array(n);
      let sum = 0, count = 0;
      const seen = [];
      for (let i = 0; i < n; i++) {
        const v = e[a + i], bl = base[Math.floor(i / LOCAL)];
        if (Number.isNaN(v) || Number.isNaN(bl)) continue;
        f[i] = Math.min(15, Math.max(-10, v - bl));
        heard[i] = 1; sum += f[i]; count++;
        if (i % 5 === 0) seen.push(f[i]);
      }
      if (count < 50 || seen.length < 10) return null;
      // louder and quieter moments must differ clearly (talking vs pauses), or there's nothing to match
      seen.sort((p, q) => p - q);
      if (seen[Math.floor(seen.length * 0.9)] - seen[Math.floor(seen.length * 0.1)] < 6) return null;
      const mean = sum / count;
      for (let i = 0; i < n; i++) if (heard[i]) f[i] -= mean;
      return f;
    }

    // Best offset (ms) in [center - range, center + range] using media time [w0, w1).
    // scale: subtitle times are multiplied by this first (frame-rate fix).
    estimate({ w0, w1, center = 0, range = 60000, scale = 1 }) {
      let a = Math.max(0, Math.floor(w0 / BIN)), b = Math.min(this.energy.length, Math.ceil(w1 / BIN));
      // only the stretch actually listened to: unheard time before/after it says nothing
      while (a < b && Number.isNaN(this.energy[a])) a++;
      while (b > a && Number.isNaN(this.energy[b - 1])) b--;
      const heardMs = this.observedMs(w0, w1);
      if (b - a < 100) return { ok: false, reason: "not enough audio yet", heardMs };
      const f = this._speech(a, b);
      if (!f) return { ok: false, reason: "no speech heard yet", heardMs };
      const n = b - a;
      const F = new Float64Array(n + 1); // running total of speech(t): any stretch's sum in one step
      for (let i = 0; i < n; i++) F[i + 1] = F[i] + f[i];
      const R = Math.round(range / BIN), C = Math.round(center / BIN);
      // lines that land in the window for some shift we try (subtitle-time slices)
      const lo = a - C - R, hi = b - C + R;
      const lines = [];
      let inRange = 0;
      for (const [s, e] of this.cues) {
        const sa = Math.round((s * scale) / BIN), sb = Math.round((e * scale) / BIN);
        if (sb <= lo || sa >= hi) continue;
        lines.push(sa, sb);
        inRange += Math.min(sb, hi) - Math.max(sa, lo);
      }
      // the on-screen time a window this long normally holds around here: a shift that pushes
      // most lines out of the window (leaving a few lucky ones) isn't considered
      const expected = (inRange * n) / (hi - lo);
      const K = 2 * R + 1;
      const scores = new Float32Array(K).fill(NaN), counts = new Int32Array(K);
      for (let k = 0; k < K; k++) {
        const d = C - R + k; // media slice = subtitle slice + d
        let s = 0, on = 0, cnt = 0, edge = 0, edges = 0;
        for (let j = 0; j < lines.length; j += 2) {
          const x0 = Math.max(lines[j] + d, a), x1 = Math.min(lines[j + 1] + d, b);
          if (x1 <= x0) continue;
          s += F[x1 - a] - F[x0 - a];
          on += x1 - x0;
          const x = lines[j] + d;
          if (x >= a) cnt++;
          // a line appears as someone starts talking: louder just after its start than just before
          // (lines often stay up a little after the talking stops, so the end says less)
          if (x - EDGE >= a && x + EDGE <= b) { edge += (F[x + EDGE - a] - F[x - a]) - (F[x - a] - F[x - EDGE - a]); edges++; }
        }
        if (expected > 0 && on >= 0.5 * expected) {
          scores[k] = s / on + (edges ? (this.edgeWeight * edge) / (edges * EDGE) : 0);
          counts[k] = cnt;
        }
      }
      let best = -1, sum = 0, sum2 = 0, m = 0;
      for (let k = 0; k < K; k++) {
        if (Number.isNaN(scores[k])) continue;
        if (best < 0 || scores[k] > scores[best]) best = k;
        sum += scores[k]; sum2 += scores[k] * scores[k]; m++;
      }
      if (best < 0) return { ok: false, reason: "too little dialogue heard yet", heardMs };
      let runner = -Infinity;
      // the runner-up is the best *other* answer: a separate peak more than 0.5 s away, not the
      // slope of the best one (lines last seconds, so shifting a little still overlaps a lot)
      const isPeak = (k) => {
        for (let j = Math.max(0, k - PEAK); j <= Math.min(K - 1, k + PEAK); j++) if (scores[j] > scores[k]) return false;
        return true;
      };
      for (let k = 0; k < K; k++) if (!Number.isNaN(scores[k]) && Math.abs(k - best) > FAR && scores[k] > runner && isPeak(k)) runner = scores[k];
      // none (the scores only rise toward the best answer): judge against everything else
      if (runner === -Infinity) for (let k = 0; k < K; k++) if (!Number.isNaN(scores[k]) && Math.abs(k - best) > FAR && scores[k] > runner) runner = scores[k];
      const sd = Math.sqrt(Math.max(sum2 / m - (sum / m) ** 2, 0)) + 1e-9;
      return {
        ok: true,
        offset: (C - R + best) * BIN,
        score: scores[best],                                              // dB above surroundings, on average, under the lines
        margin: runner === -Infinity ? 0 : (scores[best] - runner) / sd,  // how far the best stands out
        cues: counts[best],                                               // lines starting inside the window
        heardMs,
      };
    }
  }

  // The decision rule for automatic sync, kept apart from the browser so it can be tested on
  // recorded audio. Call step() every few seconds of playback; it says what to do.
  //   first match: all audio heard (up to 10 min back), shifts up to 90 s either way. Needs a
  //     margin of 2+, 6+ lines, and two estimates in a row agreeing within 0.1 s.
  //   afterwards: the last 3 minutes, within 15 s of the current timing. Corrections need the
  //     same agreement; jumps of 0.5 s or more (ad break, different cut) a margin of 2.5+.
  //   tracking (rules.track): replaces "afterwards". See _track.
  class SyncPolicy {
    constructor(locked = false, rules = {}) {
      this.locked = locked;
      this.pending = null;
      this.agree = 0;
      this.rules = { ...SyncPolicy.RULES, ...rules };
      this.points = [];  // tracking: clear measurements, {t: media time they describe, offset}
      this.drift = 0;    // tracking: how fast the timing is slipping (ms per ms of video)
    }

    step(est, nowMs, current, scale = 1) {
      if (this.locked && this.rules.track) return this._track(est, nowMs, current, scale);
      const wide = !this.locked, R = this.rules;
      const r = est.estimate({ w0: nowMs - (wide ? 600000 : 180000), w1: nowMs, center: wide ? 0 : current, range: wide ? 90000 : 15000, scale });
      const clear = r.ok && r.margin >= 2 && (this.locked
        ? r.cues >= 6 && r.heardMs >= 30000
        : r.cues >= R.firstLines && r.heardMs >= R.firstHeardMs && r.margin >= R.firstMargin);
      const diff = clear ? r.offset - current : 0;
      if (!clear || (this.locked && Math.abs(diff) <= 60) || (this.locked && Math.abs(diff) >= 500 && r.margin < 2.5)) {
        this.pending = null;
        return { r, action: null };
      }
      if (this.pending === null || Math.abs(this.pending - r.offset) > 100) {
        this.pending = r.offset;
        return { r, action: null };
      }
      this.pending = null;
      if (!this.locked) { this.locked = true; return { r, action: { kind: "lock", offset: r.offset } }; }
      return { r, action: { kind: Math.abs(diff) < 500 ? "fine" : "jump", offset: r.offset } };
    }

    // The viewer moved in the video: what was pending no longer follows on, and after a rewind
    // measurements from ahead of here would block new ones.
    onSeek(nowMs) {
      this.pending = null;
      this.agree = 0;
      this.points = this.points.filter((q) => q.t <= nowMs);
    }

    // Keep measuring where the subtitles belong, and follow it:
    //   a cut (0.5 s or more from where the measurements so far lead, seen clearly several times
    //     in a row): move at once, from about a minute ago on
    //   slow slipping: a line fitted through the last 10 minutes of measurements says how fast it
    //     slips. A steady slip becomes a new speed for the whole file; anything smaller is followed
    //     in steps of 40 ms, too small to see (larger when well off).
    _track(est, nowMs, current, scale) {
      const R = this.rules;
      const r = est.estimate({ w0: nowMs - R.trackWindow, w1: nowMs, center: current, range: R.trackRange, scale });
      const clear = (m) => r.ok && r.margin >= m && r.cues >= 6 && r.heardMs >= 30000;
      const before = driftFit(this.points, nowMs);
      if (clear(R.jumpMargin) && Math.abs(r.offset - (before ? before.target : current)) >= 500) {
        const same = this.pending !== null && Math.abs(this.pending - r.offset) <= 100;
        this.agree = same ? this.agree + 1 : 1;
        this.pending = r.offset;
        if (this.agree < R.jumpAgree) return { r, action: null };
        this.pending = null;
        this.points = [];
        this.drift = 0;
        return { r, action: { kind: "jump", offset: r.offset } };
      }
      this.pending = null;
      const last = this.points[this.points.length - 1];
      if (clear(R.trackMargin) && (!last || nowMs - R.trackWindow / 2 - last.t >= 15000)) {
        this.points.push({ t: nowMs - R.trackWindow / 2, offset: r.offset }); // a window's answer describes its middle
        this.points = this.points.filter((q) => nowMs - q.t <= 600000);
      }
      const fit = driftFit(this.points, nowMs, R.slopeSpan);
      if (!fit) return { r, action: null };
      this.drift = fit.slope;
      if (fit.span >= R.rescaleSpan && fit.n >= R.rescalePoints && Math.abs(fit.slope) >= R.rescaleSlope) {
        const newScale = scale / (1 - fit.slope);
        const offset = nowMs - ((nowMs - fit.target) / scale) * newScale;
        this.points = [];
        this.drift = 0;
        return { r, action: { kind: "rescale", scale: newScale, offset } };
      }
      const gap = fit.target - current;
      if (Math.abs(gap) <= R.deadband) return { r, action: null };
      const most = Math.max(40, Math.abs(gap) / 4); // well off (just after locking on): catch up faster
      return { r, action: { kind: "track", offset: Math.round(current + Math.max(-most, Math.min(most, gap))) } };
    }
  }

  SyncPolicy.RULES = { firstLines: 8, firstHeardMs: 60000, firstMargin: 2, track: false,
    trackWindow: 150000, trackRange: 30000, trackMargin: 2, jumpMargin: 2, jumpAgree: 4,
    slopeSpan: 120000, rescaleSpan: 240000, rescalePoints: 6, rescaleSlope: 0.0005, deadband: 80 };

  // A line through (media time, offset) measurements that one bad measurement can't bend: the
  // slope is the median slope between pairs of points. null until 4 points agree closely.
  // slope: ms of slip per ms of video (0 until they span slopeSpan ms). target: the offset right now.
  function driftFit(points, nowMs, slopeSpan = 120000) {
    if (points.length < 4) return null;
    const span = points[points.length - 1].t - points[0].t;
    let slope = 0;
    if (span >= slopeSpan) {
      const slopes = [];
      for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
        const dt = points[j].t - points[i].t;
        if (dt >= 60000) slopes.push((points[j].offset - points[i].offset) / dt);
      }
      slope = Math.max(-0.06, Math.min(0.06, median(slopes) || 0));
    }
    const atNow = points.map((q) => q.offset + slope * (nowMs - q.t));
    const target = median(atNow);
    if (median(atNow.map((v) => Math.abs(v - target))) > 150) return null;
    return { slope, target, span, n: points.length };
  }

  // Timing is {scale, segments: [{from, offset}]}: a subtitle at time t shows at t*scale + the offset
  // of the last segment starting at or before t.
  const offsetAt = (segments, t) => {
    let off = segments[0].offset;
    for (const q of segments) if (q.from <= t) off = q.offset;
    return off;
  };

  // The offset for what's on screen at video time nowMs. Segments start at a subtitle time, so
  // each is judged by the subtitle time that its own offset puts on screen now.
  function offsetNow(timing, nowMs) {
    let off = timing.segments[0].offset;
    for (const q of timing.segments) if ((nowMs - q.offset) / timing.scale >= q.from) off = q.offset;
    return off;
  }

  // Change the timing as a SyncPolicy action says.
  function applySync(timing, action, nowMs) {
    if (action.kind === "lock") {
      timing.segments = [{ from: 0, offset: action.offset }];
    } else if (action.kind === "rescale") {
      // a new speed for the whole file replaces the small steps that followed the slip; cuts stay,
      // the same size, for anyone rewinding past them
      const old = timing.segments, kept = [];
      let offset = action.offset;
      for (let i = old.length - 1; i > 0; i--) {
        const cut = old[i].offset - old[i - 1].offset;
        if (Math.abs(cut) < 500) continue;
        kept.unshift({ from: old[i].from, offset });
        offset -= cut;
      }
      timing.scale = action.scale;
      timing.segments = [{ from: old[0].from, offset }, ...kept];
    } else if (action.kind === "fine") {
      timing.segments[timing.segments.length - 1].offset = action.offset;
    } else if (action.kind === "jump") {
      // new offset from about a minute ago onward
      const from = Math.max(0, (nowMs - action.offset) / timing.scale - 60000);
      timing.segments = timing.segments.filter((q) => q.from < from).concat({ from, offset: action.offset });
    } else if (action.kind === "track") {
      // from now on (what has already played keeps the timing it had); steps close together share a segment
      const from = Math.max(0, (nowMs - action.offset) / timing.scale);
      const last = timing.segments[timing.segments.length - 1];
      if (from - last.from < 30000) last.offset = action.offset;
      else timing.segments.push({ from, offset: action.offset });
    }
  }

  // Given confident (mediaTime, offset) points, is there steady drift from a frame-rate mismatch?
  // media = subtitle * scale + offset  =>  measured offset grows by (1 - 1/scale) per ms.
  function detectScale(points) {
    if (points.length < 2) return null;
    const first = points[0], last = points[points.length - 1];
    const dt = last.t - first.t;
    if (dt < 6 * 60000) return null;
    const slope = (last.offset - first.offset) / dt;
    if (Math.abs(slope) < 0.0015) return null;
    const ratio = 1 / (1 - slope);
    return PRESET_RATIOS.find((r) => Math.abs(r - ratio) < 0.004) || null;
  }

  ns.SyncEstimator = SyncEstimator;
  ns.SyncPolicy = SyncPolicy;
  ns.driftFit = driftFit;
  ns.offsetAt = offsetAt;
  ns.offsetNow = offsetNow;
  ns.applySync = applySync;
  ns.detectScale = detectScale;
  ns.SYNC_BIN = BIN;
})();
