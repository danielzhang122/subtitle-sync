// Work out what is playing from page context gathered in every frame of a tab.
// Input: [{url, title, ogTitle, ogType, series, jsonld: [...], h1, videoName}]
// Output: {kind: "episode"|"movie"|null, title, season, episode, year, imdbId, confidence, evidence, release}
//   confidence: "high"   explicit episode numbers or structured data agree
//               "medium" movie title with year
//               "low"    a title only, or sources disagree -> never auto-load without validation

const NOISE = /\b(watch|online|free|full movie|full|movie|film|hd|1080p|720p|480p|4k|stream(ing)?|for free|english sub(bed|titles)?|eng ?sub|dubbed|player|video)\b/gi;
const SITE_SEPARATORS = /\s+[|–—]\s+|\s+-\s+|\s+::\s+/;

export function normalizeTitle(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .trim();
}

// 0..1: how alike two titles are (token overlap, exact match = 1)
export function titleSimilarity(a, b) {
  const x = normalizeTitle(a), y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const tx = new Set(x.split(" ")), ty = new Set(y.split(" "));
  const inter = [...tx].filter((t) => ty.has(t)).length;
  return inter / Math.max(tx.size, ty.size);
}

// "Breaking.Bad.S01E02.720p.WEB-DL.x264-GRP.mkv" style names
const RELEASE = /^(?<title>.+?)[. _-]+(?:S(?<s>\d{1,2})[. _-]?E(?<e>\d{1,3})|(?<s2>\d{1,2})x(?<e2>\d{2,3}))(?<rest>[. _-].*)?$/i;
const MOVIE_RELEASE = /^(?<title>.+?)[. _(-]+(?<year>(19|20)\d{2})[. _)-]+(?<rest>.*(?:720p|1080p|2160p|bluray|web|hdtv|dvdrip|x26[45]|hevc).*)$/i;

const EPISODE_PATTERNS = [
  /\bS(\d{1,2})\s*[:.\-_ ]?\s*E(\d{1,3})\b/i,                       // S01E02, S1 E2, S1:E2
  /\bseason\s*(\d{1,2})\s*[,:\-–—]?\s*(?:ep(?:isode)?\.?)\s*(\d{1,3})\b/i, // Season 1 Episode 2
  /\b(\d{1,2})x(\d{2,3})\b/,                                         // 1x02
];

function episodeFrom(text) {
  for (const re of EPISODE_PATTERNS) {
    const m = String(text || "").match(re);
    if (m) return { season: Number(m[1]), episode: Number(m[2]), index: m.index, match: m[0] };
  }
  return null;
}

function episodeFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const q = u.searchParams;
  const s = q.get("season") ?? q.get("s"), e = q.get("episode") ?? q.get("ep") ?? q.get("e");
  if (s && e && /^\d+$/.test(s) && /^\d+$/.test(e)) return { season: Number(s), episode: Number(e) };
  const path = decodeURIComponent(u.pathname);
  const m = path.match(/season[-_/]?(\d{1,2})[-_/]+(?:episode|ep)[-_/]?(\d{1,3})/i) ||
    path.match(/\/(?:tv|show|series|watch\/tv)\/[^/]+\/(\d{1,2})\/(\d{1,3})(?:\/|$)/i) ||
    path.match(/[-_/]s(\d{1,2})[-_]?e(\d{1,3})(?:[-_/.]|$)/i);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

function titleFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const i = parts.findIndex((p) => /^(tv|show|shows|series|movie|movies|film|watch)$/i.test(p));
    const slug = i >= 0 ? parts[i + 1] : null;
    if (!slug || /^(tt)?\d+$/i.test(slug)) return null; // a database id, not a name
    return slug.replace(/[-_]+/g, " ").replace(/\b\d{3,}\b/g, "").replace(/\s+/g, " ").trim() || null;
  } catch { return null; }
}

