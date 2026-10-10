// ═══════════════════════════════════════════════════════
//  RENDER SERVER — server.js
//  Handles: auth, OTP, payment, transcription, routing
//  Clips: forwarded to EC2
// ═══════════════════════════════════════════════════════
require("dotenv").config();

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required. Refusing to start with an insecure session configuration.");
}

const express    = require("express");
const mongoose   = require("mongoose");
const multer     = require("multer");
const path       = require("path");
const fs         = require("fs");
const cors       = require("cors");
const Groq       = require("groq-sdk");
const session    = require("express-session");
const passport   = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const axios      = require("axios");
const https      = require("https");
const { YoutubeTranscript } = require("youtube-transcript");
const { Resend }            = require("resend");
const Reel        = require("./models/Reel");
const User        = require("./models/User");
const GuestUsage  = require("./models/GuestUsage");
const Referral     = require("./models/Referral");
const ClipJob     = require("./models/Clip");
const AdminLog    = require("./models/AdminLog");
const Payment     = require("./models/Payment");
const Coupon      = require("./models/Coupon");
const CouponRedemption = require("./models/CouponRedemption");
const Razorpay    = require("razorpay");
const crypto      = require("crypto");
const { createAI } = require("./lib/ai");
const { safeEqual, safeRedirectPath } = require("./lib/security");
const { dayKey, monthKey } = require("./lib/quota");
const { segmentsFromYoutube, segmentsFromWhisper, decodeEntities } = require("./lib/subtitles");
const { createWebhookSender } = require("./lib/webhooks");
const JobState = require("./models/JobState");
const WebhookEndpoint = require("./models/WebhookEndpoint");
const BrandKit = require("./models/BrandKit");
const Team = require("./models/Team");
const s3 = require("./services/s3Service");

const resend  = new Resend(process.env.RESEND_API_KEY);
const app     = express();

// ── Async-safe routing ─────────────────────────────────────
// Express 4 does not catch rejected promises from async handlers. A single unhandled DB error
// in any async route used to hang the request and (on Node 15+) could crash the whole server.
// This forwards every async rejection to the central error handler instead.
for (const method of ["get", "post", "put", "patch", "delete"]) {
  const original = app[method].bind(app);
  app[method] = (route, ...handlers) => {
    if (!handlers.length) return original(route); // app.get("setting")
    return original(route, ...handlers.map(h =>
      typeof h === "function" && h.length < 4
        ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)
        : h));
  };
}
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
const groq    = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ai       = createAI(groq);
const webhooks = createWebhookSender(WebhookEndpoint);
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const EC2_URL       = process.env.EC2_URL;
const INTERNAL_KEY  = process.env.INTERNAL_SECRET;

const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

const PLAN_LIMITS = {
  free:    { transcriptDay: 2,  transcriptMonth: 5,   clipDay: 0,  clipMonth: 0,  maxMB: 100,  maxVideoMinutes: 0   },
  starter: { transcriptDay: 5,  transcriptMonth: 30,  clipDay: 2,  clipMonth: 10, maxMB: 500,  maxVideoMinutes: 40  },
  pro:     { transcriptDay: 10, transcriptMonth: 60,  clipDay: 5,  clipMonth: 15, maxMB: 1024, maxVideoMinutes: 70  },
  agency:  { transcriptDay: 20, transcriptMonth: 150, clipDay: 15, clipMonth: 60, maxMB: 2048, maxVideoMinutes: 120 },
};

app.set("trust proxy", 1);
app.disable("x-powered-by");

// Hardened security headers without introducing another dependency.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  res.setHeader("X-XSS-Protection", "0"); // deprecated in modern browsers; CSP below is the real defense
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self)");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' https://checkout.razorpay.com 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://api.razorpay.com https://*.amazonaws.com",
      "frame-src https://api.razorpay.com https://checkout.razorpay.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  next();
});

app.use(cors({
  origin: ["https://reelscribe.site", "https://www.reelscribe.site"],
  credentials: true,
}));
app.use(express.json({
  limit: "1mb",
  // Keep the raw bytes around so the Razorpay webhook route can verify the
  // HMAC signature against the exact payload Razorpay signed.
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// ── NoSQL injection guard ──────────────────────────────────
// Strips any key starting with "$" or containing "." from user-controlled
// input so it can never be interpreted as a Mongo operator/path by mistake.
function sanitizeObject(obj) {
  if (Array.isArray(obj)) {
    for (const item of obj) sanitizeObject(item);
    return obj;
  }
  if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj)) {
      if (key.startsWith("$") || key.includes(".")) {
        delete obj[key];
        continue;
      }
      sanitizeObject(obj[key]);
    }
  }
  return obj;
}
app.use((req, res, next) => {
  if (req.body)   sanitizeObject(req.body);
  if (req.params) sanitizeObject(req.params);
  if (req.query)  sanitizeObject(req.query);
  next();
});

// ── Lightweight in-memory rate limiter (no extra dependency) ──────────────
// Suitable for a single-instance Render deployment. Keyed by IP + route.
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of hits) {
      if (now - rec.windowStart > windowMs) hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = (req.ip || "unknown") + ":" + req.baseUrl + req.path;
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || now - rec.windowStart > windowMs) {
      rec = { count: 0, windowStart: now };
      hits.set(key, rec);
    }
    rec.count++;
    if (rec.count > max) {
      return res.status(429).json({ success: false, error: message || "Too many requests. Please slow down and try again shortly." });
    }
    next();
  };
}

// Generous global ceiling — catches scripted abuse without affecting real users.
const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: "Too many requests. Please slow down." });
app.use(globalLimiter);

// Tighter limits for expensive/abuse-prone routes.
const transcribeLimiter   = rateLimit({ windowMs: 60 * 1000, max: 6,   message: "Too many transcription requests. Please wait a minute and try again." });
const clipLimiter         = rateLimit({ windowMs: 60 * 1000, max: 6,   message: "Too many clip requests. Please wait a minute and try again." });
const authLimiter         = rateLimit({ windowMs: 60 * 1000, max: 10,  message: "Too many attempts. Please wait a minute and try again." });
// Generous: Razorpay's own servers call this, so it must never be the bottleneck.
const webhookLimiter      = rateLimit({ windowMs: 60 * 1000, max: 100, message: "Too many webhook calls." });

app.use(express.static("public"));
let sessionStore;
try {
  const MongoStore = require("connect-mongo");
  sessionStore = MongoStore.create({ mongoUrl: process.env.MONGO_URI, collectionName: "sessions", ttl: 30 * 24 * 60 * 60 });
} catch (e) {
  console.warn("⚠️  connect-mongo not installed — falling back to in-memory sessions (users get logged out on every deploy). Run: npm install");
}
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));
app.use(passport.initialize());
app.use(passport.session());

function getSessionEmail(req) {
  return (req.user && req.user.email) || req.session?.userEmail || null;
}

async function requireAuth(req, res, next) {
  const email = getSessionEmail(req);
  if (!email) return res.status(401).json({ success: false, loginRequired: true, error: "Please log in to continue." });
  try {
    const user = await User.findOne({ email }).select("_id email isSuspended lastActiveAt");
    if (!user) return res.status(401).json({ success: false, loginRequired: true, error: "Account not found. Please log in again." });
    if (user.isSuspended) return res.status(403).json({ success: false, suspended: true, error: "Your account is currently suspended. Please contact support." });
    req.authEmail = user.email;
    // Keep activity useful without writing on every single request.
    if (!user.lastActiveAt || Date.now() - new Date(user.lastActiveAt).getTime() > 5 * 60 * 1000) {
      User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Legacy /proxy-upload has been removed. Large uploads should go through the
// authenticated transcript flow or the dedicated clip-processing service.

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

const otpStore = {};

const otpSendLimiter   = {};
const otpVerifyAttempts = {};

const OTP_SEND_MAX_PER_WINDOW   = 3;
const OTP_SEND_WINDOW_MS        = 15 * 60 * 1000;
const OTP_VERIFY_MAX_ATTEMPTS   = 5;
const OTP_VERIFY_WINDOW_MS      = 15 * 60 * 1000;

function checkOtpSendLimit(email) {
  const now = Date.now();
  const rec = otpSendLimiter[email];
  if (!rec || now - rec.windowStart > OTP_SEND_WINDOW_MS) {
    otpSendLimiter[email] = { count: 1, windowStart: now };
    return { allowed: true };
  }
  if (rec.count >= OTP_SEND_MAX_PER_WINDOW) {
    const waitMin = Math.ceil((OTP_SEND_WINDOW_MS - (now - rec.windowStart)) / 60000);
    return { allowed: false, error: `Too many OTP requests. Please try again in ${waitMin} minute${waitMin === 1 ? "" : "s"}.` };
  }
  rec.count++;
  return { allowed: true };
}

function checkOtpVerifyLimit(email) {
  const now = Date.now();
  const rec = otpVerifyAttempts[email];
  if (!rec || now - rec.windowStart > OTP_VERIFY_WINDOW_MS) {
    otpVerifyAttempts[email] = { count: 1, windowStart: now };
    return { allowed: true };
  }
  if (rec.count >= OTP_VERIFY_MAX_ATTEMPTS) {
    return { allowed: false, error: "Too many incorrect attempts. Please request a new code." };
  }
  rec.count++;
  return { allowed: true };
}

setInterval(() => {
  const now = Date.now();
  for (const k in otpSendLimiter)    if (now - otpSendLimiter[k].windowStart > OTP_SEND_WINDOW_MS) delete otpSendLimiter[k];
  for (const k in otpVerifyAttempts) if (now - otpVerifyAttempts[k].windowStart > OTP_VERIFY_WINDOW_MS) delete otpVerifyAttempts[k];
}, 10 * 60 * 1000);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try { done(null, await User.findById(id)); } catch (err) { done(err, null); }
});
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL,
  passReqToCallback: true,
}, async (req, accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value.toLowerCase().trim();
    let user = await User.findOne({ email });
    if (!user) {
      const referralCode = req.session.referralCode || null;
      const fp = requestFingerprints(req);
      const emailIdentity = normalizeEmailIdentity(email);
      if (await hasEmailIdentityConflict(email)) return done(null, null);
      user = await User.create({ name: profile.displayName, email, credits: 5, referredBy: referralCode, emailIdentity, signupIpHash: fp.ipHash, signupUaHash: fp.uaHash });
      if (referralCode) await createReferralRecord(referralCode, email, req);
      delete req.session.referralCode;
    }
    return done(null, user);
  } catch (err) { return done(err, null); }
}));

const ALLOWED_VIDEO_MIME = new Set([
  "video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-msvideo", "video/3gpp", "video/x-m4v",
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/mp4", "audio/x-m4a", "audio/m4a",
  "audio/aac", "audio/ogg", "audio/flac", "audio/x-flac", "audio/webm",
]);
const ALLOWED_VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".3gp", ".m4v", ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename:    (req, file, cb) => {
    // Never trust the client-supplied filename beyond its extension.
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}_${crypto.randomBytes(6).toString("hex")}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 1 }, // Keep aligned with the transcription provider upload ceiling.
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_VIDEO_MIME.has(file.mimetype) || !ALLOWED_VIDEO_EXT.has(ext)) {
      return cb(new Error("UNSUPPORTED_FILE_TYPE"));
    }
    cb(null, true);
  },
});


const adminAuthAttempts = {};
const ADMIN_MAX_ATTEMPTS  = 5;
const ADMIN_WINDOW_MS     = 15 * 60 * 1000;
const ADMIN_BLOCK_MS      = 30 * 60 * 1000;

function adminAuth(req, res, next) {
  if (req.session?.isAdmin) return next();

  const ip  = req.ip || "unknown";
  const now = Date.now();
  const rec = adminAuthAttempts[ip];

  if (rec?.blockedUntil && now < rec.blockedUntil) {
    const waitMin = Math.ceil((rec.blockedUntil - now) / 60000);
    return res.status(429).json({ success: false, error: `Too many incorrect attempts. Please try again in ${waitMin} minute${waitMin === 1 ? "" : "s"}.` });
  }

  if (!process.env.ADMIN_SECRET || !safeEqual(req.headers["x-admin-key"], process.env.ADMIN_SECRET)) {
    if (!rec || now - rec.windowStart > ADMIN_WINDOW_MS) {
      adminAuthAttempts[ip] = { count: 1, windowStart: now, blockedUntil: null };
    } else {
      rec.count++;
      if (rec.count >= ADMIN_MAX_ATTEMPTS) rec.blockedUntil = now + ADMIN_BLOCK_MS;
    }
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  delete adminAuthAttempts[ip];
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const k in adminAuthAttempts) {
    const r = adminAuthAttempts[k];
    if ((!r.blockedUntil || now > r.blockedUntil) && now - r.windowStart > ADMIN_WINDOW_MS) delete adminAuthAttempts[k];
  }
}, 10 * 60 * 1000);

function internalAuth(req, res, next) {
  if (!INTERNAL_KEY || !safeEqual(req.headers["x-internal-key"], INTERNAL_KEY))
    return res.status(401).json({ success: false, error: "Unauthorized" });
  next();
}

function isValidEmail(email) {
  return typeof email === "string" &&
    email.length > 0 && email.length < 255 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── REFERRAL SECURITY HELPERS ──────────────────────────────
// Store one-way request fingerprints; never store raw IP addresses.
function getRequestIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").trim();
}

