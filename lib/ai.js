// All LLM features (summary, chapters, translation, repurposing, clip scoring) live here.
// Uses Groq's chat API, which the project already depends on for Whisper.
const { toTimedText, batch } = require("./subtitles");

const MODEL = process.env.GROQ_LLM_MODEL || "llama-3.3-70b-versatile";

function createAI(groq) {
  async function chat(messages, { json = false, temperature = 0.4, maxTokens = 2048, timeoutMs = 45000 } = {}) {
    const params = { model: MODEL, messages, temperature, max_tokens: maxTokens };
    if (json) params.response_format = { type: "json_object" };
    const res = await groq.chat.completions.create(params, { timeout: timeoutMs });
    return res.choices?.[0]?.message?.content?.trim() || "";
  }

  function parseJson(text) {
    const cleaned = String(text || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try { return JSON.parse(cleaned); } catch {}
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }

  // Keep prompts within a safe size for very long videos.
  const clamp = (t, n = 24000) => (String(t).length > n ? String(t).slice(0, n) : String(t));

  async function summarize(transcript) {
    const out = await chat([
      { role: "system", content: "You summarise video transcripts for busy creators. Reply in the SAME language as the transcript. Be accurate; never invent facts." },
      { role: "user", content: `Summarise this transcript.\nFormat:\nTL;DR: one sentence.\nKey points: 4-7 short bullet lines starting with "- ".\nBest quote: one memorable line from the transcript.\n\nTRANSCRIPT:\n${clamp(transcript)}` },
    ], { temperature: 0.2, maxTokens: 700 });
    return out;
  }

  async function chapters(segments, transcript) {
    const timed = segments?.length ? toTimedText(segments) : null;
    const src = timed || clamp(transcript);
    const out = await chat([
      { role: "system", content: "You create YouTube chapter lists. Reply with JSON only." },
      { role: "user", content: `Create 4-12 chapters.${timed ? " Use the [MM:SS] timestamps from the transcript; the first chapter must start at 00:00." : " The transcript has no timestamps, so set \"time\" to \"\"."}\nReturn JSON: {"chapters":[{"time":"MM:SS","title":"short title"}]}\n\nTRANSCRIPT:\n${src}` },
    ], { json: true, temperature: 0.2, maxTokens: 900 });
    const parsed = parseJson(out);
    const list = Array.isArray(parsed?.chapters) ? parsed.chapters : [];
    return list
      .map(c => ({ time: String(c.time || "").slice(0, 8), title: String(c.title || "").slice(0, 90) }))
      .filter(c => c.title);
  }

  const REPURPOSE = {
    blog: "Write a well-structured blog post (title, intro, 3-5 headed sections, conclusion) of about 500-700 words.",
    linkedin: "Write a LinkedIn post: a scroll-stopping first line, short paragraphs, a takeaway, and a closing question. Under 1300 characters. At most 3 hashtags.",
    thread: "Write an X/Twitter thread of 6-9 tweets. Number them 1/, 2/, ... Each under 270 characters. First tweet must be a strong hook.",
    newsletter: "Write an email newsletter: subject line, preview text, a friendly intro, 3 key takeaways, and a call-to-action line.",
    shorts_script: "Write a 45-second YouTube Shorts / Reels script: a 3-second hook, tight body, and CTA. Mark lines as [HOOK], [BODY], [CTA].",
    youtube_description: "Write a YouTube title (max 70 chars), a description (first 2 lines are the hook), and 8 relevant hashtags.",
  };

  async function repurpose(transcript, format, language) {
    const instruction = REPURPOSE[format];
    if (!instruction) throw new Error("Unknown format");
    return chat([
      { role: "system", content: `You turn video transcripts into ready-to-publish content. Stay faithful to the transcript, never invent facts or quotes. ${language ? `Write in ${language}.` : "Write in the same language as the transcript."}` },
      { role: "user", content: `${instruction}\n\nTRANSCRIPT:\n${clamp(transcript, 20000)}` },
    ], { temperature: 0.6, maxTokens: 1600 });
  }

  // Translate subtitle lines in numbered batches so timing stays aligned.
  async function translateLines(lines, language) {
    const result = new Array(lines.length);
    const groups = batch(lines.map((t, i) => ({ t, i })), 40);
    for (const group of groups) {
      const numbered = group.map((g, n) => `${n + 1}|${String(g.t).replace(/\n/g, " ")}`).join("\n");
      let parsed = null;
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        const out = await chat([
          { role: "system", content: `Translate subtitle lines into ${language}. Keep the numbering exactly: output one line per input line in the form "N|translation". No extra commentary. Keep names and brand terms.` },
          { role: "user", content: numbered },
        ], { temperature: 0.1, maxTokens: 3000 });
        const map = new Map();
        for (const line of out.split("\n")) {
          const m = line.match(/^\s*(\d+)\s*\|\s*(.*)$/);
          if (m) map.set(Number(m[1]), m[2].trim());
        }
        if (map.size >= group.length * 0.9) parsed = map;
      }
      group.forEach((g, n) => { result[g.i] = (parsed && parsed.get(n + 1)) || g.t; }); // fall back to the original line
    }
    return result;
  }

  async function translateText(text, language) {
    return chat([
      { role: "system", content: `Translate the text into ${language}. Preserve meaning and paragraph breaks. Output only the translation.` },
      { role: "user", content: clamp(text, 12000) },
    ], { temperature: 0.1, maxTokens: 3500 });
  }

  // Virality score + hook + hashtags for a set of clips in ONE call.
  async function scoreClips(clips) {
    if (!clips?.length) return [];
    const items = clips.map((c, i) => ({
      id: i,
      title: c.title || "",
      why_selected: c.reason || "",
      seconds: c.duration || 0,
      text: String(c.transcript || c.text || "").slice(0, 700),
    }));
    const out = await chat([
      { role: "system", content: "You are a short-form video strategist for Reels, Shorts and TikTok. Reply with JSON only." },
      { role: "user", content: `Rate each clip's viral potential from 0-100 (be honest and spread scores; most clips are 40-80). Judge: hook strength in the first 3 seconds, emotional pull, clarity, and ideal length (15-45s is best).\nFor each clip return: score, note (max 14 words on why), hook (a punchy on-screen opening line, max 12 words), description (1-2 sentence caption, max 200 chars), hashtags (5 items, no # symbol).\nReturn JSON: {"clips":[{"id":0,"score":0,"note":"","hook":"","description":"","hashtags":[]}]}\n\nCLIPS:\n${JSON.stringify(items)}` },
    ], { json: true, temperature: 0.3, maxTokens: 2200, timeoutMs: 30000 });
    const parsed = parseJson(out);
    const list = Array.isArray(parsed?.clips) ? parsed.clips : [];
    return clips.map((_, i) => {
      const r = list.find(x => Number(x.id) === i) || {};
      const score = Math.max(0, Math.min(100, Math.round(Number(r.score))));
      return {
        score: Number.isFinite(score) ? score : null,
        scoreNote: String(r.note || "").slice(0, 140),
        hook: String(r.hook || "").slice(0, 120),
        description: String(r.description || "").slice(0, 300),
        hashtags: (Array.isArray(r.hashtags) ? r.hashtags : []).map(h => String(h).replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean).slice(0, 8),
      };
    });
  }

  return { chat, summarize, chapters, repurpose, translateLines, translateText, scoreClips, REPURPOSE_FORMATS: Object.keys(REPURPOSE) };
}

module.exports = { createAI };
