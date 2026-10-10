// Subtitle helpers: normalise timed segments, export SRT/VTT, and batch segments for translation.

function decodeEntities(str) {
  let s = String(str ?? "");
  // YouTube captions are often double-encoded ("&amp;#39;"), so decode twice.
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
  }
  return s.replace(/\s+/g, " ").trim();
}

function median(nums) {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

// youtube-transcript has returned offsets in seconds in some versions and milliseconds in others.
// Caption lines last ~1–10 s, so a median "duration" above 100 means milliseconds.
function segmentsFromYoutube(items) {
  if (!Array.isArray(items) || !items.length) return [];
  const isMs = median(items.map(i => Number(i.duration) || 0)) > 100;
  const div = isMs ? 1000 : 1;
  const out = [];
  for (const it of items) {
    const text = decodeEntities(it.text);
    if (!text) continue;
    const start = (Number(it.offset) || 0) / div;
    const dur = (Number(it.duration) || 0) / div;
    out.push({ start: round3(start), end: round3(start + (dur > 0 ? dur : 2)), text });
  }
  // Make sure segments never overlap (some captions do), which breaks many players.
  for (let i = 0; i < out.length - 1; i++) if (out[i].end > out[i + 1].start) out[i].end = Math.max(out[i].start + 0.2, out[i + 1].start);
  return out;
}

function segmentsFromWhisper(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(s => ({ start: round3(Number(s.start) || 0), end: round3(Number(s.end) || 0), text: decodeEntities(s.text) }))
    .filter(s => s.text && s.end > s.start);
}

function round3(n) { return Math.round(n * 1000) / 1000; }

function pad(n, w = 2) { return String(n).padStart(w, "0"); }

function timestamp(sec, sep) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

// Long caption lines are hard to read on a phone — wrap near ~42 chars, max 2 lines.
function wrapLine(text, max = 42) {
  const words = String(text).split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) { lines.push(cur); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

function toSRT(segments, texts) {
  return segments
    .map((s, i) => `${i + 1}\n${timestamp(s.start, ",")} --> ${timestamp(s.end, ",")}\n${wrapLine(texts ? texts[i] ?? s.text : s.text)}\n`)
    .join("\n");
}

function toVTT(segments, texts) {
  const body = segments
    .map((s, i) => `${timestamp(s.start, ".")} --> ${timestamp(s.end, ".")}\n${wrapLine(texts ? texts[i] ?? s.text : s.text)}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

function toPlainText(segments, texts) {
  return segments.map((s, i) => (texts ? texts[i] ?? s.text : s.text)).join("\n");
}

// "[00:12] text" lines — gives the LLM timing context for chapters.
function toTimedText(segments, maxChars = 24000) {
  let out = "";
  for (const s of segments) {
    const m = Math.floor(s.start / 60), sec = Math.floor(s.start % 60);
    const line = `[${pad(m)}:${pad(sec)}] ${s.text}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out;
}

function batch(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = {
  decodeEntities, segmentsFromYoutube, segmentsFromWhisper,
  timestamp, toSRT, toVTT, toPlainText, toTimedText, batch, wrapLine,
};