function fingerprint(value) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET || "referral-fingerprint")
    .update(String(value || "unknown"))
    .digest("hex");
}

function requestFingerprints(req) {
  const ip = getRequestIp(req);
  const ua = String(req.get("user-agent") || "unknown");
  return { ipHash: fingerprint(ip), uaHash: fingerprint(ua) };
}

function normalizeEmailIdentity(email) {
  const raw = String(email || "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at < 1) return raw;
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.split("+")[0].replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

async function hasEmailIdentityConflict(email) {
  const identity = normalizeEmailIdentity(email);
  // Exact/canonical identities are cheap to check through the indexed field.
  if (await User.findOne({ emailIdentity: identity }).select("_id").lean()) return true;
  // Backward compatibility: users created before this field existed have no identity.
  // Only scan Gmail-family accounts, then normalize in application code.
  const domain = identity.split("@")[1];
  if (domain !== "gmail.com") return false;
  const legacy = await User.find({ email: /@(gmail\.com|googlemail\.com)$/i }).select("email").lean();
  return legacy.some(u => normalizeEmailIdentity(u.email) === identity);
}

// Referral-code probing is deliberately rate-limited separately from login/OTP.
const referralCodeAttempts = {};
const REFERRAL_CODE_MAX = 20;
const REFERRAL_CODE_WINDOW_MS = 10 * 60 * 1000;
function checkReferralCodeLimit(req) {
  const key = getRequestIp(req);
  const now = Date.now();
  const rec = referralCodeAttempts[key];
  if (!rec || now - rec.windowStart > REFERRAL_CODE_WINDOW_MS) {
    referralCodeAttempts[key] = { count: 1, windowStart: now };
    return { allowed: true };
  }
  if (rec.count >= REFERRAL_CODE_MAX) return { allowed: false };
  rec.count++;
  return { allowed: true };
}

// Daily/monthly limits reset at midnight IST (the Render server clock is UTC, which used to
// reset Indian users' "daily" limits at 5:30 AM).
function isNewDay(lastDate) {
  if (!lastDate) return true;
  return dayKey(new Date(lastDate)) !== dayKey();
}

function isNewMonth(lastDate) {
  if (!lastDate) return true;
  return monthKey(new Date(lastDate)) !== monthKey();
}

async function checkGuestLimit(req) {
  const ipHash = fingerprint(getRequestIp(req));
  // Atomically consume one of the three previews. If several requests arrive
  // together, MongoDB still cannot let the counter exceed the limit.
  const guest = await GuestUsage.findOneAndUpdate(
    { ipHash, previewCount: { $lt: 3 } },
    { $inc: { previewCount: 1 }, $set: { updatedAt: new Date() }, $setOnInsert: { ipHash } },
    { new: true, upsert: false }
  );
  if (guest) return { allowed: true };

  try {
    const created = await GuestUsage.create({ ipHash, previewCount: 1 });
    return { allowed: !!created };
  } catch (err) {
    if (err?.code === 11000) return { allowed: false };
    throw err;
  }
}

async function getInstagramVideoUrl(instagramUrl) {
  const response = await axios.get(
    "https://instagram-downloader-scraper-reels-igtv-posts-stories.p.rapidapi.com/scraper",
    {
      params:  { url: instagramUrl },
      headers: {
        "x-rapidapi-key":  process.env.RAPID_API_KEY,
        "x-rapidapi-host": "instagram-downloader-scraper-reels-igtv-posts-stories.p.rapidapi.com",
      },
    }
  );
  if (response.data?.data?.length > 0 && response.data.data[0].media)
    return response.data.data[0].media;
  throw new Error("Couldn't find a video at that URL.");
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function downloadVideo(videoUrl, outputPath, maxBytes = 25 * 1024 * 1024) {
  let u;
  try { u = new URL(videoUrl); } catch { throw new Error("Bad media URL"); }
  if (u.protocol !== "https:") throw new Error("Media URL must be https");
  const response = await axios.get(videoUrl, { responseType: "stream", timeout: 60000, maxRedirects: 3, maxContentLength: maxBytes, validateStatus: s => s === 200 });
  const declared = Number(response.headers["content-length"] || 0);
  if (declared > maxBytes) { response.data.destroy(); throw new HttpError(413, "This video is larger than 25 MB, so it can't be transcribed from a link. Please upload a shorter clip or the audio only."); }
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    let received = 0;
    response.data.on("data", chunk => {
      received += chunk.length;
      if (received > maxBytes) { response.data.destroy(new HttpError(413, "This video is larger than 25 MB, so it can't be transcribed from a link. Please upload a shorter clip or the audio only.")); }
    });
    response.data.on("error", err => { file.destroy(); fs.unlink(outputPath, () => {}); reject(err); });
    file.on("error", reject);
    file.on("finish", resolve);
    response.data.pipe(file);
  });
}

function getEffectivePlan(user) {
  const plan = user.plan || "free";
  if (plan === "free") return "free";
  if (!user.planExpiresAt || new Date(user.planExpiresAt) < new Date()) return "free";
  return plan;
}

// ── REFERRALS ─────────────────────────────────────────────
// One verified new signup through a referral gives the referrer
// one Starter-equivalent clip cut. Referral cuts are separate from
// paid-plan clip limits and request a watermark from the EC2 renderer.
function makeReferralCode() {
  return crypto.randomBytes(6).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
}

async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  for (let i = 0; i < 8; i++) {
    const code = makeReferralCode();
    try {
      const updated = await User.findOneAndUpdate(
        { _id: user._id, $or: [{ referralCode: { $exists: false } }, { referralCode: null }, { referralCode: "" }] },
        { $set: { referralCode: code } },
        { new: true }
      );
      if (updated?.referralCode) return updated.referralCode;
      const fresh = await User.findById(user._id);
      if (fresh?.referralCode) return fresh.referralCode;
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  throw new Error("Could not create a referral code. Please try again.");
}

async function createReferralRecord(referralCode, newUserEmail, req) {
  const code = String(referralCode || "").trim().toUpperCase();
  if (!code || !isValidEmail(newUserEmail)) return null;
  const referrer = await User.findOne({ referralCode: code });
  if (!referrer) return null;
  if (referrer.email.toLowerCase() === newUserEmail.toLowerCase()) return null;

  const fp = requestFingerprints(req);
  const knownReferrerIp = referrer.signupIpHash || referrer.lastSeenIpHash;
  const knownReferrerUa = referrer.signupUaHash || referrer.lastSeenUaHash;
  const sameIp = !!knownReferrerIp && knownReferrerIp === fp.ipHash;
  const sameUa = !!knownReferrerUa && knownReferrerUa === fp.uaHash;
  const status = sameIp ? "pending_review" : "pending";
  const riskReason = sameIp ? (sameUa ? "same_ip_and_device_signal" : "same_ip") : null;

  return Referral.findOneAndUpdate(
    { referredEmail: newUserEmail.toLowerCase() },
    {
      $setOnInsert: {
        referrerEmail: referrer.email.toLowerCase(),
        referredEmail: newUserEmail.toLowerCase(),
        referralCode: code,
        status,
        referredIpHash: fp.ipHash,
        referredUaHash: fp.uaHash,
        referrerIpHash: referrer.signupIpHash || null,
        referrerUaHash: referrer.signupUaHash || null,
        riskReason
      }
    },
    { upsert: true, new: true }
  );
}

async function creditReferralAfterFirstTranscript(user, qualifyingWords = 0) {
  if (!user?.referredBy) return false;
  // A referral reward requires a meaningful first transcript, not a tiny caption stub.
  if (Number(qualifyingWords || 0) < 50) return false;
  // Give the new account a short cooling-off period before it can generate a reward.
  if (user.createdAt && Date.now() - new Date(user.createdAt).getTime() < 10 * 60 * 1000) return false;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const referrer = await User.findOne({ referralCode: String(user.referredBy).toUpperCase() }).select("email signupIpHash signupUaHash lastSeenIpHash lastSeenUaHash").lean();
  const referrerEmail = referrer?.email?.toLowerCase();
  if (!referrerEmail) return false;

  const monthlyEarned = await Referral.countDocuments({
    referrerEmail,
    status: "credited",
    creditedAt: { $gte: monthStart }
  });
  if (monthlyEarned >= 5) return false;

  const referral = await Referral.findOneAndUpdate(
    { referredEmail: user.email.toLowerCase(), status: "pending" },
    { $set: { status: "credited", creditedAt: new Date() } },
    { new: true }
  );
  if (!referral) return false;

  await User.findOneAndUpdate(
    { email: referral.referrerEmail },
    { $inc: { referralCuts: 1, referralsCount: 1 } }
  );
  return true;
}


app.get("/ref/:code", async (req, res) => {
  const limit = checkReferralCodeLimit(req);
  if (!limit.allowed) return res.status(429).send("Too many referral-link attempts. Please try again later.");
  const code = String(req.params.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(code)) return res.redirect("/login.html");
  const referrer = await User.findOne({ referralCode: code }).select("_id").lean();
  if (!referrer) return res.redirect("/login.html");
  req.session.referralCode = code;
  req.session.referralLandingFp = requestFingerprints(req);
  res.redirect("/login.html?ref=" + encodeURIComponent(code));
});

app.get("/referral", requireAuth, async (req, res) => {
  try {
    const user = await User.findOne({ email: req.authEmail });
    if (!user) return res.status(404).json({ success: false, error: "User not found." });
    const fp = requestFingerprints(req);
    await User.updateOne({ _id: user._id }, { $set: { lastSeenIpHash: fp.ipHash, lastSeenUaHash: fp.uaHash } });
    const code = await ensureReferralCode(user);
    const base = process.env.PUBLIC_SITE_URL || "https://reelscribe.site";
    const activity = await Referral.find({ referrerEmail: user.email.toLowerCase() })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthlyEarned = await Referral.countDocuments({
      referrerEmail: user.email.toLowerCase(), status: "credited", creditedAt: { $gte: monthStart }
    });
    res.json({
      success: true,
      referralCode: code,
      referralLink: `${base.replace(/\/$/, "")}/ref/${code}`,
      referralsCount: user.referralsCount || 0,
      referralCuts: user.referralCuts || 0,
      pending: activity.filter(r => r.status !== "credited").length,
      earned: activity.filter(r => r.status === "credited").length,
      monthlyEarned,
      monthlyCap: 5,
      activity: activity.map(r => ({
        name: r.referredEmail.split("@")[0],
        date: new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
        status: r.status === "credited" ? "done" : r.status === "rejected" ? "rejected" : "pending"
      }))
    });
  } catch (e) {
    console.error("[/referral] failed:", e);
    res.status(500).json({ success: false, error: "Couldn't load your referral details right now. Please try again." });
  }
});

function getYouTubeVideoId(url) {
  const patterns = [
    /youtube\.com\/watch\?v=([^&]+)/,
    /youtu\.be\/([^?]+)/,
    /youtube\.com\/shorts\/([^?]+)/,
    /youtube\.com\/embed\/([^?]+)/,
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

function isValidYouTubeUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return /^\/[A-Za-z0-9_-]{6,20}$/.test(u.pathname);
    if (host !== "youtube.com" && host !== "m.youtube.com") return false;
    if (u.pathname === "/watch") return /^[A-Za-z0-9_-]{6,20}$/.test(u.searchParams.get("v") || "");
    return /^\/(shorts|embed)\/[A-Za-z0-9_-]{6,20}$/.test(u.pathname);
  } catch { return false; }
}

function isValidInstagramUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!["instagram.com", "m.instagram.com"].includes(host)) return false;
    return /^\/(reel|reels|p|tv)\/[A-Za-z0-9_-]+/.test(u.pathname);
  } catch { return false; }
}

async function getYouTubeDurationSeconds(url) {
  const videoId = getYouTubeVideoId(url);
  if (!videoId) return null;
  try {
    const { data: html } = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    });
    const match = html.match(/"lengthSeconds":"(\d+)"/);
    return match ? parseInt(match[1], 10) : null;
  } catch (e) {
    console.error("YouTube duration fetch failed:", e.message);
    return null;
  }
}

async function checkTranscriptLimit(user) {
  const plan   = getEffectivePlan(user);
  const limits = PLAN_LIMITS[plan];

  let usedDay   = user.transcriptsUsedToday  || 0;
  let usedMonth = user.transcriptsUsedMonth  || 0;

  if (isNewDay(user.lastTranscriptDate))       usedDay   = 0;
  if (isNewMonth(user.lastTranscriptResetDate)) usedMonth = 0;

  if (usedDay >= limits.transcriptDay)
    return { allowed: false, error: `Daily limit reached (${limits.transcriptDay}/day). Come back tomorrow or upgrade your plan.` };
  if (usedMonth >= limits.transcriptMonth)
    return { allowed: false, error: `Monthly limit reached (${limits.transcriptMonth}/month). Upgrade your plan for more.` };

  return { allowed: true };
}

