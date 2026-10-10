const mongoose = require("mongoose");

const WebhookEndpointSchema = new mongoose.Schema(
  {
    userEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    url: { type: String, required: true },
    secret: { type: String, required: true }, // used to HMAC-sign each delivery
    events: { type: [String], default: ["clip.completed", "clip.failed", "transcript.completed"] },
    active: { type: Boolean, default: true },
    lastStatus: { type: Number, default: null },
    lastDeliveryAt: { type: Date, default: null },
    failureCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.models.WebhookEndpoint || mongoose.model("WebhookEndpoint", WebhookEndpointSchema);