// Database ids in the address. Embedded players are almost always addressed by TMDB id
// (/embed/tv/1396/1/1, /movie/603, ?tmdb=1396) or IMDb id (tt0903747). Returns
// {tmdbId, imdbId, idKind: "tv"|"movie"|null}; ids are numbers.
export function idsFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return {}; }
  const out = {};
  const q = u.searchParams;
  const tmdb = q.get("tmdb") ?? q.get("tmdb_id") ?? q.get("tmdbid");
  if (tmdb && /^\d+$/.test(tmdb)) out.tmdbId = Number(tmdb);
  const imdb = `${q.get("imdb") ?? q.get("imdb_id") ?? ""} ${decodeURIComponent(u.pathname)}`.match(/\btt(\d{7,8})\b/);
  if (imdb) out.imdbId = Number(imdb[1]);
  const path = decodeURIComponent(u.pathname);
  const m = path.match(/\/(tv|series|show|shows|movie|movies)\/(\d+)(?=[-/]|$)/i);
  if (m && out.tmdbId == null) out.tmdbId = Number(m[2]);
  const section = path.match(/\/(tv|series|movie)\/?$/i); // /embed/tv?id=1396&s=1&e=1
  const qid = q.get("id");
  if (section && out.tmdbId == null && qid && /^\d+$/.test(qid)) out.tmdbId = Number(qid);
  const kind = (m?.[1] || section?.[1] || q.get("type") || "").toLowerCase();
  out.idKind = /^(tv|series|show|shows)$/.test(kind) ? "tv" : /^(movie|movies)$/.test(kind) ? "movie" : null;
  return out.tmdbId != null || out.imdbId != null ? out : {};
}

// Titles some sites put in place of the real name ("TV Show 1396", "Movie 603", "Episode 1"):
// only generic words and numbers, so they say nothing about what is playing. Numbers alone
// ("300", "1917") are real film titles, so at least one generic word is required.
const GENERIC = new Set(["tv", "show", "shows", "series", "movie", "movies", "film", "episode", "ep", "season",
  "watch", "video", "player", "embed", "untitled", "title", "stream", "online", "free", "hd", "now", "playing", "home"]);
// "TV Show 1396 S1E1 | Site" / "Movie 603": such players put the TMDB id where the name should
// be. Looks at the raw page title, part by part, with any episode marker removed.
function idFromPlaceholder(raw) {
  for (const part of String(raw || "").split(SITE_SEPARATORS)) {
    const ep = episodeFrom(part);
    const text = ep ? part.replace(ep.match, " ") : part;
    const m = normalizeTitle(text.replace(/\bwatch\b/gi, " ")).match(/^(tv show|tv series|tv|show|series|movie|film) (\d{3,7})$/);
    if (m) return { tmdbId: Number(m[2]), idKind: /movie|film/.test(m[1]) ? "movie" : "tv" };
  }
  return null;
}

export function isPlaceholderTitle(t) {
  const words = normalizeTitle(t).split(" ").filter(Boolean);
  return words.some((w) => GENERIC.has(w)) && words.every((w) => GENERIC.has(w) || /^\d+$/.test(w) || /^s\d+e\d+$/.test(w));
}

// Strip the site name and filler words from a page title.
export function cleanTitle(raw) {
  if (!raw) return { title: "", year: null };
  let t = String(raw).replace(/\s+/g, " ").trim();
  const parts = t.split(SITE_SEPARATORS).map((p) => p.trim()).filter(Boolean);
  // keep the part that carries episode info, else the first (site names usually come last)
  t = parts.find((p) => episodeFrom(p)) || parts[0] || t;
  const ep = episodeFrom(t);
  if (ep) t = t.slice(0, ep.index) || t.slice(ep.index + ep.match.length);
  let year = null;
  const ym = t.match(/\((19|20)\d{2}\)|\b(19|20)\d{2}\b(?!p)/);
  if (ym) { year = Number(ym[0].replace(/\D/g, "")); t = t.replace(ym[0], " "); }
  t = t.replace(NOISE, " ").replace(/[\[\](){}:]+/g, " ").replace(/\s*[-–—|,.]+\s*$/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^[-–—|,.\s]+|[-–—|,.\s]+$/g, "");
  return { title: t, year };
}