async function checkClipLimit(user) {
  const plan   = getEffectivePlan(user);
  const limits = PLAN_LIMITS[plan];

  let usedDay   = user.clipsUsedToday || 0;
  let usedMonth = user.clipsUsedMonth || 0;

  if (isNewDay(user.lastClipDate))   usedDay   = 0;
  if (isNewMonth(user.lastClipDate)) usedMonth = 0;

  if (usedDay >= limits.clipDay)
    return { allowed: false, error: `Daily clip limit reached (${limits.clipDay}/day). Come back tomorrow or upgrade your plan.` };
  if (usedMonth >= limits.clipMonth)
    return { allowed: false, error: `Monthly clip limit reached (${limits.clipMonth}/month). Upgrade your plan for more.` };

  return { allowed: true };
}

const USAGE_FIELDS = {
  transcript: { day: "transcriptsUsedToday", month: "transcriptsUsedMonth", lastDay: "lastTranscriptDate", lastMonth: "lastTranscriptResetDate", dayLimit: "transcriptDay", monthLimit: "transcriptMonth" },
  clip:       { day: "clipsUsedToday",       month: "clipsUsedMonth",       lastDay: "lastClipDate",       lastMonth: "lastClipDate",            dayLimit: "clipDay",       monthLimit: "clipMonth" },
};

// MongoDB expressions: "how many used today / this month" accounting for the IST rollover.
function usageExprs(f) {
  const today = dayKey(), month = monthKey();
  const fmt = (field, format) => ({ $dateToString: { format, date: { $ifNull: [`$${field}`, new Date(0)] }, timezone: "+05:30" } });
  return {
    sameDay:   { $eq: [fmt(f.lastDay, "%Y-%m-%d"), today] },
    sameMonth: { $eq: [fmt(f.lastMonth, "%Y-%m"), month] },
    usedDay:   { $cond: [{ $eq: [fmt(f.lastDay, "%Y-%m-%d"), today] }, { $ifNull: [`$${f.day}`, 0] }, 0] },
    usedMonth: { $cond: [{ $eq: [fmt(f.lastMonth, "%Y-%m"), month] }, { $ifNull: [`$${f.month}`, 0] }, 0] },
  };
}

// Atomically reserve one unit of usage. Two parallel requests can no longer both squeeze past a limit.
// Reserve BEFORE doing the expensive work and refund on failure.
async function reserveUsage(user, kind) {
  const f = USAGE_FIELDS[kind];
  const limits = PLAN_LIMITS[getEffectivePlan(user)];
  const dayLimit = limits[f.dayLimit], monthLimit = limits[f.monthLimit];
  if (!dayLimit || !monthLimit) return false;
  const e = usageExprs(f);
  const now = new Date();
  const set = {
    [f.day]:   { $add: [e.usedDay, 1] },
    [f.month]: { $add: [e.usedMonth, 1] },
    [f.lastDay]: now,
  };
  if (f.lastMonth !== f.lastDay) set[f.lastMonth] = { $cond: [e.sameMonth, `$${f.lastMonth}`, now] };
  const res = await User.collection.findOneAndUpdate(
    { _id: user._id, $expr: { $and: [{ $lt: [e.usedDay, dayLimit] }, { $lt: [e.usedMonth, monthLimit] }] } },
    [{ $set: set }],
    { returnDocument: "after" }
  );
  const doc = res && (res.value !== undefined ? res.value : res);
  return !!(doc && doc._id);
}

async function refundUsage(user, kind) {
  const f = USAGE_FIELDS[kind];
  await User.collection.updateOne(
    { _id: user._id },
    [{ $set: {
      [f.day]:   { $max: [0, { $subtract: [{ $ifNull: [`$${f.day}`, 0] }, 1] }] },
      [f.month]: { $max: [0, { $subtract: [{ $ifNull: [`$${f.month}`, 0] }, 1] }] },
    } }]
  ).catch(() => {});
}

// Unconditional +1 (used by the internal EC2 callback).
async function bumpUsage(user, kind) {
  const f = USAGE_FIELDS[kind];
  const e = usageExprs(f);
  const now = new Date();
  const set = { [f.day]: { $add: [e.usedDay, 1] }, [f.month]: { $add: [e.usedMonth, 1] }, [f.lastDay]: now };
  if (f.lastMonth !== f.lastDay) set[f.lastMonth] = { $cond: [e.sameMonth, `$${f.lastMonth}`, now] };
  await User.collection.updateOne({ _id: user._id }, [{ $set: set }]);
}

app.get("/internal/user-limits/:email", internalAuth, async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true, user, effectivePlan: getEffectivePlan(user) });
  } catch (e) {
    console.error("[/internal/user-limits] failed:", e);
    res.status(500).json({ success: false, error: "Internal lookup failed." });
  }
});

app.post("/internal/update-usage", internalAuth, async (req, res) => {
  try {
    const { email, type } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Invalid email" });
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false });

    if (type === "clip") await bumpUsage(user, "clip");

    res.json({ success: true });
  } catch (e) {
    console.error("[/internal/update-usage] failed:", e);
    res.status(500).json({ success: false, error: "Internal update failed." });
  }
});

app.get("/auth/google", (req, res, next) => {
  const next_ = req.query.next;
  const dest = safeRedirectPath(next_, "/dashboard.html");
  const referralCode = req.session.referralCode || "";
  const state = JSON.stringify({ dest, referralCode });
  passport.authenticate("google", { scope: ["profile", "email"], state })(req, res, next);
});
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  async (req, res) => {
    req.session.userEmail = req.user.email;
    User.updateOne({ _id: req.user._id }, { $set: { lastActiveAt: new Date(), lastSeenIpHash: requestFingerprints(req).ipHash, lastSeenUaHash: requestFingerprints(req).uaHash } }).catch(() => {});
    let dest = "/dashboard.html";
    try {
      const parsed = JSON.parse(String(req.query.state || "{}"));
      dest = safeRedirectPath(parsed.dest, dest);
    } catch (e) {
      const state_ = req.query.state;
      dest = safeRedirectPath(state_, dest);
    }
    delete req.session.referralCode;
    const sep = dest.includes("?") ? "&" : "?";
    res.redirect(dest + sep + "email=" + encodeURIComponent(req.user.email));
  }
);

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/me", (req, res) => {
  const email = getSessionEmail(req);
  res.json({ success: true, loggedIn: !!email, email: email || null });
});

app.post("/send-otp", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Valid email required" });

    const sendLimit = checkOtpSendLimit(email);
    if (!sendLimit.allowed) return res.status(429).json({ success: false, message: sendLimit.error });

    const otp = crypto.randomInt(100000, 1000000).toString();
    otpStore[email] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };

    await resend.emails.send({
      from:    "ReelScribe <noreply@reelscribe.site>",
      to:      email,
      subject: "Your ReelScribe OTP",
      html: `
      <div style="font-family:Inter,sans-serif;background:#09070f;padding:32px;border-radius:16px;max-width:480px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#8b5cf6,#ec4899);border-radius:16px;padding:32px;text-align:center;">
          <h1 style="color:white;font-size:24px;font-weight:900;margin:0 0 8px;">ReelScribe</h1>
          <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:0 0 28px;">Your One-Time Password</p>
          <div style="background:white;border-radius:10px;padding:16px;display:inline-block;">
            <span style="font-size:36px;font-weight:900;letter-spacing:8px;color:#8b5cf6;">${otp}</span>
          </div>
          <p style="color:rgba(255,255,255,0.6);font-size:12px;margin:12px 0 0;">Valid for 5 minutes only</p>
        </div>
      </div>`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("[/send-otp] failed:", err);
    res.status(500).json({ success: false, message: "Couldn't send the OTP right now. Please try again in a moment." });
  }
});

app.post("/verify-otp", authLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Valid email required" });

    const verifyLimit = checkOtpVerifyLimit(email);
    if (!verifyLimit.allowed) return res.status(429).json({ success: false, message: verifyLimit.error });

    const record = otpStore[email];
    if (!record)                    return res.status(400).json({ success: false, message: "OTP not found" });
    if (Date.now() > record.expiresAt) { delete otpStore[email]; return res.status(400).json({ success: false, message: "OTP expired" }); }
    if (record.otp !== otp)         return res.status(400).json({ success: false, message: "Invalid OTP" });

    delete otpStore[email];
    delete otpVerifyAttempts[email];
    let user = await User.findOne({ email });
    if (!user) {
      const referralCode = req.session.referralCode || null;
      const fp = requestFingerprints(req);
      const emailIdentity = normalizeEmailIdentity(email);
      // Prevent Gmail dot/plus aliases from creating a second referral-eligible account.
      if (await hasEmailIdentityConflict(email)) return res.status(409).json({ success: false, message: "An account already exists for this email identity. Please log in instead." });
      user = await User.create({ name: email.split("@")[0], email, credits: 5, referredBy: referralCode, emailIdentity, signupIpHash: fp.ipHash, signupUaHash: fp.uaHash });
      if (referralCode) await createReferralRecord(referralCode, email, req);
      delete req.session.referralCode;
    }

    req.session.userEmail = email;
    const fp = requestFingerprints(req);
    await User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date(), lastSeenIpHash: fp.ipHash, lastSeenUaHash: fp.uaHash } });

    res.json({
      success: true,
      user: {
        name: user.name,
        email: user.email,
        plan: user.plan,
        credits: user.credits,
      },
    });
  } catch (err) {
    console.error("[/verify-otp] failed:", err);
    res.status(500).json({ success: false, message: "Something went wrong while verifying your OTP. Please try again." });
  }
});

// ═══════════════════════════════════════════════════════
//  TRANSCRIPTION CORE
// ═══════════════════════════════════════════════════════
async function groqTranscribe(filePath) {
  const make = (extra) => groq.audio.transcriptions.create({ file: fs.createReadStream(filePath), model: "whisper-large-v3-turbo", ...extra });
  try {
    // verbose_json gives timestamps, which power SRT/VTT export and chapters.
    const t = await make({ response_format: "verbose_json", timestamp_granularities: ["segment"] });
    return { text: String(t.text || "").trim(), segments: segmentsFromWhisper(t.segments), language: String(t.language || "") };
  } catch (e) {
    if (e?.status !== 400 && e?.status !== 422) throw e;
    const t = await make({});
    return { text: String(t.text || "").trim(), segments: [], language: "" };
  }
}

// Pure fetch+transcribe for a URL (no limits/accounting) — shared by the website and the public API.
async function fetchUrlTranscript(url) {
  if (isValidYouTubeUrl(url)) {
    const videoId = getYouTubeVideoId(url);
    if (!videoId) throw new HttpError(400, "Invalid YouTube URL");
    let items;
    try { items = await YoutubeTranscript.fetchTranscript(videoId); }
    catch (error) {
      console.error("[transcribe-url] YouTube fetch failed:", error);
      throw new HttpError(500, "Couldn't fetch the transcript for this video. Please check the link and try again.");
    }
    if (!items?.length) throw new HttpError(400, "This video doesn't have any captions available.");
    const segments = segmentsFromYoutube(items);
    const text = segments.map(x => x.text).join(" ").replace(/\s+/g, " ").trim();
    if (!text) throw new HttpError(400, "This video doesn't have any captions available.");
    return { text, segments, language: String(items[0]?.lang || ""), source: "youtube-captions" };
  }
  if (isValidInstagramUrl(url)) {
    const outputPath = path.join(__dirname, "uploads", `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_insta.mp4`);
    try {
      const videoUrl = await getInstagramVideoUrl(url);
      await downloadVideo(videoUrl, outputPath);
      const r = await groqTranscribe(outputPath);
      return { ...r, source: "groq-whisper" };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      console.error("[transcribe-url] Instagram fetch failed:", error);
      throw new HttpError(500, "Couldn't fetch this Instagram video. Please check the link and try again.");
    } finally {
      fs.promises.unlink(outputPath).catch(() => {});
    }
  }
  throw new HttpError(400, "Only valid YouTube and Instagram URLs are supported.");
}

async function limitMessage(user, kind) {
  const c = kind === "clip" ? await checkClipLimit(user) : await checkTranscriptLimit(user);
  return c.allowed ? "You've reached your limit for now. Please try again shortly or upgrade your plan." : c.error;
}

function transcriptResponse({ isGuest, text, user, source, reelId }) {
  const words = text.split(/\s+/).filter(Boolean);
  const isPreview = isGuest && words.length > 100;
  return {
    success: true,
    transcript: isGuest ? words.slice(0, 100).join(" ") : text,
    isGuest, isPreview,
    totalWords: words.length,
    creditsLeft: isGuest ? 0 : user.credits,
    source,
    reelId: reelId ? String(reelId) : null,
  };
}

// Persist a finished transcript for a signed-in user and fire side effects (referral + webhook).
async function saveTranscriptForUser(user, { url, text, segments, language, source }) {
  const reel = await Reel.create({ userEmail: user.email, reelUrl: url, transcript: text, segments, language, source });
  await creditReferralAfterFirstTranscript(user, text.split(/\s+/).filter(Boolean).length).catch(e => console.error("[referral] credit failed:", e.message));
  webhooks.send(user.email, "transcript.completed", { id: String(reel._id), source, url, words: text.split(/\s+/).filter(Boolean).length });
  return reel;
}

// Shared by the website and the public API: limit-checked URL transcription for a signed-in user.
async function runUserUrlTranscription(user, url) {
  if (!(await reserveUsage(user, "transcript"))) throw new HttpError(403, await limitMessage(user, "transcript"));
  try {
    const r = await fetchUrlTranscript(url);
    const reel = await saveTranscriptForUser(user, { url, ...r });
    return { reel, ...r };
  } catch (e) {
    await refundUsage(user, "transcript");
    throw e;
  }
}

