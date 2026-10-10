// Brand kit (logo, colours, fonts) and team workspaces — Agency features.
const path = require("path");
const { hasFeature, planNeeded } = require("../lib/plans");
const { sha256 } = require("../lib/security");

const HEX = /^#[0-9a-f]{6}$/i;
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MAX_TEAM_SEATS = 5;

function detectImage(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: "png", type: "image/png" };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return { ext: "webp", type: "image/webp" };
  return null; // SVG deliberately not allowed (can carry scripts)
}

module.exports = function registerStudioRoutes(ctx) {
  const { app, requireAuth, User, BrandKit, Team, ClipJob, resend, multer, s3, mongoose, getEffectivePlan, isValidEmail, rateLimit, PUBLIC_URL } = ctx;
  const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
  const teamLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: "Too many requests. Please slow down." });

  async function getUserPlan(req) {
    const user = await User.findOne({ email: req.authEmail });
    return { user, plan: user ? getEffectivePlan(user) : "free" };
  }
  const gate = (res, plan, feature) => {
    if (hasFeature(plan, feature)) return true;
    res.status(403).json({ success: false, planRequired: planNeeded(feature), error: `This feature is available on the ${planNeeded(feature)} plan.` });
    return false;
  };

  // ───────────── Brand kit ─────────────
  app.get("/brand-kit", requireAuth, async (req, res) => {
    const { plan } = await getUserPlan(req);
    const own = await BrandKit.findOne({ ownerEmail: req.authEmail }).lean();
    let teamKit = null;
    const team = await Team.findOne({ members: { $elemMatch: { email: req.authEmail, status: "active" } } }).select("ownerEmail name").lean();
    if (team) teamKit = await BrandKit.findOne({ ownerEmail: team.ownerEmail }).lean();
    res.json({ success: true, allowed: hasFeature(plan, "brandKit"), planRequired: planNeeded("brandKit"), kit: own, teamKit: teamKit ? { ...teamKit, teamName: team.name } : null });
  });

  app.put("/brand-kit", requireAuth, teamLimiter, async (req, res) => {
    const { plan } = await getUserPlan(req);
    if (!gate(res, plan, "brandKit")) return;
    const b = req.body || {};
    const update = {
      brandName: String(b.brandName || "").trim().slice(0, 60),
      handle: String(b.handle || "").trim().replace(/[^\w.@-]/g, "").slice(0, 40),
      fontName: String(b.fontName || "").trim().replace(/[^\w \-]/g, "").slice(0, 40),
      outroText: String(b.outroText || "").trim().slice(0, 80),
      logoEnabled: b.logoEnabled !== false,
    };
    if (b.primaryColor !== undefined) { if (!HEX.test(b.primaryColor)) return res.status(400).json({ success: false, error: "Primary colour must look like #8b5cf6." }); update.primaryColor = b.primaryColor.toLowerCase(); }
    if (b.accentColor !== undefined) { if (!HEX.test(b.accentColor)) return res.status(400).json({ success: false, error: "Accent colour must look like #ec4899." }); update.accentColor = b.accentColor.toLowerCase(); }
    if (b.logoPosition !== undefined) {
      if (!["top-left", "top-right", "bottom-left", "bottom-right"].includes(b.logoPosition)) return res.status(400).json({ success: false, error: "Invalid logo position." });
      update.logoPosition = b.logoPosition;
    }
    const kit = await BrandKit.findOneAndUpdate({ ownerEmail: req.authEmail }, { $set: update }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    res.json({ success: true, kit });
  });

  app.post("/brand-kit/logo", requireAuth, teamLimiter, (req, res, next) => {
    logoUpload.single("logo")(req, res, (err) => {
      if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, error: "Logo must be under 2 MB." });
      if (err) return next(err);
      next();
    });
  }, async (req, res) => {
    const { plan } = await getUserPlan(req);
    if (!gate(res, plan, "brandKit")) return;
    if (!req.file) return res.status(400).json({ success: false, error: "Please choose a PNG, JPG or WebP logo." });
    const img = detectImage(req.file.buffer);
    if (!img) return res.status(415).json({ success: false, error: "Logo must be a PNG, JPG or WebP image." });

    const key = `brand/${sha256(req.authEmail).slice(0, 16)}/logo-${Date.now()}.${img.ext}`;
    const logoUrl = await s3.uploadBufferToS3(req.file.buffer, key, img.type);
    const prev = await BrandKit.findOneAndUpdate({ ownerEmail: req.authEmail }, { $set: { logoUrl, logoKey: key } }, { upsert: true, new: false, setDefaultsOnInsert: true });
    if (prev?.logoKey) s3.deleteFromS3(prev.logoKey).catch(() => {});
    res.json({ success: true, logoUrl });
  });

  app.delete("/brand-kit/logo", requireAuth, async (req, res) => {
    const prev = await BrandKit.findOneAndUpdate({ ownerEmail: req.authEmail }, { $set: { logoUrl: "", logoKey: "" } });
    if (prev?.logoKey) s3.deleteFromS3(prev.logoKey).catch(() => {});
    res.json({ success: true });
  });

  // ───────────── Teams ─────────────
  const activeMembership = (email) => Team.findOne({ members: { $elemMatch: { email, status: "active" } } });

  app.get("/team", requireAuth, async (req, res) => {
    const { plan } = await getUserPlan(req);
    const email = req.authEmail;
    const owned = await Team.findOne({ ownerEmail: email }).lean();
    const member = owned ? null : await activeMembership(email).then(t => t && t.toObject());
    const invites = await Team.find({ members: { $elemMatch: { email, status: "invited" } } }).select("name ownerEmail").lean();
    const view = (t) => t && { id: String(t._id), name: t.name, ownerEmail: t.ownerEmail, members: (t.members || []).map(m => ({ email: m.email, status: m.status })) };
    res.json({
      success: true, canCreate: hasFeature(plan, "team"), planRequired: planNeeded("team"), seats: MAX_TEAM_SEATS,
      role: owned ? "owner" : member ? "member" : null,
      team: view(owned || member),
      invites: invites.map(t => ({ teamId: String(t._id), name: t.name, ownerEmail: t.ownerEmail })),
    });
  });

  app.post("/team", requireAuth, teamLimiter, async (req, res) => {
    const { plan } = await getUserPlan(req);
    if (!gate(res, plan, "team")) return;
    const name = String(req.body.name || "").trim().slice(0, 60);
    if (name.length < 2) return res.status(400).json({ success: false, error: "Please enter a team name." });
    if (await Team.exists({ ownerEmail: req.authEmail })) return res.status(409).json({ success: false, error: "You already have a team." });
    if (await activeMembership(req.authEmail)) return res.status(409).json({ success: false, error: "You're already a member of another team. Leave it first." });
    const team = await Team.create({ name, ownerEmail: req.authEmail, members: [] });
    res.json({ success: true, teamId: String(team._id) });
  });

  app.post("/team/invite", requireAuth, teamLimiter, async (req, res) => {
    const { plan } = await getUserPlan(req);
    if (!gate(res, plan, "team")) return;
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Please enter a valid email address." });
    if (email === req.authEmail) return res.status(400).json({ success: false, error: "You're already the team owner." });
    const team = await Team.findOne({ ownerEmail: req.authEmail });
    if (!team) return res.status(404).json({ success: false, error: "Create a team first." });
    if (team.members.some(m => m.email === email)) return res.status(409).json({ success: false, error: "This person is already invited." });
    if (team.members.length >= MAX_TEAM_SEATS) return res.status(409).json({ success: false, error: `Your team is full (${MAX_TEAM_SEATS} seats).` });

    await Team.updateOne({ _id: team._id }, { $push: { members: { email, status: "invited" } } });
    // Best-effort invitation email — the invite also shows up inside the app after they log in.
    resend.emails.send({
      from: process.env.EMAIL_FROM || "ReelScribe <noreply@reelscribe.site>", to: email,
      subject: `${team.ownerEmail} invited you to a ReelScribe team`,
      html: `<div style="font-family:Arial;max-width:520px;margin:auto;padding:24px"><h2>You're invited 🎬</h2><p><b>${esc(team.ownerEmail)}</b> invited you to join <b>${esc(team.name)}</b> on ReelScribe. Members use the team's brand kit on their clips.</p><p><a href="${PUBLIC_URL()}/studio.html#team" style="display:inline-block;padding:12px 22px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">View invitation</a></p></div>`,
    }).catch(() => {});
    res.json({ success: true });
  });

  app.post("/team/accept", requireAuth, teamLimiter, async (req, res) => {
    if (!mongoose.isValidObjectId(req.body.teamId)) return res.status(404).json({ success: false, error: "Invitation not found." });
    if (await Team.exists({ ownerEmail: req.authEmail })) return res.status(409).json({ success: false, error: "You own a team, so you can't join another." });
    if (await activeMembership(req.authEmail)) return res.status(409).json({ success: false, error: "You're already in a team. Leave it first." });
    const t = await Team.findOneAndUpdate(
      { _id: req.body.teamId, members: { $elemMatch: { email: req.authEmail, status: "invited" } } },
      { $set: { "members.$.status": "active", "members.$.joinedAt": new Date() } }, { new: true });
    if (!t) return res.status(404).json({ success: false, error: "Invitation not found." });
    res.json({ success: true });
  });

  app.post("/team/decline", requireAuth, async (req, res) => {
    if (!mongoose.isValidObjectId(req.body.teamId)) return res.json({ success: true });
    await Team.updateOne({ _id: req.body.teamId }, { $pull: { members: { email: req.authEmail, status: "invited" } } });
    res.json({ success: true });
  });

  app.post("/team/leave", requireAuth, async (req, res) => {
    await Team.updateMany({ members: { $elemMatch: { email: req.authEmail } } }, { $pull: { members: { email: req.authEmail } } });
    res.json({ success: true });
  });

  app.delete("/team/members/:email", requireAuth, async (req, res) => {
    const r = await Team.updateOne({ ownerEmail: req.authEmail }, { $pull: { members: { email: String(req.params.email).toLowerCase() } } });
    res.json({ success: r.modifiedCount > 0 });
  });

  app.delete("/team", requireAuth, async (req, res) => {
    await Team.deleteOne({ ownerEmail: req.authEmail });
    res.json({ success: true });
  });

  // Owner overview: who made what in the last 24h (titles + scores only, never download links).
  app.get("/team/clips", requireAuth, async (req, res) => {
    const team = await Team.findOne({ ownerEmail: req.authEmail }).lean();
    if (!team) return res.status(404).json({ success: false, error: "You don't own a team." });
    const emails = team.members.filter(m => m.status === "active").map(m => m.email);
    if (!emails.length) return res.json({ success: true, jobs: [] });
    const jobs = await ClipJob.find({ userEmail: { $in: emails }, createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, jobs: jobs.map(j => ({ member: j.userEmail, title: j.ytTitle || j.ytUrl, createdAt: j.createdAt, clips: (j.clips || []).filter(c => !c.deleted).length, topScore: Math.max(0, ...(j.clips || []).map(c => c.score || 0)) })) });
  });
};
