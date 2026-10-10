// Post scheduler. Clips are only stored for 24h, so schedules must fall inside that window.
// At the scheduled time the user gets an email + in-app item with the caption, hashtags and a
// link to download the clip. Auto-publishing plugs in through ADAPTERS (see bottom of file).
const { hasFeature, planNeeded } = require("../lib/plans");

const PLATFORMS = {
  youtube:  { label: "YouTube Shorts", link: "https://studio.youtube.com" },
  instagram:{ label: "Instagram Reels", link: "https://www.instagram.com/" },
  tiktok:   { label: "TikTok", link: "https://www.tiktok.com/upload" },
  x:        { label: "X (Twitter)", link: "https://x.com/compose/post" },
  linkedin: { label: "LinkedIn", link: "https://www.linkedin.com/feed/" },
  facebook: { label: "Facebook Reels", link: "https://www.facebook.com/reels/create" },
};
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Optional auto-publishers: ADAPTERS.youtube = async ({ post, clip, user }) => { ... return true }.
// If an adapter exists for the platform it publishes automatically; otherwise a reminder email is sent.
const ADAPTERS = {};

module.exports = function registerScheduler(ctx) {
  const { app, requireAuth, User, ClipJob, resend, mongoose, getEffectivePlan, rateLimit, PUBLIC_URL } = ctx;
  const ScheduledPost = require("../models/ScheduledPost");
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: "Too many requests. Please slow down." });

  app.get("/schedule", requireAuth, async (req, res) => {
    const user = await User.findOne({ email: req.authEmail });
    const plan = getEffectivePlan(user);
    const posts = await ScheduledPost.find({ userEmail: req.authEmail, status: { $ne: "cancelled" } }).sort({ scheduledAt: -1 }).limit(50).lean();
    res.json({ success: true, allowed: hasFeature(plan, "scheduler"), planRequired: planNeeded("scheduler"), platforms: Object.entries(PLATFORMS).map(([id, p]) => ({ id, label: p.label })),
      posts: posts.map(p => ({ id: String(p._id), clipTitle: p.clipTitle, platform: p.platform, platformLabel: PLATFORMS[p.platform]?.label, caption: p.caption, scheduledAt: p.scheduledAt, status: p.status, error: p.error })) });
  });

  app.post("/schedule", requireAuth, limiter, async (req, res) => {
    const user = await User.findOne({ email: req.authEmail });
    const plan = getEffectivePlan(user);
    if (!hasFeature(plan, "scheduler")) return res.status(403).json({ success: false, planRequired: planNeeded("scheduler"), error: `Scheduling is available on the ${planNeeded("scheduler")} plan and above.` });

    const { historyId, clipIndex, platform } = req.body;
    const idx = Number(clipIndex);
    if (!mongoose.isValidObjectId(historyId) || !Number.isInteger(idx) || idx < 0) return res.status(400).json({ success: false, error: "Choose a clip to schedule." });
    if (!PLATFORMS[platform]) return res.status(400).json({ success: false, error: "Choose a platform." });

    const when = new Date(req.body.scheduledAt);
    if (isNaN(when.getTime())) return res.status(400).json({ success: false, error: "Choose a valid date and time." });
    if (when.getTime() < Date.now() + 2 * 60 * 1000) return res.status(400).json({ success: false, error: "Pick a time at least 2 minutes from now." });

    const job = await ClipJob.findOne({ _id: historyId, userEmail: user.email });
    const clip = job?.clips?.[idx];
    if (!clip || clip.deleted) return res.status(404).json({ success: false, error: "This clip is no longer available." });

    const clipExpiresAt = new Date(job.createdAt.getTime() + 24 * 3600 * 1000);
    if (when.getTime() > clipExpiresAt.getTime() - 60 * 60 * 1000)
      return res.status(400).json({ success: false, error: `Clips are stored for 24 hours, so schedule it before ${clipExpiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} IST (at least 1 hour before it expires).` });
    if ((await ScheduledPost.countDocuments({ userEmail: user.email, status: "scheduled" })) >= 20) return res.status(409).json({ success: false, error: "You can have up to 20 scheduled posts. Cancel one first." });

    const tags = (clip.hashtags || []).map(h => "#" + h).join(" ");
    const caption = String(req.body.caption || "").trim().slice(0, 2200) || [clip.description, tags].filter(Boolean).join("\n\n");
    const post = await ScheduledPost.create({ userEmail: user.email, historyId: String(job._id), clipIndex: idx, clipTitle: clip.title || "Clip", platform, caption, scheduledAt: when, clipExpiresAt });
    res.json({ success: true, id: String(post._id) });
  });

  app.delete("/schedule/:id", requireAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.json({ success: false });
    const r = await ScheduledPost.updateOne({ _id: req.params.id, userEmail: req.authEmail, status: "scheduled" }, { $set: { status: "cancelled" } });
    res.json({ success: r.modifiedCount > 0 });
  });

  async function deliver(post) {
    const job = await ClipJob.findById(post.historyId);
    const clip = job?.clips?.[post.clipIndex];
    if (!clip || clip.deleted) throw new Error("The clip expired before the scheduled time.");
    const user = await User.findOne({ email: post.userEmail });

    if (ADAPTERS[post.platform]) { await ADAPTERS[post.platform]({ post, clip, user }); return; }

    const p = PLATFORMS[post.platform];
    await resend.emails.send({
      from: process.env.EMAIL_FROM || "ReelScribe <noreply@reelscribe.site>", to: post.userEmail,
      subject: `⏰ Time to post "${post.clipTitle}" on ${p.label}`,
      html: `<div style="font-family:Arial;max-width:560px;margin:auto;padding:24px;background:#f5f3ff"><div style="background:#fff;border-radius:16px;padding:28px">
        <h2 style="margin:0 0 6px">Your scheduled post is ready ⏰</h2>
        <p style="color:#555">Time to publish <b>${esc(post.clipTitle)}</b> on <b>${esc(p.label)}</b>.</p>
        <p style="background:#f3f0ff;padding:14px;border-radius:10px;white-space:pre-wrap;font-size:14px">${esc(post.caption)}</p>
        <p><a href="${PUBLIC_URL()}/clips-dashboard.html" style="display:inline-block;padding:12px 20px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Download clip</a>
        &nbsp; <a href="${p.link}" style="color:#7c3aed;font-weight:700">Open ${esc(p.label)} →</a></p>
        <p style="color:#999;font-size:12px">Clip stays available until ${post.clipExpiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Once you download it, it's removed 5 minutes later.</p></div></div>`,
    });
  }

  async function tick() {
    for (let i = 0; i < 20; i++) {
      const post = await ScheduledPost.findOneAndUpdate({ status: "scheduled", scheduledAt: { $lte: new Date() } }, { $set: { status: "reminded", remindedAt: new Date() } }, { new: true });
      if (!post) break;
      try { await deliver(post); }
      catch (e) { await ScheduledPost.updateOne({ _id: post._id }, { $set: { status: "failed", error: String(e.message).slice(0, 200) } }); }
    }
  }
  setInterval(() => tick().catch(e => console.error("[scheduler] tick failed:", e.message)), 60 * 1000).unref();
};