app.post("/transcribe", transcribeLimiter, upload.single("video"), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file was uploaded." });

    const email   = getSessionEmail(req);
    const user    = email ? await User.findOne({ email }) : null;
    const isGuest = !user;
    if (user?.isSuspended) return res.status(403).json({ success: false, suspended: true, error: "Your account is currently suspended. Please contact support." });

    let reserved = false;
    if (isGuest) {
      const { allowed } = await checkGuestLimit(req);
      if (!allowed) return res.status(403).json({ success: false, loginRequired: true, forceLogin: true, error: "You've used all 3 free previews. Please log in to continue." });
    } else {
      if (!(await reserveUsage(user, "transcript"))) return res.status(403).json({ success: false, error: await limitMessage(user, "transcript") });
      reserved = true;
    }

    try {
      const r = await groqTranscribe(filePath);
      if (!r.text) throw new Error("Empty transcription");
      let reelId = null;
      if (!isGuest) {
        const reel = await saveTranscriptForUser(user, { url: req.file.originalname, ...r, source: "groq-whisper" });
        reelId = reel._id;
      }
      return res.json(transcriptResponse({ isGuest, text: r.text, user, source: "groq-whisper", reelId }));
    } catch (error) {
      if (reserved) await refundUsage(user, "transcript");
      throw error;
    }
  } catch (error) {
    console.error("[/transcribe] failed:", error);
    res.status(500).json({ success: false, error: "We couldn't process this video. Please try again or use a different file." });
  } finally {
    if (filePath) fs.promises.unlink(filePath).catch(() => {});
  }
});

app.post("/transcribe-url", transcribeLimiter, async (req, res) => {
  const { url } = req.body;
  if (typeof url !== "string" || !url)
    return res.status(400).json({ success: false, error: "Please provide a video URL." });
  if (!isValidYouTubeUrl(url) && !isValidInstagramUrl(url))
    return res.status(400).json({ success: false, error: "Only valid YouTube and Instagram URLs are supported." });

  const email   = getSessionEmail(req);
  const user    = email ? await User.findOne({ email }) : null;
  const isGuest = !user;
  if (user?.isSuspended) return res.status(403).json({ success: false, suspended: true, error: "Your account is currently suspended. Please contact support." });

  try {
    if (isGuest) {
      const { allowed } = await checkGuestLimit(req);
      if (!allowed) return res.status(403).json({ success: false, loginRequired: true, forceLogin: true, error: "You've used all 3 free previews. Please log in to continue." });
      const r = await fetchUrlTranscript(url);
      return res.json(transcriptResponse({ isGuest: true, text: r.text, user: null, source: r.source }));
    }
    const r = await runUserUrlTranscription(user, url);
    return res.json(transcriptResponse({ isGuest: false, text: r.text, user, source: r.source, reelId: r.reel._id }));
  } catch (error) {
    if (error instanceof HttpError) return res.status(error.status).json({ success: false, error: error.message });
    console.error("[/transcribe-url] failed:", error);
    return res.status(500).json({ success: false, error: "Couldn't fetch the transcript for this video. Please check the link and try again." });
  }
});

// ═══════════════════════════════════════════════════════
//  CLIP JOBS (persisted in MongoDB, survive restarts)
// ═══════════════════════════════════════════════════════
const INSTANCE_ID = crypto.randomUUID();
const clipJobs = {
  create: (jobId, email, via, reservedKind) => JobState.create({ jobId, email, via, reservedKind, ownerId: INSTANCE_ID, status: "processing" }),
  finish: (jobId, patch) => JobState.updateOne({ jobId }, { $set: patch }),
  get:    (jobId) => JobState.findOne({ jobId }).lean(),
};

// Running instances keep their jobs alive with a heartbeat. A job whose heartbeat goes stale was
// lost in a restart/crash: mark it failed and give the user their clip back.
setInterval(() => JobState.updateMany({ ownerId: INSTANCE_ID, status: "processing" }, { $set: { heartbeatAt: new Date() } }).catch(() => {}), 30 * 1000).unref();
setInterval(async () => {
  try {
    const stale = await JobState.find({ status: "processing", heartbeatAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) } }).limit(50);
    for (const job of stale) {
      const claimed = await JobState.findOneAndUpdate({ _id: job._id, status: "processing" }, { $set: { status: "error", error: "This job was interrupted by a server restart. Your clip allowance was not used — please try again." } });
      if (!claimed) continue;
      if (job.reservedKind === "clip") {
        const u = await User.findOne({ email: job.email }).select("_id plan planExpiresAt");
        if (u) await refundUsage(u, "clip");
      }
      webhooks.send(job.email, "clip.failed", { jobId: job.jobId, error: "interrupted" });
    }
  } catch (e) { console.error("[job-sweeper] failed:", e.message); }
}, 60 * 1000).unref();

app.get("/clip-status/:jobId", requireAuth, async (req, res) => {
  const job = await clipJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: "Job not found or expired" });
  if (job.email !== req.authEmail) return res.status(403).json({ success: false, error: "You do not have access to this job." });
  res.json({ success: true, status: job.status, error: job.error || undefined, clips: job.status === "done" ? job.clips : undefined, historyId: job.historyId || undefined });
});

// Only forward known, bounded caption options to the render service.
function sanitizeCaptionSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { captionsEnabled: true };
  const str = (v, n = 40) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const num = (v, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : undefined);
  if (input.captionsEnabled === false) return { captionsEnabled: false };
  const out = {
    captionsEnabled: true,
    style: str(input.style), language: str(input.language, 20), animation: str(input.animation),
    captionMode: str(input.captionMode), maxWordsPerLine: num(input.maxWordsPerLine, 1, 12),
    emojiReactions: typeof input.emojiReactions === "boolean" ? input.emojiReactions : undefined,
    emojiPosition: str(input.emojiPosition, 20), aspectRatio: str(input.aspectRatio, 12), quality: str(input.quality, 12),
  };
  if (input.position && typeof input.position === "object") out.position = { type: str(input.position.type, 20), marginFromBottom: num(input.position.marginFromBottom, 0, 1500) };
  if (input.reframe && typeof input.reframe === "object") out.reframe = { mode: input.reframe.mode === "focus" ? "focus" : "center", focusX: num(input.reframe.focusX, 0, 100) ?? 50 };
  return JSON.parse(JSON.stringify(out));
}

// A user's own brand kit (Agency) or the kit of the team they belong to.
async function resolveBrandKit(user) {
  const plan = getEffectivePlan(user);
  let kit = null;
  if (plan === "agency") kit = await BrandKit.findOne({ ownerEmail: user.email }).lean();
  if (!kit) {
    const team = await Team.findOne({ members: { $elemMatch: { email: user.email, status: "active" } } }).select("ownerEmail").lean();
    if (team) kit = await BrandKit.findOne({ ownerEmail: team.ownerEmail }).lean();
  }
  if (!kit) return null;
  return {
    brandName: kit.brandName, handle: kit.handle, primaryColor: kit.primaryColor, accentColor: kit.accentColor,
    fontName: kit.fontName, logoUrl: kit.logoEnabled ? kit.logoUrl : "", logoPosition: kit.logoPosition, outroText: kit.outroText,
  };
}

const uploadPrefix = (email) => `uploads/${require("./lib/security").sha256(String(email).toLowerCase()).slice(0, 16)}/`;

function mapClip(c, meta, captionSettings) {
  return {
    title: String(c.title || "").slice(0, 200), reason: String(c.reason || "").slice(0, 500), duration: Number(c.duration) || 0,
    url: c.url, s3Key: c.s3Key,
    sourceKey: String(c.sourceKey || c.masterKey || ""),
    captionSettings,
    score: meta?.score ?? null, scoreNote: meta?.scoreNote || "", hook: meta?.hook || "",
    description: meta?.description || "", hashtags: meta?.hashtags || [],
  };
}

// Starts a clip job for a signed-in user. Used by the website (/cut-clips) and the public API.
// source = { type: "youtube", url } | { type: "upload", key }
async function startClipJob({ user, source, captionSettings, via = "web" }) {
  const email = user.email;
  const plan = getEffectivePlan(user);
  const referralAvailable = (user.referralCuts || 0) > 0;
  let useReferral = false;
  let reserved = false;

  if (source.type === "youtube" && !isValidYouTubeUrl(source.url)) return { status: 400, body: { success: false, error: "Please provide a valid YouTube URL." } };
  if (source.type === "upload" && !String(source.key || "").startsWith(uploadPrefix(email))) return { status: 400, body: { success: false, error: "Invalid upload reference. Please upload the file again." } };

  if (plan === "free") {
    if (!referralAvailable)
      return { status: 403, body: { success: false, error: "Clips aren't available on the free plan. Refer a friend to earn 1 free cut, or upgrade to continue." } };
    useReferral = true;
  } else if (await reserveUsage(user, "clip")) {
    reserved = true;
  } else {
    if (!referralAvailable) return { status: 403, body: { success: false, error: await limitMessage(user, "clip") } };
    useReferral = true;
  }

  const processingPlan = useReferral ? "starter" : plan;
  const refund = async () => { if (reserved) await refundUsage(user, "clip"); };

  if (source.type === "youtube") {
    const maxMinutes = PLAN_LIMITS[processingPlan].maxVideoMinutes;
    const durationSec = await getYouTubeDurationSeconds(source.url);
    if (durationSec !== null && durationSec > maxMinutes * 60) {
      await refund();
      const videoMinutes = Math.ceil(durationSec / 60);
      return { status: 403, body: { success: false, error: `This video is ${videoMinutes} min long. The ${useReferral ? "referral cut" : processingPlan + " plan"} supports videos up to ${maxMinutes} min. Try a shorter video or upgrade your plan.` } };
    }
  }

  const settings = sanitizeCaptionSettings(captionSettings);
  const brandKit = useReferral ? null : await resolveBrandKit(user);
  const jobId = crypto.randomUUID();
  await clipJobs.create(jobId, email, via, reserved ? "clip" : "referral");

  runClipJob({ jobId, user, source, settings, brandKit, processingPlan, useReferral, reserved }).catch(e => console.error("[clip-job] crashed:", e));
  return { status: 200, body: { success: true, jobId } };
}

async function runClipJob({ jobId, user, source, settings, brandKit, processingPlan, useReferral, reserved }) {
  const email = user.email;
  const fail = async (message) => {
    if (reserved) await refundUsage(user, "clip");
    await clipJobs.finish(jobId, { status: "error", error: message });
    webhooks.send(email, "clip.failed", { jobId, error: message });
  };
  try {
    const ec2Response = await axios.post(
      `${EC2_URL}/analyze-video`,
      {
        ...(source.type === "youtube" ? { url: source.url } : { sourceKey: source.key }),
        sourceType: source.type, captionSettings: settings, brandKit,
        plan: processingPlan, referralCut: useReferral, watermark: useReferral,
      },
      { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 900000 }
    );

    if (!ec2Response.data?.success) return fail(ec2Response.data?.error || "Clip generation failed. Please try again.");

    const rawClips = (ec2Response.data.clips || []).filter(c => c && c.url && c.s3Key);
    if (!rawClips.length) return fail("No clips came back — try a different video.");

    // AI virality score / hook / hashtags (never blocks or fails the job).
    let metas = [];
    try { metas = await Promise.race([ai.scoreClips(rawClips), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000))]); }
    catch (e) { console.warn("[clip-job] AI scoring skipped:", e.message); }
    const clips = rawClips.map((c, i) => mapClip(c, metas[i], settings));

    if (useReferral) {
      const consumed = await User.findOneAndUpdate({ _id: user._id, referralCuts: { $gt: 0 } }, { $inc: { referralCuts: -1 } }, { new: true });
      if (!consumed) {
        // A concurrent request used the last reward; don't silently grant a free cut.
        await axios.post(`${EC2_URL}/delete-clips`, { keys: rawClips.map(c => c.s3Key) }, { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 30000 }).catch(() => {});
        return fail("Your referral cut was already used. Please try again.");
      }
    }

    // Save history first, THEN mark the job done, so the UI can always act on the saved clips.
    const history = await ClipJob.create({
      userEmail: email,
      ytUrl: source.type === "youtube" ? source.url : "",
      ytTitle: ec2Response.data.videoTitle || (source.type === "upload" ? "Uploaded video" : ""),
      sourceType: source.type, captionSettings: settings, clips,
    });
    await clipJobs.finish(jobId, { status: "done", clips, historyId: String(history._id) });
    webhooks.send(email, "clip.completed", {
      jobId, historyId: String(history._id),
      clips: clips.map(c => ({ title: c.title, url: c.url, duration: c.duration, score: c.score, hook: c.hook, description: c.description, hashtags: c.hashtags })),
    });
  } catch (err) {
    console.error(`[clip-job] ${jobId} failed:`, err.response?.data || err.message || err);
    await fail("Clip generation failed. Please try again.").catch(() => {});
  } finally {
    if (source.type === "upload") s3.deleteFromS3(source.key).catch(() => {});
  }
}

