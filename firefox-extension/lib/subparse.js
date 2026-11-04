// Parse SRT / WebVTT / ASS text into [{start, end, text}] (ms; text uses "\n" for line breaks
// and keeps <i>/<b> tags).

function ms(h, m, s, frac) {
  return ((Number(h || 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Math.round(Number(`0.${frac || 0}`) * 1000);
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function parseSrtVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const ma = a.match(TIME), mb = b.match(TIME);
    if (!ma || !mb) continue;
    const body = lines.slice(i + 1).join("\n")
      .replace(/<(?!\/?[ib]>)[^>]*>/gi, "")      // keep only <i>, <b>
      .replace(/\{\\[^}]*\}/g, "")                // stray ASS tags in SRTs
      .trim();
    if (!body) continue;
    cues.push({ start: ms(ma[1], ma[2], ma[3], ma[4]), end: ms(mb[1], mb[2], mb[3], mb[4]), text: body });
  }
  return cues;
}

function parseAss(text) {
  const cues = [];
  let fields = null;
  let inEvents = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\[events\]/i.test(line.trim())) { inEvents = true; continue; }
    if (/^\[/.test(line.trim())) { inEvents = false; continue; }
    if (!inEvents) continue;
    if (/^format:/i.test(line)) { fields = line.slice(7).split(",").map((f) => f.trim().toLowerCase()); continue; }
    if (!/^dialogue:/i.test(line) || !fields) continue;
    const parts = line.slice(9).split(",");
    const row = {};
    fields.forEach((f, k) => { row[f] = k === fields.length - 1 ? parts.slice(k).join(",") : parts[k]; });
    const ta = row.start?.trim().match(/(\d+):(\d{2}):(\d{2})[.](\d{1,3})/);
    const tb = row.end?.trim().match(/(\d+):(\d{2}):(\d{2})[.](\d{1,3})/);
    if (!ta || !tb) continue;
    let body = (row.text || "")
      .replace(/\{([^}]*)\}/g, (_, tags) => {
        let out = "";
        for (const [, t, v] of tags.matchAll(/\\(i|b)(\d)/g)) out += v === "1" ? `<${t}>` : `</${t}>`;
        return out;
      })
      .replace(/\\N|\\n/g, "\n").replace(/\\h/g, " ").trim();
    if (!body || /\\p\d/.test(row.text)) continue; // skip drawings
    cues.push({ start: ms(ta[1], ta[2], ta[3], ta[4].padEnd(3, "0")), end: ms(tb[1], tb[2], tb[3], tb[4].padEnd(3, "0")), text: body });
  }
  return cues;
}

export function parseSubtitles(text, name = "") {
  text = String(text).replace(/^﻿/, "");
  const cues = /\[script info\]|\[events\]/i.test(text) || /\.(ass|ssa)$/i.test(name) ? parseAss(text) : parseSrtVtt(text);
  cues.sort((a, b) => a.start - b.start);
  return cues.filter((c) => c.end > c.start);
}

// Decode bytes: UTF-8 if valid, else Windows-1252 (common for old SRTs).
export function decodeSubtitleBytes(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("windows-1252").decode(bytes); }
}

// Lines that are only sound descriptions or music: no speech to line up with.
export function isSoundOnly(text) {
  return /^\s*(?:(?:\[[^\]]*\]|\([^)]*\)|[♪♫#*\-\s]|<\/?[ib]>)+)\s*$/.test(text);
}
