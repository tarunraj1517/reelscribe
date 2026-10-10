// AI transcript tools (summary, chapters, translation, repurposing), SRT/VTT export, clip AI metadata.
const { AI_LIMITS, LANGUAGES, langSlug } = require("../lib/plans");
const { consumeDaily, refundDaily, usedToday } = require("../lib/quota");
const { toSRT, toVTT, toPlainText } = require("../lib/subtitles");

module.exports = function registerAiRoutes(ctx) {
  const { app, requireAuth, User, Reel, ClipJob, ai, getEffectivePlan, rateLimit, mongoose } = ctx;
  const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 12, message: "Too many AI requests. Please wait a minute." });

  const REPURPOSE_LABELS = {
    blog: "Blog post", linkedin: "LinkedIn post", thread: "X / Twitter thread",
    newsletter: "Newsletter", shorts_script: "Shorts / Reels script", youtube_description: "YouTube title + description",
  };

  async function loadReel(req, res, select = "") {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ success: false, error: "Transcript not found." }); return null; }
    const q = Reel.findOne({ _id: req.params.id, userEmail: req.authEmail });
    if (select) q.select(select);
    const reel = await q;
    if (!reel) { res.status(404).json({ success: false, error: "Transcript not found." }); return null; }
    return reel;
  }

  // Charges one AI action (cache hits are free). Returns the user, or null after sending the error.
  async function spendAi(req, res) {
    const user = await User.findOne({ email: req.authEmail });
    if (!user) { res.status(401).json({ success: false, loginRequired: true, error: "Please log in again." }); return null; }
    const plan = getEffectivePlan(user);
    const limit = AI_LIMITS[plan].ai;
    if (!(await consumeDaily(User, user._id, "ai", limit))) {
      res.status(429).json({ success: false, error: `You've used all ${limit} AI actions for today. They reset at midnight IST${plan === "agency" ? "." : " — upgrade for more."}` });
      return null;
    }
    user._plan = plan;
    return user;
  }

  const remaining = (user, used) => Math.max(0, AI_LIMITS[getEffectivePlan(user)].ai - used);

  app.get("/ai/options", requireAuth, async (req, res) => {
    const user = await User.findOne({ email: req.authEmail });
    const plan = getEffectivePlan(user);
    res.json({
      success: true, languages: LANGUAGES, formats: Object.entries(REPURPOSE_LABELS).map(([id, label]) => ({ id, label })),
      aiLimit: AI_LIMITS[plan].ai, aiUsed: usedToday(user, "ai"),
    });
  });

  // POST /ai/transcript/:id/:action   action = summary | chapters | translate | repurpose
  app.post("/ai/transcript/:id/:action", requireAuth, aiLimiter, async (req, res) => {
    const action = req.params.action;
    if (!["summary", "chapters", "translate", "repurpose"].includes(action)) return res.status(404).json({ success: false, error: "Unknown action." });

    const reel = await loadReel(req, res);
    if (!reel) return;
    const cache = reel.aiCache || {};

    let cacheKey, cached;
    let language = "";
    let format = "";

    if (action === "translate" || action === "repurpose") {
      language = LANGUAGES.find(l => langSlug(l) === langSlug(req.body.language || "")) || "";
      if (action === "translate" && !language) return res.status(400).json({ success: false, error: "Please choose a supported language." });
    }
    if (action === "repurpose") {
      format = String(req.body.format || "");
      if (!REPURPOSE_LABELS[format]) return res.status(400).json({ success: false, error: "Please choose a content format." });
    }

    if (action === "summary") { cacheKey = "summary"; cached = cache.summary; }
    if (action === "chapters") { cacheKey = "chapters"; cached = cache.chapters; }
    if (action === "translate") { cacheKey = `translations.${langSlug(language)}`; cached = cache.translations?.[langSlug(language)]; }
    if (action === "repurpose") { cacheKey = `repurpose.${format}_${langSlug(language) || "same"}`; cached = cache.repurpose?.[`${format}_${langSlug(language) || "same"}`]; }

    if (cached) return res.json({ success: true, cached: true, action, language, format, result: cached });

    const user = await spendAi(req, res);
    if (!user) return;

    try {
      let result;
      if (action === "summary") result = await ai.summarize(reel.transcript);
      else if (action === "chapters") {
        result = await ai.chapters(reel.segments || [], reel.transcript);
        if (!result.length) throw new Error("No chapters returned");
      } else if (action === "translate") {
        if (reel.segments?.length) {
          const lines = await ai.translateLines(reel.segments.map(s => s.text), language);
          result = { language, lines, text: lines.join(" ") };
        } else {
          result = { language, lines: [], text: await ai.translateText(reel.transcript, language) };
        }
      } else result = await ai.repurpose(reel.transcript, format, language);

      if (!result || (typeof result === "string" && !result.trim())) throw new Error("Empty AI result");
      await Reel.updateOne({ _id: reel._id }, { $set: { [`aiCache.${cacheKey}`]: result } });
      res.json({ success: true, cached: false, action, language, format, result, remaining: remaining(user, usedToday(await User.findById(user._id).select("usage"), "ai")) });
    } catch (e) {
      console.error(`[ai/${action}] failed:`, e.message);
      await refundDaily(User, user._id, "ai");
      res.status(502).json({ success: false, error: "The AI service is busy right now. You were not charged — please try again in a moment." });
    }
  });

  // GET /transcript/:id/export.(srt|vtt|txt)?lang=Hindi
  app.get("/transcript/:id/export.:ext", requireAuth, async (req, res) => {
    const ext = String(req.params.ext).toLowerCase();
    if (!["srt", "vtt", "txt"].includes(ext)) return res.status(404).json({ success: false, error: "Unsupported format." });
    const reel = await loadReel(req, res);
    if (!reel) return;

    const lang = req.query.lang ? LANGUAGES.find(l => langSlug(l) === langSlug(req.query.lang)) : "";
    let texts = null, plain = reel.transcript;
    if (lang) {
      const t = reel.aiCache?.translations?.[langSlug(lang)];
      if (!t) return res.status(404).json({ success: false, error: `Translate this transcript to ${lang} first.` });
      if (t.lines?.length === reel.segments?.length) texts = t.lines;
      plain = t.text || plain;
    }

    let body;
    if (ext === "txt") body = texts ? toPlainText(reel.segments, texts) : plain;
    else {
      if (!reel.segments?.length) return res.status(409).json({ success: false, error: "Timed subtitles aren't available for this older transcript. Run the video again to enable SRT/VTT export." });
      body = ext === "srt" ? toSRT(reel.segments, texts) : toVTT(reel.segments, texts);
    }
    const name = `transcript-${String(reel._id).slice(-6)}${lang ? "-" + langSlug(lang) : ""}.${ext}`;
    res.setHeader("Content-Type", ext === "vtt" ? "text/vtt; charset=utf-8" : "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(ext === "srt" || ext === "vtt" ? "\ufeff" + body : body);
  });

  // POST /ai/clips/:historyId/meta  — (re)generate virality score, hook, hashtags for a clip job.
  app.post("/ai/clips/:id/meta", requireAuth, aiLimiter, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "Clip job not found." });
    const job = await ClipJob.findOne({ _id: req.params.id, userEmail: req.authEmail });
    if (!job) return res.status(404).json({ success: false, error: "Clip job not found." });

    const live = job.clips.map((c, i) => ({ c, i })).filter(x => !x.c.deleted);
    if (!live.length) return res.status(400).json({ success: false, error: "No clips available in this job." });

    const user = await spendAi(req, res);
    if (!user) return;
    try {
      const metas = await ai.scoreClips(live.map(x => x.c));
      const $set = {};
      live.forEach((x, n) => {
        const m = metas[n];
        $set[`clips.${x.i}.score`] = m.score; $set[`clips.${x.i}.scoreNote`] = m.scoreNote; $set[`clips.${x.i}.hook`] = m.hook;
        $set[`clips.${x.i}.description`] = m.description; $set[`clips.${x.i}.hashtags`] = m.hashtags;
      });
      await ClipJob.updateOne({ _id: job._id }, { $set });
      const fresh = await ClipJob.findById(job._id).lean();
      res.json({ success: true, clips: fresh.clips.map((c, idx) => ({ ...c, idx })).filter(c => !c.deleted) });
    } catch (e) {
      console.error("[ai/clips/meta] failed:", e.message);
      await refundDaily(User, user._id, "ai");
      res.status(502).json({ success: false, error: "The AI service is busy right now. You were not charged — please try again." });
    }
  });
};
