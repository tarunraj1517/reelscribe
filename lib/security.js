const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

// Constant-time string comparison (avoids leaking secrets through timing).
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const hb = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Only allow same-site relative redirects. Blocks "//evil.com", "/\evil.com", "http://..." etc.
function safeRedirectPath(value, fallback = "/dashboard.html") {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(value)) return fallback;
  return value;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    if (l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80")) return true;
    if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
    return false;
  }
  return true;
}

// SSRF guard for user-supplied webhook URLs: https only, public IPs only.
async function assertSafePublicUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw new Error("Invalid URL."); }
  if (u.protocol !== "https:") throw new Error("Webhook URL must use https.");
  if (u.username || u.password) throw new Error("Webhook URL must not contain credentials.");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Webhook URL must be a public address.");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Webhook URL must be a public address.");
    return u;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error("Webhook URL must be a public address.");
  return u;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

module.exports = { safeEqual, safeRedirectPath, isPrivateIp, assertSafePublicUrl, sha256 };
