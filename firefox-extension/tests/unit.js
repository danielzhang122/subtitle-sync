// Unit tests: open tests/unit.html as an extension page (the e2e runner does this).
import { cleanTitle, contentKey, identify, isPlaceholderTitle, titleSimilarity } from "../lib/identify.js";
import { rank, runtimeCheck, validate } from "../lib/match.js";
import { isSoundOnly, parseSubtitles } from "../lib/subparse.js";

const out = [];
const check = (ok, name, detail = "") => out.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- identification -------------------------------------------------------------------
const cases = [
  [[{ title: "Watch Breaking Bad Season 1 Episode 2 Online Free | StreamSite" }], { kind: "episode", title: "Breaking Bad", season: 1, episode: 2, confidence: "high" }],
  [[{ title: "Breaking Bad S01E02 - Cat's in the Bag - Some Site" }], { kind: "episode", title: "Breaking Bad", season: 1, episode: 2, confidence: "high" }],
  [[{ title: "The Office (US) 2x05 - Halloween" }], { kind: "episode", title: "Office US", season: 2, episode: 5 }],
  [[{ title: "Player" , videoName: "Severance.S02E03.1080p.WEB.h264-ETHEL.mkv" }], { kind: "episode", title: "Severance", season: 2, episode: 3, confidence: "high" }],
  [[{ url: "https://site.example/tv/the-bear/2/4", title: "The Bear | Site" }], { kind: "episode", season: 2, episode: 4 }],
  [[{ title: "Netflix", jsonld: [JSON.stringify({ "@type": "TVEpisode", episodeNumber: 7, partOfSeason: { seasonNumber: 3 }, partOfSeries: { name: "Dark" } })] }], { kind: "episode", title: "Dark", season: 3, episode: 7, confidence: "high" }],
  [[{ title: "Watch Inception (2010) Full Movie HD | Site" }], { kind: "movie", title: "Inception", year: 2010, confidence: "medium" }],
  [[{ title: "Some random video" }], { kind: "movie", confidence: "low" }],
  [[{ title: "Show S01E02 | Site" }, { title: "Show.S01E03.720p.mkv", videoName: "" }], { kind: "episode", confidence: "low" }],
  // embedded players addressed by TMDB/IMDb id, with a placeholder instead of the name
  [[{ url: "https://site.example/tv/1396/1/1", title: "TV Show 1396 S1E1" }], { kind: "episode", title: "", season: 1, episode: 1, tmdbId: 1396, confidence: "medium" }],
  [[{ url: "https://site.example/watch", title: "Site" }, { url: "https://player.example/embed/tv?id=1396&s=2&e=7", title: "TV Show 1396" }], { kind: "episode", season: 2, episode: 7, tmdbId: 1396 }],
  [[{ url: "https://player.example/embed/tv?tmdb=1396&season=1&episode=3", title: "Player" }], { kind: "episode", season: 1, episode: 3, tmdbId: 1396, confidence: "medium" }],
  [[{ url: "https://player.example/embed/tv/tt0903747/1/2", title: "Player" }], { kind: "episode", season: 1, episode: 2, imdbId: 903747, tmdbId: null }],
  [[{ url: "https://site.example/watch?v=1", title: "TV Show 1396 - Season 1 Episode 4 | Site" }], { kind: "episode", season: 1, episode: 4, tmdbId: 1396, confidence: "medium" }],
  [[{ url: "https://site.example/movie/603", title: "Movie 603 | Site" }], { kind: "movie", tmdbId: 603, confidence: "medium" }],
  [[{ url: "https://site.example/movie/603-the-matrix", title: "The Matrix (1999) | Site" }], { kind: "movie", title: "Matrix", tmdbId: 603, confidence: "medium" }],
  [[{ url: "https://a.example/tv/1396/1/1", title: "Player" }, { url: "https://b.example/tv/4087/1/1", title: "Player" }], { kind: "episode", tmdbId: null, confidence: "low" }],
  [[{ url: "https://site.example/watch", title: "TV Show S1E1" }], { kind: "episode", title: "", tmdbId: null, confidence: "low" }],
  [[{ url: "https://site.example/watch", title: "StreamSite" }, { url: "https://player.example/embed/tv/1396/1/1", title: "Player" }], { kind: "episode", title: "", tmdbId: 1396, confidence: "medium" }],
  [[{ title: "Watch 300 (2006) Full Movie | Site" }], { kind: "movie", title: "300", year: 2006, tmdbId: null }],
];
for (const [ctx, want] of cases) {
  const got = identify(ctx);
  const ok = Object.entries(want).every(([k, v]) => (k === "title" && v ? titleSimilarity(got[k], v) >= 0.75 : got[k] === v));
  check(ok, `identify ${JSON.stringify(ctx[0].title || ctx[0].url)}`, ok ? "" : JSON.stringify(got));
}
check(cleanTitle("Watch Dune: Part Two (2024) Online | X").year === 2024, "cleanTitle year");
check(isPlaceholderTitle("TV Show 1396") && isPlaceholderTitle("Episode 3") && !isPlaceholderTitle("300") && !isPlaceholderTitle("Breaking Bad") && !isPlaceholderTitle("Show Me a Hero"),
  "placeholder titles: generic words + numbers only (a bare number is a real title)");
