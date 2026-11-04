// OpenSubtitles.com REST API (v1). Needs a free API key (opensubtitles.com -> API consumers).
// Logging in is optional and raises the daily download limit.
import { decodeSubtitleBytes, parseSubtitles } from "./subparse.js";
import * as store from "./store.js";

const USER_AGENT = "subtitle-sync v0.2";

export class ProviderError extends Error {
  constructor(message, { status = 0, quota = false } = {}) {
    super(message);
    this.status = status;
    this.quota = quota;
  }
}

async function base(settings) {
  const tok = await store.get("os-token");
  if (tok && tok.base && Date.now() - tok.savedAt < 23 * 3600e3 && tok.user === settings.username) return { url: tok.base, token: tok.token };
  if (settings.username && settings.password) {
    try {
      const res = await call(settings, settings.apiBase, "POST", "/login", { body: { username: settings.username, password: settings.password } });
      // the login answer names the server to use from now on (e.g. a VIP server)
      const url = res.base_url ? `https://${res.base_url.replace(/^https?:\/\//, "")}/api/v1` : settings.apiBase;
      const custom = !settings.apiBase.startsWith("https://api.opensubtitles.com");
      await store.put("os-token", { token: res.token, base: custom ? settings.apiBase : url, user: settings.username });
      return { url: custom ? settings.apiBase : url, token: res.token };
    } catch (err) {
      if (err.status === 401) throw new ProviderError("OpenSubtitles login failed: check the username and password in settings.", { status: 401 });
      // other login problems: carry on with the API key alone
    }
  }
  return { url: settings.apiBase, token: null };
}

async function call(settings, root, method, path, { params, body, token } = {}) {
  if (!settings.apiKey) throw new ProviderError("Add your free OpenSubtitles API key in settings to download subtitles automatically.");
  // The API asks for parameters sorted by name and lower-case values (avoids redirects).
  let qs = "";
  if (params) {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v).toLowerCase()).replace(/%20/g, "+")}`);
    qs = entries.length ? `?${entries.join("&")}` : "";
  }
  const headers = { "Api-Key": settings.apiKey, "User-Agent": USER_AGENT, Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${root}${path}${qs}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    throw new ProviderError(`Can't reach OpenSubtitles (${err.message}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.errors?.join?.(", ") || res.statusText;
    if (res.status === 401 || res.status === 403) throw new ProviderError(`OpenSubtitles refused the API key: ${msg}`, { status: res.status });
    if (res.status === 406 || res.status === 429) {
      throw new ProviderError(`OpenSubtitles daily download limit reached${data.reset_time ? `; resets in ${data.reset_time}` : ""}. Cached subtitles still work.`, { status: res.status, quota: true });
    }
    throw new ProviderError(`OpenSubtitles error ${res.status}: ${msg}`, { status: res.status });
  }
  return data;
}

// The searches to try, most exact first: by database id (TMDB/IMDb), then by name.
function searches(id) {
  const out = [];
  if (id.kind === "episode") {
    const ep = { season_number: id.season, episode_number: id.episode, type: "episode" };
    if (id.tmdbId != null) out.push({ parent_tmdb_id: id.tmdbId, ...ep });
    if (id.imdbId != null) out.push({ parent_imdb_id: id.imdbId, ...ep });
    if (id.title) out.push({ query: id.title, ...ep });
  } else {
    if (id.tmdbId != null) out.push({ tmdb_id: id.tmdbId, type: "movie" });
    if (id.imdbId != null) out.push({ imdb_id: id.imdbId });
    if (id.title) out.push({ query: id.title, year: id.year || undefined, type: "movie" });
  }
  return out;
}

// Search. id: {kind, title, season, episode, year, imdbId, tmdbId}. Takes the first id search
// that finds anything, plus the name search whenever there is a name (an address number might
// not be a real database id; validation sorts the results out).
export async function search(id, language) {
  const settings = await store.getSettings();
  const { url, token } = await base(settings);
  const found = new Map();
  let idHit = false;
  for (const params of searches(id)) {
    const byName = "query" in params;
    if (!byName && idHit) continue;
    const data = await call(settings, url, "GET", "/subtitles", { params: { languages: language, ...params }, token });
    for (const s of data.data || []) found.set(s.id, s);
    if (!byName && data.data?.length) idHit = true;
  }
  return [...found.values()].map((s) => {
    const a = s.attributes || {};
    const f = a.feature_details || {};
    return {
      provider: "opensubtitles",
      id: String(a.files?.[0]?.file_id ?? s.id),
      fileId: a.files?.[0]?.file_id,
      fileName: a.files?.[0]?.file_name || "",
      files: (a.files || []).length,
      language: a.language,
      release: a.release || "",
      downloads: a.download_count || 0,
      hearingImpaired: !!a.hearing_impaired,
      machine: !!(a.machine_translated || a.ai_translated),
      trusted: !!a.from_trusted,
      fps: a.fps || null,
      feature: {
        kind: /episode/i.test(f.feature_type || "") ? "episode" : "movie",
        title: f.parent_title || f.title || f.movie_name || "",
        episodeTitle: f.parent_title ? f.title : "",
        season: f.season_number ?? null,
        episode: f.episode_number ?? null,
        year: f.year ?? null,
        // ids of the show (for an episode) or of the movie itself
        tmdbId: (/episode/i.test(f.feature_type || "") ? f.parent_tmdb_id : f.tmdb_id) || null,
        imdbId: (/episode/i.test(f.feature_type || "") ? f.parent_imdb_id : f.imdb_id) || null,
      },
    };
  });
}

// Download one subtitle file (counts against the daily limit; callers cache the result).
export async function download(candidate) {
  const settings = await store.getSettings();
  const { url, token } = await base(settings);
  const res = await call(settings, url, "POST", "/download", {
    params: { file_id: candidate.fileId, sub_format: "srt" },
    body: { file_id: candidate.fileId, sub_format: "srt" },
    token,
  });
  if (!res.link) throw new ProviderError("OpenSubtitles gave no download link.");
  let raw;
  try {
    raw = await (await fetch(res.link)).arrayBuffer();
  } catch (err) {
    throw new ProviderError(`Download failed (${err.message}).`);
  }
  const cues = parseSubtitles(decodeSubtitleBytes(raw), res.file_name || candidate.fileName);
  if (!cues.length) throw new ProviderError("The downloaded subtitle file was empty or unreadable.");
  return { cues, remaining: res.remaining };
}