app.post("/cut-clips", clipLimiter, requireAuth, async (req, res) => {
  const { ytUrl, sourceKey, captionSettings } = req.body;
  const user = await User.findOne({ email: req.authEmail });
  if (!user) return res.status(401).json({ success: false, loginRequired: true, error: "Account not found. Please log in again." });
  const source = sourceKey ? { type: "upload", key: String(sourceKey) } : { type: "youtube", url: ytUrl };
  const r = await startClipJob({ user, source, captionSettings, via: "web" });
  res.status(r.status).json(r.body);
});

app.get("/clip-history", requireAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const jobs = await ClipJob.find({
      userEmail: req.authEmail,
      createdAt: { $gte: since }
    }).sort({ createdAt: -1 });

    const data = jobs
      .map(j => ({
        _id: j._id,
        ytUrl: j.ytUrl,
        ytTitle: j.ytTitle,
        createdAt: j.createdAt,
        // idx = position in the stored job; the editor/scheduler address clips by it.
        clips: j.clips.map((c, idx) => ({ ...c.toObject(), idx })).filter(c => !c.deleted)
      }))
      .filter(j => j.clips.length > 0);

    res.json({ success: true, data });
  } catch (error) {
    console.error("[/clip-history] failed:", error);
    res.status(500).json({ success: false, error: "Couldn't load your clip history right now. Please try again." });
  }
});

app.post("/clip-downloaded", requireAuth, async (req, res) => {
  const { s3Key } = req.body;
  if (!s3Key) return res.status(400).json({ success: false, error: "Missing clip reference." });

  const owned = await ClipJob.findOne({ userEmail: req.authEmail, "clips.s3Key": s3Key });
  if (!owned) return res.status(404).json({ success: false, error: "Clip not found." });

  res.json({ success: true });

  try {
    await ClipJob.updateOne(
      { "clips.s3Key": s3Key },
      { $set: { "clips.$.downloaded": true, "clips.$.downloadedAt": new Date() } }
    );
  } catch (e) {}

  setTimeout(async () => {
    try {
      await axios.post(`${EC2_URL}/delete-clips`, { keys: [s3Key] },
        { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 30000 });
      await ClipJob.updateOne(
        { "clips.s3Key": s3Key },
        { $set: { "clips.$.deleted": true } }
      );
    } catch (e) {}
  }, 5 * 60 * 1000);
});

async function runClipCleanupSweep() {
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

    const jobs = await ClipJob.find({
      $or: [
        { createdAt: { $lt: dayAgo } },
        { "clips.downloaded": true, "clips.downloadedAt": { $lt: fiveMinAgo }, "clips.deleted": { $ne: true } }
      ]
    });

    const keysToDelete = [];
    for (const job of jobs) {
      const jobExpired = job.createdAt < dayAgo;
      for (const clip of job.clips) {
        if (clip.deleted) continue;
        const downloadExpired = clip.downloaded && clip.downloadedAt && clip.downloadedAt < fiveMinAgo;
        if (jobExpired || downloadExpired) keysToDelete.push(clip.s3Key);
        // The caption-free master (used by the editor) goes away with the job, not per-download.
        if (jobExpired && clip.sourceKey && !keysToDelete.includes(clip.sourceKey)) keysToDelete.push(clip.sourceKey);
      }
    }

    if (keysToDelete.length > 0) {
      await axios.post(`${EC2_URL}/delete-clips`, { keys: keysToDelete },
        { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 60000 });

      await ClipJob.updateMany(
        { "clips.s3Key": { $in: keysToDelete } },
        { $set: { "clips.$[c].deleted": true } },
        { arrayFilters: [{ "c.s3Key": { $in: keysToDelete } }] }
      );
    }

    await ClipJob.deleteMany({ createdAt: { $lt: dayAgo } });
  } catch (e) {
    console.error("Clip cleanup sweep failed:", e.message);
  }
}
setInterval(runClipCleanupSweep, 15 * 60 * 1000);


function normalizeCoupon(c) {
  if (!c) return null;
  return {
    code: c.code,
    percent: Number(c.discountPercent || c.percent || 0),
    plan: Array.isArray(c.appliesToPlans) && c.appliesToPlans.includes("all")
      ? "all" : (c.appliesToPlans?.[0] || "all"),
    expiresAt: c.expiresAt,
    active: !!c.active,
    maxUses: Number(c.maxUses || 0),
    usedCount: Number(c.usedCount || 0)
  };
}

// Errors deliberately written to be safe/helpful to show a user directly.
// Anything NOT thrown as a ValidationError is treated as an internal error
// and never reaches the client verbatim (see the catch blocks below).
class ValidationError extends Error {}

async function getValidCoupon(code, email, plan) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return { coupon: null, discount: 0 };

  const coupon = await Coupon.findOne({ code: clean });
  if (!coupon) throw new ValidationError("Invalid coupon code.");
  if (!coupon.active) throw new ValidationError("This coupon is no longer active.");
  if (coupon.expiresAt && new Date(coupon.expiresAt) <= new Date()) throw new ValidationError("This coupon has expired.");
  if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses) throw new ValidationError("This coupon has reached its usage limit.");

  const plans = Array.isArray(coupon.appliesToPlans) ? coupon.appliesToPlans : ["all"];
  if (!plans.includes("all") && !plans.includes(plan)) throw new ValidationError(`This coupon is not valid for the ${plan} plan.`);

  if (coupon.singleUsePerUser) {
    const already = await CouponRedemption.exists({ code: clean, email: String(email).toLowerCase() });
    if (already) throw new ValidationError("You have already used this coupon.");
  }
  return { coupon, discount: Number(coupon.discountPercent || 0) };
}

const PLAN_PRICING = {
  starter: { m: 149, y: 124 },
  pro:     { m: 299, y: 249 },
  agency:  { m: 599, y: 499 }
};

function getMonthlyPlanPrice(plan) { return PLAN_PRICING[plan]?.m || null; }

app.post("/validate-coupon", requireAuth, async (req, res) => {
  try {
    const { code, plan, billing } = req.body;
    if (!PLAN_PRICING[plan]) return res.status(400).json({ success: false, error: "Invalid plan." });
    const originalAmount = billing === "yearly" ? PLAN_PRICING[plan].y * 12 : PLAN_PRICING[plan].m;
    const { coupon, discount } = await getValidCoupon(code, req.authEmail, plan);
    const discountAmount = coupon ? Math.round(originalAmount * discount) / 100 : 0;
    const finalAmount = Math.max(1, Math.round((originalAmount - discountAmount) * 100) / 100);
    res.json({ success: true, coupon: normalizeCoupon(coupon), originalAmount, discountAmount, finalAmount });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ success: false, error: err.message });
    console.error("[/validate-coupon] failed:", err);
    res.status(400).json({ success: false, error: "This coupon couldn't be applied. Please check the code and try again." });
  }
});