check(contentKey({ kind: "episode", title: "", tmdbId: 1396, season: 1, episode: 1 }, "en") === "tv:tmdb1396:1:1:en" &&
  contentKey({ kind: "episode", title: "Breaking Bad", season: 1, episode: 1 }, "en") === "tv:breaking bad:1:1:en", "cache key: by id when known, else by title");

// ---- subtitle parsing ---------------------------------------------------------------------
const srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> <font color=red>there</font>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n[door slams]\r\n";
const p = parseSubtitles(srt, "a.srt");
check(eq(p.map((c) => [c.start, c.end]), [[1000, 2500], [3000, 4000]]) && p[0].text === "<i>Hello</i> there", "parse SRT", JSON.stringify(p));
const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000 line:90%\nHi\n\n01:00:00.000 --> 01:00:01.500\nLater";
check(eq(parseSubtitles(vtt, "a.vtt").map((c) => [c.start, c.end]), [[1000, 2000], [3600000, 3601500]]), "parse VTT");
const ass = "[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}Hi{\\i0}, you\\Nthere";
check(eq(parseSubtitles(ass, "a.ass"), [{ start: 1500, end: 3000, text: "<i>Hi</i>, you\nthere" }]), "parse ASS (comma in text, italics, line break)");
check(isSoundOnly("[door slams]") && isSoundOnly("♪ ♪") && !isSoundOnly("[sighs] Fine."), "sound-only lines");

// ---- matching -----------------------------------------------------------------------------
const id = { kind: "episode", title: "Test Show", season: 1, episode: 2 };
const c = (over) => ({ provider: "os", id: "x", files: 1, language: "en", release: "", downloads: 10, hearingImpaired: false, machine: false, trusted: false, fileName: "",
  feature: { kind: "episode", title: "Test Show", season: 1, episode: 2 }, ...over });
