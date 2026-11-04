// Settings and caches in browser.storage.local.
//   settings                 user settings (below)
//   sub:<provider>:<id>      downloaded subtitle lines, so a file is never downloaded twice
//   match:<contentKey>       chosen subtitle + ranked alternatives for one episode/movie
//   sync:<contentKey>:<id>   timing found for that subtitle (offset, stretch), reused next time
//   page:<url>               manual identification override for a page
//   os-token                 OpenSubtitles login token (24 h)

export const DEFAULTS = {
  language: (navigator.language || "en").slice(0, 2).toLowerCase(),
  apiKey: "",
  username: "",
  password: "",
  apiBase: "https://api.opensubtitles.com/api/v1",
  autoLoad: true,
  audioSync: true,
  audioTrack: true,   // after syncing, keep following the audio and correct any slipping
  preferHearingImpaired: false,
  fontSize: 100,      // percent
  position: 90,       // percent from the top of the picture
};

export async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}

export async function get(key) {
  return (await browser.storage.local.get(key))[key];
}

export async function put(key, value) {
  await browser.storage.local.set({ [key]: { ...value, savedAt: Date.now() } });
}

export async function remove(key) {
  await browser.storage.local.remove(key);
}