app.post("/create-order", requireAuth, async (req, res) => {
  try {
    const { plan, billing, couponCode } = req.body;
    const email = req.authEmail;
    if (!PLAN_PRICING[plan]) return res.status(400).json({ success: false, error: "Invalid plan." });

    const isYearly = billing === "yearly";
    const originalAmount = isYearly ? PLAN_PRICING[plan].y * 12 : PLAN_PRICING[plan].m;
    const { coupon, discount } = await getValidCoupon(couponCode, email, plan);
    const discountAmount = coupon ? Math.round(originalAmount * discount) / 100 : 0;
    const finalAmount = Math.max(1, Math.round((originalAmount - discountAmount) * 100) / 100);

    const order = await razorpay.orders.create({
      amount: Math.round(finalAmount * 100),
      currency: "INR",
      receipt: `receipt_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      notes: {
        plan,
        billing: isYearly ? "yearly" : "monthly",
        email,
        couponCode: coupon?.code || "",
        originalAmount: String(originalAmount),
        discountAmount: String(discountAmount),
        finalAmount: String(finalAmount)
      },
    });

    res.json({
      success: true,
      order,
      key: process.env.RAZORPAY_KEY_ID,
      pricing: { originalAmount, discountAmount, finalAmount },
      coupon: normalizeCoupon(coupon)
    });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ success: false, error: err.message });
    console.error("[/create-order] failed:", err);
    res.status(400).json({ success: false, error: "We couldn't start the payment process. Please try again." });
  }
});

// Razorpay → server. No session/login — authenticity comes entirely from the
// HMAC signature below, verified against the exact raw bytes Razorpay sent.
app.post("/webhooks/razorpay", webhookLimiter, async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    if (!RAZORPAY_WEBHOOK_SECRET || !signature || !req.rawBody) {
      return res.status(400).json({ success: false });
    }

    const expectedSig = crypto.createHmac("sha256", RAZORPAY_WEBHOOK_SECRET).update(req.rawBody).digest("hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");
    const receivedBuf = Buffer.from(String(signature), "hex");
    if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
      console.error("[/webhooks/razorpay] invalid signature — rejected");
      return res.status(400).json({ success: false });
    }

    const event   = req.body?.event;
    const payload = req.body?.payload || {};

    // Recurring subscription events are no longer used.
    // ReelScribe uses one-time Razorpay orders for both monthly and yearly plans.

    if (event === "order.paid") {
      const orderId = payload.order?.entity?.id;
      const paymentId = payload.payment?.entity?.id || "";
      if (orderId) {
        const order = await razorpay.orders.fetch(orderId);
        if (order?.status === "paid") {
          const r = await fulfillPaidOrder(order, paymentId);
          if (r.status >= 400) console.error("[/webhooks/razorpay] order.paid fulfilment problem:", orderId, r.body?.error);
        }
      }
    }

    if (event === "payment.failed") {
      const paymentEntity = payload.payment?.entity;
      console.warn("[/webhooks/razorpay] payment.failed:", paymentEntity?.id, paymentEntity?.error_description || "reason unavailable");
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[/webhooks/razorpay] handler error:", err);
    if (!res.headersSent) res.status(500).json({ success: false });
  }
});

// Activates (or extends) a plan for a PAID Razorpay order. Idempotent: safe to call from both the
// browser callback and the webhook, in any order, any number of times.
async function fulfillPaidOrder(order, paymentId, expectedEmail = null) {
  const orderId = order.id;
  const plan    = order.notes?.plan;
  const billing = order.notes?.billing;
  const email   = order.notes?.email;

  if (!isValidEmail(email))
    return { status: 400, body: { success: false, error: "We could not verify who this order belongs to. Please contact support." } };
  if (expectedEmail && email.toLowerCase() !== expectedEmail.toLowerCase())
    return { status: 403, body: { success: false, error: "This payment belongs to a different account." } };

  const alreadyPaid = await Payment.findOne({ razorpayOrderId: orderId }).lean();
  if (alreadyPaid) {
    // A retry after a transient database failure should still leave the user on the plan that was
    // actually paid for, but must not extend it twice.
    const existingUser = await User.findOne({ email }).select("plan planExpiresAt").lean();
    if (existingUser && (!existingUser.planExpiresAt || new Date(existingUser.planExpiresAt) < new Date(alreadyPaid.createdAt))) {
      const repairedExpiry = new Date(alreadyPaid.createdAt);
      if (alreadyPaid.billingCycle === "yearly") repairedExpiry.setFullYear(repairedExpiry.getFullYear() + 1);
      else repairedExpiry.setMonth(repairedExpiry.getMonth() + 1);
      await User.updateOne({ email }, { $set: { plan: alreadyPaid.plan, lastPaidPlan: alreadyPaid.plan, billingCycle: alreadyPaid.billingCycle, planExpiresAt: repairedExpiry } });
    }
    return { status: 200, body: { success: true, alreadyProcessed: true, message: "Payment was already processed.", plan: alreadyPaid.plan } };
  }

  if (!["starter", "pro", "agency"].includes(plan))
    return { status: 400, body: { success: false, error: "Invalid plan" } };

  const isYearly = billing === "yearly";
  const originalAmount = isYearly ? PLAN_PRICING[plan].y * 12 : PLAN_PRICING[plan].m;
  const couponCode = String(order.notes?.couponCode || "").trim().toUpperCase();
  const discountAmount = Math.max(0, Number(order.notes?.discountAmount || 0));
  const finalAmount = Math.max(1, Number(order.notes?.finalAmount || originalAmount));

  if (Math.round(Number(order.amount) / 100 * 100) !== Math.round(finalAmount * 100))
    return { status: 400, body: { success: false, error: "Paid amount does not match this order." } };

  const existingAccount = await User.findOne({ email }).select("plan planExpiresAt").lean();
  if (!existingAccount) return { status: 404, body: { success: false, error: "User account not found. Please log in again." } };

  // Renewing the SAME active plan extends from the current expiry instead of throwing away the days
  // the customer already paid for.
  const now = new Date();
  const extending = existingAccount.plan === plan && existingAccount.planExpiresAt && new Date(existingAccount.planExpiresAt) > now;
  const planExpiry = extending ? new Date(existingAccount.planExpiresAt) : new Date(now);
  if (isYearly) planExpiry.setFullYear(planExpiry.getFullYear() + 1);
  else planExpiry.setMonth(planExpiry.getMonth() + 1);

  // Record the payment first. The unique order id makes this safe against duplicate callbacks/races.
  try {
    await Payment.create({
      userEmail: email, plan, billingCycle: isYearly ? "yearly" : "monthly",
      amount: finalAmount, originalAmount, discountAmount, couponCode: couponCode || null,
      status: "paid", razorpayOrderId: orderId, razorpayPaymentId: paymentId,
    });
  } catch (paymentErr) {
    if (paymentErr?.code === 11000) return { status: 200, body: { success: true, alreadyProcessed: true, message: "Payment was already processed.", plan } };
    throw paymentErr;
  }

  const update = { plan, lastPaidPlan: plan, billingCycle: isYearly ? "yearly" : "monthly", planExpiresAt: planExpiry };
  if (!extending) Object.assign(update, {
    transcriptsUsedToday: 0, transcriptsUsedMonth: 0, clipsUsedToday: 0, clipsUsedMonth: 0,
    lastTranscriptDate: null, lastTranscriptResetDate: null, lastClipDate: null,
  });
  const user = await User.findOneAndUpdate({ email }, update, { new: true });
  if (!user) return { status: 404, body: { success: false, error: "User not found" } };

  if (couponCode) {
    const existingRedemption = await CouponRedemption.findOne({ orderId });
    if (!existingRedemption) {
      await CouponRedemption.create({ code: couponCode, email: email.toLowerCase(), plan, orderId, paymentId, discount: discountAmount, originalAmount, finalAmount });
      await Coupon.updateOne({ code: couponCode }, { $inc: { usedCount: 1 }, $addToSet: { usedBy: email.toLowerCase() } });
    }
  }

  return { status: 200, body: { success: true, message: `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan activated successfully!`, plan, planExpiresAt: planExpiry } };
}

app.post("/verify-payment", requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (typeof razorpay_order_id !== "string" || typeof razorpay_payment_id !== "string" || typeof razorpay_signature !== "string")
      return res.status(400).json({ success: false, error: "We could not verify this payment. Please contact support." });

    const expectedSig = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");
    const receivedBuf = Buffer.from(razorpay_signature, "hex");
    if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf))
      return res.status(400).json({ success: false, error: "Payment verification failed. Please contact support if the amount was deducted." });

    const order = await razorpay.orders.fetch(razorpay_order_id);
    if (!order || order.status !== "paid")
      return res.status(400).json({ success: false, error: "This order has not been paid yet." });

    const r = await fulfillPaidOrder(order, razorpay_payment_id, req.authEmail);
    res.status(r.status).json(r.body);
  } catch (err) {
    console.error("[/verify-payment] failed:", err);
    res.status(500).json({ success: false, error: "Something went wrong while verifying your payment. Please contact support." });
  }
});

app.get("/user-plan", requireAuth, async (req, res) => {
  try {
    const user = await User.findOne({ email: req.authEmail });
    if (!user) return res.status(404).json({ success: false });

    const plan   = getEffectivePlan(user);
    const limits = PLAN_LIMITS[plan];

    const transcriptDay   = isNewDay(user.lastTranscriptDate)       ? 0 : (user.transcriptsUsedToday || 0);
    const transcriptMonth = isNewMonth(user.lastTranscriptResetDate) ? 0 : (user.transcriptsUsedMonth || 0);
    const clipDay         = isNewDay(user.lastClipDate)              ? 0 : (user.clipsUsedToday || 0);
    const clipMonth       = isNewMonth(user.lastClipDate)            ? 0 : (user.clipsUsedMonth || 0);

    res.json({
      success: true,
      plan,
      rawPlan: user.plan || "free",
      planExpired: (user.plan && user.plan !== "free") && plan === "free",
      planExpiresAt: user.planExpiresAt,
      billingCycle: user.billingCycle || null,
      usage: {
        transcriptDay,   transcriptDayLimit:   limits.transcriptDay,
        transcriptMonth, transcriptMonthLimit: limits.transcriptMonth,
        clipDay,         clipDayLimit:         limits.clipDay,
        clipMonth,       clipMonthLimit:       limits.clipMonth,
      },
      referralCuts: user.referralCuts || 0,
      referralsCount: user.referralsCount || 0,
    });
  } catch (error) {
    console.error("[/user-plan] failed:", error);
    res.status(500).json({ success: false, error: "Couldn't load your plan details right now. Please try again." });
  }
});

app.get("/history", requireAuth, async (req, res) => {
  try {
    const reels = await Reel.find({ userEmail: req.authEmail }).select("-aiCache").sort({ createdAt: -1 }).limit(100).lean();
    reels.forEach(r => { r.hasSegments = Array.isArray(r.segments) && r.segments.length > 0; delete r.segments; });
    res.json({ success: true, data: reels });
  } catch (error) { console.error("[/history] failed:", error); res.status(500).json({ success: false, error: "Couldn't load your history right now. Please try again." }); }
});

function logAdminAction(action, targetEmail, details, req) {
  AdminLog.create({ action, targetEmail: targetEmail || null, details: details || "", ip: req.ip || "" })
    .catch(() => {});
}

app.post("/admin/login", (req, res) => {
  const ip  = req.ip || "unknown";
  const now = Date.now();
  const rec = adminAuthAttempts[ip];

  if (rec?.blockedUntil && now < rec.blockedUntil) {
    const waitMin = Math.ceil((rec.blockedUntil - now) / 60000);
    return res.status(429).json({ success: false, error: `Too many incorrect attempts. Please try again in ${waitMin} minute${waitMin === 1 ? "" : "s"}.` });
  }

  if (!process.env.ADMIN_SECRET || !safeEqual(req.body?.key, process.env.ADMIN_SECRET)) {
    if (!rec || now - rec.windowStart > ADMIN_WINDOW_MS) {
      adminAuthAttempts[ip] = { count: 1, windowStart: now, blockedUntil: null };
    } else {
      rec.count++;
      if (rec.count >= ADMIN_MAX_ATTEMPTS) rec.blockedUntil = now + ADMIN_BLOCK_MS;
    }
    return res.status(401).json({ success: false, error: "Incorrect key." });
  }

  delete adminAuthAttempts[ip];
  req.session.isAdmin = true;
  logAdminAction("login", null, "Admin logged in", req);
  res.json({ success: true });
});

app.post("/admin/logout", adminAuth, (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

app.get("/admin/stats", adminAuth, async (req, res) => {
  try {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek   = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [totalUsers, newToday, newThisWeek, planCounts] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startOfToday } }),
      User.countDocuments({ createdAt: { $gte: startOfWeek } }),
      User.aggregate([
        { $project: { effectivePlan: { $cond: [
          { $or: [
            { $eq: [{ $ifNull: ["$plan", "free"] }, "free"] },
            { $and: [
              { $ne: [{ $ifNull: ["$plan", "free"] }, "free"] },
              { $ne: ["$planExpiresAt", null] },
              { $lt: ["$planExpiresAt", new Date()] }
            ] }
          ] },
          "free", { $ifNull: ["$plan", "free"] }
        ] } } },
        { $group: { _id: "$effectivePlan", count: { $sum: 1 } } }
      ]),
    ]);

    const byPlan = { free: 0, starter: 0, pro: 0, agency: 0 };
    planCounts.forEach(p => { if (byPlan[p._id] !== undefined) byPlan[p._id] = p.count; });

    res.json({ success: true, totalUsers, newToday, newThisWeek, byPlan });
  } catch (error) { console.error("[/admin/stats] failed:", error); res.status(500).json({ success: false, error: "Couldn't load stats right now." }); }
});

app.get("/admin/revenue", adminAuth, async (req, res) => {
  try {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

    const [totalAgg, monthAgg, todayAgg, paidEmails] = await Promise.all([
      Payment.aggregate([{ $match: { status: "paid" } }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
      Payment.aggregate([{ $match: { status: "paid", createdAt: { $gte: startOfMonth } } }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
      Payment.aggregate([{ $match: { status: "paid", createdAt: { $gte: startOfToday } } }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
      Payment.distinct("userEmail", { status: "paid" }),
    ]);

    // "Paid → Free conversions": users who have paid at least once but are
    // currently back on the free plan.
    const paidToFreeConversions = await User.countDocuments({
      email: { $in: paidEmails },
      $or: [
        { plan: "free" },
        { plan: { $in: ["starter", "pro", "agency"] }, planExpiresAt: { $lt: new Date(), $ne: null } }
      ]
    });

    res.json({
      success: true,
      totalRevenue: totalAgg[0]?.sum || 0,
      monthRevenue: monthAgg[0]?.sum || 0,
      todayRevenue: todayAgg[0]?.sum || 0,
      paidToFreeConversions,
    });
  } catch (error) { console.error("[/admin/revenue] failed:", error); res.status(500).json({ success: false, error: "Couldn't load revenue data right now." }); }
});

app.get("/admin/logs", adminAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));

    const [logs, total] = await Promise.all([
      AdminLog.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      AdminLog.countDocuments(),
    ]);

    res.json({ success: true, data: logs, page, totalPages: Math.max(1, Math.ceil(total / limit)), total });
  } catch (error) { console.error("[/admin/logs] failed:", error); res.status(500).json({ success: false, error: "Couldn't load audit logs right now." }); }
});

app.get("/admin/users", adminAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const search = (req.query.search || "").trim();

    const filter = {};
    if (search) filter.email = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    if (["free","starter","pro","agency"].includes(req.query.plan)) filter.plan = req.query.plan;
    if (req.query.status === "active") filter.isSuspended = false;
    if (req.query.status === "suspended") filter.isSuspended = true;
    const now = new Date();
    if (req.query.joined === "today") { const d = new Date(now); d.setHours(0,0,0,0); filter.createdAt = { $gte: d }; }
    if (req.query.joined === "7d") filter.createdAt = { $gte: new Date(Date.now() - 7*86400000) };
    if (req.query.joined === "30d") filter.createdAt = { $gte: new Date(Date.now() - 30*86400000) };
    if (req.query.quick === "paid") filter.$and = [{ plan: { $in: ["starter","pro","agency"] } }, { planExpiresAt: { $gte: now } }];
    if (req.query.quick === "free") filter.$or = [{ plan: "free" }, { plan: { $in: ["starter","pro","agency"] }, planExpiresAt: { $lt: now, $ne: null } }];
    if (req.query.quick === "expiring") filter.$and = [{ plan: { $in: ["starter","pro","agency"] } }, { planExpiresAt: { $gte: now, $lte: new Date(Date.now()+7*86400000) } }];
    if (req.query.quick === "churned") filter.$and = [{ plan: "free" }, { $or: [{ lastPaidPlan: { $in: ["starter","pro","agency"] } }, { planExpiresAt: { $lt: now, $ne: null } }] }];


    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
    ]);
    const data = users.map(u => ({
      ...u,
      rawPlan: u.plan || "free",
      plan: getEffectivePlan(u)
    }));

    res.json({ success: true, data, page, totalPages: Math.max(1, Math.ceil(total / limit)), total });
  } catch (error) { console.error("[/admin/users] failed:", error); res.status(500).json({ success: false, error: "Couldn't load users right now." }); }
});

app.post("/admin/add-credit", adminAuth, async (req, res) => {
  try {
    const { email, credits } = req.body;
    if (!isValidEmail(email) || !credits) return res.status(400).json({ success: false, error: "A valid email and credit amount are required." });
    const user = await User.findOneAndUpdate({ email }, { $inc: { credits: parseInt(credits) } }, { new: true });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    logAdminAction("add-credit", email, `Added ${credits} credits (new total: ${user.credits})`, req);
    res.json({ success: true, message: `${credits} credits added successfully.`, user });
  } catch (error) { console.error("[/admin/add-credit] failed:", error); res.status(500).json({ success: false, error: "Couldn't add credit right now." }); }
});

app.post("/admin/set-plan", adminAuth, async (req, res) => {
  try {
    const { email, plan, durationDays } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Valid email required" });

    const validPlans = ["free", "starter", "pro", "agency"];
    if (!validPlans.includes(plan)) return res.status(400).json({ success: false, error: "Invalid plan" });

    let planExpiry = null;
    const update = {
      plan,
      billingCycle:            plan === "free" ? null : "manual",
        transcriptsUsedToday:    0,
        transcriptsUsedMonth:    0,
        clipsUsedToday:          0,
        clipsUsedMonth:          0,
        lastTranscriptDate:      null,
        lastTranscriptResetDate: null,
        lastClipDate:            null,
      };
    if (plan !== "free") {
      const days = parseInt(durationDays) || 30;
      planExpiry = new Date();
      planExpiry.setDate(planExpiry.getDate() + days);
      update.planExpiresAt = planExpiry;
      update.lastPaidPlan = plan;
    } else {
      // Keep the last expiry/paid plan so churn/win-back analytics remain accurate.
      update.planExpiresAt = undefined;
    }

    const user = await User.findOneAndUpdate(
      { email },
      { $set: update },
      { new: true }
    );

    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    logAdminAction("set-plan", email, `Set plan to ${plan}${planExpiry ? ` (expires ${planExpiry.toISOString().slice(0,10)})` : ""}`, req);
    res.json({ success: true, message: `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan assigned successfully.`, user });
  } catch (error) { console.error("[/admin/set-plan] failed:", error); res.status(500).json({ success: false, error: "Couldn't update the plan right now." }); }
});


app.post("/admin/credit", adminAuth, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const action = String(req.body?.action || "add").toLowerCase();
    const amount = Number(req.body?.amount || 0);
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Valid email required." });
    if (!["add", "subtract", "deduct", "set", "reset"].includes(action)) return res.status(400).json({ success: false, error: "Invalid credit action." });
    if (action === "reset") {
      // reset ignores the entered amount.
    } else if (!Number.isInteger(amount) || amount < 0 || amount > 100000 || ((action === "add" || action === "subtract" || action === "deduct") && amount === 0)) {
      return res.status(400).json({ success: false, error: "Enter a whole number between 0 and 100000." });
    }

    let user;
    if (action === "reset") {
      user = await User.findOneAndUpdate({ email }, { $set: { credits: 0 } }, { new: true });
    } else if (action === "add") {
      user = await User.findOneAndUpdate({ email }, { $inc: { credits: amount } }, { new: true });
    } else if (action === "set") {
      user = await User.findOneAndUpdate({ email }, { $set: { credits: amount } }, { new: true });
    } else {
      user = await User.findOneAndUpdate({ email, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
    }
    if (!user) return res.status(404).json({ success: false, error: ["subtract","deduct"].includes(action) ? "User not found or not enough credits." : "User not found." });
    logAdminAction("credit-" + action, email, `${action} ${amount || 0} credits (new total: ${user.credits})`, req);
    res.json({ success: true, message: action === "reset" ? "Credits reset successfully" : `Credits ${action === "add" ? "added" : action === "set" ? "set" : action === "reset" ? "reset" : "subtracted"} successfully`, user });
  } catch (error) { console.error("[/admin/credit] failed:", error); res.status(500).json({ success: false, error: "Couldn't update credit right now." }); }
});

app.post("/admin/user-control", adminAuth, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const action = String(req.body?.action || "").toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Valid email required." });
    if (!["suspend", "unsuspend", "delete"].includes(action)) return res.status(400).json({ success: false, error: "Invalid user action." });

    if (action === "delete") {
      const jobs = await ClipJob.find({ userEmail: email }).select("clips.s3Key").lean();
      const keys = jobs.flatMap(j => (j.clips || []).map(c => c.s3Key).filter(Boolean));
      if (keys.length && EC2_URL && INTERNAL_KEY) {
        await axios.post(`${EC2_URL}/delete-clips`, { keys: [...new Set(keys)] }, { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 60000 }).catch(() => {});
      }
      const user = await User.findOneAndDelete({ email });
      if (!user) return res.status(404).json({ success: false, error: "User not found." });
      await Promise.all([
        Reel.deleteMany({ userEmail: email }),
        ClipJob.deleteMany({ userEmail: email }),
        Referral.deleteMany({ $or: [{ referrerEmail: email }, { referredEmail: email }] })
      ]);
      logAdminAction("delete-user", email, "User account and associated transcript/clip/referral data deleted; payment and audit records retained.", req);
      return res.json({ success: true, message: "User account deleted." });
    }

    const user = await User.findOneAndUpdate(
      { email },
      { $set: { isSuspended: action === "suspend" } },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, error: "User not found." });
    logAdminAction(action + "-user", email, `User ${action}d`, req);
    res.json({ success: true, message: action === "suspend" ? "User suspended." : "User unsuspended.", user });
  } catch (error) { console.error("[/admin/user-control] failed:", error); res.status(500).json({ success: false, error: "Couldn't update this user right now." }); }
});

app.get("/admin/users/:email/details", adminAuth, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ success: false, error: "Invalid email." });
    const [user, totalTranscriptions, totalClipJobs, payments] = await Promise.all([
      User.findOne({ email }).select("email name plan credits createdAt planExpiresAt lastPaidPlan billingCycle lastActiveAt isSuspended").lean(),
      Reel.countDocuments({ userEmail: email }),
      ClipJob.countDocuments({ userEmail: email }),
      Payment.find({ userEmail: email }).sort({ createdAt: -1 }).limit(50).lean()
    ]);
    if (!user) return res.status(404).json({ success: false, error: "User not found." });

    const timeline = payments.map(pay => ({
      type: pay.status === "failed" ? "payment_failed" : "payment_received",
      at: pay.createdAt, plan: pay.plan, status: pay.status, amount: pay.amount,
      paymentId: pay.razorpayPaymentId, orderId: pay.razorpayOrderId,
      label: pay.status === "failed" ? "Payment failed" : "Payment received"
    }));
    timeline.sort((a,b)=>new Date(b.at)-new Date(a.at));

    res.json({ success: true, details: {
      user, lastActive: user.lastActiveAt, totalTranscriptions, totalClipJobs, creditsUsedTotal: user.creditsUsedTotal || 0,
      payments: payments.map(p => ({ id:p.razorpayPaymentId, orderId:p.razorpayOrderId, amount:p.amount, status:p.status, plan:p.plan, billingCycle:p.billingCycle, createdAt:p.createdAt })),
      timeline
    } });
  } catch (error) { console.error("[/admin/users/:email/details] failed:", error); res.status(500).json({ success: false, error: "Couldn't load user details right now." }); }
});

app.get("/admin/referrals", adminAuth, async (req, res) => {
  try {
    const status = String(req.query.status || "pending_review");
    const allowed = ["pending", "pending_review", "credited", "rejected"];
    const filter = allowed.includes(status) ? { status } : {};
    const data = await Referral.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, data });
  } catch (error) { console.error("[/admin/referrals] failed:", error); res.status(500).json({ success: false, error: "Couldn't load referrals right now." }); }
});

app.post("/admin/referrals/:id/review", adminAuth, async (req, res) => {
  try {
    const action = String(req.body?.action || "").toLowerCase();
    if (!["approve", "reject"].includes(action)) return res.status(400).json({ success: false, error: "Invalid review action." });

    const referral = await Referral.findById(req.params.id);
    if (!referral) return res.status(404).json({ success: false, error: "Referral not found." });
    if (referral.status !== "pending_review") return res.status(409).json({ success: false, error: "This referral has already been reviewed." });

    if (action === "reject") {
      referral.status = "rejected";
      await referral.save();
      logAdminAction("reject-referral", referral.referredEmail, `Referral from ${referral.referrerEmail} rejected (${referral.riskReason || "review"})`, req);
      return res.json({ success: true, message: "Referral rejected." });
    }

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0,0,0,0);
    const earned = await Referral.countDocuments({ referrerEmail: referral.referrerEmail, status: "credited", creditedAt: { $gte: monthStart } });
    if (earned >= 5) return res.status(409).json({ success: false, error: "This referrer has already reached the 5-referral monthly reward cap." });

    const referrerUser = await User.findOne({ email: referral.referrerEmail }).select("_id").lean();
    if (!referrerUser) return res.status(404).json({ success: false, error: "The referring user no longer exists." });

    const credited = await Referral.findOneAndUpdate(
      { _id: referral._id, status: "pending_review" },
      { $set: { status: "credited", creditedAt: new Date() } },
      { new: true }
    );
    if (!credited) return res.status(409).json({ success: false, error: "Referral was already reviewed." });

    await User.findOneAndUpdate({ email: credited.referrerEmail }, { $inc: { referralCuts: 1, referralsCount: 1 } });
    logAdminAction("approve-referral", credited.referredEmail, `Referral from ${credited.referrerEmail} approved`, req);
    res.json({ success: true, message: "Referral approved and one clip reward credited." });
  } catch (error) { console.error("[/admin/referrals/:id/review] failed:", error); res.status(500).json({ success: false, error: "Couldn't review this referral right now." }); }
});

app.get("/admin/payments", adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    const filter = {};
    if (search) filter.userEmail = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    if (["paid","failed","refunded"].includes(status)) filter.status = status;
    const [data,total] = await Promise.all([
      Payment.find(filter).sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),
      Payment.countDocuments(filter)
    ]);
    res.json({success:true,data,page,totalPages:Math.max(1,Math.ceil(total/limit)),total});
  } catch(e){ console.error("[/admin/payments] failed:", e); res.status(500).json({success:false,error:"Couldn't load payments right now."}); }
});

app.get("/admin/usage", adminAuth, async (req,res)=>{
  try {
    const now=new Date(), startToday=new Date(now); startToday.setHours(0,0,0,0);
    const startMonth=new Date(now.getFullYear(),now.getMonth(),1);
    const [totalClipJobs,todayProcessed,transcriptsThisMonth,clipsThisMonth,platformAgg]=await Promise.all([
      ClipJob.countDocuments(),
      ClipJob.countDocuments({createdAt:{$gte:startToday}}),
      Reel.countDocuments({createdAt:{$gte:startMonth}}),
      ClipJob.countDocuments({createdAt:{$gte:startMonth}}),
      ClipJob.aggregate([{ $group:{_id:{$ifNull:["$platform","Unknown"]},count:{$sum:1}}},{ $sort:{count:-1}},{ $limit:1}])
    ]);
    const daily=[];
    for(let i=6;i>=0;i--){const d=new Date(startToday);d.setDate(d.getDate()-i);const next=new Date(d);next.setDate(next.getDate()+1);
      const [r,c]=await Promise.all([Reel.countDocuments({createdAt:{$gte:d,$lt:next}}),ClipJob.countDocuments({createdAt:{$gte:d,$lt:next}})]);
      daily.push({label:d.toLocaleDateString("en-IN",{weekday:"short"}),total:r+c});
    }
    res.json({success:true,totalClipJobs,todayProcessed,transcriptsThisMonth,clipsThisMonth,mostUsedPlatform:platformAgg[0]?._id||"Unknown",sevenDayProcessed:daily.reduce((a,x)=>a+x.total,0),daily});
  } catch(e){ console.error("[/admin/usage] failed:", e); res.status(500).json({success:false,error:"Couldn't load usage data right now."}); }
});

app.get("/admin/coupons", adminAuth, async (req,res)=>{
  try {
    const rows=await Coupon.find().sort({createdAt:-1}).lean();
    res.json({success:true,data:rows.map(normalizeCoupon)});
  } catch(e){ console.error("[/admin/coupons] failed:", e); res.status(500).json({success:false,error:"Couldn't load coupons right now."}); }
});

app.post("/admin/coupons", adminAuth, async (req,res)=>{
  try {
    const {code,percent,plan,expiresAt,maxUses}=req.body;
    const clean=String(code||"").trim().toUpperCase();
    const pct=Number(percent);
    if(!/^[A-Z0-9_-]{3,40}$/.test(clean)) return res.status(400).json({success:false,error:"Coupon code must be 3-40 letters, numbers, _ or -."});
    if(!(pct>0 && pct<=100)) return res.status(400).json({success:false,error:"Discount must be between 1 and 100%."});
    if(!["all","starter","pro","agency"].includes(plan)) return res.status(400).json({success:false,error:"Invalid plan."});
    if(!expiresAt || isNaN(new Date(expiresAt).getTime()) || new Date(expiresAt)<=new Date()) return res.status(400).json({success:false,error:"A future expiry date is required."});
    const coupon=await Coupon.create({code:clean,discountPercent:pct,appliesToPlans:[plan],expiresAt:new Date(expiresAt),maxUses:Math.max(0,parseInt(maxUses)||0)});
    logAdminAction("create-coupon",null,`Created ${clean}: ${pct}% off ${plan}`,req);
    res.json({success:true,coupon:normalizeCoupon(coupon)});
  } catch(e){ console.error("[/admin/coupons create] failed:", e); res.status(400).json({success:false,error:e.code===11000?"Coupon code already exists.":"Couldn't create this coupon right now."}); }
});

app.post("/admin/coupons/toggle", adminAuth, async (req,res)=>{
  try {
    const code=String(req.body.code||"").trim().toUpperCase();
    const coupon=await Coupon.findOne({code});
    if(!coupon) return res.status(404).json({success:false,error:"Coupon not found."});
    coupon.active=!coupon.active;
    await coupon.save();
    logAdminAction("toggle-coupon",null,`${code} set to ${coupon.active?"active":"inactive"}`,req);
    res.json({success:true,coupon:normalizeCoupon(coupon)});
  } catch(e){ console.error("[/admin/coupons/toggle] failed:", e); res.status(500).json({success:false,error:"Couldn't update this coupon right now."}); }
});

app.get("/admin/coupon-redemptions", adminAuth, async (req,res)=>{
  try { res.json({success:true,data:await CouponRedemption.find().sort({createdAt:-1}).limit(200).lean()}); }
  catch(e){ console.error("[/admin/coupon-redemptions] failed:", e); res.status(500).json({success:false,error:"Couldn't load redemptions right now."}); }
});

function buildOfferUrl(plan,billing,couponCode) {
  const base = process.env.PUBLIC_SITE_URL || "https://reelscribe.site";
  const u = new URL("/pricing", base);
  u.searchParams.set("plan", plan);
  u.searchParams.set("billing", billing || "monthly");
  if(couponCode) u.searchParams.set("coupon", couponCode);
  return u.toString();
}

const EMAIL_TEMPLATES = {
  discount: {
    subject: "🔥 Special Offer: Get {{percent}}% OFF ReelScribe {{planLabel}}",
    html: ({percent,planLabel,originalPrice,finalPrice,url}) => `
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f3ff;font-family:Arial,Helvetica,sans-serif;color:#171329"><tr><td align="center" style="padding:32px 12px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#fff;border-radius:18px;overflow:hidden"><tr><td style="padding:28px 32px;background:#15111f"><div style="font-size:26px;font-weight:800;color:#fff">Reel<span style="color:#8b5cf6">Scribe</span></div><div style="margin-top:6px;font-size:13px;color:#b9b2c9">Transcribe. Create. Cut Clips.</div></td></tr><tr><td style="padding:38px 32px 28px;text-align:center"><div style="display:inline-block;padding:7px 12px;border-radius:999px;background:#eee7ff;color:#6d35d4;font-size:12px;font-weight:700">SPECIAL OFFER</div><h1 style="margin:18px 0 10px;font-size:34px;line-height:1.15">Unlock More With ReelScribe</h1><p style="margin:0 auto;max-width:470px;font-size:16px;line-height:1.6;color:#696276">Get ${planLabel} at an exclusive ${percent}% discount. Your offer is already linked to checkout.</p><div style="margin:26px 0 10px"><span style="font-size:16px;color:#8c8598;text-decoration:line-through">₹${originalPrice}</span><span style="margin-left:10px;font-size:38px;font-weight:800;color:#6d35d4">₹${finalPrice}</span><span style="font-size:15px;color:#6c6478"> total</span></div><div style="font-size:13px;color:#777080">Limited-time offer</div><a href="${url}" style="display:inline-block;margin-top:24px;padding:15px 30px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:10px;font-size:16px;font-weight:700">CLAIM ${percent}% OFF →</a></td></tr><tr><td style="padding:30px 32px;background:#faf9ff;text-align:center;border-top:1px solid #eeeaf6"><h2 style="margin:0 0 8px;font-size:23px">Ready to create more?</h2><p style="margin:0;color:#716a7e;font-size:14px;line-height:1.5">Click above and your coupon will be applied automatically at checkout.</p></td></tr><tr><td style="padding:25px 32px;background:#15111f;text-align:center"><div style="font-size:17px;font-weight:800;color:#fff">Reel<span style="color:#8b5cf6">Scribe</span></div><p style="margin:8px 0;font-size:12px;color:#aaa2b8">Transcribe any video or audio and create clips with AI.</p><a href="${baseUrlSafe()}" style="color:#b18cff;text-decoration:none;font-size:12px">Visit ReelScribe</a></td></tr></table></td></tr></table>`,
  },
  upgrade: {
    subject: "🚀 Upgrade ReelScribe and unlock more",
    html: ({url}) => `<div style="background:#f5f3ff;padding:32px;font-family:Arial;text-align:center"><div style="max-width:600px;margin:auto;background:#fff;border-radius:18px;padding:42px 28px"><div style="font-size:26px;font-weight:800">Reel<span style="color:#8b5cf6">Scribe</span></div><h1 style="font-size:32px;margin:22px 0 10px">Ready for the next level? 🚀</h1><p style="color:#696276;font-size:16px;line-height:1.6">Upgrade your ReelScribe plan and unlock more of your content workflow.</p><a href="${url}" style="display:inline-block;margin-top:20px;padding:15px 30px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">UPGRADE NOW →</a></div></div>`
  },
  expiry: {
    subject: "⏰ Your ReelScribe plan is expiring soon",
    html: ({url}) => `<div style="background:#f5f3ff;padding:32px;font-family:Arial;text-align:center"><div style="max-width:600px;margin:auto;background:#fff;border-radius:18px;padding:42px 28px"><div style="font-size:26px;font-weight:800">Reel<span style="color:#8b5cf6">Scribe</span></div><h1 style="font-size:30px;margin:22px 0 10px">Don't lose your access ⚡</h1><p style="color:#696276;font-size:16px;line-height:1.6">Renew your ReelScribe plan and continue creating without interruption.</p><a href="${url}" style="display:inline-block;margin-top:20px;padding:15px 30px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">RENEW MY PLAN →</a></div></div>`
  },
  announcement: {
    subject: "🚀 New from ReelScribe",
    html: ({url}) => `<div style="background:#f5f3ff;padding:32px;font-family:Arial;text-align:center"><div style="max-width:600px;margin:auto;background:#fff;border-radius:18px;padding:42px 28px"><div style="font-size:26px;font-weight:800">Reel<span style="color:#8b5cf6">Scribe</span></div><h1 style="font-size:30px;margin:22px 0 10px">Something new is here 🚀</h1><p style="color:#696276;font-size:16px;line-height:1.6">Check out the latest ReelScribe improvements and keep creating.</p><a href="${url}" style="display:inline-block;margin-top:20px;padding:15px 30px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">CHECK IT OUT →</a></div></div>`
  },
};
function baseUrlSafe(){ return process.env.PUBLIC_SITE_URL || "https://reelscribe.site"; }

app.post("/admin/marketing/preview", adminAuth, async (req,res)=>{
  try {
    const { templateId="discount", plan="pro", billing="monthly", couponCode, percent } = req.body;
    if(!PLAN_PRICING[plan]) return res.status(400).json({success:false,error:"Invalid plan."});
    const tpl=EMAIL_TEMPLATES[templateId] || EMAIL_TEMPLATES.discount;
    let coupon=null;
    if(couponCode) coupon=await Coupon.findOne({code:String(couponCode).trim().toUpperCase()});
    const pct=Number(percent || coupon?.discountPercent || 0);
    const planPrice=PLAN_PRICING[plan][billing==="yearly"?"y":"m"];
    const originalPrice=billing==="yearly" ? planPrice*12 : planPrice;
    const finalPrice=Math.max(1,Math.round((originalPrice-(originalPrice*pct/100))*100)/100);
    const url=buildOfferUrl(plan,billing,coupon?.code);
    const html=tpl.html({percent:pct,planLabel:plan.charAt(0).toUpperCase()+plan.slice(1),originalPrice,finalPrice,url});
    const subject=tpl.subject.replace("{{percent}}",pct).replace("{{planLabel}}",plan.charAt(0).toUpperCase()+plan.slice(1));
    res.json({success:true,subject,html,url,originalPrice,finalPrice,coupon:normalizeCoupon(coupon)});
  } catch(e){ console.error("[/admin/marketing/preview] failed:", e); res.status(500).json({success:false,error:"Couldn't generate the preview right now."}); }
});

app.post("/admin/marketing/send", adminAuth, async (req,res)=>{
  try {
    const { audience, targetEmail, templateId="discount", subject, html, plan="pro", billing="monthly", couponCode, percent } = req.body;
    let users=[];
    if(audience==="specific"){
      if(!isValidEmail(targetEmail)) return res.status(400).json({success:false,error:"Valid target email required."});
      const u=await User.findOne({email:targetEmail.toLowerCase()});
      if(!u) return res.status(404).json({success:false,error:"User not found."});
      users=[u];
    } else {
      const q={};
      if(["free","starter","pro","agency"].includes(audience)) q.plan=audience;
      if(audience==="expiring") q.planExpiresAt={$gte:new Date(),$lte:new Date(Date.now()+7*86400000)};
      users=await User.find(q).limit(100).lean();
    }
    if(!users.length) return res.status(400).json({success:false,error:"No recipients found."});
    const tpl=EMAIL_TEMPLATES[templateId] || EMAIL_TEMPLATES.discount;
    let coupon=null;
    if(couponCode) coupon=await Coupon.findOne({code:String(couponCode).trim().toUpperCase()});
    const pct=Number(percent || coupon?.discountPercent || 0);
    const planPrice=PLAN_PRICING[plan]?.[billing==="yearly"?"y":"m"] || 0;
    const originalPrice=billing==="yearly"?planPrice*12:planPrice;
    const finalPrice=Math.max(1,Math.round((originalPrice-(originalPrice*pct/100))*100)/100);
    const url=buildOfferUrl(plan,billing,coupon?.code);
    const renderedHtml=html || tpl.html({percent:pct,planLabel:plan.charAt(0).toUpperCase()+plan.slice(1),originalPrice,finalPrice,url});
    const renderedSubject=subject || tpl.subject.replace("{{percent}}",pct).replace("{{planLabel}}",plan.charAt(0).toUpperCase()+plan.slice(1));
    let sent=0, failed=0;
    for(const u of users){
      try{
        await resend.emails.send({from:process.env.EMAIL_FROM||"ReelScribe <noreply@reelscribe.site>",to:u.email,subject:renderedSubject,html:renderedHtml});
        sent++;
      }catch(e){failed++;}
    }
    logAdminAction("marketing-email",audience==="specific"?targetEmail:null,`Template ${templateId}; sent ${sent}/${users.length}`,req);
    res.json({success:true,attempted:users.length,sent,failed,capped:users.length>=100});
  } catch(e){ console.error("[/admin/marketing/send] failed:", e); res.status(500).json({success:false,error:"Couldn't send the campaign right now."}); }
});

// ── Feature modules ────────────────────────────────────────
const featureCtx = {
  app, express, rateLimit, requireAuth, User, Reel, ClipJob, JobState, BrandKit, Team, WebhookEndpoint,
  ai, webhooks, resend, axios, s3, crypto, mongoose, multer,
  getEffectivePlan, PLAN_LIMITS, isValidEmail, isValidYouTubeUrl, uploadPrefix, resolveBrandKit,
  startClipJob, runUserUrlTranscription, HttpError, EC2_URL, INTERNAL_KEY, getSessionEmail, mapClip,
  sanitizeCaptionSettings,
  PUBLIC_URL: () => (process.env.PUBLIC_SITE_URL || "https://reelscribe.site").replace(/\/$/, ""),
};
require("./routes/ai")(featureCtx);
require("./routes/clipTools")(featureCtx);
require("./routes/studio")(featureCtx);
require("./routes/developer")(featureCtx);
require("./routes/scheduler")(featureCtx);

// Consistent upload errors (especially the 25 MB direct-upload limit and file-type rejection).
app.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, error: "File is too large. Direct uploads are limited to 25 MB." });
  if (err?.message === "UNSUPPORTED_FILE_TYPE") return res.status(415).json({ success: false, error: "Unsupported file type. Please upload a video file (mp4, mov, webm, mkv, avi, 3gp)." });
  next(err);
});