check(!validate(id, c({ feature: { title: "Test Show", season: 1, episode: 3 } })).ok, "wrong episode rejected");
check(!validate(id, c({ feature: { title: "Other Show", season: 1, episode: 2 } })).ok, "wrong title rejected");
const byId = { kind: "episode", title: "", tmdbId: 1396, season: 1, episode: 1 };
const f = (over) => c({ feature: { title: "Breaking Bad", season: 1, episode: 1, tmdbId: 1396, imdbId: 903747, ...over } });
check(validate(byId, f({})).ok, "id only: result filed under the same TMDB id accepted");
check(!validate(byId, f({ tmdbId: 4087 })).ok, "id only: result under another TMDB id rejected");
check(!validate(byId, f({ episode: 2 })).ok, "id only: wrong episode still rejected");
check(!validate(byId, f({ tmdbId: null, imdbId: null })).ok, "id only: result without ids rejected when the name isn't known");
check(validate({ ...byId, resolvedTitle: "Breaking Bad" }, f({ tmdbId: null, imdbId: null })).ok, "id only: result without ids accepted by the resolved name (library tracks)");
check(!validate({ kind: "movie", title: "The Matrix", tmdbId: 603 }, c({ feature: { title: "Some Other Film", tmdbId: 603 } })).ok, "same id but the page names a different film: rejected");
check(validate({ kind: "movie", title: "The Matrix", tmdbId: 603 }, c({ feature: { title: "The Matrix", tmdbId: 603 } })).ok, "same id and name: accepted");
const r = rank(id, [
  c({ id: "a", downloads: 5000 }), c({ id: "b", downloads: 50, release: "Test.Show.S01E02.1080p.WEB.h264-GRP" }),
  c({ id: "c", downloads: 90000, machine: true }), c({ id: "d", language: "fr" }), c({ id: "e", feature: { title: "Test Show", season: 2, episode: 2 } }),
], { language: "en", release: "Test.Show.S01E02.1080p.WEB.h264-GRP" });
check(eq(r.map((x) => x.id), ["b", "a", "c"]), "ranking: matching release wins, machine translation last, wrong language/episode dropped", r.map((x) => `${x.id}:${x.score}`).join(" "));
check(runtimeCheck([{ start: 0, end: 2400e3 }], 2600).ok && !runtimeCheck([{ start: 0, end: 2400e3 }], 1300).ok && !runtimeCheck([{ start: 0, end: 600e3 }], 2600).ok, "runtime check");

{
  const show = [{ start: 0, end: 1200e3 }];
  const ad = runtimeCheck(show, 20);
  check(!ad.ok && ad.waiting, "a 20 s ad under a show's 20 min subtitles: wait for the main video", JSON.stringify(ad));
  check(!runtimeCheck(show, 299).ok && runtimeCheck(show, 299).waiting, "just under 5 min with 20 min subtitles: wait");
  check(runtimeCheck([{ start: 0, end: 50e3 }], 60).ok, "a real short clip with short subtitles loads");
  check(runtimeCheck([{ start: 0, end: 170e3 }], 60).ok, "subtitles under 3x the clip: can't tell, loads");
  check(!runtimeCheck([{ start: 0, end: 190e3 }], 60).ok, "subtitles over 3x the clip: wait");
  check(runtimeCheck(show, NaN).ok && runtimeCheck(show, null).ok && runtimeCheck(show, 0).ok, "unknown length: loads");
  check(!runtimeCheck(show, 400).waiting && !runtimeCheck(show, 400).ok, "a full-length video the wrong length is rejected, not waited on");
}

