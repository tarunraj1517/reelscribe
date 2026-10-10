// Public API (API keys) + signed webhooks — Agency features.
const { hasFeature, planNeeded } = require("../lib/plans");
const { sha256, assertSafePublicUrl } = require("../lib/security");
const { toSRT, toVTT, toPlainText } = require("../lib/subtitles");

const EVENTS = ["clip.completed", "clip.failed", "transcript.completed"];
const MAX_KEYS = 5;

module.exports = function registerDeveloperRoutes(ctx) {
  const { app, requireAuth, User, Reel, JobState, WebhookEndpoint, webhooks, crypto, mongoose, getEffectivePlan, rateLimit,
          startClipJob, runUserUrlTranscription, HttpError, PLAN_LIMITS, PUBLIC_URL } = ctx;
  const ApiKey = require("../models/ApiKey");
  const manageLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: "Too many requests. Please slow down." });

  async function planOf(req) {
    const user = await User.findOne({ email: req.authEmail });
    return user ? getEffectivePlan(user) : "free";
  }
  const gate = (res, plan) => {
    if (hasFeature(plan, "api")) return true;
    res.status(403).json({ success: false, planRequired: planNeeded("api"), error: `API access and webhooks are available on the ${planNeeded("api")} plan.` });
    return false;
  };

  // ───────────── API key management (website session) ─────────────
  app.get("/developer/keys", requireAuth, async (req, res) => {
    const plan = await planOf(req);
    const keys = await ApiKey.find({ userEmail: req.authEmail, revokedAt: null }).sort({ createdAt: -1 }).select("name prefix lastUsedAt createdAt").lean();
    res.json({ success: true, allowed: hasFeature(plan, "api"), planRequired: planNeeded("api"), keys: keys.map(k => ({ id: String(k._id), name: k.name, prefix: k.prefix, lastUsedAt: k.lastUsedAt, createdAt: k.createdAt })), max: MAX_KEYS });
  });

  app.post("/developer/keys", requireAuth, manageLimiter, async (req, res) => {
    if (!gate(res, await planOf(req))) return;
    if ((await ApiKey.countDocuments({ userEmail: req.authEmail, revokedAt: null })) >= MAX_KEYS) return res.status(409).json({ success: false, error: `You can have up to ${MAX_KEYS} active keys. Revoke one first.` });
    const key = "rs_live_" + crypto.randomBytes(24).toString("base64url");
    const doc = await ApiKey.create({ userEmail: req.authEmail, name: String(req.body.name || "My key").trim().slice(0, 60) || "My key", prefix: key.slice(0, 14), hash: sha256(key) });
    // The full key is shown exactly once — only its hash is stored.
    res.json({ success: true, key, id: String(doc._id), prefix: doc.prefix });
  });

  app.delete("/developer/keys/:id", requireAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.json({ success: false });
    const r = await ApiKey.updateOne({ _id: req.params.id, userEmail: req.authEmail, revokedAt: null }, { $set: { revokedAt: new Date() } });
    res.json({ success: r.modifiedCount > 0 });
  });

  // ───────────── Webhook management ─────────────
  const webhookView = (ep) => ep && ({ url: ep.url, events: ep.events, active: ep.active, lastStatus: ep.lastStatus, lastDeliveryAt: ep.lastDeliveryAt, failureCount: ep.failureCount, secretPreview: "whsec_…" + ep.secret.slice(-4) });

  app.get("/developer/webhook", requireAuth, async (req, res) => {
    const plan = await planOf(req);
    const ep = await WebhookEndpoint.findOne({ userEmail: req.authEmail }).lean();
    res.json({ success: true, allowed: hasFeature(plan, "api"), events: EVENTS, webhook: webhookView(ep) });
  });

  app.put("/developer/webhook", requireAuth, manageLimiter, async (req, res) => {
    if (!gate(res, await planOf(req))) return;
    try { await assertSafePublicUrl(req.body.url); } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
    const events = (Array.isArray(req.body.events) ? req.body.events : EVENTS).filter(e => EVENTS.includes(e));
    if (!events.length) return res.status(400).json({ success: false, error: "Select at least one event." });
    const existing = await WebhookEndpoint.findOne({ userEmail: req.authEmail });
    if (existing) {
      Object.assign(existing, { url: String(req.body.url).trim(), events, active: true, failureCount: 0 });
      await existing.save();
      return res.json({ success: true, webhook: webhookView(existing) });
    }
    const secret = "whsec_" + crypto.randomBytes(24).toString("base64url");
    const ep = await WebhookEndpoint.create({ userEmail: req.authEmail, url: String(req.body.url).trim(), events, secret });
    res.json({ success: true, secret, webhook: webhookView(ep) }); // secret revealed once, on creation
  });

  app.post("/developer/webhook/rotate-secret", requireAuth, manageLimiter, async (req, res) => {
    const secret = "whsec_" + crypto.randomBytes(24).toString("base64url");
    const ep = await WebhookEndpoint.findOneAndUpdate({ userEmail: req.authEmail }, { $set: { secret } }, { new: true });
    if (!ep) return res.status(404).json({ success: false, error: "No webhook configured." });
    res.json({ success: true, secret });
  });

  app.post("/developer/webhook/test", requireAuth, manageLimiter, async (req, res) => {
    const ok = await webhooks.send(req.authEmail, "ping", { message: "Hello from ReelScribe 👋" });
    res.json({ success: true, delivered: ok });
  });

  app.delete("/developer/webhook", requireAuth, async (req, res) => {
    await WebhookEndpoint.deleteOne({ userEmail: req.authEmail });
    res.json({ success: true });
  });

  // ───────────── Public API v1 (Authorization: Bearer rs_live_...) ─────────────
  const hits = new Map(); // per-key rate limit: 30 requests / minute
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > 60000) hits.delete(k); }, 60000).unref();

  async function apiAuth(req, res, next) {
    const header = String(req.headers.authorization || "");
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : String(req.headers["x-api-key"] || "").trim();
    if (!key.startsWith("rs_live_")) return res.status(401).json({ success: false, error: "Missing or invalid API key. Send it as: Authorization: Bearer rs_live_..." });

    const doc = await ApiKey.findOne({ hash: sha256(key), revokedAt: null });
    if (!doc) return res.status(401).json({ success: false, error: "Invalid or revoked API key." });

    const rec = hits.get(String(doc._id)) || { n: 0, start: Date.now() };
    if (Date.now() - rec.start > 60000) { rec.n = 0; rec.start = Date.now(); }
    rec.n++; hits.set(String(doc._id), rec);
    if (rec.n > 30) return res.status(429).json({ success: false, error: "Rate limit: 30 requests per minute per key." });

    const user = await User.findOne({ email: doc.userEmail });
    if (!user) return res.status(401).json({ success: false, error: "Account not found." });
    if (user.isSuspended) return res.status(403).json({ success: false, error: "Account suspended." });
    if (!hasFeature(getEffectivePlan(user), "api")) return res.status(403).json({ success: false, error: `API access requires the ${planNeeded("api")} plan (your plan may have expired).` });

    if (!doc.lastUsedAt || Date.now() - doc.lastUsedAt.getTime() > 60000) ApiKey.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    req.apiUser = user;
    next();
  }

  const sendHttpError = (res, e, fallback) => {
    if (e instanceof HttpError) return res.status(e.status).json({ success: false, error: e.message });
    console.error("[api/v1]", e);
    return res.status(500).json({ success: false, error: fallback });
  };

  app.get("/api/v1/account", apiAuth, async (req, res) => {
    const u = req.apiUser, plan = getEffectivePlan(u), l = PLAN_LIMITS[plan];
    res.json({ success: true, email: u.email, plan, planExpiresAt: u.planExpiresAt, limits: { transcriptsPerDay: l.transcriptDay, transcriptsPerMonth: l.transcriptMonth, clipsPerDay: l.clipDay, clipsPerMonth: l.clipMonth, maxVideoMinutes: l.maxVideoMinutes } });
  });

  app.post("/api/v1/transcripts", apiAuth, async (req, res) => {
    const url = String(req.body.url || "").trim();
    if (!url) return res.status(400).json({ success: false, error: "Body must include a YouTube or Instagram \"url\"." });
    try {
      const r = await runUserUrlTranscription(req.apiUser, url);
      res.status(201).json({ success: true, id: String(r.reel._id), source: r.source, language: r.language, words: r.text.split(/\s+/).filter(Boolean).length, transcript: r.text, segments: r.segments });
    } catch (e) { sendHttpError(res, e, "Couldn't transcribe this video."); }
  });

  app.get("/api/v1/transcripts/:id", apiAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, error: "Not found." });
    const reel = await Reel.findOne({ _id: req.params.id, userEmail: req.apiUser.email }).select("-aiCache").lean();
    if (!reel) return res.status(404).json({ success: false, error: "Not found." });
    const fmt = String(req.query.format || "json").toLowerCase();
    if (fmt === "srt" || fmt === "vtt") {
      if (!reel.segments?.length) return res.status(409).json({ success: false, error: "No timed segments stored for this transcript." });
      res.type(fmt === "vtt" ? "text/vtt" : "text/plain").send(fmt === "srt" ? toSRT(reel.segments) : toVTT(reel.segments));
    } else if (fmt === "txt") res.type("text/plain").send(toPlainText(reel.segments?.length ? reel.segments : [{ text: reel.transcript }]));
    else res.json({ success: true, id: String(reel._id), url: reel.reelUrl, source: reel.source, language: reel.language, createdAt: reel.createdAt, transcript: reel.transcript, segments: reel.segments || [] });
  });

  app.post("/api/v1/clips", apiAuth, async (req, res) => {
    const url = String(req.body.url || "").trim();
    if (!url) return res.status(400).json({ success: false, error: "Body must include a YouTube \"url\"." });
    try {
      const r = await startClipJob({ user: req.apiUser, source: { type: "youtube", url }, captionSettings: req.body.captionSettings, via: "api" });
      if (r.status === 200) r.body.statusUrl = `${PUBLIC_URL()}/api/v1/clips/${r.body.jobId}`;
      res.status(r.status === 200 ? 202 : r.status).json(r.body);
    } catch (e) { sendHttpError(res, e, "Couldn't start the clip job."); }
  });

  app.get("/api/v1/clips/:jobId", apiAuth, async (req, res) => {
    const job = await JobState.findOne({ jobId: String(req.params.jobId), email: req.apiUser.email }).lean();
    if (!job) return res.status(404).json({ success: false, error: "Job not found or expired (jobs are kept for 2 hours)." });
    res.json({ success: true, jobId: job.jobId, status: job.status, error: job.error || undefined,
      clips: job.status === "done" ? job.clips.map(c => ({ title: c.title, url: c.url, duration: c.duration, score: c.score, hook: c.hook, description: c.description, hashtags: c.hashtags })) : undefined });
  });
};
