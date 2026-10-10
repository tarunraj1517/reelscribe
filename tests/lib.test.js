const test = require("node:test");
const assert = require("node:assert/strict");
const sub = require("../lib/subtitles");
const sec = require("../lib/security");
const { dayKey, monthKey } = require("../lib/quota");
const { createAI } = require("../lib/ai");

test("YouTube segments: seconds vs milliseconds are both normalised", () => {
  const secs = sub.segmentsFromYoutube([{ text: "Hello &amp;#39;world&amp;#39;", offset: 1.5, duration: 2.25 }, { text: "Second", offset: 4, duration: 3 }]);
  assert.equal(secs[0].start, 1.5); assert.equal(secs[0].end, 3.75); assert.equal(secs[0].text, "Hello 'world'");
  const ms = sub.segmentsFromYoutube([{ text: "A", offset: 1500, duration: 2250 }, { text: "B", offset: 4000, duration: 3000 }]);
  assert.equal(ms[0].start, 1.5); assert.equal(ms[0].end, 3.75); assert.equal(ms[1].start, 4);
});

test("overlapping caption segments are trimmed", () => {
  const s = sub.segmentsFromYoutube([{ text: "A", offset: 0, duration: 5 }, { text: "B", offset: 3, duration: 2 }]);
  assert.ok(s[0].end <= s[1].start);
});

test("SRT / VTT formatting", () => {
  const segs = [{ start: 0, end: 1.234, text: "Hi" }, { start: 3661.5, end: 3663, text: "Late" }];
  const srt = sub.toSRT(segs);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,234\nHi\n/);
  assert.match(srt, /2\n01:01:01,500 --> 01:01:03,000\nLate/);
  const vtt = sub.toVTT(segs, ["नमस्ते", "देर"]);
  assert.ok(vtt.startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:01.234\nनमस्ते"));
});

test("long lines wrap to two lines", () => {
  const w = sub.wrapLine("this is a rather long subtitle line that should be wrapped nicely");
  assert.ok(w.includes("\n"));
});

test("safeRedirectPath blocks open redirects", () => {
  assert.equal(sec.safeRedirectPath("/dashboard.html?x=1"), "/dashboard.html?x=1");
  for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "/a\r\nSet-Cookie: x=1", 5, null])
    assert.equal(sec.safeRedirectPath(bad), "/dashboard.html", String(bad));
});

test("SSRF guard rejects private / non-https URLs", async () => {
  for (const bad of ["http://example.com", "https://127.0.0.1/x", "https://10.0.0.5", "https://169.254.169.254/latest", "https://localhost/x", "https://[::1]/", "https://user:pw@1.1.1.1/", "not a url"])
    await assert.rejects(() => sec.assertSafePublicUrl(bad), String(bad));
  await assert.doesNotReject(() => sec.assertSafePublicUrl("https://1.1.1.1/hook"));
});

test("safeEqual", () => { assert.equal(sec.safeEqual("abc", "abc"), true); assert.equal(sec.safeEqual("abc", "abd"), false); assert.equal(sec.safeEqual(undefined, "x"), false); });

test("day key rolls over at midnight IST, not UTC", () => {
  assert.equal(dayKey(new Date("2026-10-09T18:29:00Z")), "2026-10-09"); // 23:59 IST
  assert.equal(dayKey(new Date("2026-10-09T18:31:00Z")), "2026-10-10"); // 00:01 IST next day
  assert.equal(monthKey(new Date("2026-10-31T19:00:00Z")), "2026-11");
});

function fakeGroq(replies) {
  let i = 0;
  return { chat: { completions: { create: async (p) => ({ choices: [{ message: { content: typeof replies === "function" ? replies(p, i++) : replies[i++] } }] }) } } };
}

test("scoreClips clamps scores and cleans hashtags", async () => {
  const ai = createAI(fakeGroq([JSON.stringify({ clips: [{ id: 0, score: 150, note: "great", hook: "Wait for it", description: "d", hashtags: ["#Viral!", "reels", ""] }, { id: 1, score: "abc" }] })]));
  const r = await ai.scoreClips([{ title: "a" }, { title: "b" }]);
  assert.equal(r[0].score, 100); assert.deepEqual(r[0].hashtags, ["Viral", "reels"]);
  assert.equal(r[1].score, null);
});

test("translateLines keeps alignment and falls back to the original line when the model skips one", async () => {
  const lines = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const ai = createAI(fakeGroq((p) => lines.map((_, n) => `${n + 1}|T${n + 1}`).filter((_, n) => n !== 4).join("\n")));
  const out = await ai.translateLines(lines, "Hindi");
  assert.equal(out.length, 10); assert.equal(out[0], "T1"); assert.equal(out[4], "five"); assert.equal(out[9], "T10");
});

test("chapters parse JSON and drop empty titles", async () => {
  const ai = createAI(fakeGroq([JSON.stringify({ chapters: [{ time: "00:00", title: "Intro" }, { time: "01:10", title: "" }] })]));
  const c = await ai.chapters([{ start: 0, end: 5, text: "hi" }], "hi");
  assert.deepEqual(c, [{ time: "00:00", title: "Intro" }]);
});