// ---- audio sync estimator ----------------------------------------------------------------------
const { SyncEstimator, SyncPolicy, detectScale, driftFit, offsetAt, offsetNow, applySync } = globalThis.__subsync;
function synth(seed, shiftMs, ratio = 1) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const truth = [];
  let t = 3000;
  while (t < 15 * 60000) { const d = 800 + rnd() * 3000; truth.push({ start: t, end: t + d, text: "words" }); t += d + 300 + rnd() * 4000; }
  const est = new SyncEstimator();
  // subtitles as published: shifted (and stretched) relative to the real speech
  est.setCues(truth.map((q) => ({ start: (q.start - shiftMs) / ratio, end: (q.end + 300 - shiftMs) / ratio, text: q.text })), isSoundOnly);
  for (let m = 0; m < 15 * 60000; m += 20) {
    const speaking = truth.some((q) => m >= q.start && m < q.end);
    est.addAudio(m, m + 20, (speaking ? -22 : -55) + (rnd() - 0.5) * 8);
  }
  return est;
}
{
  const est = synth(1, 2300);
  const e = est.estimate({ w0: 60000, w1: 240000, center: 0, range: 90000 });
  check(e.ok && Math.abs(e.offset - 2300) <= 40 && e.margin >= 2, "estimator finds +2.3 s, clearly (margin in standard deviations)", JSON.stringify(e));
  const narrow = est.estimate({ w0: 300000, w1: 480000, center: 2000, range: 15000 });
  check(narrow.ok && Math.abs(narrow.offset - 2300) <= 40, "estimator, narrow re-check", JSON.stringify(narrow));
  est.forget(0, 15 * 60000);
  check(!est.estimate({ w0: 60000, w1: 240000 }).ok, "no estimate without heard audio");
}
{
  const est = synth(2, -4100);
  const e = est.estimate({ w0: 100000, w1: 280000, center: 0, range: 90000 });
  check(e.ok && Math.abs(e.offset + 4100) <= 40, "estimator finds −4.1 s", JSON.stringify(e));
}
{
  // only 50 s heard, in two patches with a gap: the old scoring was fooled into a huge offset here
  const est = synth(3, 2300);
  est.forget(0, 15 * 60000);
  const full = synth(3, 2300);
  for (const [x0, x1] of [[20000, 45000], [60000, 85000]]) for (let m = x0; m < x1; m += 20) {
    const i = Math.floor(m / 20); est.addAudio(m, m + 20, full.energy[i]);
  }
  const e = est.estimate({ w0: 0, w1: 85000, center: 0, range: 90000 });
  check(e.ok && Math.abs(e.offset - 2300) <= 40, "estimator not fooled by unheard gaps", JSON.stringify(e));
}
{
  // a loud music scene (louder than the talking) with no lines: one level for the whole window
  // used to call it all speech and move the lines into it
  const est = synth(4, 2300);
  for (let m = 120000; m < 240000; m += 20) est.energy[m / 20] = -14 + Math.sin(m / 700) * 2;
  const e = est.estimate({ w0: 60000, w1: 330000, center: 0, range: 90000 });
  check(e.ok && Math.abs(e.offset - 2300) <= 40 && e.margin >= 2, "estimator not fooled by loud music", JSON.stringify(e));
}
{
  const est = synth(5, -3100);
  const p = new SyncPolicy(false);
  const a = p.step(est, 300000, 0), b = p.step(est, 305000, 0);
  check(!a.action && b.action?.kind === "lock" && Math.abs(b.action.offset + 3100) <= 40, "policy: locks after two agreeing estimates", JSON.stringify([a.action, b.action, b.r]));
  const c = p.step(est, 310000, b.action.offset), d = p.step(est, 315000, b.action.offset);
  check(!c.action && !d.action, "policy: no change once on time");
  const q = new SyncPolicy(false);
  est.forget(0, 15 * 60000);
  const full = synth(5, -3100);
  for (let m = 100000; m < 140000; m += 20) est.addAudio(m, m + 20, full.energy[m / 20]);
  const r1 = q.step(est, 140000, 0), r2 = q.step(est, 140000, 0);
  check(!r1.action && !r2.action, "policy: never locks on under a minute of audio", JSON.stringify(r2.r));
  const j = new SyncPolicy(true);
  const j1 = j.step(full, 400000, 0), j2 = j.step(full, 405000, 0);
  check(!j1.action && j2.action?.kind === "jump" && Math.abs(j2.action.offset + 3100) <= 40, "policy: a jump after locking needs two agreeing clear estimates", JSON.stringify([j1.r, j2.action]));
}
{
  // driftFit: 2 ms of slip per second, starting at 1000 ms
  const line = (n, every = 30000) => Array.from({ length: n }, (_, i) => ({ t: 100000 + i * every, offset: 1000 + (100000 + i * every) * 0.002 }));
  const now = 500000;
  const fit = driftFit(line(10), now);
  check(fit && Math.abs(fit.slope - 0.002) < 1e-6 && Math.abs(fit.target - (1000 + now * 0.002)) < 1, "driftFit: straight drift recovered", JSON.stringify(fit));
  const wild = line(10);
  wild[5].offset += 8000;
  const bent = driftFit(wild, now);
  check(bent && Math.abs(bent.slope - 0.002) < 0.0003 && Math.abs(bent.target - (1000 + now * 0.002)) < 100, "driftFit: one wild point doesn't bend it", JSON.stringify(bent));
  check(driftFit(line(3), now) === null, "driftFit: under 4 points gives nothing");
  const short = driftFit(line(4, 15000), now);
  check(short && short.slope === 0, "driftFit: no slope until the points span long enough", JSON.stringify(short));
}
{
  // a seek: pending dropped, and after a rewind nothing from ahead of here is kept
  const pol = new SyncPolicy(true, { track: true });
  pol.pending = 500;
  pol.agree = 2;
  pol.points = [100000, 200000, 300000, 400000].map((t) => ({ t, offset: 0 }));
  pol.onSeek(250000);
  check(pol.pending === null && pol.agree === 0 && pol.points.length === 2 && pol.points.every((q) => q.t <= 250000), "tracking: a rewind drops what's ahead of it", JSON.stringify(pol.points));
}
{
  // the current offset, with a segment starting at a later subtitle time than the video time
  const tm = { scale: 1, segments: [{ from: 0, offset: -30000 }, { from: 130000, offset: -30040 }] };
  check(offsetNow(tm, 100000) === -30040 && offsetAt(tm.segments, 100000) === -30000, "offsetNow: judged by the subtitle time on screen now, at a large offset");
  check(offsetNow(tm, 50000) === -30000, "offsetNow: before a segment, the one before it");
  check(offsetNow({ scale: 1, segments: [{ from: 500000, offset: 0 }] }, 1000) === 0, "offsetNow: falls back to the first segment");
}
{
  // a new speed keeps earlier cuts the same size and drops the small steps
  const tm = { scale: 1, segments: [{ from: 0, offset: 100 }, { from: 200000, offset: 4100 }, { from: 300000, offset: 4140 }] };
  applySync(tm, { kind: "rescale", scale: 1.002, offset: 3000 }, 500000);
  check(tm.scale === 1.002 && JSON.stringify(tm.segments) === JSON.stringify([{ from: 0, offset: -1000 }, { from: 200000, offset: 3000 }]), "rescale: keeps cuts, drops small steps", JSON.stringify(tm.segments));
}
{
  // tracking on: stays still when on time
  const est = synth(7, 1000);
  const pol = new SyncPolicy(true, { track: true });
  const acts = [];
  for (let now = 200000; now <= 500000; now += 5000) { const { action } = pol.step(est, now, 1000, 1); if (action) acts.push(action); }
  check(acts.length === 0, "tracking: no corrections when on time", JSON.stringify(acts.slice(0, 3)));
}
{
  // tracking on: follows a slip (subtitles published 0.3% too short)
  const est = synth(8, 0, 1.003);
  const pol = new SyncPolicy(true, { track: true });
  const tm = { scale: 1, segments: [{ from: 0, offset: 0 }] };
  const kinds = new Set();
  const errAt = (now) => { const p = now / 1.003; return p * tm.scale + offsetAt(tm.segments, p) - now; };
  let before = null;
  for (let now = 200000; now <= 800000; now += 5000) {
    if (now === 200000) before = errAt(800000);
    const { action } = pol.step(est, now, Math.round(offsetAt(tm.segments, now)), tm.scale);
    if (action) { applySync(tm, action, now); kinds.add(action.kind); }
  }
  check(kinds.has("rescale") && Math.abs(errAt(800000)) < 150 && Math.abs(tm.scale - 1.003) < 0.001, `tracking: follows a slow slip (${Math.round(before)} ms left alone, ${Math.round(errAt(800000))} ms tracked)`, JSON.stringify({ scale: tm.scale, kinds: [...kinds] }));
}
check(Math.abs(detectScale([{ t: 60000, offset: 1000 }, { t: 60000 + 10 * 60000, offset: 1000 + 10 * 60000 * (1 - 1 / (25 / 23.976)) }]) - 25 / 23.976) < 1e-9, "frame-rate drift detected");
check(detectScale([{ t: 0, offset: 1000 }, { t: 600000, offset: 1100 }]) === null, "small wobble is not drift");

document.getElementById("results").textContent = out.join("\n");
