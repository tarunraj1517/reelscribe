const crypto = require("crypto");
const axios = require("axios");
const { assertSafePublicUrl } = require("./security");

// Signed webhook delivery. Receivers verify:  sha256=HMAC(secret, `${timestamp}.${body}`)
function createWebhookSender(WebhookEndpoint) {
  async function send(userEmail, event, data) {
    try {
      const ep = await WebhookEndpoint.findOne({ userEmail: String(userEmail).toLowerCase(), active: true });
      if (!ep || (event !== "ping" && !ep.events.includes(event))) return false;
      await assertSafePublicUrl(ep.url); // re-check at send time (DNS can change)

      const body = JSON.stringify({ id: crypto.randomUUID(), event, createdAt: new Date().toISOString(), data });
      const ts = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac("sha256", ep.secret).update(`${ts}.${body}`).digest("hex");

      let status = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await axios.post(ep.url, body, {
            headers: { "Content-Type": "application/json", "X-ReelScribe-Event": event, "X-ReelScribe-Timestamp": String(ts), "X-ReelScribe-Signature": `sha256=${sig}` },
            timeout: 8000, maxRedirects: 0, validateStatus: () => true,
          });
          status = r.status;
          if (status >= 200 && status < 300) break;
        } catch { status = 0; }
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
      const ok = status >= 200 && status < 300;
      const update = { lastStatus: status, lastDeliveryAt: new Date(), failureCount: ok ? 0 : (ep.failureCount || 0) + 1 };
      if (!ok && update.failureCount >= 10) update.active = false; // auto-disable a dead endpoint
      await WebhookEndpoint.updateOne({ _id: ep._id }, { $set: update });
      return ok;
    } catch (e) {
      console.error("[webhook] delivery failed:", e.message);
      return false;
    }
  }
  return { send };
}

module.exports = { createWebhookSender };