function fromJsonLd(items) {
  const out = [];
  const visit = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(visit);
    if (o["@graph"]) visit(o["@graph"]);
    const type = [].concat(o["@type"] || []).join(" ");
    const imdb = [].concat(o.sameAs || []).map(String).map((s) => s.match(/tt(\d{5,})/)).find(Boolean);
    if (/TVEpisode/i.test(type)) {
      const series = o.partOfSeries?.name || o.partOfTVSeries?.name;
      const season = Number(o.partOfSeason?.seasonNumber ?? o.seasonNumber);
      const episode = Number(o.episodeNumber);
      if (series && season && episode) {
        out.push({ kind: "episode", title: series, season, episode, source: "structured data", weight: 0.95 });
      }
    } else if (/\bMovie\b/i.test(type) && o.name) {
      const y = String(o.datePublished || o.dateCreated || "").match(/(19|20)\d{2}/);
      out.push({ kind: "movie", title: o.name, year: y ? Number(y[0]) : null, imdbId: imdb ? Number(imdb[1]) : null, source: "structured data", weight: 0.9 });
    }
  };
  for (const raw of items || []) {
    try { visit(typeof raw === "string" ? JSON.parse(raw) : raw); } catch {}
  }
  return out;
}

export function identify(contexts) {
  const cands = [];
  const idSets = [], titleIds = [];
  let release = "";
  for (const c of contexts || []) {
    cands.push(...fromJsonLd(c.jsonld));
    // release-style file names (video src, player page title)
    for (const name of [c.videoName, c.title].filter(Boolean)) {
      const base = name.replace(/\.(mkv|mp4|avi|m4v|webm|mov|m3u8)$/i, "");
      const m = base.match(RELEASE);
      if (m && /[._]/.test(base)) {
        const g = m.groups;
        cands.push({ kind: "episode", title: g.title.replace(/[._]+/g, " ").trim(), season: Number(g.s ?? g.s2), episode: Number(g.e ?? g.e2), source: "file name", weight: 0.9 });
        release = release || base;
      } else {
        const mm = base.match(MOVIE_RELEASE);
        if (mm && /[._]/.test(base)) {
          cands.push({ kind: "movie", title: mm.groups.title.replace(/[._]+/g, " ").trim(), year: Number(mm.groups.year), source: "file name", weight: 0.85 });
          release = release || base;
        }
      }
    }
    // page / og titles
    for (const [text, source, weight] of [[c.ogTitle, "page metadata", 0.85], [c.title, "page title", 0.8], [c.h1, "page heading", 0.7]]) {
      if (!text) continue;
      const ep = episodeFrom(text);
      let { title, year } = cleanTitle(text);
      const pid = idFromPlaceholder(text);
      if (pid) titleIds.push(pid);
      if (pid || isPlaceholderTitle(title)) title = "";
      // a placeholder title still counts for the episode numbers, just not for the name
      if (ep) cands.push({ kind: "episode", title, season: ep.season, episode: ep.episode, source, weight });
      else if (!title) continue;
      else if (year && !/video\.(episode|tv_show)/.test(c.ogType || "")) cands.push({ kind: "movie", title, year, source, weight: weight - 0.1 });
      else cands.push({ kind: "titleonly", title, year, source, weight: weight - 0.2 });
    }
    const ue = episodeFromUrl(c.url);
    const urlTitle = titleFromUrl(c.url);
    if (ue) cands.push({ kind: "episode", title: urlTitle && !isPlaceholderTitle(urlTitle) ? urlTitle : "", season: ue.season, episode: ue.episode, source: "address", weight: 0.75 });
    if (c.series && !isPlaceholderTitle(c.series)) cands.push({ kind: "titleonly", title: c.series, source: "page metadata", weight: 0.7 });
    const ids = idsFromUrl(c.url);
    if (ids.tmdbId != null || ids.imdbId != null) idSets.push(ids);
  }
  for (const c of cands) if (c.title && isPlaceholderTitle(c.title)) c.title = "";

  // database ids: from the address, else from a placeholder title; only used when every
  // source that has one agrees
  const merge = (sets) => {
    const agree = (k) => new Set(sets.map((x) => x[k]).filter((v) => v != null)).size <= 1;
    return sets.length && agree("tmdbId") && agree("imdbId") && agree("idKind")
      ? Object.assign({}, ...sets.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v != null)))) : {};
  };
  const ids = idSets.length ? merge(idSets) : merge(titleIds);
  const where = idSets.length ? "address" : "page title";
  const hasIds = ids.tmdbId != null || ids.imdbId != null;
  const idEvidence = ids.tmdbId != null ? `TMDB id ${ids.tmdbId} in the ${where}` : ids.imdbId != null ? `IMDb id tt${ids.imdbId} in the ${where}` : "";

  const episodes = cands.filter((c) => c.kind === "episode" && c.season && c.episode);
  const result = { kind: null, title: "", season: null, episode: null, year: null, imdbId: null, tmdbId: null, confidence: "none", evidence: [], release };
  if (episodes.length && ids.idKind !== "movie") {
    result.tmdbId = ids.tmdbId ?? null;
    result.imdbId = ids.imdbId ?? null;
  }
  if (episodes.length) {
    // the episode numbers must agree across every source that states them
    const key = (c) => `${c.season}x${c.episode}`;
    const votes = new Map();
    for (const c of episodes) votes.set(key(c), (votes.get(key(c)) || 0) + c.weight);
    const [bestKey] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    const agreeing = episodes.filter((c) => key(c) === bestKey);
    const titled = cands.filter((c) => c.title && c.kind !== "movie").sort((a, b) => b.weight - a.weight);
    // with an id, don't borrow a name from a source that doesn't state the episode (often just
    // the site's name): the id names the show, and a wrong name would only get in the way
    const best = agreeing.filter((c) => c.title).sort((a, b) => b.weight - a.weight)[0] || (hasIds ? null : titled[0]);
    Object.assign(result, { kind: "episode", title: best?.title || "", season: agreeing[0].season, episode: agreeing[0].episode });
    result.evidence = [...new Set(agreeing.map((c) => c.source))];
    const hasId = result.tmdbId != null || result.imdbId != null;
    if (hasId) result.evidence.push(idEvidence);
    const conflict = votes.size > 1;
    // with no name, an id is enough: the show's name comes back from the subtitle search, and
    // only results filed under that same id are accepted
    result.confidence = conflict ? "low" : !result.title ? (hasId ? "medium" : "low") : agreeing.some((c) => c.weight >= 0.8) ? "high" : "medium";
    if (conflict) result.evidence.push("sources disagree on the episode");
    return result;
  }
  const movies = cands.filter((c) => c.kind === "movie").sort((a, b) => b.weight - a.weight);
  if (ids.idKind === "movie" || (ids.imdbId != null && ids.idKind == null)) {
    const named = movies[0]; // a title with a year or a release file name; not a bare page title
    Object.assign(result, { kind: "movie", title: named?.title || "", year: named?.year || null, tmdbId: ids.idKind === "movie" ? ids.tmdbId ?? null : null, imdbId: ids.imdbId ?? null });
    result.confidence = "medium";
    result.evidence = [idEvidence, ...(named ? [named.source] : [])];
    return result;
  }
  if (movies.length) {
    const m = movies[0];
    Object.assign(result, { kind: "movie", title: m.title, year: m.year || movies.find((x) => x.year)?.year || null, imdbId: m.imdbId || null });
    result.confidence = result.year ? "medium" : "low";
    result.evidence = [m.source];
    return result;
  }
  const titles = cands.filter((c) => c.title).sort((a, b) => b.weight - a.weight);
  if (titles.length) {
    Object.assign(result, { kind: "movie", title: titles[0].title, year: titles[0].year || null });
    result.confidence = "low"; // could be a show without episode numbers: never auto-load blindly
    result.evidence = [titles[0].source];
  }
  return result;
}

// The name to show: the page's title, else the one the subtitle search found for the id.
export function displayTitle(id) {
  return id?.title || id?.resolvedTitle || (id?.tmdbId != null ? `TMDB ${id.tmdbId}` : id?.imdbId != null ? `IMDb tt${id.imdbId}` : "");
}

export function contentKey(id, lang) {
  if (!id?.kind) return null;
  // a database id names the show or movie exactly, so it wins over the title
  const t = id.tmdbId != null ? `tmdb${id.tmdbId}` : id.imdbId != null ? `imdb${id.imdbId}` : normalizeTitle(id.title);
  if (!t) return null;
  return id.kind === "episode" ? `tv:${t}:${id.season}:${id.episode}:${lang}` : `movie:${t}:${id.year || ""}:${lang}`;
}