// ── ReelScribe Mascot AI support ──────────────────────────────────────────
// Uses the existing Groq client. Keep GROQ_API_KEY server-side only.
const mascotChatRate = new Map();
app.post("/api/mascot/chat", async (req, res) => {
  const now = Date.now();
  const key = String(req.sessionID || req.ip || "guest");
  const hit = mascotChatRate.get(key) || { start: now, count: 0 };
  if (now - hit.start > 60_000) { hit.start = now; hit.count = 0; }
  hit.count += 1;
  mascotChatRate.set(key, hit);
  if (hit.count > 20) return res.status(429).json({ success: false, error: "Too many messages. Please wait a minute and try again." });

  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ success: false, error: "AI support is not configured yet. Please contact support." });
  }
  const incoming = Array.isArray(req.body?.messages) ? req.body.messages.slice(-8) : [];
  const messages = incoming
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1200).trim() }))
    .filter(m => m.content);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ success: false, error: "Please enter a message first." });
  }

  const page = req.body?.page && typeof req.body.page === "object" ? req.body.page : {};
  const pagePath = String(page.path || "").replace(/[^a-zA-Z0-9_./?=&-]/g, "").slice(0, 120);
  const pageTitle = String(page.title || "").replace(/[<>]/g, "").slice(0, 100);
  const pageError = String(page.error || "").replace(/[<>]/g, "").slice(0, 350);

  const system = `You are ReelScribe Assistant, the friendly support assistant for ReelScribe, a website for video transcription and AI clip creation. Reply naturally and concisely in the user's language (Hindi/Hinglish or English). Explain workflows step-by-step. Do not claim you can inspect account data, process a video, change a plan, make payments, or perform actions unless a verified tool explicitly allows it. Never ask for passwords, OTPs, API keys, or payment details. If a user reports an issue, ask for the exact visible error if context is insufficient. General product guidance: users can paste a supported video URL into the relevant Transcript or Cut Clips tool, start processing, then view results in the dashboard/history. Plan limits and features may change; tell users to check the Pricing page for current limits. If you don't know an answer, say so honestly and direct them to the Contact page. Current page: ${pageTitle || "unknown"} (${pagePath || "unknown"}). Visible error context: ${pageError || "none"}.`;
  try {
    const completion = await groq.chat.completions.create({
      model: process.env.GROQ_CHAT_MODEL || "openai/gpt-oss-20b",
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.4,
      max_tokens: 500
    });
    const reply = completion.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error("Empty assistant response");
    return res.json({ success: true, reply });
  } catch (err) {
    console.error("[mascot-chat]", err?.status || "", err?.code || "", err?.message || err);
    if (err?.status === 429) return res.status(429).json({ success: false, error: "AI support is busy right now. Please try again shortly." });
    if (err?.code === "model_not_found" || err?.status === 404) return res.status(502).json({ success: false, error: "The configured AI model is unavailable. Please check GROQ_CHAT_MODEL in hosting settings." });
    return res.status(502).json({ success: false, error: "I couldn't reach AI support right now. Please try again, or visit Contact for help." });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()), time: new Date().toISOString() });
});

// Friendly pricing route used by marketing email CTA links.
app.get("/pricing", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pricing.html"));
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── Final catch-all error handler ──────────────────────────────────────────
// Nothing internal (DB errors, stack traces, third-party API messages) ever
// reaches the client from here on. Full detail is logged server-side only.
app.use((err, req, res, next) => {
  console.error(`[unhandled] ${req.method} ${req.originalUrl} ::`, err);
  if (res.headersSent) return next(err);
  res.status(err?.status || 500).json({ success: false, error: "Something went wrong on our end. Please try again in a moment." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Render server running on ${PORT}`));
