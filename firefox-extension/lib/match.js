// Decide which search results really are the episode/movie being watched, and rank them.
import { normalizeTitle, titleSimilarity } from "./identify.js";

const RELEASE_TOKENS = /\b(2160p|1080p|720p|480p|web[- .]?dl|webrip|web|bluray|bdrip|brrip|hdtv|dvdrip|x264|x265|h\.?264|h\.?265|hevc|amzn|nf|dsnp|hmax|atvp|hulu|repack|proper)\b/gi;

function releaseTokens(s) {
  const out = new Set((String(s || "").match(RELEASE_TOKENS) || []).map((t) => t.toLowerCase().replace(/[- .]/g, "")));
  const group = String(s || "").match(/-([A-Za-z0-9]{2,})(?:\.[a-z0-9]{2,4})?$/);
  if (group) out.add(`grp:${group[1].toLowerCase()}`);
  return out;
}

// Is this result the same episode/movie? Returns {ok, reason}.
// A database id on both sides decides it; otherwise the titles must match (id.title, or the
// name an id search came back with: id.resolvedTitle).
export function validate(id, cand) {
  const f = cand.feature;
  let sameId = false;
  for (const k of ["tmdbId", "imdbId"]) {
    if (id[k] == null || f[k] == null) continue;
    if (Number(id[k]) !== Number(f[k])) return { ok: false, reason: `it is filed under a different ${k === "tmdbId" ? "TMDB" : "IMDb"} id (${f[k]}, not ${id[k]})` };
    sameId = true;
  }
  const name = id.title || id.resolvedTitle || "";
  // same id but a clearly different name than the page shows: the address number may be the
  // site's own, not a TMDB/IMDb id
  if (sameId && id.title && titleSimilarity(id.title, f.title) < 0.5) {
    return { ok: false, reason: `"${f.title}" is filed under that id, but the page says "${id.title}"` };
  }
  if (!sameId) {
    if (!name) return { ok: false, reason: `can't confirm "${f.title}" is the right show` };
    if (titleSimilarity(name, f.title) < 0.75) return { ok: false, reason: `title "${f.title}" doesn't match "${name}"` };
  }
  if (id.kind === "episode") {
    if (f.season !== id.season || f.episode !== id.episode) {
      return { ok: false, reason: `it is S${f.season}E${f.episode}, not S${id.season}E${id.episode}` };
    }
  } else if (id.year && f.year && Math.abs(f.year - id.year) > 1) {
    return { ok: false, reason: `it is from ${f.year}, not ${id.year}` };
  }
  return { ok: true, reason: "", exactTitle: !!name && normalizeTitle(name) === normalizeTitle(f.title) };
}

// Best first. Only results that pass validate() are returned.
export function rank(id, candidates, { language, release = "", preferHearingImpaired = false } = {}) {
  const wanted = releaseTokens(release);
  const scored = [];
  for (const c of candidates) {
    const v = validate(id, c);
    if (!v.ok) continue;
    if (c.language && language && c.language.slice(0, 2).toLowerCase() !== language) continue;
    if (c.files > 1) continue; // multi-CD subtitles don't fit a single video
    let score = Math.log10(1 + c.downloads);
    if (c.trusted) score += 1;
    if (c.machine) score -= 10; // machine/AI translations only as a last resort
    if (c.hearingImpaired !== preferHearingImpaired) score -= 0.5;
    if (v.exactTitle) score += 0.5;
    const have = releaseTokens(`${c.release} ${c.fileName}`);
    for (const t of wanted) if (have.has(t)) score += t.startsWith("grp:") ? 2 : 0.7;
    scored.push({ ...c, score: Math.round(score * 100) / 100 });
  }
  return scored.sort((a, b) => b.score - a.score);
}

// Does the subtitle plausibly belong to a video of this length? (catches wrong episode/cut)
export function runtimeCheck(cues, durationSec) {
  if (!cues.length) return { ok: false, reason: "no lines" };
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { ok: true, reason: "video length unknown", checked: false };
  const last = cues[cues.length - 1].end / 1000;
  if (durationSec < 300) {
    // much too short for these subtitles: an ad before the real video, most likely. Hold them back.
    if (last > durationSec * 3) return { ok: false, waiting: true, reason: `the video is ${Math.round(durationSec)} s long but the subtitles run ${Math.round(last / 60)} min` };
    return { ok: true, reason: "too short to compare lengths", checked: false }; // a short clip or a late start
  }
  if (last > durationSec * 1.08 + 60) return { ok: false, reason: `subtitles run to ${Math.round(last / 60)} min but the video is ${Math.round(durationSec / 60)} min` };
  if (last < durationSec * 0.55) return { ok: false, reason: `subtitles end at ${Math.round(last / 60)} min but the video is ${Math.round(durationSec / 60)} min` };
  return { ok: true, reason: "", checked: true };
}
