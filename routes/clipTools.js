// Direct video upload (browser -> S3) and the clip editor (trim / reframe / re-caption / logo).
const path = require("path");
const { AI_LIMITS, hasFeature, planNeeded } = require("../lib/plans");
const { consumeDaily, refundDaily } = require("../lib/quota");

const VIDEO_EXT = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".m4v": "video/x-m4v", ".avi": "video/x-msvideo" };

module.exports = function registerClipTools(ctx) {
  const { app, requireAuth, User, ClipJob, mongoose, axios, s3, crypto, getEffectivePlan, PLAN_LIMITS, rateLimit, EC2_URL, INTERNAL_KEY, uploadPrefix, resolveBrandKit } = ctx;
  const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 6, message: "Too many upload requests. Please wait a minute." });
  const editLimiter = rateLimit({ windowMs: 60 * 1000, max: 6, message: "Too many edit requests. Please wait a minute." });

  // Step 1 of "upload your own video": the browser asks for a short-lived signed URL and PUTs the
  // file straight to S3, so big videos never pass through the web server.
  app.post("/upload-url", requireAuth, uploadLimiter, async (req, res) => {
    const user = await User.findOne({ email: req.authEmail });
    if (!user) return res.status(401).json({ success: false, loginRequired: true, error: "Please log in again." });
    const plan = getEffectivePlan(user);
    const usingReferral = plan === "free" && (user.referralCuts || 0) > 0;
    if (plan === "free" && !usingReferral) return res.status(403).json({ success: false, error: "Uploading videos for clips needs a paid plan (or a referral cut)." });

    const filename = String(req.body.filename || "");
    const size = Number(req.body.size);
    const ext = path.extname(filename).toLowerCase();
    const contentType = VIDEO_EXT[ext];
    if (!contentType) return res.status(400).json({ success: false, error: "Unsupported file type. Use mp4, mov, webm, mkv, m4v or avi." });
    if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ success: false, error: "Missing file size." });

    const maxMB = PLAN_LIMITS[usingReferral ? "starter" : plan].maxMB;
    if (size > maxMB * 1024 * 1024) return res.status(413).json({ success: false, error: `This file is larger than your plan's ${maxMB >= 1024 ? maxMB / 1024 + " GB" : maxMB + " MB"} upload limit.` });

    const key = `${uploadPrefix(user.email)}${crypto.randomUUID()}${ext}`;
    const uploadUrl = await s3.presignUpload(key, contentType, Math.round(size), 900);
    res.json({ success: true, uploadUrl, sourceKey: key, headers: { "Content-Type": contentType }, expiresIn: 900, maxMB });
  });

  // Clip editor. Trims and/or re-renders ONE clip into a NEW clip (the original stays untouched).
  // The heavy lifting happens on the render service (POST {EC2_URL}/edit-clip — see docs/EC2-UPGRADE.md).
  app.post("/clips/:id/:idx/edit", requireAuth, editLimiter, async (req, res) => {
    const idx = Number(req.params.idx);
    if (!mongoose.isValidObjectId(req.params.id) || !Number.isInteger(idx) || idx < 0) return res.status(404).json({ success: false, error: "Clip not found." });

    const user = await User.findOne({ email: req.authEmail });
    if (!user) return res.status(401).json({ success: false, loginRequired: true, error: "Please log in again." });
    const plan = getEffectivePlan(user);
    if (!hasFeature(plan, "editor")) return res.status(403).json({ success: false, error: `The clip editor is available on the ${planNeeded("editor")} plan and above.` });

    const job = await ClipJob.findOne({ _id: req.params.id, userEmail: user.email });
    const clip = job?.clips?.[idx];
    if (!clip || clip.deleted) return res.status(404).json({ success: false, error: "This clip is no longer available (clips are kept for 24 hours)." });

    const startSec = Number(req.body.startSec ?? 0);
    const endSec = Number(req.body.endSec ?? clip.duration);
    const focusX = req.body.focusX === undefined || req.body.focusX === "" ? null : Math.min(100, Math.max(0, Number(req.body.focusX)));
    const wantsRerender = !!req.body.captionSettings || req.body.applyBrand === true || focusX !== null || !!req.body.aspectRatio;
    const trimmed = startSec > 0.05 || (clip.duration && endSec < clip.duration - 0.05);

    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) return res.status(400).json({ success: false, error: "Please choose a valid start and end time." });
    if (clip.duration && endSec > clip.duration + 0.5) return res.status(400).json({ success: false, error: "The end time is beyond the end of the clip." });
    if (endSec - startSec < 3) return res.status(400).json({ success: false, error: "A clip must be at least 3 seconds long." });
    if (!trimmed && !wantsRerender && focusX === null) return res.status(400).json({ success: false, error: "Nothing to change — adjust the trim, caption style or framing first." });
    if (wantsRerender && !clip.sourceKey) return res.status(409).json({ success: false, error: "Caption, logo and framing changes need the original caption-free video, which this older clip doesn't have. You can still trim it, or generate the clip again." });

    if (!(await consumeDaily(User, user._id, "edit", AI_LIMITS[plan].edit))) return res.status(429).json({ success: false, error: `You've used all ${AI_LIMITS[plan].edit} edits for today. They reset at midnight IST.` });

    try {
      const sanitized = req.body.captionSettings ? ctx.sanitizeCaptionSettings?.(req.body.captionSettings) : null;
      const brandKit = req.body.applyBrand === true ? await resolveBrandKit(user) : null;
      const r = await axios.post(`${EC2_URL}/edit-clip`, {
        inputKey: wantsRerender ? clip.sourceKey : clip.s3Key,
        mode: wantsRerender ? "rerender" : "trim",
        startSec, endSec, focusX, captionSettings: sanitized || clip.captionSettings || null, brandKit, plan,
        aspectRatio: req.body.aspectRatio ? String(req.body.aspectRatio).slice(0, 12) : undefined,
      }, { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 300000 });

      const out = r.data?.clip;
      if (!r.data?.success || !out?.url || !out?.s3Key) throw new Error(r.data?.error || "Render failed");

      const edited = {
        title: `${clip.title || "Clip"} (edited)`.slice(0, 200), reason: clip.reason, duration: Number(out.duration) || Math.round(endSec - startSec),
        url: out.url, s3Key: out.s3Key, sourceKey: clip.sourceKey || "", editedFrom: clip.s3Key,
        captionSettings: sanitized || clip.captionSettings || null,
        score: clip.score, scoreNote: clip.scoreNote, hook: clip.hook, description: clip.description, hashtags: clip.hashtags,
      };
      await ClipJob.updateOne({ _id: job._id }, { $push: { clips: edited } });
      res.json({ success: true, clip: { ...edited, idx: job.clips.length } });
    } catch (e) {
      await refundDaily(User, user._id, "edit");
      const status = e.response?.status;
      console.error("[clips/edit] failed:", status || "", e.response?.data || e.message);
      if (status === 404 || e.code === "ECONNREFUSED") return res.status(501).json({ success: false, error: "The editor isn't enabled on the render server yet. (Add the /edit-clip endpoint — see docs/EC2-UPGRADE.md.) You were not charged." });
      res.status(502).json({ success: false, error: "We couldn't render that edit. You were not charged — please try again." });
    }
  });
};
